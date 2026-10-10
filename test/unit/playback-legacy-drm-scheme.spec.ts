import { PlaybackService } from 'src/modules/playback/playback.service';

/**
 * Mixed-provider playback: legacy HLS videos must never be told they are DRM.
 *
 * `DRM_ENABLED` is global and a Gumlet deployment turns it on. But the legacy
 * path is AES-128 HLS — not CENC — and cannot use an EME licence at all, so
 * enabling the flag must not make every legacy lesson claim `widevine`.
 *
 * It did. `drmBlock()` returned `scheme: 'widevine'` with a null licence URL,
 * which is a claim the server cannot honour. Both shipped clients happen to
 * require a licence URL before routing to the DRM player, so nothing broke —
 * but that is a coincidence of client code, not a guarantee of the contract.
 *
 * These tests pin the contract itself, so the safety does not depend on every
 * future client repeating the same guard.
 */

type Drm = {
  scheme: string;
  licenseUrl: string | null;
  certificateUrl: string | null;
  licenseHeaders: Record<string, string>;
};

function makeService(drm: {
  enabled: boolean;
  widevineLicenseUrl?: string | null;
  fairplayCertUrl?: string | null;
  providerToken?: string | null;
}) {
  const configService = {
    getOrThrow: (key: string) =>
      key === 'playback'
        ? { ticketTtl: 300, heartbeatInterval: 30, heartbeatGrace: 90 }
        : {
            drm: {
              enabled: drm.enabled,
              provider: 'gumlet',
              widevineLicenseUrl: drm.widevineLicenseUrl ?? null,
              fairplayLicenseUrl: null,
              fairplayCertUrl: drm.fairplayCertUrl ?? null,
              providerToken: drm.providerToken ?? null,
              gumlet: {
                apiKey: null,
                workspaceId: null,
                orgId: null,
                signSecret: null,
                tokenLifetimeSeconds: 300,
                resolutions: ['720p'],
              },
            },
          },
  };

  const service = new PlaybackService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { buildMasterUrl: jest.fn(() => 'https://api.example/master.m3u8') } as never,
    {} as never,
    {} as never,
    {} as never,
    configService as never,
  );

  const block = (): Drm =>
    (
      service as unknown as { drmBlock: () => Drm }
    ).drmBlock();

  return { service, block };
}

describe('a legacy HLS video when DRM is switched on', () => {
  it('is reported as scheme "none", not "widevine"', () => {
    // The regression: DRM_ENABLED=true with no licence URL configured used to
    // return widevine with a null licence.
    const t = makeService({ enabled: true, widevineLicenseUrl: null });
    expect(t.block().scheme).toBe('none');
  });

  it('carries no licence URL, so no client can be routed to a DRM player', () => {
    const t = makeService({ enabled: true, widevineLicenseUrl: null });
    expect(t.block().licenseUrl).toBeNull();
  });

  it('stays "none" even when a FairPlay certificate happens to be set', () => {
    // A certificate without a licence server is still not a usable scheme.
    const t = makeService({
      enabled: true,
      widevineLicenseUrl: null,
      fairplayCertUrl: 'https://fairplay.example/cert/org',
    });
    expect(t.block().scheme).toBe('none');
    expect(t.block().certificateUrl).toBeNull();
  });

  it('is unchanged when DRM is switched off entirely', () => {
    const t = makeService({ enabled: false, widevineLicenseUrl: 'https://wv.example/l' });
    expect(t.block()).toEqual({
      scheme: 'none',
      licenseUrl: null,
      certificateUrl: null,
      licenseHeaders: {},
    });
  });
});

describe('a genuine non-Gumlet DRM provider', () => {
  it('still reports widevine, because it can be honoured', () => {
    // The fix must not disable the generic provider path it was written for.
    const t = makeService({
      enabled: true,
      widevineLicenseUrl: 'https://wv.example/licence/org',
    });
    expect(t.block().scheme).toBe('widevine');
    expect(t.block().licenseUrl).toBe('https://wv.example/licence/org');
  });

  it('still forwards the provider token when configured', () => {
    const t = makeService({
      enabled: true,
      widevineLicenseUrl: 'https://wv.example/licence/org',
      providerToken: 'tok',
    });
    expect(t.block().licenseHeaders).toEqual({ Authorization: 'Bearer tok' });
  });

  it('reports empty headers rather than an Authorization when unset', () => {
    const t = makeService({
      enabled: true,
      widevineLicenseUrl: 'https://wv.example/licence/org',
      providerToken: null,
    });
    expect(t.block().licenseHeaders).toEqual({});
  });
});

describe('the contract every client can rely on', () => {
  it('a non-"none" scheme always comes with a licence URL', () => {
    // The invariant, stated once: it is never possible to be told "you need
    // DRM" and "here is no licence server".
    for (const enabled of [false, true]) {
      for (const licenseUrl of [null, '', 'https://wv.example/l']) {
        const t = makeService({ enabled, widevineLicenseUrl: licenseUrl });
        const drm = t.block();
        if (drm.scheme !== 'none') {
          expect(drm.licenseUrl).toBeTruthy();
        }
      }
    }
  });
});