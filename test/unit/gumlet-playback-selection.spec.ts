import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';
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
    configService as never,
  );

  return { service, manifest, gumlet };
}

/**
 * `resolvePlaybackTarget` is private by design - it is an implementation step
 * of ticket minting, not API surface. Accessing it through a typed view keeps
 * that encapsulation in production while still exercising the real logic here.
 */
function resolve(service: PlaybackService, video: VideoRow) {
  return (
    service as unknown as {
      resolvePlaybackTarget: (
        ticketId: string,
        video: VideoRow,
        expiresAt: Date,
      ) => Promise<{ manifestUrl: string; playbackHeaders: Record<string, string>; drm: unknown }>;
    }
  ).resolvePlaybackTarget('t_1', video, new Date(Date.now() + 300_000));
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

describe('legacy videos are unaffected by Gumlet configuration', () => {
  it('serves the signed HLS manifest and skips licensing entirely', async () => {
    const t = makeService({ drmEnabled: true, provider: 'gumlet' });
    const signing = jest.spyOn(t.gumlet, 'signLicenseUrl');

    const result = await resolve(t.service, legacyVideo);

    expect(result.manifestUrl).toBe('https://api.example/legacy/master.m3u8');
    // A legacy video must not be issued a Widevine licence just because the
    // platform is DRM-enabled: its content is not CENC packaged.
    expect(signing).not.toHaveBeenCalled();
  });

  it('still serves HLS when DRM is disabled globally', async () => {
    const t = makeService({ drmEnabled: false, provider: 'none' });
    const result = await resolve(t.service, legacyVideo);
    expect(result.manifestUrl).toBe('https://api.example/legacy/master.m3u8');
    // With DRM off the ticket still carries a drm block, but one that offers
    // no licence - matching the pre-integration shape.
    expect((result.drm as { scheme: string }).scheme).toBe('none');
  });

  it('still serves HLS when the provider is something else', async () => {
    const t = makeService({ drmEnabled: true, provider: 'legacy-provider' });
    const signing = jest.spyOn(t.gumlet, 'signLicenseUrl');

    const result = await resolve(t.service, legacyVideo);

    expect(result.manifestUrl).toBe('https://api.example/legacy/master.m3u8');
    expect(signing).not.toHaveBeenCalled();
  });
});

describe('a Gumlet-backed video fails closed', () => {
  it('when DRM is disabled platform-wide, without degrading to HLS', async () => {
    const t = makeService({ drmEnabled: false, provider: 'none' });

    await expect(resolve(t.service, gumletVideo)).rejects.toThrow(/DRM is disabled|requires it/i);
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('when the configured provider is not gumlet', async () => {
    const t = makeService({ drmEnabled: true, provider: 'other' });

    await expect(resolve(t.service, gumletVideo)).rejects.toThrow(/provider/i);
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

    await expect(resolve(t.service, { ...gumletVideo, gumletAssetId: null })).rejects.toThrow(/asset/i);
    expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
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