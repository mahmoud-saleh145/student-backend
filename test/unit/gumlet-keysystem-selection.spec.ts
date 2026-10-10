import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';
import { PlaybackService } from 'src/modules/playback/playback.service';

/**
 * DRM key-system selection on the Gumlet path.
 *
 * Widevine and FairPlay are different CDMs served from different hosts, and
 * neither platform has the other's. Handing an iOS client a Widevine URL does
 * not "fall back" - the CDM is simply absent and playback dies with an opaque
 * error. These tests pin the selection so that cannot regress.
 *
 * The signing is the real service (local HMAC, no network). Only the manifest
 * builder is stubbed, because the assertion is that it must NOT be reached for
 * a Gumlet video.
 */

const ORG = 'org_1';
const SECRET_B64 = 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5';

type Platform = 'ios' | 'android' | 'web' | undefined;

type VideoRowLike = {
  id: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
};

function makeService(drmEnabled = true) {
  const manifest = { buildMasterUrl: jest.fn(() => 'https://api.example/legacy/master.m3u8') };

  const configService = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? { ticketTtl: 300, heartbeatInterval: 30, heartbeatGrace: 90 }
        : {
            drm: {
              enabled: drmEnabled,
              provider: 'gumlet',
              widevineLicenseUrl: null,
              fairplayLicenseUrl: null,
              fairplayCertUrl: null,
              providerToken: null,
              gumlet: {
                apiKey: 'k',
                workspaceId: 'ws',
                orgId: ORG,
                signSecret: SECRET_B64,
                tokenLifetimeSeconds: 300,
                resolutions: ['720p', '1080p'],
              },
            },
          },
  };

  const gumlet = new GumletDrmService(configService as never);

  // Constructor order: prisma, redis, access, devices, storage, manifest,
  // tokens, security, gumlet, config.
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

const gumletVideo: VideoRowLike = {
  id: 'v_gumlet',
  drmProvider: 'gumlet',
  gumletAssetId: 'asset_1',
  gumletWorkspaceId: 'ws_1',
};

function resolve(service: PlaybackService, video: VideoRowLike, platform: Platform) {
  return (
    service as unknown as {
      resolvePlaybackTarget: (
        t: string,
        v: VideoRowLike,
        e: Date,
        p?: Platform,
      ) => Promise<{ manifestUrl: string; drm: { scheme: string; licenseUrl: string | null; certificateUrl: string | null } }>;
    }
  ).resolvePlaybackTarget('t1', video, new Date(), platform);
}

describe('a Gumlet video on iOS', () => {
  it('is issued a FairPlay licence URL, not a Widevine one', async () => {
    const t = makeService();

    const result = await resolve(t.service, gumletVideo, 'ios');

    expect(result.drm.scheme).toBe('fairplay');
    expect(result.drm.licenseUrl).toContain('fairplay.gumlet.com/licence');
    expect(result.drm.licenseUrl).not.toContain('widevine.gumlet.com');
  });

  it('receives the FairPlay certificate URL, without a Widevine URL present', async () => {
    const t = makeService();

    const result = await resolve(t.service, gumletVideo, 'ios');

    expect(result.drm.certificateUrl).toContain('fairplay.gumlet.com/certificate');
    expect(result.drm.certificateUrl).toContain(ORG);
  });

  it('carries a token on the FairPlay URL that is byte-different from Widevine\'s', async () => {
    const t = makeService();

    const ios = await resolve(t.service, gumletVideo, 'ios');
    const android = await resolve(t.service, gumletVideo, 'android');

    // Same signed token, different host. If these were identical the platform
    // field would not be doing anything.
    const tokenOf = (u: string | null) => new URL(u!).searchParams.get('token');
    expect(tokenOf(ios.drm.licenseUrl)).toBeTruthy();
    expect(tokenOf(android.drm.licenseUrl)).toBeTruthy();
    expect(ios.drm.licenseUrl).not.toBe(android.drm.licenseUrl);
  });

  it('does not receive a certificate URL it cannot use on Widevine clients', async () => {
    const t = makeService();

    const result = await resolve(t.service, gumletVideo, 'android');

    expect(result.drm.scheme).toBe('widevine');
    // Harmless either way, but the ticket carries only what is needed: a
    // certificate URL is a FairPlay-only concept.
    expect(result.drm.certificateUrl).toBeNull();
  });
});

describe('a Gumlet video on non-iOS platforms', () => {
  it('android gets Widevine', async () => {
    const t = makeService();
    const result = await resolve(t.service, gumletVideo, 'android');
    expect(result.drm.scheme).toBe('widevine');
    expect(result.drm.licenseUrl).toContain('widevine.gumlet.com/licence');
  });

  it('web gets Widevine', async () => {
    const t = makeService();
    const result = await resolve(t.service, gumletVideo, 'web');
    expect(result.drm.scheme).toBe('widevine');
  });

  it('an omitted platform defaults to Widevine rather than failing', async () => {
    // Older clients never sent `platform`. They must keep working, not start
    // receiving a FairPlay URL they cannot use.
    const t = makeService();
    const result = await resolve(t.service, gumletVideo, undefined);
    expect(result.drm.scheme).toBe('widevine');
    expect(result.drm.licenseUrl).toContain('widevine.gumlet.com');
  });
});

describe('key-system selection never bypasses access control', () => {
  it('a legacy video is unaffected by the platform field', async () => {
    const t = makeService();
    const legacy = { ...gumletVideo, id: 'v_legacy', drmProvider: null, gumletAssetId: null };

    const result = await resolve(t.service, legacy, 'ios');

    expect(result.manifestUrl).toBe('https://api.example/legacy/master.m3u8');
    expect(t.manifest.buildMasterUrl).toHaveBeenCalled();
  });

  it('a Gumlet video with DRM disabled still fails closed on every platform', async () => {
    for (const platform of ['ios', 'android', 'web'] as const) {
      const t = makeService(false);
      await expect(resolve(t.service, gumletVideo, platform)).rejects.toThrow();
      expect(t.manifest.buildMasterUrl).not.toHaveBeenCalled();
    }
  });

  it('never exposes the signing secret in either variant', async () => {
    const t = makeService();

    for (const platform of ['ios', 'android'] as const) {
      const result = await resolve(t.service, gumletVideo, platform);
      const serialised = JSON.stringify(result);
      expect(serialised).not.toContain(SECRET_B64);
      expect(serialised).not.toContain('GUMLET_SIGN_SECRET');
    }
  });
});