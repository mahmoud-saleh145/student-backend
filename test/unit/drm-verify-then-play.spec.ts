/**
 * Fix 2 - verification must lead to playback, end to end.
 *
 * Root cause: `verify()` wrote `drmVerifiedAt` but never `drmRequested`, while
 * the playback gate (`evaluate`) refuses `drmRequested=false` as
 * DRM_NOT_REQUESTED. Every asset adopted before that column existed - and
 * every asset adopted since by code that does not know the column - therefore
 * "verified" successfully and was still refused on every ticket.
 *
 * Here the REAL DrmVerificationService, the REAL GumletDrmService signing and
 * the REAL PlaybackService.issueTicket share one video row, so a test passes
 * only if a successful verification genuinely produces a playable ticket.
 * Network calls (Gumlet asset API and the DASH manifest) are stubbed.
 */
import { DrmVerificationService } from '../../src/modules/playback/drm-verification.service';
import { GumletDrmService } from '../../src/modules/playback/gumlet-drm.service';
import { PlaybackService } from '../../src/modules/playback/playback.service';

const CENC_MANIFEST =
  '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="k"/></AdaptationSet></MPD>';
const UNENCRYPTED = '<MPD><AdaptationSet><Segment/></AdaptationSet></MPD>';
// Not a real secret.
const SECRET_B64 = 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5';

const STUDENT = { id: 'usr_1', role: 'STUDENT', deviceKey: 'dev_1', sessionId: 'ses_1' } as never;

type Row = Record<string, unknown>;

function lesson(id: string, courseId: string, over: Row = {}): Row {
  return {
    id,
    title: `Lecture ${id}`,
    status: 'PUBLISHED',
    isPreview: false,
    courseId,
    sectionId: `sec_${id}`,
    deletedAt: null,
    section: { unlocksAt: null, status: 'PUBLISHED' },
    ...over,
  };
}

function world(opts: {
  row?: Row;
  manifest?: string;
  drmType?: string | null;
  attachments?: Row[];
  entitledCourses?: string[];
} = {}) {
  const video: Row = {
    id: 'vid_1',
    courseId: 'crs_src',
    lessonId: 'les_src',
    status: 'READY',
    durationSeconds: 2849,
    hlsPrefix: null,
    masterPlaylistKey: null,
    drmProvider: 'gumlet',
    // The production default for every pre-column / old-code adoption.
    drmRequested: false,
    drmVerifiedAt: null,
    drmBlockedReason: null,
    gumletAssetId: 'asset_1',
    gumletWorkspaceId: 'ws_1',
    gumletStatus: 'ready',
    deletedAt: null,
    renditions: [],
    captions: [],
    lesson: null,
    ...opts.row,
  };
  const attachments = opts.attachments ?? [lesson('les_src', 'crs_src')];
  const entitled = new Set(opts.entitledCourses ?? ['crs_src', 'crs_dst']);
  const tickets: Row[] = [];
  let existingTicket: Row | null = null;
  const ticketUpdates: { where: Row; data: Row }[] = [];

  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://api.gumlet.com/v1/video/assets/')) {
      const transformations = opts.drmType === null ? {} : { drm: { type: opts.drmType ?? 'widevine,fairplay' } };
      return {
        ok: true,
        status: 200,
        json: async () => ({ asset_id: 'asset_1', status: 'ready', progress: 100, input: { duration: 2848.9, transformations } }),
      };
    }
    return { ok: true, status: 200, text: async () => opts.manifest ?? CENC_MANIFEST };
  }) as never;

  const prisma = {
    video: {
      findFirst: jest.fn(async () => (video.deletedAt ? null : { ...video, lessonLinks: attachments.map((l) => ({ lesson: l })) })),
      update: jest.fn(async (a: { data: Row }) => Object.assign(video, a.data)),
      updateMany: jest.fn(async (a: { data: Row }) => {
        Object.assign(video, a.data);
        return { count: 1 };
      }),
    },
    user: { findUniqueOrThrow: jest.fn(async () => ({ fullName: 'Student' })) },
    watchProgress: { findUnique: jest.fn(async () => null) },
    playbackTicket: {
      create: jest.fn(async (a: { data: Row }) => {
        tickets.push(a.data);
        return { id: `tid_${tickets.length}` };
      }),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(async (a: { where: Row; data: Row }) => {
        ticketUpdates.push(a);
        return {};
      }),
      // For heartbeat tests: the most recently issued ticket, as stored.
      findFirst: jest.fn(async () => (existingTicket ? { ...existingTicket, video: { ...video } } : null)),
    },
    watchEvent: { create: jest.fn(async () => ({})) },
    videoPlay: {
      update: jest.fn(async () => ({})),
      aggregate: jest.fn(async () => ({ _max: { attemptNumber: null } })),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async () => ({ id: 'play_1' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      count: jest.fn(async () => 0),
    },
  };

  const gumletCfg = {
    apiKey: 'api-key-for-tests',
    workspaceId: 'ws_1',
    orgId: 'org_1',
    signSecret: SECRET_B64,
    tokenLifetimeSeconds: 300,
    resolutions: ['720p'],
  };
  const config = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? { ticketTtl: 300, heartbeatInterval: 30, platformTier: 1080, ticketsPerHour: 60, concurrentStreams: 2 }
        : { drm: { enabled: true, provider: 'gumlet', gumlet: gumletCfg } },
  };

  const gumlet = new GumletDrmService(config as never);
  const drmVerification = new DrmVerificationService(prisma as never, gumlet, config as never);
  const signLicence = jest.spyOn(gumlet, 'signLicenseUrl');

  const access = {
    assertContentAccess: jest.fn(async (a: { courseId: string }) => {
      if (!entitled.has(a.courseId)) throw Object.assign(new Error('NOT_ENROLLED'), { code: 'NOT_ENROLLED' });
    }),
    assertSectionAccessible: jest.fn(async () => undefined),
    // Heartbeat re-authorisation.
    resolve: jest.fn(async (a: { courseId: string }) =>
      entitled.has(a.courseId)
        ? { canAccessContent: true, state: 'ACTIVE' }
        : { canAccessContent: false, state: 'NOT_ENROLLED', denialCode: 'NOT_ENROLLED' },
    ),
  };

  const playback = new PlaybackService(
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
    } as never,
    access as never,
    { assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'dev_1' })) } as never,
    { signMediaUrl: jest.fn(async () => 'https://media.example/caption.vtt') } as never,
    {} as never,
    {} as never,
    { record: jest.fn() } as never,
    gumlet,
    drmVerification,
    config as never,
  );

  const issue = (lessonId?: string) =>
    playback.issueTicket({ user: STUDENT, videoId: 'vid_1', lessonId, platform: 'web', integritySuspect: false });

  /** Heartbeat on a stored ticket; `expiresInMs` small enough forces rotation. */
  const heartbeat = (ticket: Row, expiresInMs: number) => {
    existingTicket = {
      id: 'tid_live',
      userId: 'usr_1',
      videoId: 'vid_1',
      status: 'ACTIVE',
      deviceId: 'dev_1',
      maxHeight: null,
      playId: 'play_1',
      expiresAt: new Date(Date.now() + expiresInMs),
      ...ticket,
    };
    return playback.heartbeat({ user: STUDENT, ticketId: 'tid_live', positionSeconds: 120, watchedDeltaSeconds: 30 });
  };

  return { video, tickets, drmVerification, signLicence, issue, heartbeat, access, ticketUpdates: () => ticketUpdates };
}

describe('existing eligible Gumlet asset with drmRequested=false', () => {
  it('is refused before verification, verified once, then issues a playable Widevine ticket', async () => {
    const w = world();

    await expect(w.issue()).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
    expect(w.signLicence).not.toHaveBeenCalled();
    // A refused video leaves no ACTIVE grant behind.
    expect(w.tickets).toHaveLength(0);

    const verdict = await w.drmVerification.verify('vid_1');
    expect(verdict).toEqual({ playable: true, reason: null });
    expect(w.video.drmRequested).toBe(true);
    expect(w.video.drmVerifiedAt).toBeInstanceOf(Date);

    // The hot path agrees with verify() - this is the regression.
    await expect(w.drmVerification.evaluateVideo('vid_1')).resolves.toEqual({ playable: true, reason: null });

    const ticket = await w.issue();
    expect(ticket.drm).toMatchObject({ scheme: 'widevine' });
    expect(ticket.drm?.licenseUrl).toMatch(/^https:\/\/widevine\.gumlet\.com\/licence\/org_1\/asset_1\?/);
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_src', courseId: 'crs_src' });
  });
});

describe('verification failure', () => {
  it('a manifest without CENC is not verified, keeps drmRequested=false and issues no ticket', async () => {
    const w = world({ manifest: UNENCRYPTED });
    const verdict = await w.drmVerification.verify('vid_1');
    expect(verdict).toMatchObject({ playable: false, reason: 'NOT_VERIFIED' });
    expect(w.video).toMatchObject({ drmVerifiedAt: null, drmRequested: false });
    await expect(w.issue()).rejects.toBeDefined();
    expect(w.signLicence).not.toHaveBeenCalled();
  });

  it('a previously verified asset that stops verifying loses playback', async () => {
    const w = world({ row: { drmRequested: true, drmVerifiedAt: new Date() }, manifest: UNENCRYPTED });
    await w.drmVerification.verify('vid_1');
    expect(w.video.drmVerifiedAt).toBeNull();
    await expect(w.issue()).rejects.toBeDefined();
  });
});

describe('expired verification', () => {
  it('a verification older than the TTL is refused as VERIFICATION_STALE until re-verified', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
    const w = world({ row: { drmRequested: true, drmVerifiedAt: sevenHoursAgo } });

    await expect(w.issue()).rejects.toMatchObject({ details: { drmState: 'VERIFICATION_STALE' } });

    await w.drmVerification.verify('vid_1');
    await expect(w.issue()).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
  });
});

describe('asset not eligible for DRM', () => {
  it('Gumlet records no DRM and we never requested it: DRM_NOT_REQUESTED, nothing enabled', async () => {
    const w = world({ drmType: '' });
    const verdict = await w.drmVerification.verify('vid_1');
    expect(verdict).toMatchObject({ playable: false, reason: 'DRM_NOT_REQUESTED' });
    expect(w.video).toMatchObject({ drmRequested: false, drmVerifiedAt: null });
    await expect(w.issue()).rejects.toBeDefined();
  });

  it('Gumlet does not report DRM systems at all and we never requested it: refused', async () => {
    const w = world({ drmType: null });
    expect(await w.drmVerification.verify('vid_1')).toMatchObject({ playable: false, reason: 'DRM_NOT_REQUESTED' });
    expect(w.video.drmRequested).toBe(false);
  });

  it('FairPlay-only provider record does not establish Widevine/CENC DASH intent', async () => {
    const w = world({ drmType: 'fairplay' });
    expect(await w.drmVerification.verify('vid_1')).toMatchObject({ playable: false, reason: 'DRM_NOT_REQUESTED' });
  });

  it('our own adopt() record suffices when the provider omits the field', async () => {
    const w = world({ drmType: null, row: { drmRequested: true } });
    expect(await w.drmVerification.verify('vid_1')).toEqual({ playable: true, reason: null });
  });

  it('a legacy (non-Gumlet) video is never verified or played', async () => {
    const w = world({ row: { drmProvider: null, gumletAssetId: null } });
    expect(await w.drmVerification.verify('vid_1')).toMatchObject({ playable: false, reason: 'NO_GUMLET_ASSET' });
    await expect(w.issue()).rejects.toBeDefined();
    expect(w.video.drmRequested).toBe(false);
  });
});

describe('verification never weakens entitlement', () => {
  const shared = [lesson('les_src', 'crs_src'), lesson('les_dst', 'crs_dst')];

  it('a verified shared asset plays through the destination lecture, authorised on the destination course', async () => {
    const w = world({ attachments: shared });
    await w.drmVerification.verify('vid_1');
    await w.issue('les_dst');
    expect(w.access.assertContentAccess).toHaveBeenCalledWith(expect.objectContaining({ courseId: 'crs_dst' }));
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_dst', courseId: 'crs_dst' });
  });

  it('an unentitled student is refused even though DRM is verified', async () => {
    const w = world({ attachments: shared, entitledCourses: ['crs_src'] });
    await w.drmVerification.verify('vid_1');
    await expect(w.issue('les_dst')).rejects.toMatchObject({ code: 'NOT_ENROLLED' });
    expect(w.tickets).toHaveLength(0);
    expect(w.signLicence).not.toHaveBeenCalled();
  });

  it('a lecture the asset is not attached to is refused', async () => {
    const w = world({ attachments: shared });
    await w.drmVerification.verify('vid_1');
    await expect(w.issue('les_elsewhere')).rejects.toMatchObject({ code: 'PLAYBACK_DENIED' });
    expect(w.tickets).toHaveLength(0);
  });

  it('Fix 3: a verified video with NO lesson attachment is refused, even naming its video.lessonId', async () => {
    const w = world({ attachments: [] });
    await w.drmVerification.verify('vid_1');
    for (const lessonId of [undefined, 'les_src']) {
      await expect(w.issue(lessonId)).rejects.toMatchObject({
        code: 'VIDEO_UNAVAILABLE',
        details: { reason: 'NO_LESSON_ATTACHMENT' },
      });
    }
    expect(w.access.assertContentAccess).not.toHaveBeenCalled();
    expect(w.tickets).toHaveLength(0);
  });

  it('a shared asset with no lecture named is refused rather than guessed', async () => {
    const w = world({ attachments: shared });
    await w.drmVerification.verify('vid_1');
    await expect(w.issue()).rejects.toMatchObject({ code: 'PLAYBACK_DENIED' });
  });
});

describe('Fix 6: heartbeat and rotation keep the destination lesson', () => {
  const shared = [lesson('les_src', 'crs_src'), lesson('les_dst', 'crs_dst')];
  const onDestination = { lessonId: 'les_dst', courseId: 'crs_dst' };

  it('re-authorises every beat against the DESTINATION course', async () => {
    const w = world({ attachments: shared, row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const res = await w.heartbeat(onDestination, 10 * 60 * 1000);
    expect(res).toEqual({ ok: true, terminate: null });
    expect(w.access.resolve).toHaveBeenCalledWith(expect.objectContaining({ courseId: 'crs_dst' }));
  });

  it('rotates INSIDE the destination lecture rather than re-resolving the shared asset', async () => {
    const w = world({ attachments: shared, row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const res = await w.heartbeat(onDestination, 5 * 1000);
    expect(res).toMatchObject({ ok: true, ticket: { drm: { scheme: 'widevine' } } });
    expect(w.tickets).toHaveLength(1);
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_dst', courseId: 'crs_dst', rotatedFromId: 'tid_live' });
  });

  it('rotation still passes the strict DRM gate: a stale verification ends playback', async () => {
    const w = world({
      attachments: shared,
      row: { drmRequested: true, drmVerifiedAt: new Date(Date.now() - 7 * 3600 * 1000) },
    });
    await expect(w.heartbeat(onDestination, 5 * 1000)).rejects.toMatchObject({
      details: { drmState: 'VERIFICATION_STALE' },
    });
    // No replacement grant, and the live ticket was not released first.
    expect(w.tickets).toHaveLength(0);
    expect(w.ticketUpdates().filter((u) => u.data.status === 'RELEASED')).toEqual([]);
  });

  it('losing the destination enrolment terminates playback even though the source course is still owned', async () => {
    const w = world({
      attachments: shared,
      entitledCourses: ['crs_src'],
      row: { drmRequested: true, drmVerifiedAt: new Date() },
    });
    const res = await w.heartbeat(onDestination, 10 * 60 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'NOT_ENROLLED' } });
  });

  it('a ticket revoked by detaching its lecture is terminated at the next beat', async () => {
    const w = world({ attachments: shared, row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const res = await w.heartbeat({ ...onDestination, status: 'REVOKED', revokedReason: 'Video removed from this lecture' }, 10 * 60 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'Video removed from this lecture' } });
  });
});
