/**
 * Attaching an existing asset to another lecture (reuse).
 *
 *   * Both courses are authorisation gates: the destination (you may only write
 *     into a course you manage) AND the source (you may only reuse media from a
 *     course you manage - otherwise a teacher could copy another course's paid
 *     video into a course whose enrolment and pricing they control).
 *   * A lecture holds one live video, so attaching onto an occupied lecture is
 *     refused instead of creating an ambiguous double attachment.
 */
import { AppException } from '../../src/common/errors/app.exception';
import { LessonVideoService } from '../../src/modules/videos/lesson-video.service';
import { VideosController } from '../../src/modules/videos/videos.controller';
import { createInMemoryPrisma } from './helpers/in-memory-prisma';

function seed() {
  return {
    lesson: [
      { id: 'lS', courseId: 'cS', durationSeconds: 4317, deletedAt: null },
      { id: 'lD', courseId: 'cD', durationSeconds: 0, deletedAt: null },
      { id: 'lBusy', courseId: 'cD', durationSeconds: 100, deletedAt: null },
    ],
    video: [
      { id: 'vS', courseId: 'cS', lessonId: 'lS', deletedAt: null, durationSeconds: 4317, status: 'READY' },
      { id: 'vB', courseId: 'cD', lessonId: 'lBusy', deletedAt: null, durationSeconds: 100, status: 'READY' },
    ],
    lessonVideo: [
      { lessonId: 'lS', videoId: 'vS', sortOrder: 0, createdAt: new Date('2026-10-01') },
      { lessonId: 'lBusy', videoId: 'vB', sortOrder: 0, createdAt: new Date('2026-10-01') },
    ],
  };
}

describe('VideosController.attachExisting authorisation', () => {
  function controllerFor(manages: string[]) {
    const assertCanManageCourseContent = jest.fn(async (_u: string, _r: string, courseId: string) => {
      if (!manages.includes(courseId)) throw new AppException('NOT_COURSE_TEACHER' as never);
    });
    const videos = {
      getCourseForLesson: jest.fn(async (id: string) => ({ id, courseId: 'cD', title: 'x' })),
      getCourseForVideo: jest.fn(async (id: string) => ({ id, courseId: 'cS' })),
      assertCanManageCourseContent,
    };
    const lessonVideos = { attach: jest.fn(async () => ({ created: true, video: {} })) };
    const controller = new VideosController(videos as never, {} as never, {} as never, lessonVideos as never);
    return { controller, lessonVideos, assertCanManageCourseContent };
  }
  const actor = { id: 'tch_1', role: 'TEACHER' } as never;

  it('refuses a teacher of the destination who does not manage the SOURCE course', async () => {
    const { controller, lessonVideos } = controllerFor(['cD']);
    await expect(controller.attachExisting('lD', { videoId: 'vS' }, actor)).rejects.toBeInstanceOf(AppException);
    expect(lessonVideos.attach).not.toHaveBeenCalled();
  });

  it('refuses a teacher of the source who does not manage the DESTINATION course', async () => {
    const { controller, lessonVideos } = controllerFor(['cS']);
    await expect(controller.attachExisting('lD', { videoId: 'vS' }, actor)).rejects.toBeInstanceOf(AppException);
    expect(lessonVideos.attach).not.toHaveBeenCalled();
  });

  it('allows staff who manage both courses, checking each course exactly', async () => {
    const { controller, lessonVideos, assertCanManageCourseContent } = controllerFor(['cS', 'cD']);
    await controller.attachExisting('lD', { videoId: 'vS' }, actor);
    expect(assertCanManageCourseContent.mock.calls.map((c) => c[2]).sort()).toEqual(['cD', 'cS']);
    expect(lessonVideos.attach).toHaveBeenCalledWith({ lessonId: 'lD', videoId: 'vS', actorId: 'tch_1' });
  });
});

describe('LessonVideoService.attach', () => {
  function service() {
    const db = createInMemoryPrisma(seed());
    const courses = { recountCourse: jest.fn(async (_c: string) => undefined) };
    return { db, svc: new LessonVideoService(db.prisma as never, courses as never) };
  }

  it('attaches to an empty lecture without creating any video row', async () => {
    const { db, svc } = service();
    const res = await svc.attach({ lessonId: 'lD', videoId: 'vS', actorId: 'adm' });
    expect(res.created).toBe(true);
    expect(db.tables.video).toHaveLength(2);
    expect(db.tables.lessonVideo.map((l) => `${l.lessonId}:${l.videoId}`).sort()).toEqual([
      'lBusy:vB',
      'lD:vS',
      'lS:vS',
    ]);
  });

  it('refuses a lecture that already has a different live video', async () => {
    const { db, svc } = service();
    await expect(svc.attach({ lessonId: 'lBusy', videoId: 'vS', actorId: 'adm' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    expect(db.tables.lessonVideo).toHaveLength(2);
  });

  it('is idempotent for the same mapping', async () => {
    const { db, svc } = service();
    await svc.attach({ lessonId: 'lD', videoId: 'vS', actorId: 'adm' });
    const again = await svc.attach({ lessonId: 'lD', videoId: 'vS', actorId: 'adm' });
    expect(again.created).toBe(false);
    expect(db.tables.lessonVideo).toHaveLength(3);
  });
});
