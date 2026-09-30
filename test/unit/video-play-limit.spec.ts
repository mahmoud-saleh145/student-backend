import { ContentStatus, UserRole, VideoStatus } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { PlaybackService } from '../../src/modules/playback/playback.service';

/**
 * The three-play limit.
 *
 * The rule is easy to state and easy to get wrong in the direction that hurts
 * honest students: a limit that counts tickets would spend a whole allowance
 * on one long lesson (rotation), on a dropped network (retry), or on
 * backgrounding the app (resume). So the counted unit is a *play*, and these
 * tests pin the three ways a play is NOT consumed as carefully as the one way
 * it is.
 *
 * Everything here is server-side by construction: the count comes from
 * `video_plays` keyed on the account, so reinstalling the app, clearing
 * storage or signing in again changes nothing.
 */

const LIMIT = 3;
const USER = {
  id: 'usr_student',
  role: UserRole.STUDENT,
  sessionId: 'ses_1',
  deviceKey: 'dk_1',
} as const;

interface Options {
  /** What `countedPlays` should see. */
  countedPlays?: number;
  /** An open, recently-active play to resume into. */
  openPlay?: { id: string; attemptNumber: number } | null;
  /** Highest attemptNumber already allocated. */
  maxAttempt?: number | null;
  isPreview?: boolean;
  videoStatus?: VideoStatus;
  role?: UserRole;
}

function build(options: Options = {}) {
  const playFindFirst = jest.fn(
    async (_args: { where: unknown; orderBy: unknown; select: unknown }) =>
      options.openPlay === undefined ? null : options.openPlay,
  );
  const playCount = jest.fn(async (_args: { where: unknown }) => options.countedPlays ?? 0);
  const playCreate = jest.fn(async (args: { data: Record<string, unknown>; select: unknown }) => ({
    id: 'vp_new',
    attemptNumber: args.data.attemptNumber as number,
  }));
  const playUpdate = jest.fn(async (_args: { where: unknown; data: unknown }) => ({ id: 'vp' }));
  const playUpdateMany = jest.fn(async (_args: { where: unknown; data: unknown }) => ({
    count: 0,
  }));
  const playAggregate = jest.fn(async (_args: { where: unknown; _max: unknown }) => ({
    _max: { attemptNumber: options.maxAttempt ?? null },
  }));

  const video = {
    id: 'vid_1',
    courseId: 'crs_1',
    status: options.videoStatus ?? VideoStatus.READY,
    hlsPrefix: 'hls/vid_1/',
    masterPlaylistKey: 'hls/vid_1/master.m3u8',
    durationSeconds: 600,
    renditions: [{ height: 720 }],
    captions: [],
    lesson: {
      id: 'les_1',
      title: 'Lecture 1',
      status: ContentStatus.PUBLISHED,
      isPreview: options.isPreview ?? false,
      courseId: 'crs_1',
      sectionId: 'sec_1',
      section: { unlocksAt: null, status: ContentStatus.PUBLISHED },
    },
  };

  const prisma = {
    video: { findFirst: jest.fn(async (_args: { where: unknown; include: unknown }) => video) },
    videoPlay: {
      findFirst: playFindFirst,
      count: playCount,
      create: playCreate,
      update: playUpdate,
      updateMany: playUpdateMany,
      aggregate: playAggregate,
    },
    playbackTicket: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'tkt_1',
        expiresAt: new Date(Date.now() + 300_000),
        ...args.data,
      })),
    },
    user: {
      findUniqueOrThrow: jest.fn(async (_args: { where: unknown; select: unknown }) => ({
        fullName: 'Test Student',
      })),
    },
    watchProgress: {
      findUnique: jest.fn(async (_args: { where: unknown; select: unknown }) => null),
    },
    securityEvent: { create: jest.fn(async (_args: unknown) => ({})) },
    // mintTicket writes a STARTED event; without this the mint throws and
    // every assertion here would fail for the wrong reason.
    watchEvent: { create: jest.fn(async (_args: unknown) => ({})) },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };

  const config = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? {
            ticketTtl: 300,
            heartbeatInterval: 30,
            heartbeatGrace: 90,
            maxConcurrentStreams: 1,
            ticketsPerHour: 60,
            captureStrikes: 3,
            maxPlaysPerVideo: LIMIT,
            playResumeWindow: 2700,
            minCountedPlaySeconds: 30,
          }
        : { drm: { enabled: false } },
  };

  // Order matches the real constructor: prisma, redis, access, devices,
  // storage, manifest, tokens, security, config.
  const service = new PlaybackService(
    prisma as never,
    { incr: jest.fn(async () => 1), remember: jest.fn() } as never,
    {
      assertContentAccess: jest.fn(async () => ({ canAccessContent: true })),
      assertSectionAccessible: jest.fn(async () => undefined),
    } as never,
    {
      assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'dev_1' })),
    } as never,
    { signMediaUrl: jest.fn(async () => 'https://gate.example/x') } as never,
    { buildMasterUrl: jest.fn(() => 'https://api.example/manifest') } as never,
    { mint: jest.fn(() => 'tok') } as never,
    { record: jest.fn(async () => undefined) } as never,
    config as never,
  );

  // Rate limiting and the concurrency slot are separate concerns with their
  // own tests; stubbed so a failure here is unambiguously about play counting.
  jest
    .spyOn(service as never as { enforceIssuanceRate: () => Promise<void> }, 'enforceIssuanceRate')
    .mockResolvedValue(undefined);
  jest
    .spyOn(service as never as { acquireStreamSlot: () => Promise<void> }, 'acquireStreamSlot')
    .mockResolvedValue(undefined);

  return { service, prisma, playFindFirst, playCount, playCreate, playUpdate, playUpdateMany };
}

function issue(service: PlaybackService) {
  return service.issueTicket({
    user: USER as never,
    videoId: 'vid_1',
    integritySuspect: false,
  });
}

describe('a play is consumed', () => {
  it('allocating the next attempt number when none have been used', async () => {
    const { service, playCreate } = build({ countedPlays: 0, maxAttempt: null });

    await issue(service);

    const call = playCreate.mock.calls[0];
    if (!call) throw new Error('videoPlay.create was never called');
    expect(call[0].data).toMatchObject({
      userId: USER.id,
      videoId: 'vid_1',
      attemptNumber: 1,
    });
  });

  it('and the ticket records which play it belongs to', async () => {
    // Without this link a rotation could not inherit the play, and the
    // watched seconds would have nowhere to accumulate.
    const { service, prisma } = build({ countedPlays: 0, maxAttempt: null });

    await issue(service);

    const call = prisma.playbackTicket.create.mock.calls[0];
    if (!call) throw new Error('playbackTicket.create was never called');
    expect((call[0].data as { playId: string | null }).playId).toBe('vp_new');
  });

  it('numbering from the highest allocated, not from the counted total', async () => {
    // Uncounted plays still occupy a number; numbering from the count would
    // collide with the unique index and fail the request.
    const { service, playCreate } = build({ countedPlays: 1, maxAttempt: 4 });

    await issue(service);

    const call = playCreate.mock.calls[0];
    if (!call) throw new Error('videoPlay.create was never called');
    expect((call[0].data as { attemptNumber: number }).attemptNumber).toBe(5);
  });
});

describe('the limit', () => {
  it('refuses the fourth play with its own error code', async () => {
    const { service } = build({ countedPlays: LIMIT });

    await expect(issue(service)).rejects.toMatchObject({
      code: ErrorCode.VIDEO_WATCH_LIMIT_REACHED,
    });
  });

  it('reports used and limit so the app can say how many were allowed', async () => {
    const { service } = build({ countedPlays: LIMIT });

    await expect(issue(service)).rejects.toMatchObject({
      details: { used: LIMIT, limit: LIMIT },
    });
  });

  it('still allows the third', async () => {
    const { service, playCreate } = build({ countedPlays: LIMIT - 1, maxAttempt: 2 });
    await issue(service);
    expect(playCreate).toHaveBeenCalled();
  });

  it('counts open plays and adequately-watched closed ones', async () => {
    // The shape of this clause IS the rule: a finished play that never
    // reached the threshold is a failed start, not an attempt.
    const { service, playCount } = build({ countedPlays: 0, maxAttempt: null });

    await issue(service);

    const call = playCount.mock.calls[0];
    if (!call) throw new Error('videoPlay.count was never called');
    const where = call[0].where as {
      userId: string;
      videoId: string;
      OR: { closedAt?: null; watchedSeconds?: { gte: number } }[];
    };
    expect(where.userId).toBe(USER.id);
    expect(where.OR).toEqual([{ closedAt: null }, { watchedSeconds: { gte: 30 } }]);
  });
});

describe('a play is NOT consumed', () => {
  it('when an open play is still inside the resume window', async () => {
    // Backgrounding the app, a dropped network, or a ticket that lapsed while
    // the lesson was on screen all arrive here. None is a new attempt.
    const { service, playCreate, playUpdate } = build({
      openPlay: { id: 'vp_open', attemptNumber: 2 },
      countedPlays: LIMIT, // already at the limit, and it must STILL be allowed
    });

    await issue(service);

    expect(playCreate).not.toHaveBeenCalled();
    const call = playUpdate.mock.calls[0];
    if (!call) throw new Error('the open play was not touched');
    expect(call[0].where).toEqual({ id: 'vp_open' });
  });

  it('and resuming does not even consult the count', async () => {
    // Resuming at the limit must not throw. If the count were checked first,
    // a student halfway through their third play could not resume it.
    const { service, playCount } = build({
      openPlay: { id: 'vp_open', attemptNumber: 3 },
      countedPlays: LIMIT,
    });

    await expect(issue(service)).resolves.toBeDefined();
    expect(playCount).not.toHaveBeenCalled();
  });

  it('for a free preview lesson, at any count', async () => {
    // Free videos are exempt: they must not spend a paid allowance.
    const { service, playCreate, playFindFirst } = build({
      isPreview: true,
      countedPlays: 99,
    });

    await expect(issue(service)).resolves.toBeDefined();
    expect(playCreate).not.toHaveBeenCalled();
    expect(playFindFirst).not.toHaveBeenCalled();
  });

  it('for staff previewing their own material', async () => {
    const { service, playCreate } = build({ role: UserRole.ADMIN, countedPlays: 99 });
    const admin = { ...USER, role: UserRole.ADMIN };

    await expect(
      service.issueTicket({ user: admin as never, videoId: 'vid_1', integritySuspect: false }),
    ).resolves.toBeDefined();
    expect(playCreate).not.toHaveBeenCalled();
  });

  it('and a play abandoned beyond the window is closed before counting', async () => {
    // Left open forever it would occupy the allowance permanently; closed, it
    // counts only on the seconds it actually accumulated.
    const { service, playUpdateMany } = build({ openPlay: null, countedPlays: 0 });

    await issue(service);

    const call = playUpdateMany.mock.calls[0];
    if (!call) throw new Error('stale open plays were not closed');
    expect(call[0].where).toMatchObject({ userId: USER.id, videoId: 'vid_1', closedAt: null });
    expect(call[0].data).toHaveProperty('closedAt');
  });
});

describe('a failed transcode is distinguishable from one still processing', () => {
  it('answers VIDEO_PROCESSING_FAILED, not VIDEO_UNAVAILABLE', async () => {
    // "Unavailable" reads to a student as "try later", and no amount of
    // waiting fixes a failed encode.
    const { service } = build({ videoStatus: VideoStatus.FAILED });

    await expect(issue(service)).rejects.toMatchObject({
      code: ErrorCode.VIDEO_PROCESSING_FAILED,
    });
  });

  it('and one still processing still answers VIDEO_NOT_READY', async () => {
    const { service } = build({ videoStatus: VideoStatus.PROCESSING });

    await expect(issue(service)).rejects.toMatchObject({
      code: ErrorCode.VIDEO_NOT_READY,
    });
  });
});

describe('the allowance read', () => {
  it('reports what is left without issuing anything', async () => {
    const { service, playCreate } = build({ countedPlays: 2 });

    await expect(service.playAllowance(USER.id, 'vid_1')).resolves.toEqual({
      used: 2,
      limit: LIMIT,
      remaining: 1,
    });
    expect(playCreate).not.toHaveBeenCalled();
  });

  it('never reports a negative remainder', async () => {
    const { service } = build({ countedPlays: 7 });
    await expect(service.playAllowance(USER.id, 'vid_1')).resolves.toMatchObject({
      remaining: 0,
    });
  });
});
