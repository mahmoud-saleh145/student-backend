import { createHmac } from 'node:crypto';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { GumletDrmService } from 'src/modules/playback/gumlet-drm.service';
import { IssueTicketDto, PlaybackController } from 'src/modules/playback/playback.controller';
import { PlaybackService } from 'src/modules/playback/playback.service';

/**
 * TEMPORARY playback hotfix: signed Gumlet embed-player URL on the ticket.
 *
 * Pins the properties the hotfix relies on:
 *   * OFF by default - with GUMLET_WEB_EMBED_ENABLED unset nothing changes.
 *   * Explicit opt-in - only a request carrying `delivery: 'embed'` gets an
 *     embed URL. `platform` alone never does, because the native iOS app and
 *     iPhone Safari both send `platform: 'ios'`.
 *   * Additive - manifestUrl/drm are identical with and without it.
 *   * Never for legacy videos.
 *   * The request field is optional and strictly validated.
 *   * Token = the documented licence-token HMAC over /org/asset?expires=<ms>,
 *     WITHOUT hardware_secure, and the secret never appears in the URL.
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

type Platform = 'ios' | 'android' | 'web';
type Delivery = 'embed';

type VideoRow = {
  id: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
  gumletStatus?: string | null;
};

type Verdict = { playable: boolean; reason: string | null; detail?: string };

/**
 * The strict DRM gate runs before any playback target - embed included - is
 * built. By default this double behaves like DrmVerificationService for a
 * verified Gumlet asset and refuses everything else, so the embed tests below
 * exercise the real gate ordering instead of bypassing it.
 */
const defaultVerdict = (video: VideoRow): Verdict =>
  video.drmProvider === 'gumlet' && video.gumletAssetId
    ? { playable: true, reason: null }
    : { playable: false, reason: 'NO_GUMLET_ASSET', detail: 'not on the Gumlet path' };

type Target = {
  manifestUrl: string;
  playbackHeaders: Record<string, string>;
  drm: { scheme: string; licenseUrl: string | null; certificateUrl: string | null };
  embedUrl?: string | null;
};

/** `webEmbedEnabled: undefined` = the key is absent from config entirely. */
function makeService(
  webEmbedEnabled: boolean | undefined,
  verdictFor: (video: VideoRow) => Verdict = defaultVerdict,
) {
  const gumletCfg: Record<string, unknown> = {
    apiKey: 'api-key-for-tests',
    workspaceId: 'ws',
    orgId: ORG,
    signSecret: SECRET_B64,
    tokenLifetimeSeconds: 300,
    resolutions: ['720p', '1080p'],
  };
  if (webEmbedEnabled !== undefined) {
    gumletCfg.webEmbedEnabled = webEmbedEnabled;
    gumletCfg.embedTokenLifetimeSeconds = 3600;
  }
  const configService = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? PLAYBACK_CFG
        : {
            drm: {
              enabled: true,
              provider: 'gumlet',
              widevineLicenseUrl: null,
              fairplayLicenseUrl: null,
              fairplayCertUrl: null,
              providerToken: null,
              gumlet: gumletCfg,
            },
          },
  };
  const manifest = { buildMasterUrl: jest.fn(() => 'https://api.example/legacy/master.m3u8') };
  const gumlet = new GumletDrmService(configService as never);
  const rows = new Map<string, VideoRow>([gumletVideo, legacyVideo].map((v) => [v.id, v]));
  const drmVerification = {
    evaluateVideo: jest.fn(async (videoId: string) => verdictFor(rows.get(videoId) ?? legacyVideo)),
  };
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
    drmVerification as never,
    configService as never,
  );
  return { service, gumlet, drmVerification };
}

function resolve(
  service: PlaybackService,
  video: VideoRow,
  platform?: Platform,
  delivery?: Delivery,
): Promise<Target> {
  return (
    service as unknown as {
      resolvePlaybackTarget: (
        ticketId: string,
        video: VideoRow,
        expiresAt: Date,
        platform?: Platform,
        delivery?: Delivery,
      ) => Promise<Target>;
    }
  ).resolvePlaybackTarget('t_1', video, new Date(Date.now() + 300_000), platform, delivery);
}

const gumletVideo: VideoRow = {
  id: 'v_gumlet',
  drmProvider: 'gumlet',
  gumletAssetId: 'asset_1',
  gumletWorkspaceId: 'ws_1',
  gumletStatus: 'ready',
};

const legacyVideo: VideoRow = {
  id: 'v_legacy',
  drmProvider: null,
  gumletAssetId: null,
  gumletWorkspaceId: null,
  gumletStatus: null,
};

/** Licence URLs carry a fresh `expires`, so compare everything but the query. */
function withoutQueries(t: Target) {
  const strip = (u: string | null) => (u ? u.split('?')[0] : u);
  return {
    manifestUrl: t.manifestUrl,
    playbackHeaders: t.playbackHeaders,
    scheme: t.drm.scheme,
    licenseUrl: strip(t.drm.licenseUrl),
    certificateUrl: t.drm.certificateUrl,
  };
}

const PLATFORMS: (Platform | undefined)[] = ['ios', 'android', 'web', undefined];

describe('Gumlet embed hotfix: off by default', () => {
  it.each(PLATFORMS)('no embedUrl for an opted-in %s request when the flag is absent', async (platform) => {
    const { service } = makeService(undefined);
    expect((await resolve(service, gumletVideo, platform, 'embed')).embedUrl ?? null).toBeNull();
  });

  it.each(PLATFORMS)('no embedUrl for an opted-in %s request when the flag is false', async (platform) => {
    const { service } = makeService(false);
    expect((await resolve(service, gumletVideo, platform, 'embed')).embedUrl ?? null).toBeNull();
  });
});

describe('Gumlet embed hotfix: explicit opt-in only (native app isolation)', () => {
  it.each(PLATFORMS)(
    'flag on, a %s request WITHOUT delivery (what the native apps send) gets no embedUrl',
    async (platform) => {
      const { service, gumlet } = makeService(true);
      const signEmbed = jest.spyOn(gumlet, 'signEmbedUrl');
      expect((await resolve(service, gumletVideo, platform)).embedUrl ?? null).toBeNull();
      expect(signEmbed).not.toHaveBeenCalled();
    },
  );

  it('flag on, an iOS web request with delivery=embed gets the embed URL', async () => {
    const { service } = makeService(true);
    expect((await resolve(service, gumletVideo, 'ios', 'embed')).embedUrl).toMatch(
      /^https:\/\/play\.gumlet\.io\/embed\/asset_1\?/,
    );
  });

  it('never applies to legacy (non-Gumlet) videos: the strict gate refuses them first', async () => {
    const { service, gumlet } = makeService(true);
    const signEmbed = jest.spyOn(gumlet, 'signEmbedUrl');
    await expect(resolve(service, legacyVideo, 'ios', 'embed')).rejects.toMatchObject({
      code: 'VIDEO_UNAVAILABLE',
    });
    expect(signEmbed).not.toHaveBeenCalled();
  });
});

describe('Gumlet embed hotfix: inherits the strict DRM gate (recovery merge)', () => {
  it.each(['NOT_VERIFIED', 'VERIFICATION_STALE', 'DRM_NOT_REQUESTED', 'ASSET_FAILED'])(
    'an opted-in iOS request is refused with no embed URL signed when the verdict is %s',
    async (reason) => {
      const { service, gumlet, drmVerification } = makeService(true, () => ({
        playable: false,
        reason,
        detail: 'test',
      }));
      const signEmbed = jest.spyOn(gumlet, 'signEmbedUrl');
      const signLicence = jest.spyOn(gumlet, 'signLicenseUrl');
      await expect(resolve(service, gumletVideo, 'ios', 'embed')).rejects.toBeDefined();
      expect(drmVerification.evaluateVideo).toHaveBeenCalledWith('v_gumlet');
      expect(signEmbed).not.toHaveBeenCalled();
      expect(signLicence).not.toHaveBeenCalled();
    },
  );

  it('a verified asset still gets the embed URL, signed only after the gate ran', async () => {
    const order: string[] = [];
    const { service, gumlet, drmVerification } = makeService(true);
    drmVerification.evaluateVideo.mockImplementation(async () => {
      order.push('gate');
      return { playable: true, reason: null };
    });
    const realSign = gumlet.signEmbedUrl.bind(gumlet);
    jest.spyOn(gumlet, 'signEmbedUrl').mockImplementation((p) => {
      order.push('sign-embed');
      return realSign(p);
    });
    const t = await resolve(service, gumletVideo, 'ios', 'embed');
    expect(t.embedUrl).toMatch(/^https:\/\/play\.gumlet\.io\/embed\/asset_1\?/);
    expect(order).toEqual(['gate', 'sign-embed']);
  });
});

describe('Gumlet embed hotfix: additive only', () => {
  it.each<Platform>(['ios', 'android', 'web'])(
    'manifest and drm fields for %s are unchanged by the opt-in',
    async (platform) => {
      const off = await resolve(makeService(undefined).service, gumletVideo, platform);
      const on = await resolve(makeService(true).service, gumletVideo, platform, 'embed');
      expect(on.embedUrl).toBeTruthy();
      expect(withoutQueries(on)).toEqual(withoutQueries(off));
    },
  );
});

describe('Gumlet embed hotfix: request contract', () => {
  const check = async (body: Record<string, unknown>) =>
    validate(plainToInstance(IssueTicketDto, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });

  it('keeps existing request bodies valid (field is optional)', async () => {
    expect(await check({})).toHaveLength(0);
    expect(await check({ platform: 'ios' })).toHaveLength(0);
    expect(await check({ platform: 'android', maxHeight: 720 })).toHaveLength(0);
  });

  it('accepts delivery=embed and rejects any other value', async () => {
    expect(await check({ platform: 'ios', delivery: 'embed' })).toHaveLength(0);
    for (const delivery of ['EMBED', 'iframe', '', 1, true]) {
      const errors = await check({ platform: 'ios', delivery });
      expect(errors.map((e) => e.property)).toContain('delivery');
    }
  });

  it('the controller forwards delivery only when it is exactly "embed"', () => {
    const issueTicket = jest.fn();
    const controller = new PlaybackController({ issueTicket } as never);
    const req = { ip: '127.0.0.1', header: () => 'ua', deviceContext: undefined } as never;
    const user = { id: 'u_1' } as never;

    controller.issue('v_1', { platform: 'ios' } as IssueTicketDto, user, req);
    controller.issue('v_1', { platform: 'ios', delivery: 'embed' } as IssueTicketDto, user, req);

    expect(issueTicket.mock.calls[0][0].delivery).toBeUndefined();
    expect(issueTicket.mock.calls[1][0].delivery).toBe('embed');
  });
});

describe('Gumlet embed hotfix: token', () => {
  it('is the documented licence HMAC over /org/asset?expires=<ms>, without hardware_secure', () => {
    const { gumlet } = makeService(true);
    const before = Date.now();
    const url = new URL(gumlet.signEmbedUrl({ assetId: 'asset_1', tokenLifetimeSeconds: 3600 }));

    expect(url.origin + url.pathname).toBe('https://play.gumlet.io/embed/asset_1');
    expect([...url.searchParams.keys()].sort()).toEqual(['expires', 'token']);

    const expires = Number(url.searchParams.get('expires'));
    // Milliseconds since epoch, one hour out.
    expect(expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 3600 * 1000);

    const expected = createHmac('sha1', Buffer.from(SECRET_B64, 'base64'))
      .update(`/${ORG}/asset_1?expires=${expires}`)
      .digest('hex');
    expect(url.searchParams.get('token')).toBe(expected);
    expect(url.toString()).not.toContain(SECRET_B64);
  });

  it('fails closed without a signing secret', () => {
    const configService = {
      getOrThrow: () => ({
        drm: { gumlet: { orgId: ORG, signSecret: null, tokenLifetimeSeconds: 300 } },
      }),
    };
    const gumlet = new GumletDrmService(configService as never);
    expect(() => gumlet.signEmbedUrl({ assetId: 'asset_1' })).toThrow();
  });
});
