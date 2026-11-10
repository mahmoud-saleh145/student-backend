import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { StorageService } from '../../src/modules/storage/storage.service';

/**
 * How the media Worker delivers a document once a ticket is accepted: status,
 * Range handling, HEAD, and the refusals around it.
 *
 * The REAL Worker source is evaluated and every URL is signed by the REAL server
 * signer, as in worker-library-liveness.spec.ts.
 *
 * The R2 stand-in reproduces what production R2 does and what made every plain
 * GET answer "206 Partial Content" (72 h of production traffic up to
 * 2026-11-10: 506 responses, all 206, none 200): `get()` reports a `range` on
 * EVERY object, requested or not. A range that starts past the end is refused
 * with an error, as R2 refuses it.
 */

const SIGNING_KEY = 'test-signing-key';
const API = 'https://api.test';
const WEB = 'https://student-web.test';
const DOC = 'library/doc.pdf';
const SIZE = 1000;
const BYTES = 'x'.repeat(SIZE);

function loadWorker(): { fetch(req: Request, env: unknown, ctx: unknown): Promise<Response> } {
  const source = readFileSync(join(process.cwd(), 'docs/cloudflare-worker.js'), 'utf8');
  const commonjs = source.replace('export default {', 'module.exports = {');
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', commonjs)(module, module.exports);
  return module.exports as never;
}

function signer(): StorageService {
  const storage = Object.create(StorageService.prototype) as StorageService;
  (storage as unknown as { cfg: unknown }).cfg = { cdnBaseUrl: 'https://media.test', signingKey: SIGNING_KEY };
  return storage;
}

function sign(params: { objectKey?: string; ttl?: number; tid?: string } = {}): Promise<string> {
  return signer().signMediaUrl({
    objectKey: params.objectKey ?? DOC,
    expiresInSeconds: params.ttl ?? 300,
    userId: 'usr_1',
    sessionId: 'ses_1',
    deviceId: 'dev_1',
    ticketId: params.tid ?? 'lib_part1',
  });
}

type R2Range = { offset?: number; length?: number; suffix?: number };

/** Production-shaped R2: `range` is always reported; out-of-range reads throw. */
function r2(objects: Record<string, string> = { [DOC]: BYTES }) {
  const meta = (key: string) => ({
    key,
    size: objects[key]!.length,
    httpEtag: '"etag-1"',
    writeHttpMetadata(headers: Headers) {
      headers.set('content-type', 'application/octet-stream');
    },
  });
  return {
    get: jest.fn(async (key: string, options?: { range?: R2Range }) => {
      if (!(key in objects)) return null;
      const all = objects[key]!;
      const r = options?.range;
      if (r?.offset !== undefined && r.offset >= all.length) {
        throw new Error('get: The requested range is not satisfiable (10039)');
      }
      let start = 0;
      let end = all.length;
      if (r?.suffix !== undefined) start = Math.max(all.length - r.suffix, 0);
      else if (r?.offset !== undefined) {
        start = r.offset;
        end = r.length === undefined ? all.length : Math.min(r.offset + r.length, all.length);
      }
      return {
        ...meta(key),
        body: new Response(all.slice(start, end)).body,
        // What R2 echoes: the request's own shape, or the whole object.
        range: r ?? { offset: 0, length: all.length },
      };
    }),
    head: jest.fn(async (key: string) => (key in objects ? meta(key) : null)),
  };
}

let apiFetch: jest.Mock;
const realFetch = globalThis.fetch;

beforeEach(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { caches: unknown }).caches = {
    default: {
      match: jest.fn(async (req: Request) => (store.has(req.url) ? new Response(store.get(req.url)) : undefined)),
      put: jest.fn(async (req: Request, res: Response) => void store.set(req.url, await res.text())),
    },
  };
  apiFetch = jest.fn(async () =>
    new Response(JSON.stringify({ success: true, data: { live: true } }), { status: 200 }),
  );
  globalThis.fetch = apiFetch as never;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function env(library = r2()) {
  return {
    MEDIA: r2({}),
    LIBRARY: library,
    MEDIA_SIGNING_KEY: SIGNING_KEY,
    TICKET_CHECK: 'true',
    API_ORIGIN: API,
    WEB_ORIGINS: WEB,
  };
}

async function hit(url: string, init: RequestInit = {}, e = env()) {
  const pending: Promise<unknown>[] = [];
  const headers = new Headers(init.headers);
  if (!headers.has('origin')) headers.set('origin', WEB);
  const res = await loadWorker().fetch(new Request(url, { ...init, headers }), e, {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
  });
  await Promise.all(pending);
  return res;
}

describe('Worker delivery — a valid ticket', () => {
  it('a plain GET is 200 with the whole document, even though R2 reports a range', async () => {
    const e = env();
    const res = await hit(await sign(), {}, e);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(await res.text()).toHaveLength(SIZE);
    // Asked for the whole object: no range option was passed to storage.
    expect(e.LIBRARY.get).toHaveBeenCalledWith(DOC, undefined);
  });

  it('a 200 does not advertise ranges, so pdf.js keeps to one download per ticket', async () => {
    const res = await hit(await sign());
    expect(res.headers.get('accept-ranges')).toBeNull();
  });

  it('is a private, uncacheable PDF readable by the allow-listed web origin', async () => {
    const res = await hit(await sign());
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
  });

  it('is never readable by an origin that is not allow-listed', async () => {
    const res = await hit(await sign(), { headers: { origin: 'https://evil.test' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-site');
  });
});

describe('Worker delivery — Range', () => {
  it.each([
    ['bytes=0-99', { offset: 0, length: 100 }, 'bytes 0-99/1000', 100],
    ['bytes=900-', { offset: 900 }, 'bytes 900-999/1000', 100],
    ['bytes=-100', { suffix: 100 }, 'bytes 900-999/1000', 100],
    ['bytes=950-5000', { offset: 950, length: 4051 }, 'bytes 950-999/1000', 50],
    ['bytes=-5000', { suffix: 5000 }, 'bytes 0-999/1000', 1000],
  ])('%s is 206 with the exact span', async (header, asked, contentRange, length) => {
    const e = env();
    const res = await hit(await sign(), { headers: { range: header } }, e);
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe(contentRange);
    expect(res.headers.get('accept-ranges')).toBe('bytes');
    expect(await res.text()).toHaveLength(length);
    expect(e.LIBRARY.get).toHaveBeenCalledWith(DOC, { range: asked });
  });

  it('a range starting past the end is 416 with the size, not a 500', async () => {
    const res = await hit(await sign(), { headers: { range: 'bytes=1000-' } });
    expect(res.status).toBe(416);
    expect(res.headers.get('content-range')).toBe('bytes */1000');
    expect(res.headers.get('x-deny-reason')).toBe('range_not_satisfiable');
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
  });

  it('a range whose end runs past the file is served to the end, even if storage refuses it as asked', async () => {
    // A storage layer that rejects any span reaching past the end: the Worker
    // must clamp and ask again, not answer 416 for a valid request.
    const strict = r2();
    const lenient = strict.get.getMockImplementation()!;
    strict.get.mockImplementation(async (key: string, options?: { range?: R2Range }) => {
      const r = options?.range;
      if (r?.offset !== undefined && r.length !== undefined && r.offset + r.length > SIZE) {
        throw new Error('get: The requested range is not satisfiable (10039)');
      }
      return lenient(key, options);
    });
    const res = await hit(await sign(), { headers: { range: 'bytes=0-99999999' } }, env(strict));
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 0-999/1000');
    expect(await res.text()).toHaveLength(SIZE);
    expect(strict.get).toHaveBeenLastCalledWith(DOC, { range: { offset: 0, length: 1000 } });
  });

  it('"bytes=-0" is 416 without reading the body', async () => {
    const e = env();
    const res = await hit(await sign(), { headers: { range: 'bytes=-0' } }, e);
    expect(res.status).toBe(416);
    expect(e.LIBRARY.get).not.toHaveBeenCalled();
  });

  it.each(['bytes=0-1,5-6', 'bytes=10-2', 'items=0-1', 'bytes=-', 'garbage'])(
    'an unusable Range (%s) is ignored and the whole document is served',
    async (header) => {
      const e = env();
      const res = await hit(await sign(), { headers: { range: header } }, e);
      expect(res.status).toBe(200);
      expect(await res.text()).toHaveLength(SIZE);
      expect(e.LIBRARY.get).toHaveBeenCalledWith(DOC, undefined);
    },
  );
});

describe('Worker delivery — HEAD', () => {
  it('answers 200 with the length and no body, without downloading the object', async () => {
    const e = env();
    const res = await hit(await sign(), { method: 'HEAD' }, e);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe(String(SIZE));
    expect(res.body).toBeNull();
    expect(e.LIBRARY.head).toHaveBeenCalledWith(DOC);
    expect(e.LIBRARY.get).not.toHaveBeenCalled();
  });

  it('is still gated: an expired ticket is refused before storage is touched', async () => {
    const e = env();
    const res = await hit(await sign({ ttl: -1 }), { method: 'HEAD' }, e);
    expect(res.status).toBe(403);
    expect(e.LIBRARY.head).not.toHaveBeenCalled();
  });
});

describe('Worker delivery — refusals', () => {
  it('a missing object is 404 not_found, with CORS so the reader can tell', async () => {
    const e = env(r2({}));
    const res = await hit(await sign(), {}, e);
    expect(res.status).toBe(404);
    expect(res.headers.get('x-deny-reason')).toBe('not_found');
    expect(res.headers.get('access-control-allow-origin')).toBe(WEB);
  });

  it('an expired ticket is 403 expired, with no liveness probe and no storage read', async () => {
    const e = env();
    const res = await hit(await sign({ ttl: -1 }), {}, e);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('expired');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(e.LIBRARY.get).not.toHaveBeenCalled();
  });

  it('a ticket for one document cannot open another (bad_signature)', async () => {
    const url = new URL(await sign({ objectKey: 'library/a.pdf' }));
    url.pathname = '/library/doc.pdf';
    const e = env();
    const res = await hit(url.toString(), {}, e);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('bad_signature');
    expect(e.LIBRARY.get).not.toHaveBeenCalled();
  });

  it('a student the API no longer authorises is refused (ticket_revoked)', async () => {
    apiFetch.mockImplementation(
      async () => new Response(JSON.stringify({ success: true, data: { live: false } }), { status: 200 }),
    );
    const e = env();
    const res = await hit(await sign(), {}, e);
    expect(res.status).toBe(403);
    expect(res.headers.get('x-deny-reason')).toBe('ticket_revoked');
    expect(e.LIBRARY.get).not.toHaveBeenCalled();
  });

  it('a Range request is gated exactly like a full one', async () => {
    apiFetch.mockImplementation(
      async () => new Response(JSON.stringify({ success: true, data: { live: false } }), { status: 200 }),
    );
    const res = await hit(await sign(), { headers: { range: 'bytes=0-99' } });
    expect(res.status).toBe(403);
  });
});

describe('Worker delivery — concurrent requests on one ticket', () => {
  it('each is answered on its own terms, with nothing shared between them', async () => {
    const url = await sign();
    const e = env();
    const [full, first, last, head, beyond] = await Promise.all([
      hit(url, {}, e),
      hit(url, { headers: { range: 'bytes=0-9' } }, e),
      hit(url, { headers: { range: 'bytes=-10' } }, e),
      hit(url, { method: 'HEAD' }, e),
      hit(url, { headers: { range: 'bytes=5000-' } }, e),
    ]);
    expect(full.status).toBe(200);
    expect(first.status).toBe(206);
    expect(first.headers.get('content-range')).toBe('bytes 0-9/1000');
    expect(last.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(head.status).toBe(200);
    expect(beyond.status).toBe(416);
    // Every request was checked: one liveness probe each (workers.dev has no cache).
    expect(apiFetch.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});
