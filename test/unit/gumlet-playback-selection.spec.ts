import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';
import { buildDrmVerification } from './helpers/drm-doubles';
import { PlaybackService } from 'src/modules/playback/playback.service';

/**
 * Playback-ticket integration for the Gumlet path.
 *
 * These are the behaviours that decide whether a Gumlet-backed lesson is ever
 * handed to a student as an unprotected stream. They drive the REAL
 * `PlaybackService.resolvePlaybackTarget` and the REAL `GumletDrmService`:
 * signing is local (HMAC) and asset management is never called here, so no
 * network traffic and no credentials are needed.
 *
 * The collaborators that are stubbed (Prisma, Redis, manifest builder) are not
 * on the code path under test; the manifest builder is stubbed because it is the
 * thing that must NOT be reached for a Gumlet video, and asserting on its
 * call count is the point.
 */

const ORG = 'org_1';
// Not a real secret: a base64 string long enough to be accepted as a key.
const SECRET_B64 = 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5';

const PLAYBACK_CFG = {
  ticketTtl: 300,
  heartbeatInterval: 30,
  heartbeatGrace: 90,
  maxConcurrentStreams: 1,
  ticketsPerHour: 60,
};

type VideoRow = {
  id: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
};

function videoConfig(overrides: {
  enabled?: boolean;
  provider?: string;
  signSecret?: string | null;
}) {
  return {
    drm: {
      enabled: overrides.enabled ?? true,
      provider: overrides.provider ?? 'gumlet',
      widevineLicenseUrl: null,
      fairplayLicenseUrl: null,
      fairplayCertUrl: null,
      providerToken: null,
      gumlet: {
        apiKey: 'api-key-for-tests',
        workspaceId: 'ws',
        orgId: ORG,
        signSecret: overrides.signSecret === undefined ? SECRET_B64 : overrides.signSecret,
        tokenLifetimeSeconds: 300,
        resolutions: ['720p', '1080p'],
      },
    },
  };
}

/** Rows registered by `resolve()` so the DRM verifier judges the right video. */
const rowsById = new Map<string, VideoRow>();

function makeService(opts: {
  drmEnabled: boolean;
  provider: string;
  /** Simulates a missing/mislabelled signing secret at the config layer. */
  signSecret?: string | null;
}) {
  const manifest = { buildMasterUrl: jest.fn(() => 'https://api.example/legacy/master.m3u8') };

  const configService = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? PLAYBACK_CFG
        : videoConfig({
            enabled: opts.drmEnabled,
            provider: opts.provider,
            signSecret: opts.signSecret,
          }),
  };

  const gumlet = new GumletDrmService(configService as never);

  // Constructor order is fixed by the service:
  // prisma, redis, access, devices, storage, manifest, tokens, security,
  // gumlet, config. Only `manifest` and `config` are on this path.
  const service = new PlaybackService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    manifest as never,
    {} as never,
    {} as never,
    gumlet as never,
    // The REAL DRM verifier, over the same config. A permissive double here would
  // hide exactly the regressions this suite exists to catch: a Gumlet video with
  // no asset, a misconfigured provider, or missing signing must all refuse.
  //
  // `row` is overridden per test via `setVerifierRow`, so the verdict reflects
  // the video actually under test rather than a fixed happy path.
  buildDrmVerification({
    enabled: opts.drmEnabled,
    provider: opts.provider === 'gumlet' ? 'gumlet' : 'none',
    signingConfigured: opts.signSecret !== null,
    row: (id) => {
      // Mirror whatever video is under test, so a legacy row is judged as a
      // legacy row instead of inheriting the happy path.
      const legacy = rowsById.get(id);
      return legacy
        ? {
            drmProvider: legacy.drmProvider,
            gumletAssetId: legacy.gumletAssetId,
            gumletStatus: 'ready',
            gumletWorkspaceId: legacy.gumletWorkspaceId,
            drmRequested: legacy.drmProvider === 'gumlet',
            drmVerifiedAt: legacy.drmProvider === 'gumlet' ? new Date() : null,
          }
        : {};
    },
  }) as never,
    configService as never,
  );

  return { service, manifest, gumlet };
}

/**
 * `resolvePlaybackTarget` is private by design - it is an implementation step
 * of ticket minting, not API surface. Accessing it through a typed view keeps
 * that encapsulation in production while still exercising the real logic here.
 */
function resolve(
  service: PlaybackService,
  video: VideoRow,
  platform?: 'ios' | 'android' | 'web',
) {
  // The DRM verifier looks the video up by id, so register the row under test so
  // its verdict reflects THIS video rather than a fixed happy path.
  rowsById.set(video.id, video);
  return (
    service as unknown as {
      resolvePlaybackTarget: (
        ticketId: string,
        video: VideoRow,
        expiresAt: Date,
        platform?: 'ios' | 'android' | 'web',
      ) => Promise<{ manifestUrl: string; playbackHeaders: Record<string, string>; drm: unknown }>;
    }
  ).resolvePlaybackTarget('t_1', video, new Date(Date.now() + 300_000), platform);
}

const legacyVideo: VideoRow = {
  id: 'v_legacy',
  drmProvider: null,
  gumletAssetId: null,
  gumletWorkspaceId: null,
};

const gumletVideo: VideoRow = {
  id: 'v_gumlet',
  drmProvider: 'gumlet',
  gumletAssetId: 'asset_1',
  gumletWorkspaceId: 'ws_1',
};

describe('legacy videos are refused, not served', () => {
  it('never serves the signed HLS manifest for a legacy video', async () => {
    // This used to assert a legacy video was served normally. Under strict DRM
    // that is precisely the hole: an AES-128 HLS lesson is not CENC-packaged,
    // so it cannot satisfy the platform's protection requirement.
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });
    const signing = jest.spyOn(t.gumlet, 'signLicenseUrl');

    // The legacy row has no asset and was never verified, so the gate refuses
    // before any licence is minted.
    await expect(resolve(t.service, legacyVideo)).rejects.toThrow();
    // A legacy video must not be issued a Widevine licence either.
    expect(signing).not.toHaveBeenCalled();
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('REFUSES a legacy video - there is no HLS fallback any more', async () => {
    // This used to assert "still serves HLS when DRM is disabled globally".
    // That behaviour was the bypass: on a DRM-only platform an unencrypted
    // lesson must not be servable at all. The strict gate refuses instead.
    const t = makeService({ drmEnabled: false, provider: 'none' });
    await expect(resolve(t.service, legacyVideo)).rejects.toThrow();
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('REFUSES a legacy video even when DRM is on, because it has no verified asset', async () => {
    // This used to assert "still serves HLS when the provider is something else".
    const t = makeService({ drmEnabled: true, provider: 'legacy-provider' });
    const signing = jest.spyOn(t.gumlet, 'signLicenseUrl');

    await expect(resolve(t.service, legacyVideo)).rejects.toThrow();
    expect(signing).not.toHaveBeenCalled();
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });
});

describe('a Gumlet-backed video fails closed', () => {
  it('when DRM is disabled platform-wide, without degrading to HLS', async () => {
    const t = makeService({ drmEnabled: false, provider: 'none' });

    await expect(resolve(t.service, gumletVideo)).rejects.toThrow(/DRM is unavailable|cannot be played/i);
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('when the configured provider is not gumlet', async () => {
    const t = makeService({ drmEnabled: true, provider: 'other' });

    // The refusal now comes from the DRM verification gate rather than a
    // separate provider check - same outcome, one code path.
    await expect(resolve(t.service, gumletVideo)).rejects.toThrow();
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('when the signing secret is missing', async () => {
    // This is the case that must not be stubbed away: `resolvePlaybackTarget`
    // relies on `signLicenseUrl` refusing, so the test uses the real service
    // with a genuinely absent secret.
    const t = makeService({ drmEnabled: true, provider: 'gumlet', signSecret: null });
    expect(t.gumlet.isSigningConfigured()).toBe(false);

    await expect(resolve(t.service, gumletVideo)).rejects.toThrow();
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('when the asset id is missing', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    await expect(resolve(t.service, { ...gumletVideo, gumletAssetId: null })).rejects.toThrow();
  });

  it('when no workspace can be determined at all', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });
    // The row has no workspace and the config has none either.
    (t.gumlet as unknown as { cfg: { workspaceId: string | null } }).cfg.workspaceId = null;

    await expect(resolve(t.service, { ...gumletVideo, gumletWorkspaceId: null })).rejects.toThrow(
      /workspace/i,
    );
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });
});

describe('a correctly configured Gumlet video', () => {
  it('returns the DASH manifest plus a signed licence URL', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo);
    const drm = result.drm as {
      licenseUrl: string | null;
      certificateUrl: string | null;
      scheme: string;
    };

    expect(result.manifestUrl).toBe('https://video.gumlet.io/ws_1/asset_1/main.mpd');
    expect(drm.scheme).toBe('widevine');
    expect(drm.licenseUrl).toContain('widevine.gumlet.com');
    // The legacy manifest builder must not have been used.
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('prefers the workspace stored on the video row over the configured default', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo);

    expect(result.manifestUrl).toContain('/ws_1/');
  });

  it('falls back to the configured workspace when the row has none', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, { ...gumletVideo, gumletWorkspaceId: null });

    expect(result.manifestUrl).toBe('https://video.gumlet.io/ws/asset_1/main.mpd');
  });

  it('scopes the licence URL to the asset and the requesting organisation', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const bundle = t.gumlet.signLicenseUrl({ assetId: 'asset_1' });

    expect(bundle.licenseUrl).toContain(`/${ORG}/asset_1`);
    expect(new URL(bundle.licenseUrl!).searchParams.get('expires')).toBeTruthy();
    expect(new URL(bundle.licenseUrl!).searchParams.get('token')).toBeTruthy();
  });

  it('never puts the signing secret or an API key in the ticket payload', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo);
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain(SECRET_B64);
    expect(serialised).not.toContain('GUMLET_SIGN_SECRET');
    expect(serialised).not.toContain('GUMLET_API_KEY');
    expect(serialised).not.toContain('api-key-for-tests');
  });
});

/**
 * Gumlet publishes FairPlay for HLS only: their compatibility matrix has an
 * `HLS FairPlay` column and no `DASH FairPlay` column. Serving a DASH manifest
 * to Safari therefore guarantees failure at key-system negotiation, because
 * that manifest carries a Widevine PSSH and nothing an Apple CDM can use.
 */
describe('manifest selection follows the DRM system', () => {
  it('serves HLS to iOS, because that is the only FairPlay signalling Gumlet emits', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo, 'ios');
    const drm = result.drm as { scheme: string; licenseUrl: string; certificateUrl: string | null };

    expect(result.manifestUrl).toBe('https://video.gumlet.io/ws_1/asset_1/main.m3u8');
    expect(drm.scheme).toBe('fairplay');
    expect(drm.licenseUrl).toContain('fairplay.gumlet.com');
    // FairPlay needs the application certificate; Widevine clients get none.
    expect(drm.certificateUrl).toBe('https://fairplay.gumlet.com/certificate/org_1');
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('keeps DASH for Chrome, Edge and Android', async () => {
    for (const platform of ['web', 'android'] as const) {
      const t = makeService({ drmEnabled: true, provider: 'gumlet' });

      const result = await resolve(t.service, gumletVideo, platform);
      const drm = result.drm as { scheme: string; licenseUrl: string; certificateUrl: string | null };

      expect(result.manifestUrl).toBe('https://video.gumlet.io/ws_1/asset_1/main.mpd');
      expect(drm.scheme).toBe('widevine');
      expect(drm.licenseUrl).toContain('widevine.gumlet.com');
      expect(drm.certificateUrl).toBeNull();
    }
  });

  it('still resolves the workspace for the HLS branch', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const fromRow = await resolve(t.service, gumletVideo, 'ios');
    expect(fromRow.manifestUrl).toContain('/ws_1/');

    const fromConfig = await resolve(t.service, { ...gumletVideo, gumletWorkspaceId: null }, 'ios');
    expect(fromConfig.manifestUrl).toBe('https://video.gumlet.io/ws/asset_1/main.m3u8');
  });

  it('fails closed for iOS when no workspace can be determined', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });
    (t.gumlet as unknown as { cfg: { workspaceId: string | null } }).cfg.workspaceId = null;

    await expect(
      resolve(t.service, { ...gumletVideo, gumletWorkspaceId: null }, 'ios'),
    ).rejects.toThrow(/workspace/i);
  });

  it('issues both licences from the same signed token, scoped to the same asset', async () => {
    // `expires` is derived from Date.now(), so without a pinned clock the two
    // signing calls can straddle a millisecond boundary and legitimately
    // produce different tokens — a flake, not a defect.
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const widevine = t.gumlet.signLicenseUrl({ assetId: 'asset_1' }).licenseUrl;
    const fairplay = t.gumlet.signFairPlayLicenseUrl({ assetId: 'asset_1' });
    const widevineParsed = new URL(widevine);
    const fairplayParsed = new URL(fairplay);

    for (const parsed of [widevineParsed, fairplayParsed]) {
      expect(parsed.pathname).toBe(`/licence/${ORG}/asset_1`);
      expect(parsed.searchParams.get('token')).toBeTruthy();
      expect(parsed.searchParams.get('expires')).toBeTruthy();
    }

    // FairPlay is the SAME signed token on a different host: only the licence
    // base changes. If these ever diverge, one of the two would be unsigned.
    expect(fairplayParsed.searchParams.get('token')).toBe(
      widevineParsed.searchParams.get('token'),
    );
    expect(fairplayParsed.searchParams.get('expires')).toBe(
      widevineParsed.searchParams.get('expires'),
    );
    expect(widevineParsed.host).not.toBe(fairplayParsed.host);
    jest.useRealTimers();
  });

  it('never leaks the signing secret into the iOS ticket', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo, 'ios');
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain(SECRET_B64);
    expect(serialised).not.toContain('api-key-for-tests');
  });
});

/**
 * `hardware_secure=true` is signed into the licence URL, which is what gates SD
 * and audio behind hardware decode. `gumlet-signing.spec.ts` proves the SIGNING
 * honours the flag; these prove the PLAYBACK PATH actually asks for it, so a
 * future refactor cannot quietly drop it and leave the library playable on
 * software-only devices.
 */
describe('the issued licence URL always requests hardware security', () => {
  it.each(['web', 'android'] as const)('for platform %s', async (platform) => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo, platform);
    const url = new URL((result.drm as { licenseUrl: string }).licenseUrl);

    expect(url.searchParams.get('hardware_secure')).toBe('true');
  });

  it('for iOS as well, on the FairPlay host', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const result = await resolve(t.service, gumletVideo, 'ios');
    const url = new URL((result.drm as { licenseUrl: string }).licenseUrl);

    expect(url.host).toContain('fairplay.gumlet.com');
    expect(url.searchParams.get('hardware_secure')).toBe('true');
  });

  it('carries it in the signed string, not only in the query', async () => {
    // If the flag were appended after signing, Gumlet would see a token that
    // does not match its parameters and reject the request.
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });

    const signed = t.gumlet.signLicenseUrl({ assetId: 'asset_1', hardwareSecure: true });
    const withFlag = new URL(signed.licenseUrl).searchParams.get('token');
    const without = new URL(
      t.gumlet.signLicenseUrl({ assetId: 'asset_1', hardwareSecure: false }).licenseUrl,
    ).searchParams.get('token');

    expect(withFlag).toBeTruthy();
    expect(withFlag).not.toBe(without);
  });
});