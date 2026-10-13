/**
 * Shared assets must not share course entitlements.
 *
 * The invariant under test: a reused video is an ASSET that can appear in
 * several lectures. It is NOT a licence. A student may only play it through a
 * lecture they are actually entitled to, and knowing the video id or the Gumlet
 * asset id must never be enough on its own.
 *
 * These tests drive the real resolution block in `PlaybackService.issueTicket`.
 */
import { PlaybackService } from '../../src/modules/playback/playback.service';

const ACTOR_STUDENT = {
  id: 'usr_student',
  role: 'STUDENT',
  deviceKey: 'dev_1',
  sessionId: 'ses_1',
} as never;

const CONTENT_STATUS = { PUBLISHED: 'PUBLISHED' } as never;

type LessonRow = {
  id: string;
  title: string;
  status: string;
  isPreview: boolean;
  courseId: string;
  sectionId: string;
  deletedAt: string | null;
  section: { unlocksAt: string | null; status: string };
};

function lesson(id: string, courseId: string, overrides: Partial<LessonRow> = {}): LessonRow {
  return {
    id,
    title: `Lecture in ${courseId}`,
    status: 'PUBLISHED',
    isPreview: false,
    courseId,
    sectionId: `sec_${id}`,
    deletedAt: null,
    section: { unlocksAt: null, status: 'PUBLISHED' },
    ...overrides,
  };
}

function harness(opts: { attachments: LessonRow[] }) {
  const calls = {
    contentAccess: [] as Record<string, unknown>[],
    sectionAccess: [] as Record<string, unknown>[],
    tickets: [] as Record<string, unknown>[],
    denied: [] as string[],
  };

  const prisma = {
    video: {
      findFirst: jest.fn(async () => ({
        id: 'vid_shared',
        courseId: 'crs_src',
        status: 'READY',
        durationSeconds: 600,
        hlsPrefix: null,
        masterPlaylistKey: null,
        drmProvider: 'gumlet',
        gumletAssetId: 'asset_abc',
        gumletWorkspaceId: 'ws',
        gumletStatus: 'ready',
        renditions: [],
        captions: [],
        lesson: null,
        lessonLinks: opts.attachments.map((l) => ({ lesson: l })),
      })),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ fullName: 'Student' })) },
    watchProgress: { findUnique: jest.fn(async () => null) },
    playbackTicket: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        calls.tickets.push(args.data);
        return { id: 'tid_1' };
      }),
      updateMany: jest.fn(),
    },
    watchEvent: { create: jest.fn(async () => ({})) },
    videoPlay: {
      aggregate: jest.fn(async () => ({ _max: { attemptNumber: null } })),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'play_1' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    },
  };

  const access = {
    assertContentAccess: jest.fn(async (args: Record<string, unknown>) => {
      calls.contentAccess.push(args);
    }),
    assertSectionAccessible: jest.fn(async (args: Record<string, unknown>) => {
      calls.sectionAccess.push(args);
    }),
  };
  const devices = {
    assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'dev_1' })),
  };

  const cfg = {
    getOrThrow: (key: string) => {
      if (key === 'playback') return { ticketTtl: 60, platformTier: 1080, ticketsPerHour: 60, concurrentStreams: 2 };
      if (key === 'video') return { drm: { enabled: true, provider: 'gumlet', gumlet: {} } };
      return {};
    },
  };

  const service = new PlaybackService(
    prisma as never,
    {
      incrementWindow: jest.fn(async () => 1),
      key: jest.fn((k: string) => k),
      client: {
        zremrangebyscore: jest.fn(async () => 0),
        zcard: jest.fn(async () => 0),
        zadd: jest.fn(async () => 1),
        expire: jest.fn(async () => 1),
      },
    } as never, // redis
    access as never,
    devices as never,
    {} as never, // storage
    {} as never, // manifest
    {} as never, // tokens
    { record: jest.fn() } as never, // security
    {} as never, // gumlet
    {
      evaluate: jest.fn(async () => ({ playable: true, reason: null })),
      // The strict gate now runs before the ticket row is written, so the
      // double must answer the method the gate actually calls.
      evaluateVideo: jest.fn(async () => ({ playable: true, reason: null })),
      verify: jest.fn(async () => ({ playable: true, reason: null })),
    } as never, // drmVerification
    cfg as never,
  );

  return { service, calls, access };
}

const REJECTED = expect.objectContaining({ status: expect.anything() });

describe('shared video entitlement', () => {
  it('authorises against the DESTINATION course, not the uploading course', async () => {
    const srcLesson = lesson('les_src', 'crs_src');
    const dstLesson = lesson('les_dst', 'crs_dst');
    const { service, calls } = harness({ attachments: [srcLesson, dstLesson] });

    await service
      .issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        lessonId: 'les_dst',
        integritySuspect: false,
        manifest: REJECTED,
      } as never)
      .catch(() => undefined);

    // The course checked is the DESTINATION course. Checking `crs_src` would
    // entitle the student using the uploading course's rules.
    expect(calls.contentAccess[0]).toMatchObject({ courseId: 'crs_dst' });
    expect(calls.sectionAccess[0]).toMatchObject({ courseId: 'crs_dst', sectionId: 'sec_les_dst' });
  });

  it('records the destination lesson on the ticket and the watch event', async () => {
    const srcLesson = lesson('les_src', 'crs_src');
    const dstLesson = lesson('les_dst', 'crs_dst');
    const { service, calls } = harness({ attachments: [srcLesson, dstLesson] });

    let thrown: unknown;
    try {
      await service.issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        lessonId: 'les_dst',
        integritySuspect: false,
        manifest: REJECTED,
      } as never);
    } catch (e) {
      thrown = e;
    }

    expect(calls.tickets[0]).toMatchObject({ lessonId: 'les_dst', courseId: 'crs_dst' });
  });

  it('REFUSES a lesson the asset is not attached to', async () => {
    // Knowing the video id is not enough: a client cannot name an arbitrary
    // lesson and borrow its entitlement.
    const srcLesson = lesson('les_src', 'crs_src');
    const dstLesson = lesson('les_dst', 'crs_dst');
    const { service, calls } = harness({ attachments: [srcLesson, dstLesson] });

    await expect(
      service.issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        lessonId: 'les_someone_elses',
        integritySuspect: false,
        manifest: REJECTED,
      } as never),
    ).rejects.toBeDefined();

    // Nothing was authorised.
    expect(calls.contentAccess).toHaveLength(0);
    expect(calls.tickets).toHaveLength(0);
  });

  it('REFUSES rather than guessing when several lectures share the asset and none is named', async () => {
    // Picking one arbitrarily would let a caller choose the most permissive
    // attachment - for example a free-preview lecture.
    const { service, calls } = harness({
      attachments: [lesson('les_a', 'crs_a'), lesson('les_b', 'crs_b')],
    });

    await expect(
      service.issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        integritySuspect: false,
        manifest: REJECTED,
      } as never),
    ).rejects.toBeDefined();

    expect(calls.contentAccess).toHaveLength(0);
    expect(calls.tickets).toHaveLength(0);
  });

  it('resolves unambiguously when only one lecture is attached', async () => {
    const only = lesson('les_only', 'crs_only');
    const { service, calls } = harness({ attachments: [only] });

    await service
      .issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        integritySuspect: false,
        manifest: REJECTED,
      } as never)
      .catch(() => undefined);

    expect(calls.contentAccess[0]).toMatchObject({ courseId: 'crs_only' });
  });

  it('ignores soft-deleted lessons when resolving', async () => {
    const { service, calls } = harness({
      attachments: [lesson('les_a', 'crs_a', { deletedAt: new Date().toISOString() })],
    });

    // The only attachment is a deleted lecture, so there is nothing to authorise.
    await expect(
      service.issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        integritySuspect: false,
        manifest: REJECTED,
      } as never),
    ).rejects.toBeDefined();

    expect(calls.contentAccess).toHaveLength(0);
  });

  it('does not let a preview lecture in one course make the asset free elsewhere', async () => {
    const previewLesson = lesson('les_preview', 'crs_src', { isPreview: true });
    const paidLesson = lesson('les_paid', 'crs_dst', { isPreview: false });
    const { service, calls } = harness({ attachments: [previewLesson, paidLesson] });

    await service
      .issueTicket({
        user: ACTOR_STUDENT,
        videoId: 'vid_shared',
        lessonId: 'les_paid',
        integritySuspect: false,
        manifest: REJECTED,
      } as never)
      .catch(() => undefined);

    // Entitlement comes from the PAID destination lecture.
    expect(calls.contentAccess[0]).toMatchObject({
      courseId: 'crs_dst',
      isPreviewContent: false,
    });
    // And section-level entitlement is enforced, which a preview would skip.
    expect(calls.sectionAccess).toHaveLength(1);
  });
});
