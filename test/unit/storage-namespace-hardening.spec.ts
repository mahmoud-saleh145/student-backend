import { AttachmentsService } from '../../src/modules/attachments/attachments.service';
import { StorageController } from '../../src/modules/storage/storage.controller';
import { VideosService } from '../../src/modules/videos/videos.service';

/**
 * Object keys are capabilities: whatever key a row holds gets SIGNED for
 * viewers, and whatever namespace a write lands in belongs to some course.
 * These pin the three places that trusted a caller-supplied key or course id.
 */

const TEACHER = { id: 'usr_t', role: 'TEACHER' } as const;

describe('caption tracks', () => {
  function videos() {
    const service = Object.create(VideosService.prototype) as VideosService;
    const upsert = jest.fn(async () => ({ id: 'cap_1' }));
    Object.assign(service, {
      prisma: {
        video: { findFirst: jest.fn(async () => ({ id: 'vid_1', courseId: 'crs_1' })) },
        captionTrack: { updateMany: jest.fn(async () => ({ count: 0 })), upsert },
      },
      access: { assertCanManageCourse: jest.fn(async () => undefined) },
    });
    return { service, upsert };
  }

  it('accepts a key issued for this video', async () => {
    const { service, upsert } = videos();
    await service.addCaption('vid_1', { language: 'en', label: 'English', objectKey: 'captions/vid_1/en.vtt' }, TEACHER);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it.each([
    'library/paid-book.pdf',
    'attachments/crs_other/notes.pdf',
    'captions/vid_OTHER/en.vtt',
    'hls/vid_1/master.m3u8',
  ])('refuses %s, which would be signed for every viewer', async (objectKey) => {
    const { service, upsert } = videos();
    await expect(
      service.addCaption('vid_1', { language: 'en', label: 'English', objectKey }, TEACHER),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('streamed uploads check course ownership before writing', () => {
  function controller(allowed: boolean) {
    const putStream = jest.fn(async () => undefined);
    const assertCourseExistsAndManageable = jest.fn(async () => {
      if (!allowed) throw Object.assign(new Error('FORBIDDEN'), { code: 'FORBIDDEN' });
    });
    const c = new StorageController(
      { putStream, presignUpload: jest.fn(async () => ({ url: 'u', fields: {} })) } as never,
      {} as never,
      { assertCourseExistsAndManageable } as never,
    ) as unknown as {
      attachmentContent(a: unknown, q: unknown, r: unknown): Promise<unknown>;
      coursePartThumbnailContent(a: unknown, q: unknown, r: unknown): Promise<unknown>;
      coursePartThumbnail(a: unknown, d: unknown): Promise<unknown>;
    };
    return { c, putStream, assertCourseExistsAndManageable };
  }
  const req = { headers: { 'content-length': '1024' } };

  it('a teacher who cannot manage the course cannot stream material into its namespace', async () => {
    const { c, putStream } = controller(false);
    await expect(
      c.attachmentContent(TEACHER, { courseId: 'crs_x', filename: 'a.pdf', contentType: 'application/pdf' }, req),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(putStream).not.toHaveBeenCalled();
  });

  it('nor a part thumbnail, streamed or presigned', async () => {
    const { c, putStream } = controller(false);
    const q = { courseId: 'crs_x', partId: 'prt_1', contentType: 'image/jpeg' };
    await expect(c.coursePartThumbnailContent(TEACHER, q, req)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(c.coursePartThumbnail(TEACHER, q)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(putStream).not.toHaveBeenCalled();
  });

  it('checks the course named in the request', async () => {
    const { c, assertCourseExistsAndManageable, putStream } = controller(true);
    await c.attachmentContent(TEACHER, { courseId: 'crs_1', filename: 'a.pdf', contentType: 'application/pdf' }, req);
    expect(assertCourseExistsAndManageable).toHaveBeenCalledWith('usr_t', 'TEACHER', 'crs_1', 'content');
    expect(putStream).toHaveBeenCalledTimes(1);
  });
});

describe('deleting course material', () => {
  function attachments(objectKey: string) {
    const service = Object.create(AttachmentsService.prototype) as AttachmentsService;
    const deleteObject = jest.fn(async () => undefined);
    Object.assign(service, {
      prisma: {
        attachment: {
          findFirst: jest.fn(async () => ({ id: 'att_1', courseId: 'crs_1', objectKey, title: 't' })),
          update: jest.fn(async () => ({})),
        },
      },
      access: { assertCanManageCourse: jest.fn(async () => undefined) },
      storage: { deleteObject },
      audit: { record: jest.fn(async () => undefined) },
    });
    return { service, deleteObject };
  }

  it('removes the bytes from the media bucket, where current uploads live', async () => {
    const { service, deleteObject } = attachments('attachments/crs_1/uuid-notes.pdf');
    await service.remove('att_1', TEACHER);
    expect(deleteObject).toHaveBeenCalledWith('media', 'attachments/crs_1/uuid-notes.pdf');
    // Legacy copies written before the bucket fix are still cleaned up.
    expect(deleteObject).toHaveBeenCalledWith('uploads', 'attachments/crs_1/uuid-notes.pdf');
  });

  it('never deletes from media outside the attachments namespace', async () => {
    const { service, deleteObject } = attachments('hls/vid_1/master.m3u8');
    await service.remove('att_1', TEACHER);
    expect(deleteObject).not.toHaveBeenCalledWith('media', expect.anything());
  });
});
