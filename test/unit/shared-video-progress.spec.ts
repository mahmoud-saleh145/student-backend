/**
 * F1 - progress and completion for a SHARED video, per lecture.
 *
 * A video uploaded to one lecture (the owner, `Lesson.video`) can be attached
 * to lectures in other courses through `videoLinks`. Progress used to credit
 * watch time only through `Lesson.video`, which is null for every destination
 * lecture: the student's real viewing was never found, the resume position was
 * capped at the 120 s tolerance, and the lecture could never complete. Watch
 * time was also summed across ALL lectures of the video, so - once a
 * destination lecture could see the video at all - watching it in one course
 * would have credited the other course too.
 *
 * Real ProgressService.upsert and real LessonsService.markComplete over one
 * in-memory store. The store applies every `where` key the services pass (as
 * Postgres would), so a query that is not scoped to the lecture really does
 * read another lecture's tickets here.
 */
import { LessonsService } from '../../src/modules/lessons/lessons.service';
import { ProgressService } from '../../src/modules/progress/progress.service';

type Row = Record<string, unknown>;

const VIDEO = { id: 'vid_1', durationSeconds: 600, status: 'READY', deletedAt: null };

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => row[k] === v);
}

function world(opts: { rule?: Row; ownerHasBackfilledLink?: boolean } = {}) {
  const course = (id: string) => ({
    id,
    status: 'PUBLISHED',
    completionRuleType: 'WATCH_PERCENT',
    completionThreshold: 90,
    completionRequireContiguous: false,
    ...opts.rule,
  });
  const base = {
    status: 'PUBLISHED',
    isPreview: true,
    deletedAt: null,
    // 0 = "use the video's duration" - the fallback a destination lecture needs.
    durationSeconds: 0,
    completionRuleType: null,
    completionThreshold: null,
    completionRequireContiguous: null,
  };
  const lessons: Record<string, Row> = {
    // The uploading lecture: owns the video (legacy relation). Rows created
    // since the shared-video migration also have their own link backfilled.
    les_src: {
      ...base, id: 'les_src', courseId: 'crs_src', course: course('crs_src'),
      video: { ...VIDEO },
      videoLinks: opts.ownerHasBackfilledLink === false ? [] : [{ video: { ...VIDEO } }],
    },
    // A lecture in another course that ATTACHES the same video.
    les_dst: {
      ...base, id: 'les_dst', courseId: 'crs_dst', course: course('crs_dst'),
      video: null,
      videoLinks: [{ video: { ...VIDEO } }],
    },
  };

  const tickets: Row[] = [];
  const progress = new Map<string, Row>();
  const events: Row[] = [];
  const enrollmentUpdates: Row[] = [];

  const watchProgress = {
    findUnique: jest.fn(async (a: { where: { userId_lessonId: { userId: string; lessonId: string } } }) =>
      progress.get(`${a.where.userId_lessonId.userId}:${a.where.userId_lessonId.lessonId}`) ?? null),
    upsert: jest.fn(async (a: { where: { userId_lessonId: { userId: string; lessonId: string } }; create: Row; update: Row }) => {
      const key = `${a.where.userId_lessonId.userId}:${a.where.userId_lessonId.lessonId}`;
      const existing = progress.get(key);
      const defined = Object.fromEntries(Object.entries(a.update).filter(([, v]) => v !== undefined));
      const row = existing ? { ...existing, ...defined } : { ...a.create };
      progress.set(key, row);
      return row;
    }),
    count: jest.fn(async (a: { where: Row }) => [...progress.values()].filter((r) => matches(r, a.where)).length),
  };
  const tx = {
    watchProgress,
    enrollment: { updateMany: jest.fn(async (a: Row) => { enrollmentUpdates.push(a); return { count: 1 }; }) },
    watchEvent: { create: jest.fn(async (a: { data: Row }) => { events.push(a.data); return {}; }) },
  };
  const prisma = {
    lesson: { findFirst: jest.fn(async (a: { where: { id: string } }) => lessons[a.where.id] ?? null) },
    playbackTicket: {
      findMany: jest.fn(async (a: { where: Row }) => tickets.filter((t) => matches(t, a.where))),
    },
    watchProgress,
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const access = { assertContentAccess: jest.fn(async () => undefined) };

  const progressSvc = new ProgressService(prisma as never, access as never, {} as never);
  const lessonsSvc = new LessonsService(prisma as never, access as never, {} as never, {} as never);

  return {
    tickets,
    events,
    enrollmentUpdates,
    progressOf: (lessonId: string) => progress.get(`usr_1:${lessonId}`) ?? null,
    /** A heartbeat-fed ticket, exactly as PlaybackService records it: for the lecture it was issued in. */
    watched: (lessonId: string, watchedSeconds: number, lastPositionSeconds: number) =>
      tickets.push({ userId: 'usr_1', videoId: 'vid_1', lessonId, watchedSeconds, lastPositionSeconds }),
    report: (lessonId: string, positionSeconds: number, watchedSeconds: number) =>
      progressSvc.upsert({ userId: 'usr_1', role: 'STUDENT' as never, input: { lessonId, positionSeconds, watchedSeconds } }),
    complete: (lessonId: string) => lessonsSvc.markComplete(lessonId, 'usr_1', 'STUDENT' as never),
  };
}

describe.each([
  ['the OWNING lecture (legacy Lesson.video)', 'les_src', 'crs_src'],
  ['a DESTINATION lecture (videoLinks only, Lesson.video = null)', 'les_dst', 'crs_dst'],
])('%s', (_label, lessonId, courseId) => {
  it('credits real watch time and the resume position, from the video duration', async () => {
    const w = world();
    w.watched(lessonId, 300, 300);
    await w.report(lessonId, 300, 300);
    expect(w.progressOf(lessonId)).toMatchObject({
      courseId, positionSeconds: 300, watchedSeconds: 300, durationSeconds: 600, percent: 50, completed: false,
    });
  });

  it('accumulates across reports without counting the same viewing twice', async () => {
    const w = world();
    w.watched(lessonId, 200, 200);
    await w.report(lessonId, 200, 200);
    // A retried / duplicated report of the same window earns nothing more.
    await w.report(lessonId, 200, 200);
    expect(w.progressOf(lessonId)).toMatchObject({ watchedSeconds: 200 });
    // A second ticket (e.g. a rotation) adds its own viewing.
    w.watched(lessonId, 250, 450);
    await w.report(lessonId, 450, 250);
    expect(w.progressOf(lessonId)).toMatchObject({ watchedSeconds: 450, positionSeconds: 450, percent: 75 });
  });

  it('completes from watch progress, records it in THIS course, and markComplete then agrees', async () => {
    const w = world();
    w.watched(lessonId, 580, 590);
    await w.report(lessonId, 590, 580);
    expect(w.progressOf(lessonId)).toMatchObject({ completed: true, percent: 98 });
    expect(w.events).toEqual([expect.objectContaining({ type: 'COMPLETED', lessonId, courseId, videoId: 'vid_1' })]);
    expect(w.enrollmentUpdates.at(-1)).toMatchObject({ where: { userId: 'usr_1', courseId } });
    await expect(w.complete(lessonId)).resolves.toMatchObject({ completed: true });
  });

  it('a contiguous-watch rule completes from accumulated watch time', async () => {
    const w = world({ rule: { completionRequireContiguous: true } });
    w.watched(lessonId, 300, 300);
    await w.report(lessonId, 300, 300);
    w.watched(lessonId, 260, 590);
    await w.report(lessonId, 590, 260);
    expect(w.progressOf(lessonId)).toMatchObject({ watchedSeconds: 560, completed: true });
  });

  it('with no viewing behind it, a report cannot complete the lecture and markComplete refuses', async () => {
    const w = world();
    await w.report(lessonId, 590, 580);
    expect(w.progressOf(lessonId)).toMatchObject({ watchedSeconds: 0, positionSeconds: 120, completed: false });
    await expect(w.complete(lessonId)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('the same video in two courses does not credit across courses', () => {
  it('watching through the OWNING lecture does not credit the destination lecture', async () => {
    const w = world();
    w.watched('les_src', 580, 590);
    await w.report('les_dst', 590, 580);
    expect(w.progressOf('les_dst')).toMatchObject({ watchedSeconds: 0, positionSeconds: 120, completed: false });
    await expect(w.complete('les_dst')).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });

  it('watching through the DESTINATION lecture does not credit the owning lecture', async () => {
    const w = world();
    w.watched('les_dst', 580, 590);
    await w.report('les_src', 590, 580);
    expect(w.progressOf('les_src')).toMatchObject({ watchedSeconds: 0, positionSeconds: 120, completed: false });
  });

  it('each lecture is credited with exactly its own viewing', async () => {
    const w = world();
    w.watched('les_src', 100, 100);
    w.watched('les_dst', 400, 400);
    await w.report('les_src', 100, 100);
    await w.report('les_dst', 400, 400);
    expect(w.progressOf('les_src')).toMatchObject({ courseId: 'crs_src', watchedSeconds: 100 });
    expect(w.progressOf('les_dst')).toMatchObject({ courseId: 'crs_dst', watchedSeconds: 400 });
  });
});

describe('legacy lectures are unchanged', () => {
  it('an owning lecture without a backfilled link still credits through Lesson.video', async () => {
    const w = world({ ownerHasBackfilledLink: false });
    w.watched('les_src', 580, 590);
    await w.report('les_src', 590, 580);
    expect(w.progressOf('les_src')).toMatchObject({ watchedSeconds: 580, completed: true });
  });
});
