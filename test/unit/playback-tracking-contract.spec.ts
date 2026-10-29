import { ContentStatus, CompletionRuleType, PlaybackTicketStatus, UserRole, WatchEventType } from '@prisma/client';

import { PlaybackService } from '../../src/modules/playback/playback.service';
import { GumletDrmService } from '../../src/modules/playback/gumlet-drm.service';
import { ProgressService } from '../../src/modules/progress/progress.service';

/**
 * The contract between the student web player and the backend, executed.
 *
 * WHY THIS FILE EXISTS
 *
 * The frontend tracking fix restores heartbeat and progress reporting on the DRM
 * branch. Two consequences were reasoned about from source but never executed:
 *
 *   1. A heartbeat now refreshes the concurrent-stream slot, changing how long
 *      that enforcement actually holds.
 *   2. A heartbeat can rotate a ticket, and rotation runs on the backend.
 *
 * Both are asserted here against the real `PlaybackService.heartbeat`, with
 * only Redis, Prisma and the provider stubbed. This CHANGES NO POLICY - it
 * pins the behaviour that already exists, so a future refactor cannot quietly
 * widen or narrow it.
 */

const STUDENT = { id: 'usr_1', role: UserRole.STUDENT, deviceKey: 'dev_1', sessionId: 'ses_1' } as never;

function liveTicket(over: Record<string, unknown> = {}) {
  return {
    id: 'tid_live',
    userId: 'usr_1',
    videoId: 'vid_1',
    lessonId: 'les_1',
    courseId: 'crs_1',
    status: PlaybackTicketStatus.ACTIVE,
    deviceId: 'dev_1',
    maxHeight: null,
    playId: 'play_1',
    startPositionSeconds: 0,
    lastPositionSeconds: 0,
    watchedSeconds: 0,
    rotatedFromId: null,
    releasedAt: null,
    revokedAt: null,
    revokedReason: null,
    expiresAt: new Date(Date.now() + 300_000),
    video: {
      id: 'vid_1',
      durationSeconds: 600,
      gumletAssetId: 'a_1',
      gumletWorkspaceId: 'ws_1',
      renditions: [],
      captions: [],
      lesson: { id: 'les_1', title: 'Lecture' },
    },
    ...over,
  };
}

/** A PlaybackService with Redis and Prisma stubbed; signing stays real. */
function buildPlayback(options: { expiresInMs?: number } = {}) {
  const ticket = liveTicket({
    expiresAt: new Date(Date.now() + (options.expiresInMs ?? 300_000)),
  });

  const prisma = {
    playbackTicket: {
      findFirst: jest.fn(async () => ticket),
      update: jest.fn(async () => ({})),
      create: jest.fn(async () => liveTicket({ id: 'tid_next', status: PlaybackTicketStatus.ACTIVE })),
    },
    watchEvent: { create: jest.fn(async () => ({})) },
    user: { findUniqueOrThrow: jest.fn(async () => ({ id: 'usr_1', fullName: 'Test Student' })) },
    watchProgress: { findUnique: jest.fn(async () => null) },
    videoPlay: { update: jest.fn(async () => ({})), create: jest.fn(async () => ({ id: 'play_1' })) },
    video: { findFirst: jest.fn(async () => ticket.video), update: jest.fn(async () => ({})) },
    enrollment: { updateMany: jest.fn(async () => ({ count: 1 })) },
  };

  const redis = {
    incrementWindow: jest.fn(async () => 1),
    key: jest.fn((k: string) => k),
    client: {
      zadd: jest.fn(async () => 1),
      zscore: jest.fn(async () => null),
      zrem: jest.fn(async () => 1),
      zcard: jest.fn(async () => 0),
      zremrangebyscore: jest.fn(async () => 0),
      expire: jest.fn(async () => 1),
    },
  };

  const access = {
    assertContentAccess: jest.fn(async () => undefined),
    assertSectionAccessible: jest.fn(async () => undefined),
    resolve: jest.fn(async () => ({ canAccessContent: true, state: 'ACTIVE' })),
  };

  const gumletCfg = {
    apiKey: 'k',
    workspaceId: 'ws_1',
    orgId: 'org_1',
    // Not a real secret.
    signSecret: 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5',
    tokenLifetimeSeconds: 300,
    resolutions: ['720p'],
  };
  const config = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? { ticketTtl: 300, heartbeatInterval: 30, platformTier: 1080, ticketsPerHour: 60, concurrentStreams: 1 }
        : { drm: { enabled: true, provider: 'gumlet', gumlet: gumletCfg } },
  };

  // The real signer: manifest/licence construction is pure string and HMAC work
  // against a throwaway secret, so rotation exercises the genuine code path with
  // no network call and no real credential.
  const gumlet = new GumletDrmService(config as never);

  const playback = new PlaybackService(
    prisma as never,
    redis as never,
    access as never,
    { assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'dev_1' })) } as never,
    { signMediaUrl: jest.fn(async () => 'https://media.example/c.vtt') } as never,
    {} as never,
    {} as never,
    { record: jest.fn() } as never,
    gumlet,
    { covers: () => false, ensurePlayable: jest.fn(async () => ({ playable: true })) } as never,
    config as never,
  );

  return { playback, prisma, redis, access };
}

/** The exact body the player sends on every tick. */
const PLAYER_HEARTBEAT = {
  positionSeconds: 61,
  watchedDeltaSeconds: 30,
  // secureSurface is absent on purpose; see the frontend payload builder.
  protection: { recording: false, externalDisplay: false },
};

describe('heartbeat: concurrent-stream slot', () => {
  it('refreshes the stream slot on every heartbeat', async () => {
    // DRM previously sent no heartbeat at all, so its slot score froze at
    // issuance and was pruned after the grace window. This is the behaviour the
    // fix restores.
    const { playback, redis } = buildPlayback();
    await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });

    expect(redis.client.zadd).toHaveBeenCalledTimes(1);
    const [key, score, member] = redis.client.zadd.mock.calls[0] as unknown as [string, number, string];
    expect(key).toBe('pb:slots:usr_1');
    expect(member).toBe('ses_1');
    expect(typeof score).toBe('number');
  });

  it('does NOT extend the slot key lifetime', async () => {
    // Only the ticket-issuance path refreshes the Redis TTL
    // (`acquireStreamSlot`). Rotation bypasses it. So the enforcement ceiling
    // stays bounded - heartbeats keep a session's score fresh but cannot keep
    // the key alive indefinitely.
    const { playback, redis } = buildPlayback();
    await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(redis.client.expire).not.toHaveBeenCalled();
  });

  it('re-checks entitlement on every heartbeat, so revocation stays real', async () => {
    const { playback, access } = buildPlayback();
    await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(access.resolve).toHaveBeenCalledWith({ userId: 'usr_1', role: UserRole.STUDENT, courseId: 'crs_1' });
  });

  it('terminates and releases the slot when access is lost mid-playback', async () => {
    const { playback, redis, access } = buildPlayback();
    (access.resolve as jest.Mock).mockResolvedValue({
      canAccessContent: false,
      state: 'EXPIRED',
      denialCode: 'NOT_ENROLLED',
    });
    const res = await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(res.terminate?.reason).toBe('NOT_ENROLLED');
    expect(redis.client.zrem).toHaveBeenCalledWith('pb:slots:usr_1', 'ses_1');
  });

  it('records the observed position and watch time server-side', async () => {
    // This is the evidence `POST /progress` later vouches against, so a client
    // cannot bank watch time with no playback behind it.
    const { playback, prisma } = buildPlayback();
    await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(prisma.playbackTicket.update).toHaveBeenCalledWith({
      where: { id: 'tid_live' },
      data: expect.objectContaining({
        lastPositionSeconds: 61,
        watchedSeconds: { increment: 30 },
        lastHeartbeatAt: expect.any(Date),
      }),
    });
  });
});

describe('heartbeat: rotation side effects', () => {
  it('does not consume a ticket-rate allowance when it rotates', async () => {
    const { playback, redis } = buildPlayback({ expiresInMs: 5_000 });
    const res = await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(res.ticket).toBeDefined();
    expect(redis.incrementWindow).not.toHaveBeenCalled();
  });

  it('does not open a second counted play when it rotates', async () => {
    const { playback, prisma } = buildPlayback({ expiresInMs: 5_000 });
    await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(prisma.videoPlay.create).not.toHaveBeenCalled();
  });

  it('carries the same play forward, so a long lesson is one attempt', async () => {
    const { playback, prisma } = buildPlayback({ expiresInMs: 5_000 });
    await playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(prisma.videoPlay.update).toHaveBeenCalledWith({
      where: { id: 'play_1' },
      data: expect.objectContaining({ lastActivityAt: expect.any(Date) }),
    });
  });

  it('writes a PROGRESS event only when there is new watch time to record', async () => {
    const withDelta = buildPlayback();
    await withDelta.playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', ...PLAYER_HEARTBEAT });
    expect(withDelta.prisma.watchEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: WatchEventType.PROGRESS, deltaSeconds: 30 }) }),
    );

    const noDelta = buildPlayback();
    await noDelta.playback.heartbeat({
      user: STUDENT,
      ticketId: 'tid_live',
      positionSeconds: 61,
      watchedDeltaSeconds: 0,
      protection: { recording: false, externalDisplay: false },
    });
    expect(noDelta.prisma.watchEvent.create).not.toHaveBeenCalled();
  });
});

describe('progress contract: the exact payload the player sends', () => {
  const LESSON = {
    id: 'les_1',
    courseId: 'crs_1',
    sectionId: 'sec_1',
    isPreview: false,
    durationSeconds: 600,
    status: ContentStatus.PUBLISHED,
    course: {
      id: 'crs_1',
      status: 'PUBLISHED',
      completionRuleType: CompletionRuleType.WATCH_PERCENT,
      completionThreshold: 90,
      completionRequireContiguous: false,
    },
    video: { id: 'vid_1', durationSeconds: 600 },
    videoLinks: [{ video: { id: 'vid_1', durationSeconds: 600 } }],
  };

  function buildProgress(observed: { watchedSeconds: number; positionSeconds: number }) {
    let stored: Record<string, unknown> | null = null;
    const prisma = {
      lesson: { findFirst: jest.fn(async () => LESSON), count: jest.fn(async () => 1) },
      watchProgress: {
        findUnique: jest.fn(async () => stored),
        count: jest.fn(async () => 1),
        upsert: jest.fn(async ({ create, update }: never) => {
          stored = (stored ? { ...stored, ...(update as object) } : { ...(create as object) }) as Record<string, unknown>;
          return stored;
        }),
      },
      enrollment: { updateMany: jest.fn(async () => ({ count: 1 })) },
      watchEvent: { create: jest.fn(async () => ({})) },
      playbackTicket: {
        findMany: jest.fn(async () => [
          { watchedSeconds: observed.watchedSeconds, lastPositionSeconds: observed.positionSeconds },
        ]),
      },
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));

    const service = new ProgressService(
      prisma as never,
      { assertContentAccess: jest.fn(async () => ({ canAccessContent: true })) } as never,
      { publicAssetUrl: jest.fn(async () => null) } as never,
    );
    return { service, prisma, read: () => stored };
  }

  /** Byte-for-byte the object `buildProgressPayload` produces. */
  const PLAYER_PROGRESS = { lessonId: 'les_1', positionSeconds: 300, watchedSeconds: 28 };

  it('accepts the player payload and creates the row the Viewers page reads', async () => {
    const { service, read } = buildProgress({ watchedSeconds: 28, positionSeconds: 300 });
    await service.upsert({ userId: 'usr_1', role: UserRole.STUDENT, input: PLAYER_PROGRESS });
    const row = read() as Record<string, number>;
    expect(row.userId).toBe('usr_1');
    expect(row.lessonId).toBe('les_1');
    expect(row.positionSeconds).toBe(300);
    expect(row.watchedSeconds).toBe(28);
    expect(row.percent).toBe(50);
  });

  it('credits only what the heartbeat actually vouched for', async () => {
    // The client can claim 28s; the server only believes the 10s a heartbeat
    // recorded. Anti-forgery must survive the DRM fix intact.
    const { service, read } = buildProgress({ watchedSeconds: 10, positionSeconds: 300 });
    await service.upsert({ userId: 'usr_1', role: UserRole.STUDENT, input: PLAYER_PROGRESS });
    expect((read() as Record<string, number>).watchedSeconds).toBe(10);
  });

  it('banks nothing at all when no heartbeat ever arrived', async () => {
    // Exactly the pre-fix DRM shape: a progress report with no playback
    // evidence behind it.
    const { service, read } = buildProgress({ watchedSeconds: 0, positionSeconds: 0 });
    await service.upsert({ userId: 'usr_1', role: UserRole.STUDENT, input: PLAYER_PROGRESS });
    expect((read() as Record<string, number>).watchedSeconds).toBe(0);
  });

  it('still records a viewer row even when watch time is zero', async () => {
    // This is the fix working: the row appears, so the Video Viewers page has
    // something to show, even in the degenerate no-evidence case.
    const { service, read } = buildProgress({ watchedSeconds: 0, positionSeconds: 0 });
    await service.upsert({ userId: 'usr_1', role: UserRole.STUDENT, input: PLAYER_PROGRESS });
    expect(read()).not.toBeNull();
  });
});