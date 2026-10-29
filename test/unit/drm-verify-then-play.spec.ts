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
  /** Gumlet unreachable: every provider request fails at the network level. */
  gumletDown?: boolean;
  /** What device binding answers for the requesting device (default: dev_1, active). */
  deviceResult?: () => Promise<{ deviceId: string | null }>;
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

  const providerCalls: string[] = [];
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    providerCalls.push(url.startsWith('https://api.gumlet.com/') ? 'asset-api' : 'manifest');
    if (opts.gumletDown) throw new TypeError('fetch failed');
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

  const redisStore = new Map<string, unknown>();
  const playback = new PlaybackService(
    prisma as never,
    {
      incrementWindow: jest.fn(async () => 1),
      key: jest.fn((k: string) => k),
      getJson: jest.fn(async (k: string) => redisStore.get(k) ?? null),
      setJson: jest.fn(async (k: string, v: unknown) => {
        redisStore.set(k, v);
      }),
      client: {
        zremrangebyscore: jest.fn(async () => 0),
        zcard: jest.fn(async () => 0),
        zadd: jest.fn(async () => 1),
        expire: jest.fn(async () => 1),
        zrem: jest.fn(async () => 1),
      },
    } as never,
    access as never,
    {
      assertAuthorizedForProtectedContent: jest.fn(opts.deviceResult ?? (async () => ({ deviceId: 'dev_1' }))),
    } as never,
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

  return {
    video, tickets, drmVerification, signLicence, issue, heartbeat, access, prisma, playback,
    ticketUpdates: () => ticketUpdates,
    providerCalls: () => [...providerCalls],
  };
}

describe('existing eligible Gumlet asset with drmRequested=false', () => {
  it('a separate verify() establishes the proof, and the hot path agrees with it', async () => {
    const w = world();
    const verdict = await w.drmVerification.verify('vid_1');
    expect(verdict).toEqual({ playable: true, reason: null });
    expect(w.video.drmRequested).toBe(true);
    expect(w.video.drmVerifiedAt).toBeInstanceOf(Date);
    // The hot path agrees with verify() - this is the Fix 2 regression.
    await expect(w.drmVerification.evaluateVideo('vid_1')).resolves.toEqual({ playable: true, reason: null });
  });

  it('with NO worker and NO prior sweep, the first ticket request verifies on demand and plays', async () => {
    const w = world();

    const ticket = await w.issue();

    expect(ticket.drm).toMatchObject({ scheme: 'widevine' });
    expect(ticket.drm?.licenseUrl).toMatch(/^https:\/\/widevine\.gumlet\.com\/licence\/org_1\/asset_1\?/);
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_src', courseId: 'crs_src' });
    expect(w.video).toMatchObject({ drmRequested: true, drmVerifiedAt: expect.any(Date) });
    expect(w.providerCalls()).toEqual(['asset-api', 'manifest']);
  });

  it('a fresh proof is served without asking the provider again', async () => {
    const w = world();
    await w.issue();
    const calls = w.providerCalls().length;
    await w.issue();
    expect(w.providerCalls()).toHaveLength(calls);
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

describe('expired verification (no worker needed)', () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

  it('a proof older than the TTL is renewed on demand by the ticket request', async () => {
    const w = world({ row: { drmRequested: true, drmVerifiedAt: hoursAgo(7) } });
    await expect(w.issue()).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect((w.video.drmVerifiedAt as Date).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('Gumlet unreachable: an earlier proof inside TTL + grace still plays, and is NOT erased', async () => {
    const proof = hoursAgo(7); // TTL 6 h, default grace 24 h
    const w = world({ gumletDown: true, row: { drmRequested: true, drmVerifiedAt: proof } });
    await expect(w.issue()).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect(w.video.drmVerifiedAt).toEqual(proof);
  });

  it('Gumlet unreachable: a proof older than TTL + grace is refused (and still not erased)', async () => {
    const proof = hoursAgo(31);
    const w = world({ gumletDown: true, row: { drmRequested: true, drmVerifiedAt: proof } });
    await expect(w.issue()).rejects.toMatchObject({ details: { drmState: 'VERIFICATION_STALE' } });
    expect(w.video.drmVerifiedAt).toEqual(proof);
    expect(w.tickets).toHaveLength(0);
  });

  it('Gumlet unreachable: a video that was NEVER verified is refused - grace needs a real earlier proof', async () => {
    const w = world({ gumletDown: true });
    await expect(w.issue()).rejects.toBeDefined();
    expect(w.tickets).toHaveLength(0);
    expect(w.signLicence).not.toHaveBeenCalled();
  });

  it('a lapsed proof that now fails DEFINITIVELY (manifest unencrypted) is cleared and refused', async () => {
    const w = world({ manifest: UNENCRYPTED, row: { drmRequested: true, drmVerifiedAt: hoursAgo(7) } });
    await expect(w.issue()).rejects.toBeDefined();
    expect(w.video.drmVerifiedAt).toBeNull();
    expect(w.tickets).toHaveLength(0);
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

  // The six shared-video lectures and clients that send no lessonId (native
  // app, older web builds): resolved to the first lecture the student passes
  // the full checks for - never one they could not open by naming it.
  it('old client, shared asset, entitled only via the DESTINATION: plays as the destination lecture', async () => {
    const w = world({ attachments: shared, entitledCourses: ['crs_dst'] });
    await expect(w.issue()).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_dst', courseId: 'crs_dst' });
  });

  it('old client, shared asset, entitled via the SOURCE: plays as the source lecture (as it does today)', async () => {
    const w = world({ attachments: shared, entitledCourses: ['crs_src'] });
    await expect(w.issue()).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_src', courseId: 'crs_src' });
  });

  it('old client, shared asset, entitled via neither: refused, no ticket, no licence signed', async () => {
    const w = world({ attachments: shared, entitledCourses: [] });
    await expect(w.issue()).rejects.toMatchObject({ code: 'NOT_ENROLLED' });
    expect(w.tickets).toHaveLength(0);
    expect(w.signLicence).not.toHaveBeenCalled();
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

  it('rotation renews a lapsed proof on demand and keeps playing (no worker needed)', async () => {
    const w = world({
      attachments: shared,
      row: { drmRequested: true, drmVerifiedAt: new Date(Date.now() - 7 * 3600 * 1000) },
    });
    const res = await w.heartbeat(onDestination, 5 * 1000);
    expect(res).toMatchObject({ ok: true, ticket: { drm: { scheme: 'widevine' } } });
    expect(w.tickets[0]).toMatchObject({ lessonId: 'les_dst', courseId: 'crs_dst' });
  });

  it('rotation still passes the strict DRM gate: a lapsed proof that fails definitively ends playback', async () => {
    const w = world({
      attachments: shared,
      manifest: UNENCRYPTED,
      row: { drmRequested: true, drmVerifiedAt: new Date(Date.now() - 7 * 3600 * 1000) },
    });
    await expect(w.heartbeat(onDestination, 5 * 1000)).rejects.toMatchObject({
      details: { drmState: 'NOT_VERIFIED' },
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

describe('T2: one DRM verification per ticket, and none reused across requests', () => {
  const shared = [lesson('les_src', 'crs_src'), lesson('les_dst', 'crs_dst')];
  const onDestination = { lessonId: 'les_dst', courseId: 'crs_dst' };
  const realNow = Date.now.bind(Date);
  let skewMs = 0;
  beforeEach(() => {
    skewMs = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);
  });
  afterEach(() => jest.restoreAllMocks());

  it('issuing a ticket runs the gate ONCE (previously twice)', async () => {
    const w = world({ row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const gate = jest.spyOn(w.drmVerification, 'ensurePlayable');
    await expect(w.issue('les_src')).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(w.signLicence).toHaveBeenCalledTimes(1);
  });

  it('a lapsed proof is renewed with ONE provider round trip per ticket (1 asset + 1 manifest read)', async () => {
    const w = world({ row: { drmRequested: true, drmVerifiedAt: new Date(Date.now() - 7 * 3600 * 1000) } });
    const gate = jest.spyOn(w.drmVerification, 'ensurePlayable');
    await expect(w.issue('les_src')).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(w.providerCalls()).toEqual(['asset-api', 'manifest']);
  });

  it('a rotation runs the gate ONCE (previously three times), before releasing the live ticket', async () => {
    const w = world({ attachments: shared, row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const order: string[] = [];
    const gate = jest.spyOn(w.drmVerification, 'ensurePlayable').mockImplementation(async function (this: unknown, id: string) {
      order.push('gate');
      return DrmVerificationService.prototype.ensurePlayable.call(w.drmVerification, id);
    });
    w.prisma.playbackTicket.update.mockImplementation(async (a: { data: Row }) => {
      if (a.data.status === 'RELEASED') order.push('release');
      return {};
    });
    const res = await w.heartbeat(onDestination, 5 * 1000);
    expect(res).toMatchObject({ ok: true, ticket: { drm: { scheme: 'widevine' } } });
    expect(gate).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['gate', 'release']);
    expect(w.tickets).toEqual([expect.objectContaining({ lessonId: 'les_dst', rotatedFromId: 'tid_live' })]);
  });

  it('state changing BETWEEN requests is always seen: no pass outlives its request', async () => {
    const w = world({ attachments: shared, row: { drmRequested: true, drmVerifiedAt: new Date() } });
    await expect(w.issue('les_dst')).resolves.toBeTruthy();
    // Gumlet / staff mark the asset unservable after the first ticket.
    Object.assign(w.video, { drmVerifiedAt: null, drmBlockedReason: 'NOT_VERIFIED: manifest 404' });
    await expect(w.issue('les_dst')).rejects.toMatchObject({ details: { drmState: 'NOT_VERIFIED' } });
    // ...and the next rotation ends playback instead of minting a new grant.
    await expect(w.heartbeat(onDestination, 5 * 1000)).rejects.toMatchObject({ details: { drmState: 'NOT_VERIFIED' } });
    expect(w.tickets).toHaveLength(1);
    expect(w.ticketUpdates().filter((u) => u.data.status === 'RELEASED')).toEqual([]);
  });

  it('a pass gone stale inside one slow request is not trusted: the gate runs again and sees the change', async () => {
    const w = world({ attachments: shared, row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const gate = jest.spyOn(w.drmVerification, 'ensurePlayable');
    // The release write is slow (11 s > the 10 s pass lifetime) and, meanwhile,
    // the asset stops verifying.
    w.prisma.playbackTicket.update.mockImplementation(async (a: { data: Row }) => {
      // Only the release of the live ticket (the beat's own position write is
      // also an update, and comes before the gate).
      if (a.data.status === 'RELEASED') {
        skewMs += 11_000;
        Object.assign(w.video, { drmVerifiedAt: null, drmBlockedReason: 'NOT_VERIFIED: manifest 404' });
      }
      return {};
    });
    await expect(w.heartbeat(onDestination, 5 * 1000)).rejects.toMatchObject({ details: { drmState: 'NOT_VERIFIED' } });
    expect(gate).toHaveBeenCalledTimes(2);
    expect(w.tickets).toHaveLength(0);
    expect(w.signLicence).not.toHaveBeenCalled();
  });

  it('a slow ticket write likewise re-gates before signing', async () => {
    const w = world({ row: { drmRequested: true, drmVerifiedAt: new Date() } });
    const gate = jest.spyOn(w.drmVerification, 'ensurePlayable');
    const create = w.prisma.playbackTicket.create.getMockImplementation()!;
    w.prisma.playbackTicket.create.mockImplementation(async (a: { data: Row }) => {
      skewMs += 11_000;
      return create(a);
    });
    await expect(w.issue('les_src')).resolves.toMatchObject({ drm: { scheme: 'widevine' } });
    expect(gate).toHaveBeenCalledTimes(2);
  });
});

describe('heartbeat hardening: expired grants, device, section scope, key system', () => {
  const onSource = { lessonId: 'les_src', courseId: 'crs_src', lesson: { sectionId: 'sec_les_src', isPreview: false } };
  const verified = { drmRequested: true, drmVerifiedAt: new Date() };

  it('an EXPIRED ticket is terminated, never exchanged for a fresh one', async () => {
    const w = world({ row: verified });
    const res = await w.heartbeat({ ...onSource, status: 'EXPIRED' }, -10 * 60 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'PLAYBACK_TICKET_EXPIRED' } });
    expect(w.tickets).toHaveLength(0);
  });

  it('a ticket well past its expiry (status not yet swept) is terminated too', async () => {
    const w = world({ row: verified });
    const res = await w.heartbeat(onSource, -10 * 60 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'PLAYBACK_TICKET_EXPIRED' } });
    expect(w.tickets).toHaveLength(0);
  });

  it('a beat that is only slightly late (inside the grace) still rotates', async () => {
    const w = world({ row: verified });
    const res = await w.heartbeat(onSource, -5 * 1000);
    expect(res).toMatchObject({ ok: true, ticket: { drm: { scheme: 'widevine' } } });
  });

  it('rotation from a different device than the grant was issued to is refused', async () => {
    const w = world({ row: verified, deviceResult: async () => ({ deviceId: 'dev_other' }) });
    const res = await w.heartbeat(onSource, 5 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'DEVICE_NOT_AUTHORIZED' } });
    expect(w.tickets).toHaveLength(0);
  });

  it('rotation from a device that is no longer authorised is refused', async () => {
    const w = world({
      row: verified,
      deviceResult: async () => {
        throw Object.assign(new Error('DEVICE_NOT_AUTHORIZED'), { code: 'DEVICE_NOT_AUTHORIZED' });
      },
    });
    const res = await w.heartbeat(onSource, 5 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'DEVICE_NOT_AUTHORIZED' } });
  });

  it('a section revoked mid-lesson terminates playback at the next beat', async () => {
    const w = world({ row: verified });
    w.access.assertSectionAccessible.mockImplementationOnce(async () => {
      throw Object.assign(new Error('NOT_ENROLLED'), { code: 'NOT_ENROLLED' });
    });
    const res = await w.heartbeat(onSource, 10 * 60 * 1000);
    expect(res).toEqual({ ok: false, terminate: { reason: 'NOT_ENROLLED' } });
    expect(w.access.assertSectionAccessible).toHaveBeenCalledWith(
      expect.objectContaining({ courseId: 'crs_src', sectionId: 'sec_les_src' }),
    );
  });

  it('a FairPlay (iOS) grant rotates into FairPlay, not Widevine', async () => {
    const w = world({ row: verified });
    const first = await w.playback.issueTicket({
      user: STUDENT, videoId: 'vid_1', lessonId: 'les_src', platform: 'ios', integritySuspect: false,
    });
    expect(first.drm).toMatchObject({ scheme: expect.stringMatching(/fairplay/i) });

    const res = await w.heartbeat({ ...onSource, id: first.ticketId }, 5 * 1000);
    expect(res).toMatchObject({ ok: true });
    const rotated = (res as { ticket: { drm: { scheme: string }; manifestUrl: string } }).ticket;
    expect(rotated.drm.scheme).toBe(first.drm!.scheme);
    // FairPlay is HLS-only at Gumlet, so the rotated grant must stay on HLS.
    expect(rotated.manifestUrl).toMatch(/m3u8/);
  });
});
