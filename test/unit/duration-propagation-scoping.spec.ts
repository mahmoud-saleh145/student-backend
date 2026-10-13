/**
 * Fix 4 - a video's duration reaches exactly the lectures that play it, and
 * exactly those courses' totals are recounted.
 *
 * Production evidence (2026-10-13 read-only audit): four DESTINATION courses
 * of the two shared videos had totalDurationSeconds = 0 while their lectures
 * carried 4317 s / 4779 s. Course totals are SUM(published lecture durations),
 * so any path that writes a lecture duration must recount that lecture's
 * course - not only the uploading course. The legacy markReady() path did not.
 */
import { LessonVideoService } from '../../src/modules/videos/lesson-video.service';
import { VideosService } from '../../src/modules/videos/videos.service';
import { createInMemoryPrisma, type Seed } from './helpers/in-memory-prisma';

function seed(): Seed {
  return {
    lesson: [
      { id: 'lS', courseId: 'cS', durationSeconds: 0, deletedAt: null, title: 'Source' },
      { id: 'lD1', courseId: 'cD1', durationSeconds: 0, deletedAt: null, title: 'Dest 1' },
      { id: 'lD2', courseId: 'cD2', durationSeconds: 0, deletedAt: null, title: 'Dest 2' },
      { id: 'lX', courseId: 'cX', durationSeconds: 3909, deletedAt: null, title: 'Unrelated' },
    ],
    video: [
      { id: 'vS', courseId: 'cS', lessonId: 'lS', durationSeconds: 0, deletedAt: null, status: 'PROCESSING' },
      { id: 'vX', courseId: 'cX', lessonId: 'lX', durationSeconds: 3909, deletedAt: null, status: 'READY' },
    ],
    lessonVideo: [
      { lessonId: 'lS', videoId: 'vS' },
      { lessonId: 'lD1', videoId: 'vS' },
      { lessonId: 'lD2', videoId: 'vS' },
      { lessonId: 'lX', videoId: 'vX' },
    ],
  };
}

const durations = (db: ReturnType<typeof createInMemoryPrisma>) =>
  Object.fromEntries(db.tables.lesson.map((l) => [l.id, l.durationSeconds]));

describe('Gumlet path: LessonVideoService.propagateDurationToAttachedLessons', () => {
  function build() {
    const db = createInMemoryPrisma(seed());
    const courses = { recountCourse: jest.fn(async (_c: string) => undefined) };
    return { db, courses, svc: new LessonVideoService(db.prisma as never, courses as never) };
  }

  it('writes the duration to the source and every destination lecture, and to nothing else', async () => {
    const { db, svc } = build();
    expect(await svc.propagateDurationToAttachedLessons('vS', 4317)).toBe(3);
    expect(durations(db)).toEqual({ lS: 4317, lD1: 4317, lD2: 4317, lX: 3909 });
  });

  it('recounts the source course and every destination course', async () => {
    const { svc, courses } = build();
    await svc.propagateDurationToAttachedLessons('vS', 4317);
    expect(courses.recountCourse.mock.calls.map((c) => c[0]).sort()).toEqual(['cD1', 'cD2', 'cS']);
  });

  it.each([0, -5, Number.NaN])('never writes a fabricated duration (%p)', async (bad) => {
    const { db, svc, courses } = build();
    expect(await svc.propagateDurationToAttachedLessons('vS', bad)).toBe(0);
    expect(durations(db)).toEqual({ lS: 0, lD1: 0, lD2: 0, lX: 3909 });
    expect(courses.recountCourse).not.toHaveBeenCalled();
  });
});

describe('legacy path: VideosService.markReady', () => {
  it('recounts every course whose lecture received the duration, destinations included', async () => {
    const db = createInMemoryPrisma(seed());
    const courses = { recountCourse: jest.fn(async (_c: string) => undefined) };
    const svc = new VideosService(
      db.prisma as never,
      {} as never,
      {} as never,
      courses as never,
      { notifyCourseStudents: jest.fn(async () => undefined) } as never,
      { record: jest.fn() } as never,
      {} as never,
      {} as never,
      { getOrThrow: () => ({ drm: { enabled: false }, ladder: [720] }) } as never,
      {} as never,
    );

    await svc.markReady('vS', {
      durationSeconds: 4317,
      width: 1280,
      height: 720,
      frameRate: 30,
      hlsPrefix: 'hls/vS/',
      masterPlaylistKey: 'hls/vS/master.m3u8',
      isEncrypted: true,
      renditions: [],
    } as never);

    expect(durations(db)).toEqual({ lS: 4317, lD1: 4317, lD2: 4317, lX: 3909 });
    expect(courses.recountCourse.mock.calls.map((c) => c[0]).sort()).toEqual(['cD1', 'cD2', 'cS']);
  });
});
