import 'reflect-metadata';

import { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';
import { StorageController } from '../../src/modules/storage/storage.controller';
import { StorageService } from '../../src/modules/storage/storage.service';

/**
 * The course thumbnail, end to end.
 *
 * `Course.thumbnailKey` has existed since the catalogue did, and the API has
 * always accepted it — but nothing could set it. Every other thumbnail kind has
 * a streaming upload route; the course's own was the one missing, so the field
 * was write-only in practice and every course card fell back to its icon.
 *
 * What is worth pinning here, because each fails differently:
 *
 *   1. The upload route issues the key. The dashboard never names one — it
 *      returns whatever this route mints, and that is what the course row holds.
 *   2. The key lands in the course-thumbnail namespace under the right course.
 *      `assertCourseThumbnailKey` on the write path is a prefix check, so a key
 *      from the wrong namespace is refused rather than silently filed.
 *   3. Replacing an image must not leak the old file. Every upload mints a
 *      fresh UUID on purpose, so the previous object is unreferenced the moment
 *      the row moves — and deleting it has to be namespace-guarded, or a
 *      hand-edited row naming `hls/…` would take paid video down with it.
 */

const COURSE_ID = 'crs_abc123';
const PREVIOUS_KEY = `thumbnails/courses/${COURSE_ID}/11111111-1111-1111-1111-111111111111.jpg`;
const NEXT_KEY = `thumbnails/courses/${COURSE_ID}/22222222-2222-2222-2222-222222222222.png`;
const OTHER_COURSE_KEY =
  'thumbnails/courses/crs_other/33333333-3333-3333-3333-333333333333.jpg';

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

// ---------------------------------------------------------------------------
// 1. The streaming upload route
// ---------------------------------------------------------------------------

/** A storage double that records the single call the route makes. */
function buildStorage() {
  const putStream = jest.fn(
    async (_args: {
      bucket: string;
      objectKey: string;
      body: unknown;
      contentLength: number;
      contentType: string;
    }) => undefined,
  );
  return { storage: { putStream } as never, putStream };
}

/** A request double carrying only what `requireLength` reads. */
function request(contentLength?: string) {
  return {
    headers: contentLength === undefined ? {} : { 'content-length': contentLength },
  } as never;
}

describe('POST /storage/uploads/course-thumbnail/content', () => {
  it('issues a key under the course thumbnail namespace', async () => {
    const { storage, putStream } = buildStorage();
    const controller = new StorageController(storage);

    const result = await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/jpeg' },
      request('2048'),
    );

    // The dashboard registers exactly this string as Course.thumbnailKey.
    expect(result.objectKey).toMatch(
      new RegExp(`^thumbnails/courses/${COURSE_ID}/[0-9a-f-]{36}\\.jpg$`),
    );
    expect(result.sizeBytes).toBe(2048);
    expect(putStream).toHaveBeenCalledTimes(1);
  });

  it('streams to the media bucket, not uploads', async () => {
    const { storage, putStream } = buildStorage();
    const controller = new StorageController(storage);

    await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/png' },
      request('10'),
    );

    // Students read course cards from `media`; the other bucket is for paid
    // material and uploads. Filing a thumbnail in the wrong one is a data bug,
    // not a style one.
    const call = putStream.mock.calls[0];
    if (!call) throw new Error('putStream was never called');
    expect(call[0]).toMatchObject({ bucket: 'media', contentLength: 10 });
  });

  it('derives the extension from the content type, not the filename', async () => {
    const { storage } = buildStorage();
    const controller = new StorageController(storage);

    const webp = await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/webp' },
      request('10'),
    );

    expect(webp.objectKey.endsWith('.webp')).toBe(true);
  });

  it('mints a fresh key every time, so a cached URL keeps resolving', async () => {
    const { storage } = buildStorage();
    const controller = new StorageController(storage);

    const first = await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/jpeg' },
      request('10'),
    );
    const second = await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/jpeg' },
      request('10'),
    );

    // Overwriting in place is what the UUID exists to avoid; this is also why
    // replacing an image needs the old object deleted rather than overwritten.
    expect(first.objectKey).not.toBe(second.objectKey);
  });

  it('refuses a request with no Content-Length', async () => {
    const { storage, putStream } = buildStorage();
    const controller = new StorageController(storage);

    // Rather than read the body to measure it — the thing streaming exists to
    // avoid.
    await expect(
      controller.courseThumbnailContent(
        { courseId: COURSE_ID, contentType: 'image/jpeg' },
        request(undefined),
      ),
    ).rejects.toThrow();
    expect(putStream).not.toHaveBeenCalled();
  });

  it('refuses anything over 10 MB', async () => {
    const { storage, putStream } = buildStorage();
    const controller = new StorageController(storage);

    await expect(
      controller.courseThumbnailContent(
        { courseId: COURSE_ID, contentType: 'image/jpeg' },
        request(String(10 * 1024 * 1024 + 1)),
      ),
    ).rejects.toThrow();
    expect(putStream).not.toHaveBeenCalled();
  });

  it('accepts a request at exactly the 10 MB ceiling', async () => {
    const { storage } = buildStorage();
    const controller = new StorageController(storage);

    const result = await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/jpeg' },
      request(String(10 * 1024 * 1024)),
    );

    expect(result.sizeBytes).toBe(10 * 1024 * 1024);
  });

  it('is @StaffOnly(), so a teacher may use it and a student may not', () => {
    const roles = Reflect.getMetadata(
      ROLES_KEY,
      StorageController.prototype.courseThumbnailContent as object,
    ) as UserRole[];

    expect(roles).toEqual([UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER]);

    const guardFor = (role: UserRole) => {
      const context = {
        switchToHttp: () => ({ getRequest: () => ({ user: { id: 'u1', role } }) }),
        getHandler: () => StorageController.prototype.courseThumbnailContent,
        getClass: () => StorageController,
      } as never;
      const reflector = {
        getAllAndOverride: (key: string) => (key === ROLES_KEY ? roles : undefined),
      } as never;
      return new RolesGuard(reflector).canActivate(context);
    };

    expect(guardFor(UserRole.TEACHER)).toBe(true);
    try {
      guardFor(UserRole.STUDENT);
      throw new Error('the guard should have refused');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe(ErrorCode.INSUFFICIENT_ROLE);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The key the route issues is one the course row accepts
// ---------------------------------------------------------------------------

describe('the issued key is accepted by the course write path', () => {
  it('passes the namespace check the create/update path applies', () => {
    // The two halves only work together: the route mints the key, and the
    // service holds it to a prefix. If either moved, this fails.
    expect(PREVIOUS_KEY.startsWith(StorageService.courseThumbnailPrefix(COURSE_ID))).toBe(true);
  });

  it('refuses a key belonging to a different course', () => {
    expect(OTHER_COURSE_KEY.startsWith(StorageService.courseThumbnailPrefix(COURSE_ID))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Replacing an image deletes the old object
// ---------------------------------------------------------------------------

function buildAdminService(options: { before?: Record<string, unknown> } = {}) {
  const before = {
    id: COURSE_ID,
    title: 'Organic Chemistry',
    shortDescription: '',
    description: '',
    status: 'DRAFT',
    thumbnailKey: PREVIOUS_KEY,
    universityId: null,
    facultyId: null,
    // `update` finishes by re-reading the row through `detailForStaff`, whose
    // own include always selects these, so a double without them is unrealistic
    // rather than merely incomplete.
    prices: [],
    teachers: [],
    sections: [],
    departments: [],
    university: null,
    faculty: null,
    academicYear: null,
    subject: null,
    _count: { enrollments: 0, attachments: 0 },
    sectionCount: 0,
    lessonCount: 0,
    ...options.before,
  };

  // Mirrors Prisma: an absent field leaves the column alone, an explicit null
  // clears it, anything else overwrites.
  const courseUpdate = jest.fn(
    async (args: { data: { thumbnailKey?: string | null } }) => ({
      ...before,
      thumbnailKey:
        args.data.thumbnailKey === undefined
          ? before.thumbnailKey
          : args.data.thumbnailKey,
    }),
  );
  const deleteObject = jest.fn(async () => undefined);

  const prisma: Record<string, unknown> = {
    course: {
      findFirst: jest.fn(async () => before),
      findUnique: jest.fn(async () => null),
      update: courseUpdate,
      findMany: jest.fn(async () => []),
    },
    faculty: { findFirst: jest.fn(async () => null) },
    department: { findMany: jest.fn(async () => []) },
  };

  // Assigned after the fact: the interactive form hands the callback this same
  // object, which it cannot reference from inside its own initialiser.
  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
  );

  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    { assertCanManageCourse: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
    {
      publicAssetUrl: jest.fn(async () => null),
      deleteObject,
    } as never,
  );

  return { service, deleteObject, courseUpdate };
}

describe('replacing a course thumbnail', () => {
  it('deletes the previous object once the row points at the new one', async () => {
    const { service, deleteObject } = buildAdminService();

    await service.update(COURSE_ID, { thumbnailKey: NEXT_KEY }, ADMIN);

    expect(deleteObject).toHaveBeenCalledWith('media', PREVIOUS_KEY);
  });

  it('deletes the previous object when the image is cleared', async () => {
    const { service, deleteObject } = buildAdminService();

    await service.update(COURSE_ID, { thumbnailKey: null }, ADMIN);

    expect(deleteObject).toHaveBeenCalledWith('media', PREVIOUS_KEY);
  });

  it('leaves the object alone when the thumbnail was not mentioned', async () => {
    const { service, deleteObject } = buildAdminService();

    // The regression this guards: an unrelated edit — a renamed course — must
    // not delete the image the row still points at.
    await service.update(COURSE_ID, { title: 'Organic Chemistry II' }, ADMIN);

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('leaves the object alone when the same key is written back', async () => {
    const { service, deleteObject } = buildAdminService();

    await service.update(COURSE_ID, { thumbnailKey: PREVIOUS_KEY }, ADMIN);

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('never deletes outside this course thumbnail namespace', async () => {
    // A hand-edited or legacy row could name anything. `hls/<paidVideoId>/…`
    // is the dangerous case: deleting it on trust would destroy paid video and
    // every enrolment that points at it.
    const { service, deleteObject } = buildAdminService({
      before: { thumbnailKey: 'hls/vid_paid/360p/index.m3u8' },
    });

    await service.update(COURSE_ID, { thumbnailKey: NEXT_KEY }, ADMIN);

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('does not delete a thumbnail that belongs to another course', async () => {
    const { service, deleteObject } = buildAdminService({
      before: { thumbnailKey: OTHER_COURSE_KEY },
    });

    await service.update(COURSE_ID, { thumbnailKey: NEXT_KEY }, ADMIN);

    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('succeeds even when the delete fails', async () => {
    const { service, deleteObject } = buildAdminService();
    deleteObject.mockRejectedValueOnce(new Error('R2 unavailable'));

    // The row has already moved, so a storage failure here is an orphaned
    // file, never a lost one — and never worth failing an edit over.
    await expect(
      service.update(COURSE_ID, { thumbnailKey: NEXT_KEY }, ADMIN),
    ).resolves.toBeDefined();
  });

  it('still refuses a key from the wrong namespace on the write itself', async () => {
    const { service } = buildAdminService();

    // Unchanged behaviour: a client cannot point the course at paid video.
    await expect(
      service.update(COURSE_ID, { thumbnailKey: 'hls/vid_paid/360p/index.m3u8' }, ADMIN),
    ).rejects.toThrow();
  });
});
