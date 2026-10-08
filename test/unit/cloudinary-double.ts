import { v2 as cloudinarySdk } from 'cloudinary';

import type { CloudinaryService } from '../../src/modules/storage/cloudinary.service';

/**
 * A Cloudinary double for tests that do not exercise Cloudinary itself.
 *
 * The provider is a module-level singleton, so a test that leaves it configured
 * leaks that configuration into whatever runs next — the same reason
 * `CloudinaryService` configures it once in its constructor. Every spec that
 * constructs a service taking a `CloudinaryService` passes one of these.
 *
 * `uploadCourseThumbnail` mints a key shaped exactly as the real one does, so a
 * test can assert on what was stored without caring where it went.
 *
 * Typed as `CloudinaryService` so call sites need no cast; the jest mocks stay
 * reachable because the intersection keeps them.
 */
export function cloudinaryDouble(
  overrides: Partial<CloudinaryService> = {},
): CloudinaryService {
  return {
    enabled: true,
    cloudName: 'test-cloud',
    coursesFolder: 'courses',
    uploadCourseThumbnail: jest.fn(async ({ courseId }: { courseId: string }) => ({
      objectKey: `cloudinary:courses/${courseId}/11111111-1111-1111-1111-111111111111`,
      url: 'https://res.cloudinary.com/test-cloud/image/upload/courses/x/1111.jpg',
    })),
    deleteByKey: jest.fn(async () => undefined),
    resolveStoredKey: jest.fn((key: string | null | undefined) => {
      if (!key?.startsWith('cloudinary:')) return null;
      return `https://res.cloudinary.com/test-cloud/image/upload/${key.slice('cloudinary:'.length)}`;
    }),
    ...overrides,
  } as unknown as CloudinaryService;
}

/**
 * Stubs the SDK's uploader so `upload_stream` completes.
 *
 * `uploadCourseThumbnail` pipes a Buffer into `upload_stream` and resolves from
 * the callback, so a test of that method needs the SDK's callback to fire. The
 * response is shaped like the real one — `public_id` and `secure_url` — because
 * those are the two fields the service reads.
 */
export function stubCloudinaryUploader(
  result: { public_id: string; secure_url: string },
): void {
  jest
    .spyOn(cloudinarySdk.uploader, 'upload_stream')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .mockImplementation(((_options: unknown, callback: any) => {
      // A minimal writable that swallows the piped bytes and calls back, which
      // is all the service asks of it.
      // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-call
      const { Writable } = require('node:stream') as typeof import('node:stream');
      return new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
        final(done) {
          callback(null, result);
          done();
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any);
}

/** Restores the real uploader. Call from `afterEach`. */
export function restoreCloudinaryUploader(): void {
  jest.restoreAllMocks();
}
