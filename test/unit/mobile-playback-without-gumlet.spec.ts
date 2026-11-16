import { ContentStatus, UserRole, VideoStatus } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { LessonsController } from '../../src/modules/lessons/lessons.controller';
import { PlaybackService } from '../../src/modules/playback/playback.service';
import {
  gumletStateOf,
  mobileJobIdFor,
  mobileLadderCanCarry,
  sourceStateOf,
  studentFacingVideoStatus,
  uploadTranscodeJobIdFor,
} from '../../src/modules/videos/pipeline-state';

import { buildDrmVerification } from './helpers/drm-doubles';

/**
 * MOBILE PLAYBACK DOES NOT DEPEND ON GUMLET
 * =========================================
 *
 * `Video.status` is the Gumlet/web pipeline's state. The ticket endpoint used
 * to refuse on it before looking at anything else, so a lecture whose Gumlet
 * asset was rejected could not be played on a phone even though its own HLS
 * ladder - produced by a different system from the same file - was READY.
 *
 * What is pinned here:
 *
 *   - a bound, HLS-capable mobile device IS served the ready ladder when
 *     Gumlet failed or is still working;
 *   - the web, an old app build, an unbound device and a switched-off mobile
 *     delivery are refused EXACTLY as before - the exception is one case, not
 *     a loosening;
 *   - every protection in front of a grant still runs for that one case:
 *     lesson authorisation, device authorisation, the concurrency slot, the
 *     play allowance, the watermark;
 *   - and the reverse: a failed or missing mobile ladder never stops a working
 *     Gumlet stream.
 */

const STUDENT = { id: 'usr_student', role: UserRole.STUDENT, sessionId: 'ses_1', deviceKey: 'dk_1', deviceId: 'dev_1' } as const;

interface Options {
  videoStatus?: VideoStatus;
  mobileStatus?: string;
  renditions?: { height: number }[];
  hlsPrefix?: string | null;
  device?: { platform: string; status: string } | null;
  mobile?: { delivery: 'hls' | 'gumlet'; gumletFallback: boolean } | null;
  override?: { delivery: 'hls' | 'gumlet' } | null;
  deviceRefused?: boolean;
  lessonRefused?: boolean;
  gumletStatus?: string | null;
}

function build(options: Options = {}) {
  const lesson = {
    id: 'les_1',
    title: 'Lecture 1',
    status: ContentStatus.PUBLISHED,
    isPreview: false,
    courseId: 'crs_1',
    sectionId: 'sec_1',
    deletedAt: null,
    section: { unlocksAt: null, status: ContentStatus.PUBLISHED },
  };
  const video = {
    id: 'vid_1',
    courseId: 'crs_1',
    lessonId: 'les_1',
    status: options.videoStatus ?? VideoStatus.READY,
    drmProvider: 'gumlet',
    gumletAssetId: options.videoStatus === VideoStatus.FAILED ? null : 'asset_1',
    gumletWorkspaceId: 'ws_1',
    gumletStatus: options.gumletStatus === undefined ? 'ready' : options.gumletStatus,
    drmRequested: true,
    drmVerifiedAt: new Date(),
    drmBlockedReason: null,
    mobileStatus: options.mobileStatus ?? 'READY',
    hlsPrefix: options.hlsPrefix === undefined ? 'hls/vid_1/' : options.hlsPrefix,
    masterPlaylistKey: 'hls/vid_1/master.m3u8',
    durationSeconds: 600,
    renditions: options.renditions ?? [{ height: 480 }, { height: 720 }],
    captions: [],
    lesson,
    lessonLinks: [{ lesson }],
  };

  const ticketCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'tkt_1',
    expiresAt: new Date(Date.now() + 300_000),
    ...args.data,
  }));
  const playCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'vp_new',
    attemptNumber: args.data.attemptNumber as number,
  }));
  const prisma = {
    video: { findFirst: jest.fn(async () => video) },
    device: {
      findUnique: jest.fn(async () =>
        options.device === undefined ? { platform: 'android', status: 'ACTIVE' } : options.device,
      ),
    },
    videoPlay: {
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
      create: playCreate,
      update: jest.fn(async () => ({ id: 'vp' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      aggregate: jest.fn(async () => ({ _max: { attemptNumber: null } })),
    },
    playbackTicket: { create: ticketCreate },
    user: { findUniqueOrThrow: jest.fn(async () => ({ fullName: 'Test Student', phone: '01000000010' })) },
    watchProgress: { findUnique: jest.fn(async () => null) },
    securityEvent: { create: jest.fn(async () => ({})) },
    watchEvent: { create: jest.fn(async () => ({})) },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };

  const access = {
    assertContentAccess: jest.fn(async () => {
      if (options.lessonRefused) throw Object.assign(new Error('not enrolled'), { code: ErrorCode.NOT_ENROLLED });
      return { canAccessContent: true };
    }),
    assertSectionAccessible: jest.fn(async () => undefined),
    resolve: jest.fn(async () => ({ canAccessContent: true })),
  };
  const devices = {
    assertAuthorizedForProtectedContent: jest.fn(async () => {
      if (options.deviceRefused) throw Object.assign(new Error('device'), { code: ErrorCode.DEVICE_NOT_AUTHORIZED });
      return { deviceId: 'dev_1' };
    }),
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
            maxPlaysPerVideo: 3,
            playResumeWindow: 2700,
            minCountedPlaySeconds: 30,
          }
        : {
            drm: {
              enabled: true,
              provider: 'gumlet',
              gumlet: { apiKey: 'k', workspaceId: 'ws_1', orgId: 'org_1', signSecret: Buffer.from('s').toString('base64') },
            },
            ...(options.mobile === null ? {} : { mobile: options.mobile ?? { delivery: 'hls', gumletFallback: true } }),
          },
    get: () => undefined,
  };
  const redis = {
    incr: jest.fn(async () => 1),
    remember: jest.fn(),
    getJson: jest.fn(async () => options.override ?? null),
  };
  const manifest = { buildMasterUrl: jest.fn(() => 'https://api.example/api/v1/playback/manifest/tkt_1/master.m3u8?exp=1&sig=x') };

  const service = new PlaybackService(
    prisma as never,
    redis as never,
    access as never,
    devices as never,
    { signMediaUrl: jest.fn(async () => 'https://gate.example/x') } as never,
    manifest as never,
    { mint: jest.fn(() => 'tok') } as never,
    { record: jest.fn(async () => undefined) } as never,
    {
      signLicenseUrl: jest.fn(() => ({
        licenseUrl: 'https://widevine.gumlet.com/licence/org_1/a_1?token=T',
        certificateUrl: 'https://fairplay.gumlet.com/certificate/org_1',
        manifestUrl: null,
        expires: 1,
        expiresIso: new Date().toISOString(),
        signedString: 's',
        hardwareSecure: true,
        videoRobustness: ['HW_SECURE_ALL'],
        audioRobustness: ['HW_SECURE_ALL'],
      })),
      signFairPlayLicenseUrl: jest.fn(() => 'https://fairplay.gumlet.com/licence/org_1/a_1?token=T'),
      dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
      hlsManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.m3u8'),
    } as never,
    buildDrmVerification({ row: { id: 'vid_1' } }) as never,
    config as never,
  );

  jest.spyOn(service as never as { enforceIssuanceRate: () => Promise<void> }, 'enforceIssuanceRate').mockResolvedValue(undefined);
  const slot = jest
    .spyOn(service as never as { acquireStreamSlot: () => Promise<void> }, 'acquireStreamSlot')
    .mockResolvedValue(undefined);

  const issue = (request: { platform?: 'android' | 'ios' | 'web'; capabilities?: string[] } = {}) =>
    service.issueTicket({
      user: STUDENT as never,
      videoId: 'vid_1',
      platform: request.platform ?? 'android',
      capabilities: 'capabilities' in request ? request.capabilities : ['hls-aes128'],
      integritySuspect: false,
    } as never);

  return { service, prisma, access, devices, slot, ticketCreate, playCreate, manifest, issue };
}

const HLS_APP = { platform: 'android' as const, capabilities: ['hls-aes128'] };

describe('Gumlet is not READY, the mobile ladder is', () => {
  it.each([VideoStatus.FAILED, VideoStatus.QUEUED, VideoStatus.PROCESSING])(
    'a bound HLS-capable device is served the ladder while Gumlet is %s',
    async (videoStatus) => {
      const t = build({ videoStatus });

      const ticket = await t.issue(HLS_APP);

      expect(ticket.drm.scheme).toBe('none');
      expect(ticket.manifestUrl).toContain('/playback/manifest/');
      expect(t.ticketCreate.mock.calls[0]![0].data).toMatchObject({ delivery: 'hls', videoId: 'vid_1' });
    },
  );

  it('every protection in front of the grant still runs', async () => {
    const t = build({ videoStatus: VideoStatus.FAILED });

    const ticket = await t.issue(HLS_APP);

    expect(t.access.assertContentAccess).toHaveBeenCalled();
    expect(t.devices.assertAuthorizedForProtectedContent).toHaveBeenCalledTimes(1);
    expect(t.slot).toHaveBeenCalledTimes(1);
    // The play allowance is counted, exactly as for a Gumlet grant.
    expect(t.playCreate).toHaveBeenCalledTimes(1);
    expect(ticket.watermark).toBeTruthy();
  });

  it('a student who is not entitled is refused before the pipeline is even considered', async () => {
    const t = build({ videoStatus: VideoStatus.FAILED, lessonRefused: true });
    await expect(t.issue(HLS_APP)).rejects.toMatchObject({ code: ErrorCode.NOT_ENROLLED });
    expect(t.ticketCreate).not.toHaveBeenCalled();
  });

  it('an unauthorised device is refused by the device check, as always', async () => {
    const t = build({ videoStatus: VideoStatus.FAILED, deviceRefused: true });
    await expect(t.issue(HLS_APP)).rejects.toMatchObject({ code: ErrorCode.DEVICE_NOT_AUTHORIZED });
    expect(t.ticketCreate).not.toHaveBeenCalled();
  });
});

describe('the exception is exactly one case - everything else is refused as before', () => {
  const refusals: [string, Options, Parameters<ReturnType<typeof build>['issue']>[0], ErrorCode][] = [
    ['the web player (Gumlet failed)', { videoStatus: VideoStatus.FAILED, device: { platform: 'web', status: 'ACTIVE' } }, { platform: 'web', capabilities: undefined }, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['the web player (Gumlet still processing)', { videoStatus: VideoStatus.PROCESSING, device: { platform: 'web', status: 'ACTIVE' } }, { platform: 'web', capabilities: undefined }, ErrorCode.VIDEO_NOT_READY],
    ['an app build that does not declare hls-aes128', { videoStatus: VideoStatus.FAILED }, { platform: 'android', capabilities: undefined }, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['a session with no bound device row', { videoStatus: VideoStatus.FAILED, device: null }, HLS_APP, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['a revoked device binding', { videoStatus: VideoStatus.FAILED, device: { platform: 'android', status: 'REVOKED' } }, HLS_APP, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['mobile delivery configured as gumlet', { videoStatus: VideoStatus.FAILED, mobile: { delivery: 'gumlet', gumletFallback: true } }, HLS_APP, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['the operator override back to gumlet', { videoStatus: VideoStatus.QUEUED, override: { delivery: 'gumlet' } }, HLS_APP, ErrorCode.VIDEO_NOT_READY],
    ['no mobile pipeline configured at all', { videoStatus: VideoStatus.FAILED, mobile: null }, HLS_APP, ErrorCode.VIDEO_PROCESSING_FAILED],
  ];

  it.each(refusals)('%s', async (_name, options, request, code) => {
    const t = build(options);

    await expect(t.issue(request)).rejects.toMatchObject({ code });

    // Refused before anything is consumed.
    expect(t.slot).not.toHaveBeenCalled();
    expect(t.playCreate).not.toHaveBeenCalled();
    expect(t.ticketCreate).not.toHaveBeenCalled();
  });

  const neverCarried: [string, Options, ErrorCode][] = [
    ['the source is being (re)uploaded', { videoStatus: VideoStatus.UPLOADING }, ErrorCode.VIDEO_NOT_READY],
    ['the lecture is archived', { videoStatus: VideoStatus.ARCHIVED }, ErrorCode.VIDEO_UNAVAILABLE],
    ['the mobile ladder failed too', { videoStatus: VideoStatus.FAILED, mobileStatus: 'FAILED' }, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['the mobile ladder is still encoding', { videoStatus: VideoStatus.PROCESSING, mobileStatus: 'PROCESSING' }, ErrorCode.VIDEO_NOT_READY],
    ['the mobile ladder was never made', { videoStatus: VideoStatus.FAILED, mobileStatus: 'NONE' }, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['READY is claimed but there are no renditions', { videoStatus: VideoStatus.FAILED, renditions: [] }, ErrorCode.VIDEO_PROCESSING_FAILED],
    ['READY is claimed but there is no output prefix', { videoStatus: VideoStatus.FAILED, hlsPrefix: null }, ErrorCode.VIDEO_PROCESSING_FAILED],
  ];

  it.each(neverCarried)('%s: refused at once, before any authorisation work', async (_name, options, code) => {
    const t = build(options);

    await expect(t.issue(HLS_APP)).rejects.toMatchObject({ code });

    expect(t.devices.assertAuthorizedForProtectedContent).not.toHaveBeenCalled();
    expect(t.ticketCreate).not.toHaveBeenCalled();
  });
});

describe('a failed mobile ladder never stops a working Gumlet stream', () => {
  it.each(['FAILED', 'NONE', 'QUEUED', 'PROCESSING'])(
    'Gumlet READY, mobile %s: the app is served its Gumlet stream',
    async (mobileStatus) => {
      const t = build({ videoStatus: VideoStatus.READY, mobileStatus });

      const ticket = await t.issue(HLS_APP);

      expect(ticket.drm.scheme).toBe('widevine');
      expect(t.ticketCreate.mock.calls[0]![0].data).toMatchObject({ delivery: 'gumlet' });
    },
  );

  it('and the web is untouched by any mobile state', async () => {
    const t = build({ videoStatus: VideoStatus.READY, mobileStatus: 'FAILED', device: { platform: 'web', status: 'ACTIVE' } });
    const ticket = await t.issue({ platform: 'web', capabilities: undefined });
    expect(ticket.drm.scheme).toBe('widevine');
  });
});

describe('the status a student client is shown', () => {
  const ready = { mobileStatus: 'READY', hlsPrefix: 'hls/v/', renditions: [{ height: 720 }] };

  it('a native app sees READY when its own ladder can play a lecture Gumlet could not', () => {
    for (const status of ['FAILED', 'QUEUED', 'PROCESSING']) {
      expect(studentFacingVideoStatus({ status, ...ready }, { mobileHls: true })).toBe('READY');
      // Everyone else sees the raw Gumlet state.
      expect(studentFacingVideoStatus({ status, ...ready }, { mobileHls: false })).toBe(status);
    }
  });

  it('never upgrades an upload in progress, an archived lecture, or a missing ladder', () => {
    expect(studentFacingVideoStatus({ status: 'UPLOADING', ...ready }, { mobileHls: true })).toBe('UPLOADING');
    expect(studentFacingVideoStatus({ status: 'ARCHIVED', ...ready }, { mobileHls: true })).toBe('ARCHIVED');
    expect(studentFacingVideoStatus({ status: 'FAILED', ...ready, mobileStatus: 'FAILED' }, { mobileHls: true })).toBe('FAILED');
    expect(studentFacingVideoStatus({ status: 'FAILED', ...ready, renditions: [] }, { mobileHls: true })).toBe('FAILED');
    expect(mobileLadderCanCarry({ status: 'READY', ...ready })).toBe(false);
  });

  it('the lesson endpoints derive the client from the device headers and the delivery switch', async () => {
    const lessons = { detail: jest.fn(async () => ({})), byVideoId: jest.fn(async () => ({})) };
    const controller = (delivery: string | undefined) =>
      new LessonsController(lessons as never, { get: () => (delivery ? { mobile: { delivery } } : undefined) } as never);
    const user = { id: 'u', role: 'STUDENT' } as never;
    const device = (platform: string | null) => ({ platform }) as never;

    await controller('hls').detail('les_1', user, device('Android'));
    await controller('hls').detail('les_1', user, device('ios'));
    await controller('hls').detail('les_1', user, device('web'));
    await controller('hls').detail('les_1', user, null as never);
    await controller('gumlet').detail('les_1', user, device('android'));
    await controller(undefined).detail('les_1', user, device('android'));
    await controller('hls').byVideo('vid_1', user, device('ios'), 'les_1');

    expect(lessons.detail.mock.calls.map((call) => (call as unknown[])[3])).toEqual([
      { mobileHls: true },
      { mobileHls: true },
      { mobileHls: false },
      { mobileHls: false },
      { mobileHls: false },
      { mobileHls: false },
    ]);
    expect(lessons.byVideoId).toHaveBeenCalledWith('vid_1', 'u', 'STUDENT', 'les_1', { mobileHls: true });
  });
});

describe('the three states are derived from the row, independently', () => {
  it('source', () => {
    expect(sourceStateOf({ sourceKey: null, sourceSizeBytes: null })).toBe('NONE');
    expect(sourceStateOf({ sourceKey: 'k', sourceSizeBytes: null })).toBe('UPLOADING');
    expect(sourceStateOf({ sourceKey: 'k', sourceSizeBytes: BigInt(10) })).toBe('VERIFIED');
  });

  it('gumlet', () => {
    const g = (status: string, gumletAssetId: string | null, gumletStatus: string | null, drmProvider: string | null = 'gumlet') =>
      gumletStateOf({ status, drmProvider, gumletAssetId, gumletStatus });
    expect(g('READY', null, null, null)).toBe('NOT_APPLICABLE');
    expect(g('UPLOADING', null, null)).toBe('WAITING_UPLOAD');
    expect(g('QUEUED', null, null)).toBe('PENDING');
    expect(g('PROCESSING', 'a', 'queued')).toBe('SUBMITTED');
    expect(g('PROCESSING', 'a', 'processing')).toBe('PROCESSING');
    expect(g('READY', 'a', 'ready')).toBe('READY');
    expect(g('FAILED', 'a', 'errored')).toBe('FAILED');
    expect(g('FAILED', null, null)).toBe('FAILED');
    // An asset deleted at the provider is failed even if the row still says READY.
    expect(g('READY', 'a', 'deleted')).toBe('FAILED');
  });

  it('job identities are a function of the work, and valid BullMQ custom ids', () => {
    expect(mobileJobIdFor('v_1', 3)).toBe(mobileJobIdFor('v_1', 3));
    expect(mobileJobIdFor('v_1', 3)).not.toBe(mobileJobIdFor('v_1', 4));
    expect(uploadTranscodeJobIdFor('v_1', 'source/a.mp4')).toBe(uploadTranscodeJobIdFor('v_1', 'source/a.mp4'));
    expect(uploadTranscodeJobIdFor('v_1', 'source/a.mp4')).not.toBe(uploadTranscodeJobIdFor('v_1', 'source/b.mp4'));
    // BullMQ rejects a custom id unless it has exactly three colon-separated parts.
    for (const id of [mobileJobIdFor('cmv8a242y015ffz014zd1f68o', 12), uploadTranscodeJobIdFor('cmv8a242y015ffz014zd1f68o', 'source/x y.mp4')]) {
      expect(id.split(':')).toHaveLength(3);
      expect(String(Number.parseInt(id, 10))).not.toBe(id);
    }
  });
});
