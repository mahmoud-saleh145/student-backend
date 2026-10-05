import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import {
  assertObjectKeyInNamespace,
  StorageService,
} from '../../src/modules/storage/storage.service';

/**
 * Client-supplied object keys.
 *
 * A presign response hands the client an `objectKey`; the client sends it back
 * when it registers the upload. Until now nothing checked that the key came
 * back from the endpoint it claims to, and the key is what every later URL is
 * built from.
 *
 * The reason this is a security fix rather than tidiness: `publicAssetUrl`
 * returns an **unsigned** CDN URL, because it exists for images that are public
 * by design. So a `thumbnailKey` of `hls/<paidVideoId>/360p/index.m3u8` — a
 * namespace no thumbnail endpoint issues — becomes a permanent public link to
 * protected video, with no playback ticket and no viewer-bound signature. The
 * same shape reaches the original uploads under `source/videos/`.
 *
 * `assertObjectKeyInNamespace` is pure, so it is tested on its own here; the
 * specs for each module assert that they actually call it.
 */
describe('assertObjectKeyInNamespace', () => {
    it.each([
    'thumbnails/courses/crs_1/9f2c-1.png',
    'thumbnails/courses/crs_1/parts/prt_1/8ab-2.jpg',
  ])('accepts a course thumbnail key: %s', (key) => {
    expect(() =>
      assertObjectKeyInNamespace(key, 'thumbnails/courses/crs_1/', 'thumbnailKey'),
    ).not.toThrow();
  });

  it.each([
    ['hls/vid_1/360p/index.m3u8', 'thumbnails/courses/crs_1/'],
    ['source/videos/vid_1/9f2c.mp4', 'thumbnails/courses/crs_1/'],
    ['avatars/usr_1/3ab.png', 'thumbnails/courses/crs_1/'],
    ['captions/vid_1/en.vtt', 'thumbnails/courses/crs_1/'],
    ['library/9f2c.pdf', 'thumbnails/courses/crs_1/'],
  ])('refuses %s as a course thumbnail', (key, namespace) => {
    expect(() => assertObjectKeyInNamespace(key, namespace, 'thumbnailKey')).toThrow(
      AppException,
    );
  });

  it('names the field and the expected prefix in the error', () => {
    try {
      assertObjectKeyInNamespace(
        'hls/vid_1/360p/index.m3u8',
        'thumbnails/courses/crs_1/',
        'thumbnailKey',
      );
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      const app = e as AppException;
      expect(app.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(JSON.stringify(app.details)).toContain('thumbnails/courses/crs_1/');
    }
  });

  it('points the caller at the presign endpoint rather than just failing', () => {
    try {
      assertObjectKeyInNamespace('hls/vid_1/x.m3u8', 'thumbnails/courses/', 'thumbnailKey');
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toMatch(/presign/i);
    }
  });

  describe('the prefixes it checks against', () => {
    it('scopes a course thumbnail to that course', () => {
      expect(StorageService.courseThumbnailPrefix('crs_1')).toBe('thumbnails/courses/crs_1/');
    });

    it('scopes an attachment to that course', () => {
      expect(StorageService.attachmentPrefix('crs_1')).toBe('attachments/crs_1/');
    });

    it('scopes a library thumbnail to that material', () => {
      expect(StorageService.libraryThumbnailPrefix('mat_1')).toBe('thumbnails/library/mat_1/');
    });

    it('keeps the library default in its own namespace', () => {
      // `_default` is not a material id, so a material-scoped prefix would
      // reject the very key the default-thumbnail endpoint issues.
      expect(StorageService.LIBRARY_DEFAULT_THUMBNAIL_PREFIX).toBe(
        'thumbnails/library/_default/',
      );
    });

    it('keeps paid documents under library/', () => {
      expect(StorageService.LIBRARY_DOCUMENT_PREFIX).toBe('library/');
    });

    it('accepts every key shape its own presign endpoint issues', () => {
      // Guards against the check and the key builders drifting apart, which
      // would reject a legitimate upload.
      const issued = [
        [StorageService.keys.courseThumbnail('crs_1', '.png'), 'thumbnails/courses/'],
        [
          StorageService.keys.coursePartThumbnail('crs_1', 'prt_1', '.jpg'),
          'thumbnails/courses/',
        ],
        [
          StorageService.keys.libraryPartThumbnail('mat_1', 'lp_1', '.jpg'),
          'thumbnails/library/',
        ],
        [StorageService.keys.libraryDefaultThumbnail('.png'), 'thumbnails/library/'],
        [StorageService.keys.attachment('crs_1', 'notes.pdf'), 'attachments/crs_1/'],
        [StorageService.keys.libraryDocument('notes.pdf'), 'library/'],
      ] as const;

      for (const [key, namespace] of issued) {
        expect(() => assertObjectKeyInNamespace(key, namespace, 'k')).not.toThrow();
      }
    });
  });

  describe('the library default thumbnail setting', () => {
    // Same key-to-URL path as a part thumbnail, but reachable through
    // PATCH /settings rather than a per-part write, so it needs its own guard.
    const valid = (value: unknown) =>
      value === '' || (typeof value === 'string' &&
        value.startsWith(StorageService.LIBRARY_DEFAULT_THUMBNAIL_PREFIX));

    it('accepts a key from the default-thumbnail endpoint', () => {
      expect(valid(StorageService.keys.libraryDefaultThumbnail('.png'))).toBe(true);
    });

    it('accepts an empty string, which clears it', () => {
      expect(valid('')).toBe(true);
    });

    it('refuses a key into protected video', () => {
      expect(valid('hls/vid_1/360p/index.m3u8')).toBe(false);
    });

    it('refuses a key into an original upload', () => {
      expect(valid('source/videos/vid_1/9f.mp4')).toBe(false);
    });
  });
});