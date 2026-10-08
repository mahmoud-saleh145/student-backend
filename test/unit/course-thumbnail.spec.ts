import 'reflect-metadata';

import { UserRole } from '@prisma/client';
import { Readable } from 'node:stream';

import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';
import { StorageController } from '../../src/modules/storage/storage.controller';
import { StorageService } from '../../src/modules/storage/storage.service';

import { cloudinaryDouble } from './cloudinary-double';

/**
 * Course images live in Cloudinary.
 *
 * They used to be R2 objects, and that was why they displayed as broken: the
 * upload succeeded (bucket credentials bypass the edge) but the *read* did not,
 * because `publicAssetUrl` mints an unsigned URL to the media gate and the gate
 * answers `403 x-deny-reason: unsigned` to anything without a viewer-bound
 * signature. A signature means nothing for a public catalogue image, so the
 * asset moved providers rather than gaining protection.
 *
 * What is pinned here:
 *
 *   1. The upload route reaches Cloudinary and returns a `cloudinary:` key. The
 *      R2 presign route is refused rather than left to mint unreadable objects.
 *   2. The size rules are unchanged — Content-Length required, 10 MB ceiling,
 *      re-checked while reading rather than trusted from the header.
 *   3. Replacing an image deletes the previous asset in whichever provider
 *      holds it, and never touches anything outside this course's own namespace
 *      — `hls/<paidVideoId>/…` must survive.
 *   4. The write path accepts a Cloudinary key and still refuses a key that
 *      would point a public image at protected video.
 */

const COURSE_ID = 'crs_abc123';
const CLOUD_KEY = `cloudinary:courses/${COURSE_ID}/22222222-2222-2222-2222-222222222222.png`;
const LEGACY_R2_KEY = `thumbnails/courses/${COURSE_ID}/11111111-1111-1111-1111-111111111111.jpg`;
const OTHER_COURSE_CLOUD_KEY =
  'cloudinary:courses/crs_other/33333333-3333-3333-3333-333333333333.png';

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

const STORAGE_CONFIG = {
  accountId: 'acct-test',
  accessKeyId: 'key',
  secretAccessKey: 'secret',
  region: 'auto',
  endpoint: 'https://acct-test.r2.cloudflarestorage.com',
  forcePathStyle: true,
  buckets: { media: 'edu-media-test', uploads: 'edu-uploads-test', library: 'edu-lib-test' },
  cdnBaseUrl: 'https://media-gate.example/',
  signingKey: 'x'.repeat(32),
  localOrigin: false,
};

// ---------------------------------------------------------------------------
// The upload route
// ---------------------------------------------------------------------------

function buildController() {
  const cloudinary = cloudinaryDouble();
  const config = { getOrThrow: () => STORAGE_CONFIG } as never;
  const storage = new StorageService(config, cloudinary);
  return { controller: new StorageController(storage, cloudinary), cloudinary };
}

/** A request carrying `bytes` of body, as the controller sees one. */
function request(bytes: number, body = 'x') {
  const stream = Readable.from([Buffer.from(body.repeat(bytes))]);
  return Object.assign(stream, { headers: { 'content-length': String(bytes) } }) as never;
}

describe('POST /storage/uploads/course-thumbnail/content', () => {
  it('stores the image in Cloudinary and returns its key', async () => {
    const { controller, cloudinary } = buildController();

    const result = await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/png' },
      request(4),
    );

    expect(cloudinary.uploadCourseThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: COURSE_ID, contentType: 'image/png' }),
    );
    // The dashboard registers exactly this as Course.thumbnailKey. The exact
    // UUID is minted per upload, so the shape is what matters.
    expect(result.objectKey).toMatch(
      new RegExp(`^cloudinary:courses/${COURSE_ID}/[0-9a-f-]{36}$`),
    );
    expect(result.url).toContain('res.cloudinary.com');
  });

  it('never writes to R2', async () => {
    const { controller, cloudinary } = buildController();
    const putStream = jest.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (controller as any).storage.putStream = putStream;

    await controller.courseThumbnailContent(
      { courseId: COURSE_ID, contentType: 'image/png' },
      request(4),
    );

    expect(putStream).not.toHaveBeenCalled();
    expect(cloudinary.uploadCourseThumbnail).toHaveBeenCalled();
  });

  it('refuses a request with no Content-Length', async () => {
    const { controller, cloudinary } = buildController();
    const noLength = Readable.from([Buffer.from('x')]);

    await expect(
      controller.courseThumbnailContent(
        { courseId: COURSE_ID, contentType: 'image/png' },
        noLength as never,
      ),
    ).rejects.toThrow();
    expect(cloudinary.uploadCourseThumbnail).not.toHaveBeenCalled();
  });

  it('refuses anything over 10 MB', async () => {
    const { controller, cloudinary } = buildController();

    await expect(
      controller.courseThumbnailContent(
        { courseId: COURSE_ID, contentType: 'image/png' },
        request(10 * 1024 * 1024 + 1),
      ),
    ).rejects.toThrow();
    expect(cloudinary.uploadCourseThumbnail).not.toHaveBeenCalled();
  });

  it('re-reads the cap while reading, trusting the header not at all', async () => {
    // A client may declare 1 KB and send 20 MB. The header is not evidence.
    const { controller, cloudinary } = buildController();
    const liar = Object.assign(Readable.from([Buffer.alloc(2 * 1024 * 1024, 1)]), {
      headers: { 'content-length': '1' },
    });

    await expect(
      controller.courseThumbnailContent(
        { courseId: COURSE_ID, contentType: 'image/png' },
        liar as never,
      ),
    ).rejects.toThrow();
    expect(cloudinary.uploadCourseThumbnail).not.toHaveBeenCalled();
  });
});

describe('the removed R2 presign route', () => {
  it('refuses instead of minting an object the gate will not serve', async () => {
    const { controller } = buildController();

    // A 404 reads as a routing mistake; the object it used to produce is the
    // unreadable file this change exists to stop creating.
    await expect(controller.courseThumbnail()).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Replacing an image
// ---------------------------------------------------------------------------

function buildAdminService(options: { before?: Record<string, unknown> } = {}) {
  const before = {
    id: COURSE_ID,
    title: 'Anatomy',
    shortDescription: '',
    description: '',
    status: 'DRAFT',
    thumbnailKey: CLOUD_KEY,
    universityId: null,
    facultyId: null,
    academicYearId: null,
    departments: [],
    prices: [],
    teachers: [],
    sections: [],
    university: null,
    faculty: null,
    academicYear: null,
    subject: null,
    _count: { enrollments: 0, attachments: 0 },
    sectionCount: 0,
    lessonCount: 0,
    ...options.before,
  };

  const courseUpdate = jest.fn(
    async (args: { data: { thumbnailKey?: string | null } }) => ({
      ...before,
      thumbnailKey:
        args.data.thumbnailKey === undefined ? before.thumbnailKey : args.data.thumbnailKey,
    }),
  );
  const deleteObject = jest.fn(async () => undefined);

  const prisma = {
    course: {
      findFirst: jest.fn(async () => before),
      findUnique: jest.fn(async () => null),
      update: courseUpdate,
      findMany: jest.fn(async () => []),
    },
    faculty: { findFirst: jest.fn(async () => null) },
    department: { findMany: jest.fn(async () => []) },
    courseDepartment: { deleteMany: jest.fn(), createMany: jest.fn() },
  } as Record<string, unknown>;

  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
  );

  const cloudinary = cloudinaryDouble();
  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    { assertCanManageCourse: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
    { publicAssetUrl: jest.fn(async () => null), deleteObject } as never,
    { resolveAcademicStructure: jest.fn(async () => ({ id: 'as_1', kind: 'YEAR' })) } as never,
    cloudinary,
  );

  return { service, cloudinary, deleteObject };
}

describe('replacing a course image', () => {
  it('deletes the previous Cloudinary asset', async () => {
    const { service, cloudinary, deleteObject } = buildAdminService();
    const next = `cloudinary:courses/${COURSE_ID}/44444444-4444-4444-4444-444444444444.png`;

    await service.update(COURSE_ID, { thumbnailKey: next }, ADMIN);

    expect(cloudinary.deleteByKey).toHaveBeenCalledWith(CLOUD_KEY);
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('deletes it when the image is cleared', async () => {
    const { service, cloudinary } = buildAdminService();

    await service.update(COURSE_ID, { thumbnailKey: null }, ADMIN);

    expect(cloudinary.deleteByKey).toHaveBeenCalledWith(CLOUD_KEY);
  });

  it('leaves the asset alone when the image was not mentioned', async () => {
    const { service, cloudinary } = buildAdminService();

    // The regression this guards: renaming a course must not delete the image
    // the row still points at.
    await service.update(COURSE_ID, { title: 'Anatomy II' }, ADMIN);

    expect(cloudinary.deleteByKey).not.toHaveBeenCalled();
  });

  it('leaves the asset alone when the same key is written back', async () => {
    const { service, cloudinary } = buildAdminService();

    await service.update(COURSE_ID, { thumbnailKey: CLOUD_KEY }, ADMIN);

    expect(cloudinary.deleteByKey).not.toHaveBeenCalled();
  });

  it('never deletes another course image', async () => {
    const { service, cloudinary } = buildAdminService({
      before: { thumbnailKey: OTHER_COURSE_CLOUD_KEY },
    });

    await service.update(
      COURSE_ID,
      { thumbnailKey: `cloudinary:courses/${COURSE_ID}/55555555-5555-5555-5555-555555555555` },
      ADMIN,
    );

    expect(cloudinary.deleteByKey).not.toHaveBeenCalled();
  });

  it('never deletes protected video, even named in this course thumbnail field', async () => {
    // A hand-edited or legacy row could name anything. Deleting on trust would
    // destroy paid video and every enrolment pointing at it.
    const { service, cloudinary, deleteObject } = buildAdminService({
      before: { thumbnailKey: 'hls/vid_paid/360p/index.m3u8' },
    });

    await service.update(
      COURSE_ID,
      { thumbnailKey: `cloudinary:courses/${COURSE_ID}/66666666-6666-6666-6666-666666666666` },
      ADMIN,
    );

    expect(cloudinary.deleteByKey).not.toHaveBeenCalled();
    expect(deleteObject).not.toHaveBeenCalled();
  });

  it('still cleans up a legacy R2 row', async () => {
    // Rows written before the move still hold an R2 key, and replacing one must
    // not leak the object.
    const { service, cloudinary, deleteObject } = buildAdminService({
      before: { thumbnailKey: LEGACY_R2_KEY },
    });

    await service.update(
      COURSE_ID,
      { thumbnailKey: `cloudinary:courses/${COURSE_ID}/77777777-7777-7777-7777-777777777777` },
      ADMIN,
    );

    expect(deleteObject).toHaveBeenCalledWith('media', LEGACY_R2_KEY);
    expect(cloudinary.deleteByKey).not.toHaveBeenCalled();
  });

  it('succeeds even when the delete fails', async () => {
    const { service, cloudinary } = buildAdminService();
    (cloudinary.deleteByKey as jest.Mock).mockRejectedValueOnce(new Error('Cloudinary down'));

    // The row has already moved, so a failure here is an orphaned asset, never
    // a lost one — and never worth failing an edit over.
    await expect(
      service.update(
        COURSE_ID,
        { thumbnailKey: `cloudinary:courses/${COURSE_ID}/88888888-8888-8888-8888-888888888888` },
        ADMIN,
      ),
    ).resolves.toBeDefined();
  });

  it('accepts a Cloudinary key on the write path', async () => {
    const { service } = buildAdminService();
    await expect(
      service.update(
        COURSE_ID,
        { thumbnailKey: `cloudinary:courses/${COURSE_ID}/99999999-9999-9999-9999-999999999999` },
        ADMIN,
      ),
    ).resolves.toBeDefined();
  });

  it('still refuses a key that would expose protected video', async () => {
    const { service } = buildAdminService();

    await expect(
      service.update(COURSE_ID, { thumbnailKey: 'hls/vid_paid/360p/index.m3u8' }, ADMIN),
    ).rejects.toThrow();
  });
});
