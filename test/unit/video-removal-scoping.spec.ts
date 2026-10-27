/**
 * Fix 1 - removing a video must be scoped to THIS video and THIS lecture.
 *
 * Two production-grade defects in the previous VideosService.remove():
 *
 *   1. For an unshared video it ran
 *        lessonVideo.findMany({ where: { videoId: undefined } })
 *      Prisma ignores `undefined`, so that is "every attachment on the
 *      platform", and the next statement zeroed `durationSeconds` on every
 *      lecture that had a video - in every course.
 *
 *   2. For a shared video it always detached `video.lessonId` (the uploading
 *      lecture). "Remove from this lecture" clicked in a DESTINATION course
 *      therefore stripped the SOURCE course instead, and authorisation was
 *      checked against the source course rather than the course being edited.
 *
 * These tests run against an in-memory Prisma that evaluates `where` with
 * Prisma's own undefined semantics, and they assert the exact query arguments.
 */
import { AppException } from '../../src/common/errors/app.exception';
import { LessonVideoService } from '../../src/modules/videos/lesson-video.service';
import { VideosService } from '../../src/modules/videos/videos.service';
import { createInMemoryPrisma, type Seed } from './helpers/in-memory-prisma';

type Row = Record<string, unknown>;

const ADMIN = { id: 'adm_1', role: 'ADMIN' } as never;

function teacherOf(...courseIds: string[]) {
  return { id: `tch_${courseIds.join('_')}`, role: 'TEACHER', courses: new Set(courseIds) };
}

function lesson(id: string, courseId: string, durationSeconds: number, extra: Row = {}): Row {
  return { id, courseId, durationSeconds, deletedAt: null, status: 'PUBLISHED', ...extra };
}

function video(id: string, courseId: string, lessonId: string | null, extra: Row = {}): Row {
  return {
    id,
    courseId,
    lessonId,
    status: 'READY',
    deletedAt: null,
    durationSeconds: 4317,
    hlsPrefix: `hls/${id}/`,
    sourceKey: `source/${id}/file.mp4`,
    processingJobId: null,
    ...extra,
  };
}

/**
 * cS owns the shared asset vS (origin lS), reused by lD1 (cD1) and lD2 (cD2).
 * cN owns an unshared asset vN on lN. cX/cU are unrelated courses whose
 * lecture durations must never change.
 */
function seed(overrides: Partial<Seed> = {}): Seed {
  return {
    lesson: [
      lesson('lS', 'cS', 4317),
      lesson('lD1', 'cD1', 4317),
      lesson('lD2', 'cD2', 4317),
      lesson('lN', 'cN', 2849),
      lesson('lX', 'cX', 3909),
      lesson('lU', 'cU', 2913),
    ],
    video: [
      video('vS', 'cS', 'lS'),
      video('vN', 'cN', 'lN', { durationSeconds: 2849 }),
      video('vX', 'cX', 'lX', { durationSeconds: 3909 }),
      video('vU', 'cU', 'lU', { durationSeconds: 2913 }),
    ],
    lessonVideo: [
      { lessonId: 'lS', videoId: 'vS' },
      { lessonId: 'lD1', videoId: 'vS' },
      { lessonId: 'lD2', videoId: 'vS' },
      { lessonId: 'lN', videoId: 'vN' },
      { lessonId: 'lX', videoId: 'vX' },
      { lessonId: 'lU', videoId: 'vU' },
    ],
    playbackTicket: [
      { id: 't_S', videoId: 'vS', lessonId: 'lS', status: 'ACTIVE' },
      { id: 't_D1', videoId: 'vS', lessonId: 'lD1', status: 'ACTIVE' },
      { id: 't_D2', videoId: 'vS', lessonId: 'lD2', status: 'ACTIVE' },
      { id: 't_N', videoId: 'vN', lessonId: 'lN', status: 'ACTIVE' },
      { id: 't_X', videoId: 'vX', lessonId: 'lX', status: 'ACTIVE' },
    ],
    ...overrides,
  };
}

function harness(s: Seed = seed()) {
  const db = createInMemoryPrisma(s);

  const access = {
    assertCanManageCourse: jest.fn(async (_u: string, role: string, courseId: string) => {
      if (role === 'ADMIN' || role === 'MASTER') return;
      const actor = currentActor as unknown as { courses: Set<string> };
      if (!actor.courses?.has(courseId)) {
        throw new AppException('NOT_COURSE_TEACHER' as never, { message: `not a teacher of ${courseId}` });
      }
    }),
    assertTeacherCapability: jest.fn(async () => undefined),
  };
  let currentActor: unknown = ADMIN;

  const storage = {
    deletePrefix: jest.fn(async () => undefined),
    deleteObject: jest.fn(async () => undefined),
  };
  const courses = { recountCourse: jest.fn(async (_courseId: string) => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const queue = { getJob: jest.fn(async () => null) };

  const service = new VideosService(
    db.prisma as never,
    storage as never,
    access as never,
    courses as never,
    {} as never,
    audit as never,
    { getJson: jest.fn(async () => null) } as never,
    queue as never,
    { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: {} }, ladder: [720] }) } as never,
    // The real attachment service over the same in-memory tables, so attachment
    // counts come from the data rather than from a canned number.
    new LessonVideoService(db.prisma as never, courses as never),
    // gumletIngest: only the recovery sweep reads this; these tests never sweep.
    {} as never,
  );

  const as = (actor: unknown) => {
    currentActor = actor;
    return actor as never;
  };

  const duration = (id: string) => db.tables.lesson.find((l) => l.id === id)?.durationSeconds;
  const links = () => db.tables.lessonVideo.map((l) => `${l.lessonId}:${l.videoId}`).sort();
  const ticket = (id: string) => db.tables.playbackTicket.find((t) => t.id === id)?.status;
  const row = (id: string) => db.tables.video.find((v) => v.id === id) as Row;
  const lessonUpdateManyCalls = () =>
    db.calls.filter((c) => c.model === 'lesson' && c.op === 'updateMany').map((c) => c.args);

  return { service, db, access, storage, courses, as, duration, links, ticket, row, lessonUpdateManyCalls };
}

/** No query against lesson_videos may ever be unscoped. */
function expectEveryAttachmentQueryScoped(db: ReturnType<typeof createInMemoryPrisma>) {
  for (const call of db.calls.filter((c) => c.model === 'lessonVideo')) {
    const where = (call.args.where ?? {}) as Row;
    const scoped =
      (typeof where.videoId === 'string' && where.videoId.length > 0) ||
      (typeof where.lessonId === 'string' && where.lessonId.length > 0) ||
      (where.lessonId && typeof where.lessonId === 'object' && Array.isArray((where.lessonId as Row).in));
    expect({ op: call.op, where, scoped }).toEqual(expect.objectContaining({ scoped: true }));
  }
}

describe('the fake honours Prisma undefined semantics (so it can catch the old bug)', () => {
  it('an undefined videoId filter returns EVERY attachment, exactly as Prisma does', async () => {
    const { db } = harness();
    const rows = await db.prisma.lessonVideo.findMany({ where: { videoId: undefined } });
    expect(rows).toHaveLength(6);
  });
});

describe('removing an UNSHARED video', () => {
  it('archives only that video and zeroes only its own lecture - no other course is touched', async () => {
    const h = harness();

    const result = await h.service.remove('vN', h.as(ADMIN));

    expect(result).toEqual({ ok: true, detached: false, remainingAttachments: 0 });
    expect(h.row('vN')).toMatchObject({ status: 'ARCHIVED', deletedAt: expect.any(Date) });
    expect(h.duration('lN')).toBe(0);
    // Every unrelated lecture keeps its duration.
    expect([h.duration('lS'), h.duration('lD1'), h.duration('lD2'), h.duration('lX'), h.duration('lU')]).toEqual([
      4317, 4317, 4317, 3909, 2913,
    ]);
    // Exact write: one lecture, by id.
    expect(h.lessonUpdateManyCalls()).toEqual([{ where: { id: { in: ['lN'] } }, data: { durationSeconds: 0 } }]);
    // Only this video's tickets are revoked.
    expect(h.ticket('t_N')).toBe('REVOKED');
    expect(h.ticket('t_X')).toBe('ACTIVE');
    expect(h.ticket('t_S')).toBe('ACTIVE');
    expect(h.storage.deletePrefix).toHaveBeenCalledWith('media', 'hls/vN/');
    expect(h.storage.deleteObject).toHaveBeenCalledWith('uploads', 'source/vN/file.mp4');
    // The WHOLE source prefix, not just the key the row points at. Every
    // upload attempt mints a fresh key, so a video uploaded more than once has
    // source objects under this prefix that no row references. Deleting only
    // the current one left those behind: unreachable bytes that still cost
    // money on a bucket meant to hold nothing but live material.
    expect(h.storage.deletePrefix).toHaveBeenCalledWith('uploads', 'source/videos/vN/');
    expectEveryAttachmentQueryScoped(h.db);
  });

  it('ROOT CAUSE: never rewrites the duration of a lecture in another course', async () => {
    const h = harness();
    await h.service.remove('vN', h.as(ADMIN));
    const durations = Object.fromEntries(h.db.tables.lesson.map((l) => [l.id, l.durationSeconds]));
    expect(durations).toEqual({ lS: 4317, lD1: 4317, lD2: 4317, lN: 0, lX: 3909, lU: 2913 });
  });

  it('recounts only the owning course', async () => {
    const h = harness();
    await h.service.remove('vN', h.as(ADMIN));
    expect(h.courses.recountCourse.mock.calls.map((c) => c[0])).toEqual(['cN']);
  });

  it('accepts an explicit lessonId that matches its only lecture', async () => {
    const h = harness();
    await h.service.remove('vN', h.as(ADMIN), true, 'lN');
    expect(h.row('vN').status).toBe('ARCHIVED');
  });
});

describe('removing a SHARED video', () => {
  it('without naming a lecture is refused, and nothing is written', async () => {
    const h = harness();
    await expect(h.service.remove('vS', h.as(ADMIN))).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(h.links()).toContain('lS:vS');
    expect(h.db.calls.filter((c) => ['update', 'updateMany', 'deleteMany'].includes(c.op))).toEqual([]);
  });

  it('from a DESTINATION lecture detaches only that lecture; origin and other destination keep playing', async () => {
    const h = harness();

    const result = await h.service.remove('vS', h.as(ADMIN), true, 'lD1');

    expect(result).toEqual({ ok: true, detached: true, remainingAttachments: 2 });
    expect(h.links()).toEqual(['lD2:vS', 'lN:vN', 'lS:vS', 'lU:vU', 'lX:vX']);
    // Asset intact: not archived, origin pointer unchanged, bytes kept.
    expect(h.row('vS')).toMatchObject({ status: 'READY', deletedAt: null, lessonId: 'lS' });
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
    expect(h.storage.deleteObject).not.toHaveBeenCalled();
    // Only the detached lecture loses its duration and its live tickets.
    expect([h.duration('lD1'), h.duration('lS'), h.duration('lD2')]).toEqual([0, 4317, 4317]);
    expect([h.ticket('t_D1'), h.ticket('t_S'), h.ticket('t_D2')]).toEqual(['REVOKED', 'ACTIVE', 'ACTIVE']);
    // Exact query shapes.
    expect(h.db.calls.find((c) => c.model === 'lessonVideo' && c.op === 'deleteMany')?.args).toEqual({
      where: { lessonId: 'lD1', videoId: 'vS' },
    });
    expect(h.db.calls.find((c) => c.model === 'playbackTicket' && c.op === 'updateMany')?.args.where).toEqual({
      videoId: 'vS',
      lessonId: 'lD1',
      status: 'ACTIVE',
    });
    expect(h.lessonUpdateManyCalls()).toEqual([{ where: { id: { in: ['lD1'] } }, data: { durationSeconds: 0 } }]);
    expect(h.courses.recountCourse.mock.calls.map((c) => c[0])).toEqual(['cD1']);
    expectEveryAttachmentQueryScoped(h.db);
  });

  it('from the ORIGIN lecture detaches it and releases the origin pointer; both destinations keep playing', async () => {
    const h = harness();

    await h.service.remove('vS', h.as(ADMIN), true, 'lS');

    expect(h.links()).toEqual(['lD1:vS', 'lD2:vS', 'lN:vN', 'lU:vU', 'lX:vX']);
    expect(h.row('vS')).toMatchObject({ status: 'READY', deletedAt: null, lessonId: null });
    expect([h.duration('lS'), h.duration('lD1'), h.duration('lD2')]).toEqual([0, 4317, 4317]);
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
  });

  it('naming a lecture the video is not attached to is refused', async () => {
    const h = harness();
    await expect(h.service.remove('vS', h.as(ADMIN), true, 'lX')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(h.links()).toHaveLength(6);
  });

  it('archives the asset only when the named lecture is its last LIVE lecture', async () => {
    const h = harness(
      seed({
        lesson: [
          lesson('lS', 'cS', 4317, { deletedAt: new Date('2026-10-01') }),
          lesson('lD1', 'cD1', 4317),
          lesson('lD2', 'cD2', 4317, { deletedAt: new Date('2026-10-01') }),
          lesson('lX', 'cX', 3909),
        ],
      }),
    );

    await h.service.remove('vS', h.as(ADMIN), true, 'lD1');

    expect(h.row('vS')).toMatchObject({ status: 'ARCHIVED' });
    expect(h.duration('lX')).toBe(3909);
    expect(h.storage.deletePrefix).toHaveBeenCalledWith('media', 'hls/vS/');
  });
});

describe('authorisation is checked against the course being edited', () => {
  it('a teacher of the destination course can remove it from their own lecture', async () => {
    const h = harness();
    await h.service.remove('vS', h.as(teacherOf('cD1')), true, 'lD1');
    expect(h.access.assertCanManageCourse).toHaveBeenCalledWith(expect.any(String), 'TEACHER', 'cD1', 'content');
    expect(h.access.assertCanManageCourse).not.toHaveBeenCalledWith(expect.any(String), 'TEACHER', 'cS', 'content');
    expect(h.links()).not.toContain('lD1:vS');
  });

  it('a teacher of one destination cannot remove it from ANOTHER course', async () => {
    const h = harness();
    await expect(h.service.remove('vS', h.as(teacherOf('cD1')), true, 'lD2')).rejects.toBeInstanceOf(AppException);
    expect(h.links()).toContain('lD2:vS');
  });

  it('a source-course teacher cannot remove it from a destination course by naming that lecture', async () => {
    const h = harness();
    await expect(h.service.remove('vS', h.as(teacherOf('cS')), true, 'lD1')).rejects.toBeInstanceOf(AppException);
    expect(h.links()).toContain('lD1:vS');
  });

  it('archiving another course\'s asset (last live lecture is a destination) also needs the source course', async () => {
    const s = seed({
      lesson: [lesson('lS', 'cS', 4317, { deletedAt: new Date('2026-10-01') }), lesson('lD1', 'cD1', 4317)],
      lessonVideo: [
        { lessonId: 'lS', videoId: 'vS' },
        { lessonId: 'lD1', videoId: 'vS' },
      ],
    });
    const h = harness(s);
    await expect(h.service.remove('vS', h.as(teacherOf('cD1')), true, 'lD1')).rejects.toBeInstanceOf(AppException);
    expect(h.row('vS').status).toBe('READY');
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
  });
});

describe('duration clean-up never blanks a lecture that still has another video', () => {
  it('skips a lecture that keeps a different live video', async () => {
    const s = seed();
    // lD1 also carries vX (pre-existing double attachment).
    (s.lessonVideo as Row[]).push({ lessonId: 'lD1', videoId: 'vX' });
    const h = harness(s);

    await h.service.remove('vS', h.as(ADMIN), true, 'lD1');

    expect(h.duration('lD1')).toBe(4317);
    expect(h.lessonUpdateManyCalls()).toEqual([]);
  });
});

describe('the dedicated detach route (VideosService.detach)', () => {
  it('detaches without ever archiving, even for the last live lecture', async () => {
    const h = harness();
    const result = await h.service.detach('vN', 'lN', h.as(ADMIN));
    expect(result).toEqual({ ok: true, detached: true, remainingAttachments: 0 });
    expect(h.row('vN')).toMatchObject({ status: 'READY', deletedAt: null, lessonId: null });
    expect(h.storage.deletePrefix).not.toHaveBeenCalled();
    expect(h.duration('lN')).toBe(0);
    expect(h.ticket('t_N')).toBe('REVOKED');
  });

  it('is authorised against the lecture\'s course', async () => {
    const h = harness();
    await expect(h.service.detach('vS', 'lD2', h.as(teacherOf('cD1')))).rejects.toBeInstanceOf(AppException);
    await h.service.detach('vS', 'lD1', h.as(teacherOf('cD1')));
    expect(h.links()).toEqual(['lD2:vS', 'lN:vN', 'lS:vS', 'lU:vU', 'lX:vX']);
  });
});

/**
 * THE STRANDED UPLOAD
 * -------------------
 * Nine production videos sit in UPLOADING: `initUpload` minted the key and the
 * row, the presigned PUT never landed, so `processingJobId` and `gumletAssetId`
 * are NULL and neither bucket holds an object for them. Deleting such a video
 * must work - and it must not turn "there is nothing to delete" into an error,
 * nor ask a provider about an asset that was never registered.
 *
 * `gumletIngest` is `{}` in this harness on purpose: any call into it would be
 * a TypeError, so a green test is the proof that no provider request was made.
 */
describe('removing a video whose upload never landed (no asset, no stored bytes)', () => {
  it('archives the row, revokes its grant and purges prefixes without needing an object', async () => {
    const h = harness(
      seed({
        lesson: [lesson('lU', 'cU', 2913)],
        video: [
          video('vStranded', 'cU', 'lU', {
            status: 'UPLOADING',
            hlsPrefix: null, // no HLS output was ever produced
            processingJobId: null, // nothing is queued
            gumletAssetId: null, // the provider asset was never created
            durationSeconds: 0,
          }),
        ],
        lessonVideo: [{ lessonId: 'lU', videoId: 'vStranded' }],
        playbackTicket: [{ id: 't_U', videoId: 'vStranded', lessonId: 'lU', status: 'ACTIVE' }],
      }),
    );

    const result = await h.service.remove('vStranded', h.as(ADMIN));

    expect(result).toEqual({ ok: true, detached: false, remainingAttachments: 0 });
    expect(h.row('vStranded')).toMatchObject({
      status: 'ARCHIVED',
      deletedAt: expect.any(Date),
      gumletAssetId: null, // archived, never invented
    });
    // The link row is retained next to the soft-deleted video; every read
    // filters `video: { deletedAt: null }`, so the lecture simply sees no
    // video any more.
    expect(h.links()).toEqual(['lU:vStranded']);
    expect(h.duration('lU')).toBe(0);
    expect(h.ticket('t_U')).toBe('REVOKED');

    // Nothing to delete is not a failure. No HLS prefix exists, so the media
    // prefix is never listed; the source key is still named (the object simply
    // is not in the bucket) and the whole upload prefix is swept.
    expect(h.storage.deletePrefix).toHaveBeenCalledTimes(1);
    expect(h.storage.deletePrefix).toHaveBeenCalledWith('uploads', 'source/videos/vStranded/');
    expect(h.storage.deletePrefix).not.toHaveBeenCalledWith('media', expect.anything());
    expect(h.storage.deleteObject).toHaveBeenCalledWith('uploads', 'source/vStranded/file.mp4');
    expectEveryAttachmentQueryScoped(h.db);
  });

  it('never asks the provider to delete an asset that was never registered', async () => {
    const h = harness(
      seed({
        lesson: [lesson('lU', 'cU', 2913)],
        video: [
          video('vStranded', 'cU', 'lU', {
            status: 'UPLOADING',
            hlsPrefix: null,
            processingJobId: null,
            gumletAssetId: null,
            durationSeconds: 0,
          }),
        ],
        lessonVideo: [{ lessonId: 'lU', videoId: 'vStranded' }],
        playbackTicket: [],
      }),
    );

    // gumletIngest is `{}` here: this resolves only if nothing is called on it.
    await expect(h.service.remove('vStranded', h.as(ADMIN))).resolves.toMatchObject({ ok: true });
  });
});
