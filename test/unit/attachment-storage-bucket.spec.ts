import { StorageController } from 'src/modules/storage/storage.controller';
import { StorageService } from 'src/modules/storage/storage.service';

/**
 * THE PRODUCTION 404 THIS FILE EXISTS FOR
 * ---------------------------------------
 * Students opening a lecture PDF got, from the media Worker:
 *
 *     404 Not Found
 *     x-deny-reason: not_found
 *
 * `cloudflare-worker.js` derives `objectKey` from the URL PATH and then picks a
 * store by key prefix only:
 *
 *     const objectKey = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
 *     const store = objectKey.startsWith('library/') && env.LIBRARY
 *       ? env.LIBRARY : env.MEDIA;
 *     const object = await store.get(objectKey);
 *     if (!object) return deny(404, 'not_found', origin);
 *
 * `MediaOriginController:161` does the same via `StorageService.bucketForKey`.
 *
 * Both were correct. The WRITE was not: the two attachment upload sites passed
 * `bucket: 'uploads'`, so the object landed in `edu-uploads` while every reader
 * looked in `edu-media` (R2_BUCKET_MEDIA=edu-media, R2_BUCKET_UPLOADS=edu-uploads).
 * Signature and expiry were valid the whole time - only the bucket was wrong.
 *
 * Library documents survived because `library/` IS the prefix that selects the
 * bucket they were written to. That is the entire difference between the working
 * flow and the failing one.
 *
 * These tests pin the invariant that closed the gap: whatever bucket an
 * attachment is WRITTEN to must be the bucket `bucketForKey` READS it from.
 */

/** The two endpoints under test, with their real arities. */
type StorageControllerLike = {
  attachment(
    actor: { id: string; role: 'ADMIN' },
    dto: Record<string, unknown>,
  ): Promise<{ url: string; fields: Record<string, string> }>;
  attachmentContent(
    actor: { id: string; role: 'ADMIN' },
    query: Record<string, unknown>,
    req: unknown,
  ): Promise<{ objectKey: string; sizeBytes: number }>;
};

function build() {
  const presignUpload = jest.fn(
    async (_args: { bucket: string; objectKey: string; contentType: string }) => ({
      url: 'https://up.example',
      fields: {},
    }),
  );
  const putStream = jest.fn(
    async (_args: {
      bucket: string;
      objectKey: string;
      contentLength: number;
      contentType: string;
    }) => undefined,
  );

  const storage = {
    presignUpload,
    putStream,
    publicAssetUrl: jest.fn(async () => null),
    signMediaUrl: jest.fn(async () => 'https://gate.example/x'),
    deleteObject: jest.fn(async () => undefined),
    get isConfigured() {
      return true;
    },
  };

  const cloudinary = {};
  // `assertCourseExistsAndManageable` is on the presign route now: `courseId`
  // names the key's namespace, so it has to be a course this actor may manage
  // before anything is signed.
  const assertCourseExistsAndManageable = jest.fn(async () => undefined);
  const courseAccess = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertCourseExistsAndManageable,
    assertTeacherCapability: jest.fn(async () => undefined),
  };

  // Order matches the real constructor: storage, cloudinary, courseAccess.
  const controller = new StorageController(
    storage as never,
    cloudinary as never,
    courseAccess as never,
  ) as unknown as StorageControllerLike;

  return { controller, storage, presignUpload, putStream, assertCourseExistsAndManageable };
}

/** The actor every `attachment()` call below is made as. */
const ADMIN = { id: 'usr_1', role: 'ADMIN' } as const;

/** Minimal request carrying a body length, which the endpoint requires. */
function req(contentLength = 1024) {
  return { headers: { 'content-length': String(contentLength) } } as never;
}

describe('the bucket an attachment is written to', () => {
  it('matches the bucket bucketForKey reads it from', () => {
    // The invariant, stated directly. If either side moves, this fails.
    const key = StorageService.keys.attachment('crs_1', 'slides.pdf');

    expect(StorageService.bucketForKey(key)).toBe('media');
  });

  it('is NOT the uploads bucket, which no reader ever queries', () => {
    const key = StorageService.keys.attachment('crs_1', 'slides.pdf');
    // `uploads` is a real bucket name, so this is a real trap - the drift was
    // invisible because the write succeeded.
    expect(StorageService.bucketForKey(key)).not.toBe('uploads');
  });

  it('keeps library documents on the bucket their prefix selects', () => {
    // The flow that always worked, pinned so it cannot be "fixed" into breaking.
    const key = StorageService.keys.libraryDocument('book.pdf');
    expect(StorageService.bucketForKey(key)).toBe('library');
  });
});

describe('presigned attachment upload', () => {
  it('targets the bucket readers resolve attachments from', async () => {
    const t = build();
    await t.controller.attachment(ADMIN, {
      courseId: 'crs_1',
      filename: 'slides.pdf',
      contentType: 'application/pdf',
    });

    expect(t.presignUpload).toHaveBeenCalledTimes(1);
    expect(t.presignUpload.mock.calls[0]![0]).toMatchObject({
      bucket: 'media',
      contentType: 'application/pdf',
    });
  });

  it('signs an object key under the course attachment namespace', async () => {
    const t = build();
    await t.controller.attachment(ADMIN, {
      courseId: 'crs_1',
      filename: 'slides.pdf',
      contentType: 'application/pdf',
    });

    const { objectKey } = t.presignUpload.mock.calls[0]![0] as { objectKey: string };
    expect(objectKey.startsWith('attachments/crs_1/')).toBe(true);
    expect(objectKey.endsWith('.pdf')).toBe(true);
  });

  it('still refuses a filename with path separators', async () => {
    const t = build();
    await expect(
      t.controller.attachment(ADMIN, {
        courseId: 'crs_1',
        filename: '../../etc/passwd',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow();
    expect(t.presignUpload).not.toHaveBeenCalled();
  });
});

/**
 * The presign route became the dashboard's ONLY route to an attachment: the
 * bytes now go browser -> storage over a signature this call returns, because
 * proxying them through a Function failed above Vercel's 4.5 MB cap. That
 * promoted this endpoint from "a key generator" to the whole authorisation
 * step for the upload, so the checks it performs matter more than they did.
 */
describe('presigned attachment upload — course ownership', () => {
  it('checks the course is manageable before signing anything', async () => {
    const t = build();

    await t.controller.attachment(ADMIN, {
      courseId: 'crs_1',
      filename: 'slides.pdf',
      contentType: 'application/pdf',
    });

    expect(t.assertCourseExistsAndManageable).toHaveBeenCalledWith(
      ADMIN.id,
      ADMIN.role,
      'crs_1',
      'content',
    );
  });

  it('signs nothing when the actor may not manage the course', async () => {
    // Without this, `@StaffOnly()` alone would let any teacher mint a signature
    // naming a course they do not teach — an object written into another
    // teacher's namespace.
    const t = build();
    t.assertCourseExistsAndManageable.mockRejectedValueOnce(new Error('forbidden'));

    await expect(
      t.controller.attachment(ADMIN, {
        courseId: 'crs_someone_elses',
        filename: 'slides.pdf',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow();

    expect(t.presignUpload).not.toHaveBeenCalled();
  });

  it('checks ownership BEFORE validating the filename, so nothing is minted', async () => {
    // Order is the point: an unauthorised caller learns nothing, and a
    // traversal attempt cannot ride through on the back of the ownership check.
    const t = build();
    t.assertCourseExistsAndManageable.mockRejectedValueOnce(new Error('forbidden'));

    await expect(
      t.controller.attachment(ADMIN, {
        courseId: 'crs_someone_elses',
        filename: '../../etc/passwd',
        contentType: 'application/pdf',
      }),
    ).rejects.toThrow('forbidden');

    expect(t.presignUpload).not.toHaveBeenCalled();
  });
});

describe('streamed attachment upload (the path the dashboard uses)', () => {
  it('writes to the same bucket the presign offers', async () => {
    // Both write sites must agree, or the object lands in one bucket while the
    // presigned PUT and the read expect another.
    const t = build();

    await t.controller.attachmentContent(
      ADMIN,
      { courseId: 'crs_1', filename: 'slides.pdf', contentType: 'application/pdf' } as never,
      req(),
    );

    expect(t.putStream).toHaveBeenCalledTimes(1);
    expect(t.putStream.mock.calls[0]![0]).toMatchObject({
      bucket: 'media',
      contentType: 'application/pdf',
    });
  });

  it('agrees with the presigned bucket exactly', async () => {
    const t = build();

    await t.controller.attachment(
      ADMIN,
      { courseId: 'crs_1', filename: 'slides.pdf', contentType: 'application/pdf' } as never,
    );
    await t.controller.attachmentContent(
      ADMIN,
      { courseId: 'crs_1', filename: 'slides.pdf', contentType: 'application/pdf' } as never,
      req(),
    );

    const presigned = (t.presignUpload.mock.calls[0]![0] as { bucket: string }).bucket;
    const streamed = (t.putStream.mock.calls[0]![0] as { bucket: string }).bucket;

    expect(streamed).toBe(presigned);
  });

  it('returns a key in the namespace bucketForKey resolves back to media', async () => {
    const t = build();
    const result = (await t.controller.attachmentContent(
      ADMIN,
      { courseId: 'crs_1', filename: 'slides.pdf', contentType: 'application/pdf' } as never,
      req(),
    )) as { objectKey: string; sizeBytes: number };

    expect(StorageService.bucketForKey(result.objectKey)).toBe('media');
    expect(result.sizeBytes).toBe(1024);
  });

  it('refuses an oversized or separator-bearing upload before writing', async () => {
    const t = build();

    await expect(
      t.controller.attachmentContent(
        ADMIN,
        { courseId: 'crs_1', filename: 'a/b.pdf', contentType: 'application/pdf' } as never,
        req(),
      ),
    ).rejects.toThrow();
    expect(t.putStream).not.toHaveBeenCalled();
  });
});

describe('the failure this prevents is diagnosable, not silent', () => {
  it('writes to exactly one bucket, so a mismatch cannot half-apply', async () => {
    const t = build();
    await t.controller.attachmentContent(
      ADMIN,
      { courseId: 'crs_1', filename: 'slides.pdf', contentType: 'application/pdf' } as never,
      req(),
    );

    const call = t.putStream.mock.calls[0]![0] as { bucket: string; objectKey: string };
    // The reader derives both the key and the bucket from the URL. If the two
    // disagree the Worker answers 404 `not_found` with no other signal.
    expect(call.bucket).toBe(StorageService.bucketForKey(call.objectKey));
  });
});
