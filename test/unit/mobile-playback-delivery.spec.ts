import { ErrorCode } from '../../src/common/errors/error-codes';
import { ManifestService } from '../../src/modules/playback/manifest.service';
import { PlaybackService } from '../../src/modules/playback/playback.service';

/**
 * Platform-aware playback delivery.
 *
 *   WEB     → Gumlet DASH + Widevine, behind the strict DRM gate (unchanged).
 *   MOBILE  → the independent AES-128 HLS pipeline, when the ladder is READY.
 *
 * The decision is made from the DEVICE the session is bound to, not from the
 * `platform` string in the request body, and the manifest endpoints serve only
 * grants that were minted for the HLS pipeline. Those two properties are what
 * keep an ordinary web session from reaching the mobile ladder.
 */

/** Installed apps from before the pipeline never declare `hls-aes128` and keep getting Gumlet. */
describe('client capability gate', () => {
  it('serves Gumlet to a bound mobile device whose app did not declare hls-aes128, even for a READY ladder', async () => {
    const t = buildOverride(null);
    expect(await t.plan(t.video('READY'), 'd_1', undefined, false)).toMatchObject({ delivery: 'gumlet' });
  });

  it('keeps an HLS grant on HLS across a rotation without re-declaring the capability', async () => {
    const t = buildOverride(null);
    expect(await t.plan(t.video('READY'), 'd_1', 'hls', false)).toEqual({ delivery: 'hls' });
  });

  it('serves HLS once the capability is declared', async () => {
    const t = buildOverride(null);
    expect(await t.plan(t.video('READY'), 'd_1', undefined, true)).toEqual({ delivery: 'hls' });
  });
});

/** The runtime override (POST /videos/mobile/delivery) beats the configured switch. */
describe('mobile delivery runtime override', () => {
  it('sends a bound mobile device back to Gumlet for a READY video when the override says gumlet', async () => {
    const t = buildOverride({ delivery: 'gumlet' });
    const plan = await t.plan(t.video('READY'));
    expect(plan).toMatchObject({ delivery: 'gumlet' });
  });

  it('can turn the fallback off at runtime so an unmigrated video is reported as not ready', async () => {
    const t = buildOverride({ delivery: 'hls', gumletFallback: false });
    await expect(t.plan(t.video('NONE'))).rejects.toMatchObject({ code: ErrorCode.VIDEO_NOT_READY });
  });

  it('ignores a malformed override and keeps the configured behaviour', async () => {
    const t = buildOverride({ delivery: 'nonsense' } as never);
    expect(await t.plan(t.video('READY'))).toEqual({ delivery: 'hls' });
  });
});

function buildOverride(override: { delivery: 'hls' | 'gumlet'; gumletFallback?: boolean } | null) {
  return build({ device: { platform: 'android', status: 'ACTIVE' }, override });
}

const FULL_GUMLET = {
  apiKey: 'k',
  workspaceId: 'ws_1',
  orgId: 'org_1',
  signSecret: 's'.repeat(40),
  webEmbedEnabled: false,
  embedTokenLifetimeSeconds: 3600,
};

function build(opts: {
  device?: { platform: string; status: string } | null;
  mobile?: { delivery: 'hls' | 'gumlet'; gumletFallback: boolean };
  override?: { delivery: 'hls' | 'gumlet'; gumletFallback?: boolean } | null;
}) {
  const prisma = {
    device: { findUnique: jest.fn(async () => (opts.device === undefined ? null : opts.device)) },
  };
  const drm = { ensurePlayable: jest.fn(async () => ({ playable: true, reason: 'ok', detail: '' })) };
  const gumlet = {
    signLicenseUrl: jest.fn(() => ({
      licenseUrl: 'https://widevine.gumlet.com/licence/org_1/a_1?token=T',
      certificateUrl: 'https://fairplay.gumlet.com/certificate/org_1',
    })),
    signFairPlayLicenseUrl: jest.fn(() => 'https://fairplay.gumlet.com/licence/org_1/a_1?token=T'),
    dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
    hlsManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.m3u8'),
  };
  const manifest = {
    buildMasterUrl: jest.fn(() => 'https://api.example/api/v1/playback/manifest/t_1/master.m3u8?exp=1&sig=x'),
  };
  const config = {
    getOrThrow: (k: string) =>
      k === 'video'
        ? {
            drm: { enabled: true, provider: 'gumlet', gumlet: FULL_GUMLET },
            mobile: opts.mobile ?? { delivery: 'hls', gumletFallback: true },
          }
        : { ticketTtl: 300 },
    get: () => undefined,
  };
  const redis = { getJson: jest.fn(async () => opts.override ?? null) };
  const service = new PlaybackService(
    prisma as never, redis as never, {} as never, {} as never, {} as never,
    manifest as never, {} as never, {} as never, gumlet as never, drm as never,
    config as never,
  );
  const video = (mobileStatus: string, renditions = [{ height: 720 }]) => ({
    id: 'v_1',
    drmProvider: 'gumlet',
    gumletAssetId: 'a_1',
    gumletWorkspaceId: 'ws_1',
    gumletStatus: 'ready',
    hlsPrefix: 'hls/v_1/',
    masterPlaylistKey: null,
    durationSeconds: 100,
    renditions,
    captions: [],
    lesson: null,
    mobileStatus,
  });
  const plan = (
    v: ReturnType<typeof video>,
    deviceId: string | null = 'd_1',
    sticky?: 'hls' | 'gumlet',
    supportsHls: boolean = true,
  ) =>
    (service as unknown as {
      planDelivery: (
        video: unknown,
        deviceId: string | null,
        gate?: unknown,
        sticky?: string,
        supportsHls?: boolean,
      ) => Promise<unknown>;
    }).planDelivery(v, deviceId, undefined, sticky, supportsHls);
  const resolve = (v: ReturnType<typeof video>, p: unknown, platform?: string) =>
    (service as unknown as {
      resolvePlaybackTarget: (...args: unknown[]) => Promise<{ manifestUrl: string; drm: { scheme: string } }>;
    }).resolvePlaybackTarget('t_1', v, new Date(Date.now() + 60_000), platform, undefined, undefined, p);

  return { service, prisma, drm, gumlet, manifest, video, plan, resolve };
}

const ANDROID = { platform: 'android', status: 'ACTIVE' };
const WEB = { platform: 'web', status: 'ACTIVE' };

describe('which pipeline a grant is minted for', () => {
  it('a bound Android device with a READY ladder gets the independent HLS pipeline, and Gumlet is never consulted', async () => {
    const t = build({ device: ANDROID });

    await expect(t.plan(t.video('READY'))).resolves.toEqual({ delivery: 'hls' });
    expect(t.drm.ensurePlayable).not.toHaveBeenCalled();
  });

  it('a bound iOS device is treated the same as Android', async () => {
    const t = build({ device: { platform: 'iOS', status: 'ACTIVE' } });
    await expect(t.plan(t.video('READY'))).resolves.toEqual({ delivery: 'hls' });
  });

  it('a web device stays on Gumlet behind the strict DRM gate', async () => {
    const t = build({ device: WEB });

    await expect(t.plan(t.video('READY'))).resolves.toMatchObject({ delivery: 'gumlet' });
    expect(t.drm.ensurePlayable).toHaveBeenCalledWith('v_1');
  });

  it('a session with no bound device stays on Gumlet', async () => {
    const t = build({ device: null });
    await expect(t.plan(t.video('READY'), null)).resolves.toMatchObject({ delivery: 'gumlet' });
    expect(t.prisma.device.findUnique).not.toHaveBeenCalled();
  });

  it('a device binding that is not ACTIVE never gets the HLS pipeline', async () => {
    const t = build({ device: { platform: 'android', status: 'PENDING_APPROVAL' } });
    await expect(t.plan(t.video('READY'))).resolves.toMatchObject({ delivery: 'gumlet' });
  });

  it('a mobile device whose ladder is not ready yet falls back to Gumlet during the migration window', async () => {
    const t = build({ device: ANDROID });
    await expect(t.plan(t.video('NONE', []))).resolves.toMatchObject({ delivery: 'gumlet' });
    expect(t.drm.ensurePlayable).toHaveBeenCalled();
  });

  it('with the fallback off, an unprepared video is "still being prepared", not Gumlet', async () => {
    const t = build({ device: ANDROID, mobile: { delivery: 'hls', gumletFallback: false } });

    await expect(t.plan(t.video('NONE', []))).rejects.toMatchObject({ code: ErrorCode.VIDEO_NOT_READY });
    expect(t.drm.ensurePlayable).not.toHaveBeenCalled();
  });

  it('READY without a rendition row is not a ladder', async () => {
    const t = build({ device: ANDROID, mobile: { delivery: 'hls', gumletFallback: false } });
    await expect(t.plan(t.video('READY', []))).rejects.toMatchObject({ code: ErrorCode.VIDEO_NOT_READY });
  });

  it('MOBILE_VIDEO_DELIVERY=gumlet keeps every platform on Gumlet (the pre-migration behaviour)', async () => {
    const t = build({ device: ANDROID, mobile: { delivery: 'gumlet', gumletFallback: true } });
    await expect(t.plan(t.video('READY'))).resolves.toMatchObject({ delivery: 'gumlet' });
    expect(t.prisma.device.findUnique).not.toHaveBeenCalled();
  });

  it('a rotation keeps the pipeline its original grant used', async () => {
    const t = build({ device: ANDROID });
    // A Gumlet session is not swapped onto HLS mid-lesson because the ladder finished.
    await expect(t.plan(t.video('READY'), 'd_1', 'gumlet')).resolves.toMatchObject({ delivery: 'gumlet' });
    // An HLS session whose ladder vanished does not silently become Gumlet either.
    await expect(t.plan(t.video('NONE', []), 'd_1', 'hls')).rejects.toMatchObject({ code: ErrorCode.VIDEO_NOT_READY });
  });
});

describe('what the ticket carries', () => {
  it('an HLS grant carries our per-ticket manifest URL and no DRM block, without touching Gumlet', async () => {
    const t = build({ device: ANDROID });

    const target = await t.resolve(t.video('READY'), { delivery: 'hls' }, 'android');

    expect(target.manifestUrl).toMatch(/\/playback\/manifest\/t_1\/master\.m3u8/);
    expect(target.drm).toEqual({ scheme: 'none', licenseUrl: null, certificateUrl: null, licenseHeaders: {} });
    expect(t.manifest.buildMasterUrl).toHaveBeenCalledWith('t_1', expect.any(Date));
    expect(t.gumlet.signLicenseUrl).not.toHaveBeenCalled();
    expect(t.gumlet.dashManifestUrl).not.toHaveBeenCalled();
  });

  it('a web request claiming platform=android still gets Gumlet when its device is web', async () => {
    const t = build({ device: WEB });
    const plan = await t.plan(t.video('READY'));
    const target = await t.resolve(t.video('READY'), plan, 'android');

    expect(target.manifestUrl).toBe('https://video.gumlet.io/ws_1/a_1/main.mpd');
    expect(target.drm.scheme).toBe('widevine');
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('every pre-existing caller (no plan) is Gumlet, gated as before', async () => {
    const t = build({ device: WEB });
    const target = await t.resolve(t.video('READY'), undefined, 'web');
    expect(target.drm.scheme).toBe('widevine');
    expect(t.drm.ensurePlayable).toHaveBeenCalled();
  });
});

describe('the manifest endpoints serve HLS grants only', () => {
  function manifestFor(ticket: Record<string, unknown>) {
    const prisma = { playbackTicket: { findUnique: jest.fn(async () => ticket) } };
    const config = {
      getOrThrow: (key: string) =>
        ({
          app: { publicUrl: 'https://api.example.test', apiPrefix: 'api', apiVersion: '1' },
          playback: {},
          video: { keyRoot: 'k'.repeat(40) },
        })[key],
    };
    return new ManifestService(prisma as never, {} as never, config as never);
  }
  const live = {
    id: 'tkt_1',
    status: 'ACTIVE',
    expiresAt: new Date(Date.now() + 60_000),
    maxHeight: null,
    session: { status: 'ACTIVE' },
    device: { status: 'ACTIVE' },
  };
  const request = (svc: ManifestService) => {
    const url = new URL(svc.buildMasterUrl('tkt_1', new Date(Date.now() + 60_000)));
    return svc.masterPlaylist({
      ticketId: 'tkt_1',
      exp: Number(url.searchParams.get('exp')),
      signature: url.searchParams.get('sig')!,
    });
  };

  it('refuses a Gumlet grant even when its signature is valid and the ladder exists', async () => {
    const svc = manifestFor({
      ...live,
      delivery: 'gumlet',
      video: { mobileStatus: 'READY', hlsPrefix: 'hls/v/', renditions: [{ height: 720, width: 1280, bitrateKbps: 2328 }] },
    });
    await expect(request(svc)).rejects.toMatchObject({ code: ErrorCode.PLAYBACK_DENIED });
  });

  it('refuses an HLS grant whose ladder is no longer READY', async () => {
    const svc = manifestFor({
      ...live,
      delivery: 'hls',
      video: { mobileStatus: 'FAILED', hlsPrefix: 'hls/v/', renditions: [{ height: 720, width: 1280, bitrateKbps: 2328 }] },
    });
    await expect(request(svc)).rejects.toMatchObject({ code: ErrorCode.VIDEO_NOT_READY });
  });

  it('serves an HLS grant with a READY ladder', async () => {
    const svc = manifestFor({
      ...live,
      delivery: 'hls',
      video: { mobileStatus: 'READY', hlsPrefix: 'hls/v/', renditions: [{ height: 720, width: 1280, bitrateKbps: 2328 }] },
    });
    await expect(request(svc)).resolves.toContain('RESOLUTION=1280x720');
  });
});
