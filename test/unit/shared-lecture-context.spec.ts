/**
 * C1 - which lecture a SHARED video is played "as" when the client names none.
 *
 * The native app and older web builds request lesson details (by video id) and
 * playback tickets without a lessonId. Production has two videos shared by
 * three lectures each, and every one of those lectures is (intentionally) a
 * free preview. Before this fix the uploading lecture was always tried first,
 * and as a preview it passed for everyone - so a student enrolled only in a
 * destination course was played the ORIGIN course's lecture, and their watch
 * events, progress and completion landed in the wrong course.
 *
 * These tests use the REAL CourseAccessService preview rule (assertContentAccess
 * runs unmodified; only `resolve()` - "is this user enrolled / staff in this
 * course" - is modelled), the REAL PlaybackService.issueTicket and the REAL
 * LessonsService.byVideoId + detail(), and assert that both pick the same
 * lecture. Preview access itself is expected behaviour and is preserved.
 */
import { ErrorCode } from '../../src/common/errors/error-codes';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { LessonsService } from '../../src/modules/lessons/lessons.service';
import { GumletDrmService } from '../../src/modules/playback/gumlet-drm.service';
import { PlaybackService } from '../../src/modules/playback/playback.service';

// Not a real secret: a base64 string long enough to be accepted as a key.
const SIGN_SECRET = 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5';
const CONFIG = {
  getOrThrow: (k: string) =>
    k === 'playback'
      ? { ticketTtl: 300, ticketsPerHour: 60 }
      : {
          drm: {
            enabled: true,
            provider: 'gumlet',
            gumlet: { apiKey: 'k', workspaceId: 'ws', orgId: 'org_1', signSecret: SIGN_SECRET, tokenLifetimeSeconds: 300 },
          },
        },
};

type Lecture = {
  id: string;
  courseId: string;
  isPreview: boolean;
  status?: string;
  unlocksAt?: Date | null;
};

const VIDEO_ID = 'vid_shared';

function world(opts: {
  lectures: Lecture[]; // attachment order, oldest first; the FIRST is the uploading lecture
  enrolled?: string[];
  role?: 'STUDENT' | 'ADMIN';
}) {
  const enrolled = new Set(opts.enrolled ?? []);
  const role = opts.role ?? 'STUDENT';
  const origin = opts.lectures[0];

  // The real access engine; only enrolment state is modelled.
  const access = new CourseAccessService({} as never, {} as never, {} as never);
  jest.spyOn(access, 'resolve').mockImplementation(async ({ courseId, role: r }) =>
    r === 'ADMIN' || enrolled.has(courseId)
      ? { state: 'ACTIVE', canAccessContent: true, enrollment: null, expiresAt: null }
      : { state: 'NOT_ENROLLED', canAccessContent: false, enrollment: null, expiresAt: null, denialCode: ErrorCode.NOT_ENROLLED },
  );
  // Enrolments here are whole-course.
  jest.spyOn(access, 'assertSectionAccessible').mockImplementation(async () => undefined as never);

  const lessonRow = (l: Lecture) => ({
    id: l.id,
    title: `Lecture ${l.id}`,
    status: l.status ?? 'PUBLISHED',
    isPreview: l.isPreview,
    courseId: l.courseId,
    sectionId: `sec_${l.id}`,
    deletedAt: null,
    section: { id: `sec_${l.id}`, status: 'PUBLISHED', unlocksAt: l.unlocksAt ?? null, sortOrder: 1 },
  });

  // ---- playback ------------------------------------------------------------
  const tickets: Record<string, unknown>[] = [];
  const watchEvents: Record<string, unknown>[] = [];
  const playbackPrisma = {
    video: {
      findFirst: jest.fn(async () => ({
        id: VIDEO_ID, courseId: origin.courseId, lessonId: origin.id, status: 'READY', durationSeconds: 600,
        hlsPrefix: null, masterPlaylistKey: null, drmProvider: 'gumlet', gumletAssetId: 'asset_1',
        gumletWorkspaceId: 'ws', gumletStatus: 'ready', renditions: [], captions: [], lesson: null,
        lessonLinks: opts.lectures.map((l) => ({ lesson: lessonRow(l) })),
      })),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ fullName: 'Student' })) },
    watchProgress: { findUnique: jest.fn(async () => null) },
    playbackTicket: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        tickets.push(a.data);
        return { id: 'tid_1' };
      }),
      updateMany: jest.fn(),
    },
    watchEvent: {
      create: jest.fn(async (a: { data: Record<string, unknown> }) => {
        watchEvents.push(a.data);
        return {};
      }),
    },
    videoPlay: {
      aggregate: jest.fn(async () => ({ _max: { attemptNumber: null } })),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'play_1' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    },
  };
  const playback = new PlaybackService(
    playbackPrisma as never,
    {
      incrementWindow: jest.fn(async () => 1),
      key: (k: string) => k,
      client: { zremrangebyscore: jest.fn(async () => 0), zcard: jest.fn(async () => 0), zadd: jest.fn(async () => 1), expire: jest.fn(async () => 1) },
    } as never,
    access,
    { assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'dev_1' })) } as never,
    {} as never,
    {} as never,
    {} as never,
    { record: jest.fn() } as never,
    // Real signing, so issuance runs to completion (ticket row, licence URL,
    // watch event). DRM verification itself is covered elsewhere.
    new GumletDrmService(CONFIG as never),
    { ensurePlayable: jest.fn(async () => ({ playable: true, reason: null })) } as never,
    CONFIG as never,
  );

  // ---- lesson details --------------------------------------------------------
  const lessonsPrisma = {
    video: {
      findFirst: jest.fn(async () => ({
        lessonId: origin.id,
        // As the real query returns them: live lectures only, oldest attachment first.
        lessonLinks: opts.lectures.map((l) => ({ lessonId: l.id, lesson: { courseId: l.courseId } })),
      })),
    },
    lesson: {
      findFirst: jest.fn(async (a: { where: { id: string } }) => {
        const l = opts.lectures.find((x) => x.id === a.where.id);
        if (!l) return null;
        return {
          ...lessonRow(l),
          description: null, kind: 'VIDEO', sortOrder: 1, durationSeconds: 600,
          completionRuleType: null, completionThreshold: null, completionRequireContiguous: null,
          course: { completionRuleType: 'WATCH_PERCENT', completionThreshold: 90, completionRequireContiguous: false },
          attachments: [],
          video: null,
          videoLinks: [{ video: { id: VIDEO_ID, status: 'READY', durationSeconds: 600, renditions: [], captions: [], deletedAt: null } }],
        };
      }),
      findMany: jest.fn(async () => []),
    },
    watchProgress: { findUnique: jest.fn(async () => null) },
  };
  const lessons = new LessonsService(lessonsPrisma as never, access, {} as never, {} as never);

  const user = { id: 'usr_1', role, deviceKey: 'dev_1', sessionId: 'ses_1' } as never;

  return {
    access,
    tickets,
    watchEvents,
    /** What the client is told it is watching (its progress/completion use this id). */
    details: () => lessons.byVideoId(VIDEO_ID, 'usr_1', role as never),
    detailsFor: (lessonId: string) => lessons.byVideoId(VIDEO_ID, 'usr_1', role as never, lessonId),
    /** The ticket's lecture (watch events and heartbeat progress use this). */
    play: async (lessonId?: string) => {
      const err = await playback
        .issueTicket({ user, videoId: VIDEO_ID, lessonId, integritySuspect: false })
        .then(() => null, (e: unknown) => e);
      return { ticket: tickets.at(-1) ?? null, err };
    },
  };
}

/** Playback, lesson details and the watch event all point at `lessonId` / `courseId`. */
async function expectConsistent(w: ReturnType<typeof world>, lessonId: string, courseId: string) {
  const detail = (await w.details()) as { id: string; courseId: string };
  const { ticket } = await w.play();
  expect({ id: detail.id, courseId: detail.courseId }).toEqual({ id: lessonId, courseId });
  expect(ticket).toMatchObject({ lessonId, courseId });
  expect(w.watchEvents.at(-1)).toMatchObject({ lessonId, courseId, videoId: VIDEO_ID });
}

const src = (o: Partial<Lecture> = {}): Lecture => ({ id: 'les_src', courseId: 'crs_src', isPreview: true, ...o });
const dst1 = (o: Partial<Lecture> = {}): Lecture => ({ id: 'les_dst1', courseId: 'crs_dst1', isPreview: true, ...o });
const dst2 = (o: Partial<Lecture> = {}): Lecture => ({ id: 'les_dst2', courseId: 'crs_dst2', isPreview: true, ...o });

describe('student enrolled only in a destination course', () => {
  it('production shape (every lecture a free preview): resolves to THEIR course, not the origin preview', async () => {
    const w = world({ lectures: [src(), dst1(), dst2()], enrolled: ['crs_dst1'] });
    await expectConsistent(w, 'les_dst1', 'crs_dst1');
  });

  it('origin is a free preview, their destination lecture is paid: still their course', async () => {
    const w = world({ lectures: [src(), dst1({ isPreview: false })], enrolled: ['crs_dst1'] });
    await expectConsistent(w, 'les_dst1', 'crs_dst1');
  });

  it('the second destination too', async () => {
    const w = world({ lectures: [src(), dst1(), dst2()], enrolled: ['crs_dst2'] });
    await expectConsistent(w, 'les_dst2', 'crs_dst2');
  });
});

describe('student with access to more than one candidate course (deterministic)', () => {
  it('origin among their courses: the uploading lecture wins', async () => {
    const w = world({ lectures: [src(), dst1(), dst2()], enrolled: ['crs_dst2', 'crs_src'] });
    await expectConsistent(w, 'les_src', 'crs_src');
  });

  it('two destinations, not the origin: the oldest attachment among THEIR courses wins', async () => {
    const w = world({ lectures: [src(), dst1(), dst2()], enrolled: ['crs_dst2', 'crs_dst1'] });
    await expectConsistent(w, 'les_dst1', 'crs_dst1');
  });

  it('staff (access everywhere): the uploading lecture', async () => {
    const w = world({ lectures: [src(), dst1(), dst2()], role: 'ADMIN' });
    await expectConsistent(w, 'les_src', 'crs_src');
  });
});

describe('preview-only student (no enrolment) - free preview access is preserved', () => {
  it('every lecture a preview: the uploading lecture (documented fallback order)', async () => {
    const w = world({ lectures: [src(), dst1(), dst2()], enrolled: [] });
    await expectConsistent(w, 'les_src', 'crs_src');
  });

  it('only a destination is a preview: that preview lecture', async () => {
    const w = world({ lectures: [src({ isPreview: false }), dst1({ isPreview: false }), dst2()], enrolled: [] });
    await expectConsistent(w, 'les_dst2', 'crs_dst2');
  });

  it('no preview anywhere: refused by BOTH paths, no ticket, no watch event', async () => {
    const w = world({ lectures: [src({ isPreview: false }), dst1({ isPreview: false })], enrolled: [] });
    await expect(w.details()).rejects.toMatchObject({ code: ErrorCode.NOT_ENROLLED });
    const { err } = await w.play();
    expect(err).toMatchObject({ code: ErrorCode.NOT_ENROLLED });
    expect(w.tickets).toHaveLength(0);
    expect(w.watchEvents).toHaveLength(0);
  });
});

describe('lesson checks still apply to the student\'s own lecture, identically on both paths', () => {
  it('their lecture is unpublished: skipped; falls back to a lecture they may open (the origin preview)', async () => {
    const w = world({ lectures: [src(), dst1({ status: 'DRAFT' })], enrolled: ['crs_dst1'] });
    await expectConsistent(w, 'les_src', 'crs_src');
  });

  it('their lecture is not released yet (drip) and paid: skipped the same way on both paths', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000);
    const w = world({ lectures: [src(), dst1({ isPreview: false, unlocksAt: tomorrow })], enrolled: ['crs_dst1'] });
    await expectConsistent(w, 'les_src', 'crs_src');
  });
});

describe('a NAMED lecture is unchanged and strict', () => {
  it('never falls back, even when another attached lecture would pass', async () => {
    const w = world({ lectures: [src(), dst1({ isPreview: false })], enrolled: [] });
    await expect(w.detailsFor('les_dst1')).rejects.toMatchObject({ code: ErrorCode.NOT_ENROLLED });
    const { err, ticket } = await w.play('les_dst1');
    expect(err).toMatchObject({ code: ErrorCode.NOT_ENROLLED });
    expect(ticket).toBeNull();
  });

  it('a named preview lecture plays as that lecture', async () => {
    const w = world({ lectures: [src(), dst1()], enrolled: [] });
    expect(((await w.detailsFor('les_dst1')) as { id: string }).id).toBe('les_dst1');
    const { ticket } = await w.play('les_dst1');
    expect(ticket).toMatchObject({ lessonId: 'les_dst1', courseId: 'crs_dst1' });
  });
});

describe('access lookups', () => {
  it('ask about each candidate COURSE once per request (cached), not once per lecture', async () => {
    const w = world({ lectures: [src(), dst1(), { id: 'les_dst1b', courseId: 'crs_dst1', isPreview: true }], enrolled: ['crs_dst1'] });
    await w.play();
    const courses = (w.access.resolve as jest.Mock).mock.calls.map((c) => c[0].courseId);
    // One ordering lookup per distinct course, plus assertContentAccess's own call for the checked lecture.
    expect(courses.filter((c: string) => c === 'crs_src')).toHaveLength(1);
  });
});
