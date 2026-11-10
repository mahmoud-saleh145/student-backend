import 'reflect-metadata';

import express from 'express';
import supertest from 'supertest';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import {
  PUBLIC_ASSET_ORIGIN_LIMIT,
  PUBLIC_ASSET_ORIGIN_MAX_CLIENTS,
  PUBLIC_ASSET_ORIGIN_WINDOW_MS,
  PublicAssetRateLimiter,
} from '../../src/modules/storage/public-asset-rate-limiter';
import {
  PublicAssetsController,
  publicAssetClientKey,
} from '../../src/modules/storage/public-assets.controller';
import {
  isPublicAssetKey,
  PUBLIC_ASSET_PREFIXES,
  StorageService,
  type StoredObject,
} from '../../src/modules/storage/storage.service';

/**
 * The public image door.
 *
 * Every R2 thumbnail, cover and avatar used to be handed out as an unsigned
 * media-gate URL, which the gate refuses (`403 unsigned`); nothing stored in
 * R2 has ever rendered in production. `GET /assets/<key>` is the route those
 * images needed. These tests pin the two things that make it safe to expose:
 * it serves ONLY the allow-listed namespaces, and it answers an unknown or
 * private key with the same 404 so the bucket cannot be probed.
 */

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('isPublicAssetKey', () => {
  it.each([
    'thumbnails/courses/crs_1/9f2c.png',
    'thumbnails/courses/crs_1/parts/prt_1/9f2c.jpg',
    'thumbnails/library/mat_1/cover/9f2c.webp',
    'thumbnails/library/mat_1/parts/lp_1/9f2c.jpg',
    'thumbnails/library/_default/9f2c.png',
    'avatars/usr_1/9f2c.jpg',
  ])('accepts %s', (key) => {
    expect(isPublicAssetKey(key)).toBe(true);
  });

  it.each([
    'hls/vid_1/360p/index.m3u8',
    'hls/vid_1/720p/seg00001.ts',
    'source/videos/vid_1/9f2c.mp4',
    'uploads/vid_1/9f2c.mp4',
    'library/9f2c.pdf',
    'attachments/crs_1/9f2c.pdf',
    'captions/vid_1/en.vtt',
    // Poster frames of paid lectures are not in the list on purpose.
    'thumbnails/videos/vid_1.jpg',
    'thumbnails/courses/../../hls/vid_1/master.m3u8',
    '/thumbnails/courses/crs_1/9f2c.png',
    '',
    // Encoded and double-encoded traversal, as Express may hand them over.
    'thumbnails/courses/%2e%2e/%2e%2e/library/x.png',
    'thumbnails/courses/%252e%252e/library/x.png',
    'thumbnails/library/..%2f..%2flibrary/x.png',
    'thumbnails/library/mat_1%2fcover/x.png',
    // Separators and dot segments that a key builder never produces.
    'thumbnails\\library\\x.png',
    'thumbnails/library//x.png',
    'thumbnails/library/./x.png',
    'avatars/usr 1/a b.jpg',
    // Active or unexpected content types, whatever the namespace.
    'thumbnails/library/mat_1/cover/x.svg',
    'thumbnails/library/mat_1/cover/x.html',
    'thumbnails/library/mat_1/cover/x.gif',
    'thumbnails/library/mat_1/cover/x.bin',
    'thumbnails/library/mat_1/cover/x.JPG',
    'thumbnails/library/mat_1/cover/x.png.pdf',
    // A bare namespace, and an over-long key.
    'thumbnails/library/x',
    `avatars/${'a'.repeat(600)}.jpg`,
  ])('refuses %s', (key) => {
    expect(isPublicAssetKey(key)).toBe(false);
  });

  it('accepts every key the upload routes actually issue', () => {
    for (const ext of ['.jpg', '.png', '.webp']) {
      for (const key of [
        StorageService.keys.courseThumbnail('cmcrs1', ext),
        StorageService.keys.coursePartThumbnail('cmcrs1', 'cmprt1', ext),
        StorageService.keys.libraryPartThumbnail('cmmat1', 'cmlp1', ext),
        StorageService.keys.libraryCover('cmmat1', ext),
        StorageService.keys.libraryDefaultThumbnail(ext),
        StorageService.keys.avatar('cmusr1', ext),
      ]) {
        expect(isPublicAssetKey(key)).toBe(true);
      }
    }
  });

  it('is an allow-list of image namespaces and nothing else', () => {
    expect([...PUBLIC_ASSET_PREFIXES]).toEqual([
      'thumbnails/courses/',
      'thumbnails/library/',
      'avatars/',
    ]);
  });
});

describe('StorageService.publicAssetUrlSync', () => {
  it('points a public key at this API, under its prefix and version', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com/';
    delete process.env.API_PREFIX;
    delete process.env.API_VERSION;

    expect(StorageService.publicAssetUrlSync('thumbnails/library/mat_1/cover/9f2c.png')).toBe(
      'https://api.example.com/api/v1/assets/thumbnails/library/mat_1/cover/9f2c.png',
    );
  });

  it('never builds a URL for a private key, whatever the configuration', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    expect(StorageService.publicAssetUrlSync('hls/vid_1/master.m3u8')).toBeNull();
    expect(StorageService.publicAssetUrlSync('library/9f2c.pdf')).toBeNull();
  });

  it('returns null without PUBLIC_API_URL so the caller falls through', () => {
    delete process.env.PUBLIC_API_URL;
    expect(StorageService.publicAssetUrlSync('avatars/usr_1/9f2c.jpg')).toBeNull();
  });

  it('builds no URL for a key outside the strict shape (spaces, encodings, dot segments)', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    expect(StorageService.publicAssetUrlSync('avatars/usr 1/a b.jpg')).toBeNull();
    expect(StorageService.publicAssetUrlSync('avatars/%2e%2e/x.jpg')).toBeNull();
  });

  it('prefers the edge (PUBLIC_ASSET_BASE_URL) when it is set', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    process.env.PUBLIC_ASSET_BASE_URL = 'https://edu-media-gate.example.workers.dev/';
    expect(StorageService.publicAssetUrlSync('thumbnails/library/mat_1/cover/9f2c.png')).toBe(
      'https://edu-media-gate.example.workers.dev/thumbnails/library/mat_1/cover/9f2c.png',
    );
    // Private keys stay private whichever base is configured.
    expect(StorageService.publicAssetUrlSync('library/9f2c.pdf')).toBeNull();
  });

  it('falls back to the API route when PUBLIC_ASSET_BASE_URL is unset or blank (the rollback)', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    for (const value of [undefined, '', '   ']) {
      if (value === undefined) delete process.env.PUBLIC_ASSET_BASE_URL;
      else process.env.PUBLIC_ASSET_BASE_URL = value;
      expect(StorageService.publicAssetUrlSync('avatars/usr_1/9f2c.jpg')).toBe(
        'https://api.example.com/api/v1/assets/avatars/usr_1/9f2c.jpg',
      );
    }
  });
});

describe('StorageService.resolveAvatarUrl', () => {
  beforeEach(() => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
  });

  it('passes a full URL through', () => {
    expect(StorageService.resolveAvatarUrl('https://cdn.example.com/a.jpg')).toBe(
      'https://cdn.example.com/a.jpg',
    );
  });

  it('resolves a stored avatars/ key to the public asset route', () => {
    expect(StorageService.resolveAvatarUrl('avatars/usr_1/9f2c.jpg')).toBe(
      'https://api.example.com/api/v1/assets/avatars/usr_1/9f2c.jpg',
    );
  });

  it('turns a key that is neither into null rather than a broken image', () => {
    expect(StorageService.resolveAvatarUrl('hls/vid_1/master.m3u8')).toBeNull();
    expect(StorageService.resolveAvatarUrl(null)).toBeNull();
    expect(StorageService.resolveAvatarUrl('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

interface ResponseDouble {
  statusCode: number;
  body: unknown;
  ended: boolean;
  setHeader: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
  end: jest.Mock;
}

function response() {
  const headers: Record<string, string> = {};
  const res: ResponseDouble = {
    statusCode: 0,
    body: undefined,
    ended: false,
    setHeader: jest.fn((name: string, value: string) => {
      headers[name.toLowerCase()] = value;
    }),
    status: jest.fn((code: number): ResponseDouble => {
      res.statusCode = code;
      return res;
    }),
    send: jest.fn((body: unknown) => {
      res.body = body;
      res.ended = true;
    }),
    end: jest.fn(() => {
      res.ended = true;
    }),
  };
  return { res, headers };
}

function build(object: StoredObject | null, limiter?: PublicAssetRateLimiter) {
  const getPublicObject = jest.fn(async (_bucket: string, _key: string) => object);
  const headPublicObject = jest.fn(async (_bucket: string, _key: string) =>
    object ? { size: object.body.length, contentType: object.contentType, etag: object.etag } : null,
  );
  const storage = { getPublicObject, headPublicObject } as never;
  return {
    controller: new PublicAssetsController(storage, limiter),
    getPublicObject,
    headPublicObject,
  };
}

const PNG: StoredObject = {
  body: Buffer.from('png-bytes'),
  contentType: 'image/png',
  etag: '"abc"',
};

const request = (method = 'GET', headers: Record<string, string> = {}, ip = '203.0.113.7') =>
  ({ method, headers, ip }) as never;

describe('GET /assets/*', () => {
  it('serves a public image with cross-origin, immutable caching headers', async () => {
    const { controller, getPublicObject } = build(PNG);
    const { res, headers } = response();

    await controller.serve(
      ['thumbnails', 'library', 'mat_1', 'cover', '9f2c.png'],
      request(),
      res as never,
    );

    expect(getPublicObject).toHaveBeenCalledWith('media', 'thumbnails/library/mat_1/cover/9f2c.png');
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PNG.body);
    expect(headers['content-type']).toBe('image/png');
    expect(headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-length']).toBe(String(PNG.body.length));
    expect(headers['etag']).toBe('"abc"');
  });

  it('answers a private namespace 404 without touching storage', async () => {
    const { controller, getPublicObject } = build(PNG);
    const { res } = response();

    await expect(
      controller.serve('hls/vid_1/360p/index.m3u8', request(), res as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(getPublicObject).not.toHaveBeenCalled();
  });

  it('a traversal inside a public prefix is refused the same way', async () => {
    const { controller, getPublicObject } = build(PNG);
    const { res } = response();

    await expect(
      controller.serve(['thumbnails', 'courses', '..', '..', 'hls', 'x.m3u8'], request(), res as never),
    ).rejects.toBeInstanceOf(AppException);
    expect(getPublicObject).not.toHaveBeenCalled();
  });

  it('a missing object is 404, indistinguishable from a private key', async () => {
    const { controller } = build(null);
    const { res } = response();

    await expect(
      controller.serve('avatars/usr_1/missing.jpg', request(), res as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('answers a matching If-None-Match with 304 from metadata alone — the bytes are never read', async () => {
    const { controller, getPublicObject, headPublicObject } = build(PNG);
    const { res, headers } = response();

    await controller.serve(
      'avatars/usr_1/9f2c.jpg',
      request('GET', { 'if-none-match': 'W/"abc"' }),
      res as never,
    );

    expect(res.statusCode).toBe(304);
    expect(res.send).not.toHaveBeenCalled();
    expect(headers['etag']).toBe('"abc"');
    expect(headPublicObject).toHaveBeenCalledTimes(1);
    expect(getPublicObject).not.toHaveBeenCalled();
  });

  it('a stale If-None-Match gets the full image', async () => {
    const { controller, getPublicObject } = build(PNG);
    const { res } = response();
    await controller.serve('avatars/usr_1/9f2c.jpg', request('GET', { 'if-none-match': '"old"' }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(PNG.body);
    expect(getPublicObject).toHaveBeenCalledTimes(1);
  });

  it('HEAD sends the headers and the length from metadata, and no body', async () => {
    const { controller, getPublicObject } = build(PNG);
    const { res, headers } = response();

    await controller.serve('avatars/usr_1/9f2c.jpg', request('HEAD'), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.send).not.toHaveBeenCalled();
    expect(headers['content-length']).toBe(String(PNG.body.length));
    expect(headers['content-type']).toBe('image/jpeg');
    expect(getPublicObject).not.toHaveBeenCalled();
  });

  it('HEAD of a missing image is the same 404', async () => {
    const { controller } = build(null);
    const { res } = response();
    await expect(
      controller.serve('avatars/usr_1/missing.jpg', request('HEAD'), res as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('marks origin responses so an edge hit and an origin hit can be told apart', async () => {
    const { controller } = build(PNG);
    const { res, headers } = response();
    await controller.serve('avatars/usr_1/9f2c.jpg', request(), res as never);
    expect(headers['x-asset-source']).toBe('origin');
  });

  it.each([
    'thumbnails/courses/%2e%2e/%2e%2e/library/x.png',
    'thumbnails/courses/%252e%252e/library/x.png',
    'thumbnails/library/mat_1/cover/x.svg',
    'thumbnails/videos/vid_1.jpg',
  ])('refuses %s with 404 before storage is touched', async (key) => {
    const { controller, getPublicObject, headPublicObject } = build(PNG);
    const { res } = response();
    await expect(controller.serve(key, request(), res as never)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(getPublicObject).not.toHaveBeenCalled();
    expect(headPublicObject).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Direct-origin rate limiting
// ---------------------------------------------------------------------------

describe('PublicAssetRateLimiter', () => {
  it('allows up to the limit in a window, then refuses with the seconds left', () => {
    let now = 1_000_000;
    const limiter = new PublicAssetRateLimiter(3, 60_000, 100, () => now);
    expect([1, 2, 3].map(() => limiter.hit('ip:a').allowed)).toEqual([true, true, true]);
    now += 15_000;
    const refused = limiter.hit('ip:a');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(45);
  });

  it('recovers when the window has passed', () => {
    let now = 0;
    const limiter = new PublicAssetRateLimiter(1, 60_000, 100, () => now);
    expect(limiter.hit('ip:a').allowed).toBe(true);
    expect(limiter.hit('ip:a').allowed).toBe(false);
    now = 60_000;
    expect(limiter.hit('ip:a').allowed).toBe(true);
  });

  it('counts clients separately', () => {
    const limiter = new PublicAssetRateLimiter(1, 60_000, 100, () => 0);
    expect(limiter.hit('ip:a').allowed).toBe(true);
    expect(limiter.hit('ip:b').allowed).toBe(true);
    expect(limiter.hit('ip:a').allowed).toBe(false);
  });

  it('never tracks more than its bound, however many addresses arrive', () => {
    let now = 0;
    const limiter = new PublicAssetRateLimiter(5, 60_000, 1_000, () => now);
    for (let i = 0; i < 50_000; i++) {
      now += 1;
      limiter.hit(`ip:${i}`);
    }
    expect(limiter.size).toBeLessThanOrEqual(1_000);
  });

  it('evicts expired windows before live ones when full', () => {
    let now = 0;
    const limiter = new PublicAssetRateLimiter(1, 1_000, 2, () => now);
    limiter.hit('ip:old');
    now = 900;
    limiter.hit('ip:live');
    now = 1_500; // ip:old has expired, ip:live has not
    limiter.hit('ip:new');
    // ip:live's window survived the eviction, so it is still over its limit.
    expect(limiter.hit('ip:live').allowed).toBe(false);
  });
});

describe('GET /assets/* — rate limiting', () => {
  it('refuses a client over the limit with 429-class RATE_LIMITED and Retry-After, before storage', async () => {
    const limiter = new PublicAssetRateLimiter(2, 60_000, 100, () => 0);
    const { controller, getPublicObject } = build(PNG, limiter);

    for (let i = 0; i < 2; i++) {
      const { res } = response();
      await controller.serve('avatars/usr_1/9f2c.jpg', request(), res as never);
      expect(res.statusCode).toBe(200);
    }

    const { res, headers } = response();
    await expect(
      controller.serve('avatars/usr_1/9f2c.jpg', request(), res as never),
    ).rejects.toMatchObject({ code: ErrorCode.RATE_LIMITED });
    expect(headers['retry-after']).toBe('60');
    expect(headers['cache-control']).toBe('no-store');
    expect(getPublicObject).toHaveBeenCalledTimes(2);
  });

  it('another client is unaffected', async () => {
    const limiter = new PublicAssetRateLimiter(1, 60_000, 100, () => 0);
    const { controller } = build(PNG, limiter);
    await controller.serve('avatars/usr_1/9f2c.jpg', request('GET', {}, '203.0.113.7'), response().res as never);
    const { res } = response();
    await controller.serve('avatars/usr_1/9f2c.jpg', request('GET', {}, '198.51.100.9'), res as never);
    expect(res.statusCode).toBe(200);
  });

  it('the production policy is 300 per minute per address, tracking at most 10 000 addresses', () => {
    expect(PUBLIC_ASSET_ORIGIN_LIMIT).toBe(300);
    expect(PUBLIC_ASSET_ORIGIN_WINDOW_MS).toBe(60_000);
    expect(PUBLIC_ASSET_ORIGIN_MAX_CLIENTS).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// Which address the limiter sees
// ---------------------------------------------------------------------------

describe('which client a public image request is counted against', () => {
  // The chain production actually delivers (from GET /admin/diagnostics/client-ip,
  // addresses replaced by documentation ranges): whatever the client wrote,
  // then the address Cloudflare saw, Cloudflare's edge, Render's balancer —
  // and a local sidecar as the socket peer.
  const PLATFORM = ['198.51.100.10', '192.0.2.20', '10.24.0.30'];
  const CLIENT = '198.51.100.10';

  function app() {
    const server = express();
    server.set('trust proxy', 1); // what main.ts sets in production today
    server.get('/key', (req, res) => {
      res.json({ key: publicAssetClientKey(req), ip: req.ip });
    });
    return server;
  }

  const ORIGINAL_HOPS = process.env.PUBLIC_ASSET_CLIENT_IP_HOPS;
  afterEach(() => {
    if (ORIGINAL_HOPS === undefined) delete process.env.PUBLIC_ASSET_CLIENT_IP_HOPS;
    else process.env.PUBLIC_ASSET_CLIENT_IP_HOPS = ORIGINAL_HOPS;
  });

  it('with 3 platform hops, keys on the address Cloudflare observed', async () => {
    process.env.PUBLIC_ASSET_CLIENT_IP_HOPS = '3';
    const res = await supertest(app()).get('/key').set('X-Forwarded-For', PLATFORM.join(', '));
    expect(res.body.key).toBe(`ip:${CLIENT}`);
  });

  it('ignores anything the client wrote into X-Forwarded-For (it sits further left)', async () => {
    process.env.PUBLIC_ASSET_CLIENT_IP_HOPS = '3';
    const seen = new Set<string>();
    for (const forged of ['1.1.1.1', '2.2.2.2, 3.3.3.3', '6.6.6.6, 7.7.7.7, 8.8.8.8, 9.9.9.9']) {
      const res = await supertest(app())
        .get('/key')
        .set('X-Forwarded-For', [forged, ...PLATFORM].join(', '));
      seen.add(res.body.key);
    }
    expect([...seen]).toEqual([`ip:${CLIENT}`]);
  });

  it('two different clients behind the same balancer get different keys', async () => {
    process.env.PUBLIC_ASSET_CLIENT_IP_HOPS = '3';
    const a = await supertest(app()).get('/key').set('X-Forwarded-For', PLATFORM.join(', '));
    const b = await supertest(app())
      .get('/key')
      .set('X-Forwarded-For', ['203.0.113.99', ...PLATFORM.slice(1)].join(', '));
    expect(a.body.key).not.toBe(b.body.key);
  });

  it('documents why req.ip is not used: with one trusted hop it is the shared balancer', async () => {
    const res = await supertest(app()).get('/key').set('X-Forwarded-For', PLATFORM.join(', '));
    expect(res.body.ip).toBe('10.24.0.30');
  });

  it('falls back to req.ip when the hop count is unset or invalid', async () => {
    for (const value of [undefined, '', '0', '11', 'abc']) {
      if (value === undefined) delete process.env.PUBLIC_ASSET_CLIENT_IP_HOPS;
      else process.env.PUBLIC_ASSET_CLIENT_IP_HOPS = value;
      const res = await supertest(app()).get('/key').set('X-Forwarded-For', PLATFORM.join(', '));
      expect(res.body.key).toBe(`ip:${res.body.ip}`);
    }
  });

  it('a direct-origin request with no forwarding headers still gets a stable key', async () => {
    process.env.PUBLIC_ASSET_CLIENT_IP_HOPS = '3';
    const res = await supertest(app()).get('/key');
    expect(res.body.key).toMatch(/^ip:.+/);
  });
});

describe('content type', () => {
  it('decides the content type from the key, never from stored metadata that is not an image', () => {
    expect(PublicAssetsController.contentTypeFor('a/b.JPG', 'text/html')).toBe('image/jpeg');
    expect(PublicAssetsController.contentTypeFor('a/b.webp', null)).toBe('image/webp');
    expect(PublicAssetsController.contentTypeFor('a/b', 'image/png')).toBe('image/png');
    expect(PublicAssetsController.contentTypeFor('a/b', 'text/html')).toBe(
      'application/octet-stream',
    );
  });
});
