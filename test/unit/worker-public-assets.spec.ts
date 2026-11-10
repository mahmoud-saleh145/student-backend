import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PUBLIC_IMAGE_KEY_PATTERN } from '../../src/modules/storage/storage.service';

/**
 * Public images at the edge: the media gate Worker's unsigned branch.
 *
 * The real docs/cloudflare-worker.js runs here against stand-ins for the three
 * platform pieces it touches — the location's cache (`caches.default`), the
 * MEDIA R2 binding and the two rate-limit bindings — so each assertion is
 * about what the deployed code does:
 *
 *   * a repeat request is served from the cache and does NOT read R2;
 *   * only the strict public key shape reaches the branch; every private
 *     namespace, traversal, encoded or double-encoded path falls through to
 *     the signed path and is refused there exactly as before;
 *   * headers, validators, HEAD and 304 are right on both HIT and MISS;
 *   * the limits are keyed by the address Cloudflare saw, not by a header the
 *     client wrote, and refusals carry Retry-After.
 */

type WorkerModule = { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> };

function loadWorker(): WorkerModule {
  const source = readFileSync(join(process.cwd(), 'docs/cloudflare-worker.js'), 'utf8');
  const commonjs = source.replace('export default {', 'module.exports = {');
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', commonjs)(module, module.exports);
  return module.exports as never;
}

/** The location's cache: stores a materialised copy, hands out fresh responses. */
class FakeCache {
  readonly entries = new Map<string, { status: number; headers: [string, string][]; body: Uint8Array }>();
  matches = 0;
  puts = 0;

  async match(request: Request): Promise<Response | undefined> {
    this.matches += 1;
    const entry = this.entries.get(request.url);
    if (!entry) return undefined;
    return new Response(entry.status === 200 ? entry.body : null, {
      status: entry.status,
      headers: entry.headers,
    });
  }

  async put(request: Request, response: Response): Promise<void> {
    this.puts += 1;
    const body = new Uint8Array(await response.arrayBuffer());
    this.entries.set(request.url, { status: response.status, headers: [...response.headers], body });
  }
}

interface FakeObject {
  bytes: Uint8Array;
  etag: string;
}

function fakeBucket(objects: Record<string, FakeObject>) {
  const gets: string[] = [];
  return {
    gets,
    get: jest.fn(async (key: string) => {
      gets.push(key);
      const object = objects[key];
      if (!object) return null;
      return {
        body: new Response(object.bytes).body,
        size: object.bytes.length,
        httpEtag: `"${object.etag}"`,
        uploaded: new Date('2026-11-10T20:00:00Z'),
      };
    }),
  };
}

function fakeLimiter(allow: () => boolean = () => true) {
  const keys: string[] = [];
  return {
    keys,
    limit: jest.fn(async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: allow() };
    }),
  };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const COVER = 'thumbnails/library/cmwb528al004vg301ncvnh414/cover/9b92ce50-8e1a-4a94-b856-aae2b8815b4b.png';
const AVATAR = 'avatars/usr_1/0f8fad5b-d9cb-469f-a165-70867728950e.jpg';

function harness(options: {
  objects?: Record<string, FakeObject>;
  allowAll?: () => boolean;
  allowMiss?: () => boolean;
  withLimiters?: boolean;
} = {}) {
  const worker = loadWorker();
  const cache = new FakeCache();
  (globalThis as unknown as { caches: unknown }).caches = { default: cache };
  const MEDIA = fakeBucket(options.objects ?? { [COVER]: { bytes: PNG, etag: 'abc123' } });
  const all = fakeLimiter(options.allowAll);
  const miss = fakeLimiter(options.allowMiss);
  const env = {
    MEDIA,
    MEDIA_SIGNING_KEY: 'test-key',
    WEB_ORIGINS: 'https://app.example.com',
    ...(options.withLimiters === false ? {} : { PUBLIC_ASSET_LIMITER: all, PUBLIC_ASSET_MISS_LIMITER: miss }),
  };
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };

  async function get(path: string, init: RequestInit & { headers?: Record<string, string> } = {}) {
    const response = await worker.fetch(
      new Request(`https://edu-media-gate.example.workers.dev/${path}`, {
        ...init,
        headers: { 'cf-connecting-ip': '203.0.113.7', ...(init.headers ?? {}) },
      }),
      env,
      ctx,
    );
    await Promise.all(pending.splice(0));
    return response;
  }

  return { get, cache, MEDIA, all, miss };
}

afterEach(() => {
  delete (globalThis as unknown as { caches?: unknown }).caches;
});

// ---------------------------------------------------------------------------

describe('public images at the edge — caching', () => {
  it('a miss reads R2 once, and the repeat is a HIT that does not touch R2', async () => {
    const { get, MEDIA } = harness();

    const first = await get(COVER);
    expect(first.status).toBe(200);
    expect(first.headers.get('x-asset-cache')).toBe('MISS');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG);

    const second = await get(COVER);
    expect(second.status).toBe(200);
    expect(second.headers.get('x-asset-cache')).toBe('HIT');
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(PNG);

    const third = await get(COVER);
    expect(third.headers.get('x-asset-cache')).toBe('HIT');
    await third.arrayBuffer();

    expect(MEDIA.get).toHaveBeenCalledTimes(1);
  });

  it('serves the browser policy, the right type, a stable validator and cross-origin headers', async () => {
    const { get } = harness();
    for (const response of [await get(COVER), await get(COVER)]) {
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(response.headers.get('etag')).toBe('"abc123"');
      expect(response.headers.get('content-length')).toBe(String(PNG.length));
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('set-cookie')).toBeNull();
      expect(response.headers.get('vary')).toBeNull();
      await response.arrayBuffer();
    }
  });

  it('keeps the edge copy for one day only, so a deleted image does not linger for a year', async () => {
    const { get, cache } = harness();
    await (await get(COVER)).arrayBuffer();
    const [entry] = [...cache.entries.values()];
    expect(new Headers(entry!.headers).get('cache-control')).toBe('public, max-age=86400');
  });

  it('ignores the query string for the cache key: random queries cannot force R2 reads', async () => {
    const { get, MEDIA } = harness();
    for (const q of ['', '?v=1', '?v=2', '?bust=8f2c']) {
      await (await get(COVER + q)).arrayBuffer();
    }
    expect(MEDIA.get).toHaveBeenCalledTimes(1);
  });

  it('answers a matching If-None-Match with 304 and no body, on a HIT without R2', async () => {
    const { get, MEDIA } = harness();
    await (await get(COVER)).arrayBuffer();

    const revalidated = await get(COVER, { headers: { 'if-none-match': '"abc123"' } });
    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe('"abc123"');
    expect(await revalidated.text()).toBe('');

    const weak = await get(COVER, { headers: { 'if-none-match': 'W/"abc123", "other"' } });
    expect(weak.status).toBe(304);

    const stale = await get(COVER, { headers: { 'if-none-match': '"old"' } });
    expect(stale.status).toBe(200);
    await stale.arrayBuffer();

    expect(MEDIA.get).toHaveBeenCalledTimes(1);
  });

  it('a revalidation on a cold location still answers 304 and warms the cache', async () => {
    const { get, MEDIA, cache } = harness();
    const response = await get(COVER, { headers: { 'if-none-match': '"abc123"' } });
    expect(response.status).toBe(304);
    expect(cache.entries.size).toBe(1);
    await (await get(COVER)).arrayBuffer();
    expect(MEDIA.get).toHaveBeenCalledTimes(1);
  });

  it('HEAD returns the headers and length without a body', async () => {
    const { get } = harness();
    const head = await get(COVER, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(PNG.length));
    expect(head.headers.get('content-type')).toBe('image/png');
    expect(await head.text()).toBe('');
  });

  it('a missing image is 404, remembered briefly, so a burst for it costs one R2 read', async () => {
    const { get, MEDIA, cache } = harness({ objects: {} });
    const first = await get(AVATAR);
    expect(first.status).toBe(404);
    expect(first.headers.get('cache-control')).toBe('public, max-age=60');
    const second = await get(AVATAR);
    expect(second.status).toBe(404);
    expect(second.headers.get('x-asset-cache')).toBe('HIT');
    expect(MEDIA.get).toHaveBeenCalledTimes(1);
    const [entry] = [...cache.entries.values()];
    expect(new Headers(entry!.headers).get('cache-control')).toBe('public, max-age=60');
  });

  it('refuses anything over 10 MB as missing', async () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const { get } = harness({ objects: { [COVER]: { bytes: big, etag: 'big' } } });
    expect((await get(COVER)).status).toBe(404);
  });

  it('a replacement is a new key, so it is fresh at once while the old key keeps its own entry', async () => {
    const NEW = COVER.replace('9b92ce50', '1c0ffee0');
    const { get } = harness({
      objects: {
        [COVER]: { bytes: PNG, etag: 'old' },
        [NEW]: { bytes: new Uint8Array([9, 9, 9]), etag: 'new' },
      },
    });
    await (await get(COVER)).arrayBuffer();
    const replaced = await get(NEW);
    expect(replaced.headers.get('x-asset-cache')).toBe('MISS');
    expect(replaced.headers.get('etag')).toBe('"new"');
    expect(new Uint8Array(await replaced.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it('works without a cache at all (degrades to R2 every time, never errors)', async () => {
    const { get, MEDIA } = harness();
    delete (globalThis as unknown as { caches?: unknown }).caches;
    expect((await get(COVER)).status).toBe(200);
    expect((await get(COVER)).status).toBe(200);
    expect(MEDIA.get).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['image/jpeg', AVATAR],
    ['image/jpeg', 'thumbnails/courses/crs_1/parts/prt_1/aa-bb.jpeg'],
    ['image/webp', 'thumbnails/library/_default/aa-bb.webp'],
    ['image/png', 'thumbnails/courses/crs_1/aa-bb.png'],
  ])('decides %s from the extension of %s', async (type, key) => {
    const { get } = harness({ objects: { [key]: { bytes: PNG, etag: 'e' } } });
    const response = await get(key);
    expect(response.headers.get('content-type')).toBe(type);
  });
});

// ---------------------------------------------------------------------------

describe('public images at the edge — what never reaches the public branch', () => {
  it.each([
    'hls/vid_1/master.m3u8',
    'hls/vid_1/720p/seg00001.ts',
    'source/videos/vid_1/a.mp4',
    'uploads/x.mp4',
    'library/9f2c.pdf',
    'attachments/crs_1/notes.pdf',
    'captions/vid_1/en.vtt',
    'thumbnails/videos/vid_1.jpg',
    'thumbnails/library/mat_1/cover/x.svg',
    'thumbnails/library/mat_1/cover/x.gif',
    'thumbnails/library/mat_1/cover/x.JPG',
    'thumbnails/library/mat_1/cover/x.bin',
    'thumbnails/library/mat_1/cover/x.pdf',
    'thumbnails/courses/../../hls/vid_1/master.m3u8',
    'thumbnails/courses/%2e%2e/%2e%2e/library/x.pdf',
    'thumbnails/courses/%252e%252e/%252e%252e/library/x.png',
    'thumbnails/library/..%2f..%2flibrary/x.png',
    'thumbnails/library/mat_1%2fcover/x.png',
    'thumbnails/library//x.png',
    'thumbnails/library/mat_1/cover/x.png.pdf',
    'avatars/../library/x.png',
    'avatars/usr%201/x.jpg',
    'Thumbnails/library/x.png',
  ])('%s falls through to the signed path: 403, and no public R2 read', async (path) => {
    const { get, MEDIA, all } = harness();
    const response = await get(path);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-asset-cache')).toBeNull();
    expect(MEDIA.get).not.toHaveBeenCalled();
    expect(all.limit).not.toHaveBeenCalled();
  });

  it.each(['thumbnails/library/./x.png', 'thumbnails\\library\\x.png', 'avatars/a/../b/x.jpg'])(
    '%s is normalised by the URL parser to a key INSIDE the public namespace, and only that key is read',
    async (path) => {
      const { get, MEDIA } = harness({ objects: {} });
      const response = await get(path);
      expect(response.status).toBe(404);
      for (const key of MEDIA.gets) expect(PUBLIC_IMAGE_KEY_PATTERN.test(key)).toBe(true);
    },
  );

  it('a signed request for a public key keeps the signed path (and its checks)', async () => {
    const { get, MEDIA } = harness();
    const response = await get(`${COVER}?exp=9999999999&uid=u&sig=forged`);
    expect(response.status).toBe(403);
    expect(response.headers.get('x-deny-reason')).toBe('bad_signature');
    expect(MEDIA.get).not.toHaveBeenCalled();
  });

  it('only GET and HEAD are served', async () => {
    const { get, MEDIA } = harness();
    const response = await get(COVER, { method: 'POST' });
    expect(response.status).toBe(405);
    expect(MEDIA.get).not.toHaveBeenCalled();
  });

  it('the Worker and the API accept exactly the same key shape', () => {
    const source = readFileSync(join(process.cwd(), 'docs/cloudflare-worker.js'), 'utf8');
    const match = source.match(/const PUBLIC_IMAGE_KEY = \/(.+)\/;\r?\n/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(PUBLIC_IMAGE_KEY_PATTERN.source);
  });
});

// ---------------------------------------------------------------------------

describe('public images at the edge — rate limiting', () => {
  it('keys both limits on the address Cloudflare saw, never on X-Forwarded-For', async () => {
    const { get, all, miss } = harness();
    await (
      await get(COVER, { headers: { 'x-forwarded-for': '198.51.100.1', 'x-real-ip': '198.51.100.2' } })
    ).arrayBuffer();
    expect(all.keys).toEqual(['ip:203.0.113.7']);
    expect(miss.keys).toEqual(['ip:203.0.113.7']);
  });

  it('the miss limit is consulted only on a miss; cache hits never spend it', async () => {
    const { get, miss } = harness();
    for (let i = 0; i < 5; i++) await (await get(COVER)).arrayBuffer();
    expect(miss.limit).toHaveBeenCalledTimes(1);
  });

  it('over the overall limit: 429 with Retry-After, not cached, no R2 read', async () => {
    const { get, MEDIA, cache } = harness({ allowAll: () => false });
    const response = await get(COVER);
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-deny-reason')).toBe('rate_limited');
    expect(MEDIA.get).not.toHaveBeenCalled();
    expect(cache.entries.size).toBe(0);
  });

  it('over the miss limit: 429 before R2, while cached images keep loading', async () => {
    let allowMiss = true;
    const OTHER = COVER.replace('9b92ce50', 'deadbeef');
    const { get, MEDIA } = harness({
      allowMiss: () => allowMiss,
      objects: { [COVER]: { bytes: PNG, etag: 'a' }, [OTHER]: { bytes: PNG, etag: 'b' } },
    });
    await (await get(COVER)).arrayBuffer();
    allowMiss = false;

    const walked = await get(OTHER);
    expect(walked.status).toBe(429);
    expect(MEDIA.get).toHaveBeenCalledTimes(1);

    const cached = await get(COVER);
    expect(cached.status).toBe(200);
    expect(cached.headers.get('x-asset-cache')).toBe('HIT');
  });

  it('recovers once the window allows again', async () => {
    let allow = false;
    const { get } = harness({ allowAll: () => allow });
    expect((await get(COVER)).status).toBe(429);
    allow = true;
    expect((await get(COVER)).status).toBe(200);
  });

  it('without the bindings (an older deploy, local runs) nothing is limited', async () => {
    const { get } = harness({ withLimiters: false });
    expect((await get(COVER)).status).toBe(200);
  });
});
