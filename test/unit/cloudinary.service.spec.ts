import 'reflect-metadata';

import { v2 as cloudinarySdk } from 'cloudinary';

import { AppException } from '../../src/common/errors/app.exception';
import {
  CLOUDINARY_KEY_PREFIX,
  CloudinaryService,
  type CloudinaryConfig,
} from '../../src/modules/storage/cloudinary.service';

import { restoreCloudinaryUploader, stubCloudinaryUploader } from './cloudinary-double';

/**
 * The Cloudinary wrapper.
 *
 * Course images are the only assets here that are public by design, so this is
 * the only place a delivery URL is unsigned. The properties worth pinning are
 * the ones that would otherwise fail quietly:
 *
 *   1. The stored value is a **key**, not a URL — `cloudinary:<public_id>`.
 *      A column called `thumbnailKey` holding a URL would break every other
 *      convention in this codebase, and Cloudinary's value is that the URL is
 *      derived, so a different size or format can be served later without
 *      touching a row.
 *   2. The provider is recoverable from the key alone. Without the prefix, a
 *      folder rename would orphan everything already stored, and `publicAssetUrl`
 *      would have to guess which provider a key belongs to.
 *   3. `f_auto,q_auto` are applied. A catalogue card is exactly the asset class
 *      they exist for, and omitting them means a 3 MB phone photo is served at
 *      3 MB to every visitor.
 *   4. Delete is restricted to this course's own folder and is best-effort.
 */

const CLOUD = 'demo-cloud';

function config(overrides: Partial<CloudinaryConfig> = {}): CloudinaryConfig {
  return {
    enabled: true,
    cloudName: CLOUD,
    apiKey: 'key',
    apiSecret: 'secret',
    coursesFolder: 'courses',
    ...overrides,
  };
}

function build(overrides: Partial<CloudinaryConfig> = {}) {
  const cfg = config(overrides);
  const service = new CloudinaryService({
    getOrThrow: () => cfg,
  } as never);
  return { service, cfg };
}

describe('the stored key format', () => {
  it('prefixes the public ID so the provider is readable from the row', () => {
    expect(CloudinaryService.keyFor('courses/crs_1/abc')).toBe(
      `${CLOUDINARY_KEY_PREFIX}courses/crs_1/abc`,
    );
  });

  it('round-trips a key back to its public ID', () => {
    const key = CloudinaryService.keyFor('courses/crs_1/abc');
    expect(CloudinaryService.publicIdFrom(key)).toBe('courses/crs_1/abc');
  });

  it('does not mistake an R2 key for a Cloudinary one', () => {
    // The two live in the same column, so this distinction is load-bearing.
    expect(CloudinaryService.isCloudinaryKey('thumbnails/courses/crs_1/a.jpg')).toBe(false);
    expect(CloudinaryService.publicIdFrom('thumbnails/courses/crs_1/a.jpg')).toBeNull();
    // And a paid-video path must never read as either.
    expect(CloudinaryService.publicIdFrom('hls/vid/360p/index.m3u8')).toBeNull();
  });
});

describe('delivery URLs', () => {
  it('serves the public ID from the configured cloud', () => {
    const { service } = build();
    const url = service.deliveryUrl('courses/crs_1/abc');

    expect(url).toContain(`res.cloudinary.com/${CLOUD}`);
    expect(url).toContain('/image/upload/');
    expect(url.startsWith('https://')).toBe(true);
  });

  it('asks Cloudinary for a modern format and an automatic quality', () => {
    const { service } = build();
    // f_auto,q_auto: the two transformations that make a thumbnail worth
    // serving, and neither changes the stored bytes.
    const url = service.deliveryUrl('courses/crs_1/abc');

    expect(url).toContain('f_auto');
    expect(url).toContain('q_auto');
  });

  it('is unsigned — an unsigned URL is the whole reason this left R2', () => {
    const { service } = build();
    expect(service.deliveryUrl('courses/crs_1/abc')).not.toContain('sig=');
  });

  it('resolves a stored key to a delivery URL', () => {
    const { service } = build();
    expect(service.resolveStoredKey(`cloudinary:courses/crs_1/abc`)).toContain(
      'res.cloudinary.com',
    );
  });

  it('leaves an R2 key for the R2 path to handle', () => {
    const { service } = build();
    // Returning null here is how StorageService knows to fall through to its
    // own logic rather than emit a Cloudinary URL for an R2 object.
    expect(service.resolveStoredKey('thumbnails/courses/crs_1/a.jpg')).toBeNull();
    expect(service.resolveStoredKey(null)).toBeNull();
  });
});

describe('uploading', () => {
  afterEach(() => restoreCloudinaryUploader());

  it('mints a public ID under this course folder', async () => {
    stubCloudinaryUploader({
      public_id: 'courses/crs_1/minted',
      secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/courses/crs_1/minted`,
    });
    const { service } = build();

    const result = await service.uploadCourseThumbnail({
      courseId: 'crs_1',
      body: Buffer.from('x'),
      contentType: 'image/png',
    });

    expect(result.objectKey).toBe('cloudinary:courses/crs_1/minted');
    expect(result.url).toContain('res.cloudinary.com');
  });

  /**
   * Regression, found by uploading to the live account.
   *
   * Cloudinary prepends `folder` to `public_id` itself. Passing a public_id
   * that already began with the folder produced real assets at
   * `courses/courses/<courseId>/…`, while the stored key said
   * `courses/<courseId>/…` — so the row pointed at an asset that never existed
   * and the delete guard matched nothing. A stubbed uploader returning a
   * canned public_id cannot catch this, because the folder is applied by the
   * server; the options the client sends are the whole of it.
   */
  it('leaves the folder to Cloudinary rather than doubling it in public_id', async () => {
    const seen: { options?: Record<string, unknown> } = {};
    jest
      .spyOn(cloudinarySdk.uploader, 'upload_stream')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((options: unknown, callback: any) => {
        seen.options = options as Record<string, unknown>;
        const { Writable } = require('node:stream') as typeof import('node:stream');
        return new Writable({
          write(_c, _e, done) {
            done();
          },
          final(done) {
            callback(null, { public_id: 'courses/crs_1/x', secure_url: 'https://x/y' });
            done();
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);
    const { service } = build();

    await service.uploadCourseThumbnail({
      courseId: 'crs_1',
      body: Buffer.from('x'),
      contentType: 'image/png',
    });

    expect(seen.options?.folder).toBe('courses');
    // The point of the test: relative, not `courses/…`.
    expect(String(seen.options?.public_id)).not.toMatch(/^courses\//);
    expect(String(seen.options?.public_id)).toMatch(/^crs_1\/[0-9a-f-]{36}$/);
  });

  it('refuses when Cloudinary is not configured, rather than failing obscurely', async () => {
    const { service } = build({ enabled: false });

    await expect(
      service.uploadCourseThumbnail({
        courseId: 'crs_1',
        body: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toBeInstanceOf(AppException);
  });

  it('names a credential problem in the message', async () => {
    // The likeliest misconfiguration, and the one an operator needs told about
    // rather than left to decode from a 500.
    jest
      .spyOn(cloudinarySdk.uploader, 'upload_stream')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(((_o: unknown, callback: any) => {
        const { Writable } = require('node:stream') as typeof import('node:stream');
        return new Writable({
          write(_c, _e, done) {
            done();
          },
          final(done) {
            callback(Object.assign(new Error('unauthorised'), { http_code: 401 }));
            done();
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);
    const { service } = build();

    await expect(
      service.uploadCourseThumbnail({
        courseId: 'crs_1',
        body: Buffer.from('x'),
        contentType: 'image/png',
      }),
    ).rejects.toThrow(/Cloudinary credentials/);
  });
});

describe('deleting', () => {
  afterEach(() => restoreCloudinaryUploader());

  it('destroys the asset and its renditions', async () => {
    const destroy = jest.spyOn(cloudinarySdk.uploader, 'destroy').mockResolvedValue({} as never);
    const { service } = build();

    await service.deleteByKey('cloudinary:courses/crs_1/abc');

    // Without `invalidate`, Cloudinary keeps the derived renditions and only
    // forgets the original — which is most of a thumbnail's bytes.
    expect(destroy).toHaveBeenCalledWith('courses/crs_1/abc', {
      resource_type: 'image',
      invalidate: true,
    });
  });

  it('never touches a key that is not Cloudinary', async () => {
    // The guard that stops a paid-video path being destroyed by a thumbnail edit.
    const destroy = jest.spyOn(cloudinarySdk.uploader, 'destroy').mockResolvedValue({} as never);
    const { service } = build();

    await service.deleteByKey('hls/vid_paid/360p/index.m3u8');
    await service.deleteByKey('thumbnails/courses/crs_1/a.jpg');
    await service.deleteByKey(null);

    expect(destroy).not.toHaveBeenCalled();
  });

  it('does nothing when Cloudinary is not configured', async () => {
    const destroy = jest.spyOn(cloudinarySdk.uploader, 'destroy').mockResolvedValue({} as never);
    const { service } = build({ enabled: false });

    await service.deleteByKey('cloudinary:courses/crs_1/abc');

    expect(destroy).not.toHaveBeenCalled();
  });

  /*
   * "Deleted" is asserted on the SDK call, never on a 404 from the delivery
   * URL. Anything fetched before the delete stays in Cloudinary's delivery CDN
   * and keeps answering 200 for a while — which is what made an earlier
   * end-to-end run report two false failures for a delete that had worked.
   */

  it('swallows a failure — cleanup must never fail an edit', async () => {
    jest
      .spyOn(cloudinarySdk.uploader, 'destroy')
      .mockRejectedValue(new Error('cloudinary unreachable'));
    const { service } = build();

    await expect(service.deleteByKey('cloudinary:courses/crs_1/abc')).resolves.toBeUndefined();
  });
});
