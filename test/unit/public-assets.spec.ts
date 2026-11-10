import 'reflect-metadata';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { PublicAssetsController } from '../../src/modules/storage/public-assets.controller';
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
  ])('refuses %s', (key) => {
    expect(isPublicAssetKey(key)).toBe(false);
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

  it('percent-encodes each path segment and keeps the slashes', () => {
    process.env.PUBLIC_API_URL = 'https://api.example.com';
    expect(StorageService.publicAssetUrlSync('avatars/usr 1/a b.jpg')).toBe(
      'https://api.example.com/api/v1/assets/avatars/usr%201/a%20b.jpg',
    );
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

function build(object: StoredObject | null) {
  const getPublicObject = jest.fn(async (_bucket: string, _key: string) => object);
  const storage = { getPublicObject } as never;
  return { controller: new PublicAssetsController(storage), getPublicObject };
}

const PNG: StoredObject = {
  body: Buffer.from('png-bytes'),
  contentType: 'image/png',
  etag: '"abc"',
};

const request = (method = 'GET', headers: Record<string, string> = {}) =>
  ({ method, headers }) as never;

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

  it('answers 304 to a matching If-None-Match and sends no body', async () => {
    const { controller } = build(PNG);
    const { res } = response();

    await controller.serve(
      'avatars/usr_1/9f2c.jpg',
      request('GET', { 'if-none-match': '"abc"' }),
      res as never,
    );

    expect(res.statusCode).toBe(304);
    expect(res.send).not.toHaveBeenCalled();
  });

  it('HEAD sends the headers and no body', async () => {
    const { controller } = build(PNG);
    const { res, headers } = response();

    await controller.serve('avatars/usr_1/9f2c.jpg', request('HEAD'), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.send).not.toHaveBeenCalled();
    expect(headers['content-length']).toBe(String(PNG.body.length));
  });

  it('decides the content type from the key, never from stored metadata that is not an image', () => {
    expect(PublicAssetsController.contentTypeFor('a/b.JPG', 'text/html')).toBe('image/jpeg');
    expect(PublicAssetsController.contentTypeFor('a/b.webp', null)).toBe('image/webp');
    expect(PublicAssetsController.contentTypeFor('a/b', 'image/png')).toBe('image/png');
    expect(PublicAssetsController.contentTypeFor('a/b', 'text/html')).toBe(
      'application/octet-stream',
    );
  });
});
