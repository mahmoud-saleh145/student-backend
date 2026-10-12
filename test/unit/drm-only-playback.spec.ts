import { DrmVerificationService, VideoForVerdict } from 'src/modules/playback/drm-verification.service';
import { PlaybackService } from 'src/modules/playback/playback.service';
import { allowDrm, denyDrm, verifiedVideo } from './helpers/drm-doubles';

/**
 * THE SECURITY TESTS.
 *
 * The rule under test: a student may only play a video whose DRM has actually
 * been verified against the live provider. Not "is flagged as Gumlet", not "says
 * READY in the database" - actually verified.
 *
 * These are deliberately written against the REAL `DrmVerificationService` and the
 * REAL `PlaybackService.resolvePlaybackTarget`. A permissive double is used only
 * where the point of the test is something else, so a regression in the gate
 * cannot be hidden by a stub.
 */

const FULL_GUMLET = {
  apiKey: 'gumlet-api-key-fixture-value-0001',
  workspaceId: 'ws_1',
  orgId: 'org_1',
  signSecret: Buffer.from('sign-secret-fixture').toString('base64'),
  tokenLifetimeSeconds: 300,
  resolutions: ['720p', '1080p'],
};

const ENCRYPTED_MANIFEST = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">
  <Period id="0"><AdaptationSet contentType="video">
    <ContentProtection value="cbcs" schemeIdUri="urn:mpeg:dash:mp4protection:2011"
      cenc:default_KID="6fcf5dd7-7260-5a02-9d73-cd2cac0b573e"/>
    <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
  </AdaptationSet></Period></MPD>`;

const PLAIN_MANIFEST = `<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period id="0"></Period></MPD>`;

/**
 * Build a REAL verification service over a fake provider and a fake manifest.
 * `encrypted` flips the decisive check.
 */
function buildVerifier(opts?: {
  row?: Partial<VideoForVerdict>;
  assetStatus?: string;
  encrypted?: boolean;
  fetchThrows?: boolean;
  getAssetThrows?: boolean;
  enabled?: boolean;
  provider?: 'none' | 'gumlet';
  signing?: boolean;
}) {
  const updates: Record<string, unknown>[] = [];
  const row = verifiedVideo(opts?.row ?? {});
  const prisma = {
    video: {
      findFirst: jest.fn(async () => ({ ...row, ...(opts?.row ?? {}) })),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        Object.assign(row, a.data);
        return row;
      }),
      // verify() routes its success through updateMany with a conditional where,
      // so an overlapping slower check cannot overwrite a newer timestamp.
      updateMany: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        Object.assign(row, a.data);
        return { count: 1 };
      }),
    },
  };
  const gumlet = {
    isSigningConfigured: jest.fn(() => opts?.signing ?? true),
    dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
    assetHasDrm: jest.fn((t: string) =>
      /schemeIdUri="urn:mpeg:dash:mp4protection:2011"/.test(t) && /cenc:default_KID="/.test(t),
    ),
    isAssetPlayable: jest.fn((s: string) => s === 'ready'),
    getAsset: jest.fn(async () => {
      if (opts?.getAssetThrows) throw new Error('Gumlet API unreachable');
      return {
        assetId: 'a_1',
        status: opts?.assetStatus ?? 'ready',
        progress: 100,
        playbackUrl: null,
        dashPlaybackUrl: null,
        error: opts?.assetStatus === 'errored' ? 'quota exceeded' : null,
      };
    }),
  };
  // The manifest fetch is the decisive check, so it is stubbed explicitly rather
  // than derived from `encrypted` inside assetHasDrm alone.
  const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation((async () => {
    if (opts?.fetchThrows) throw new Error('manifest fetch failed');
    return {
      ok: true,
      text: async () => (opts?.encrypted === false ? PLAIN_MANIFEST : ENCRYPTED_MANIFEST),
    };
  }) as never);

  const service = new DrmVerificationService(
    prisma as never,
    gumlet as never,
    {
      getOrThrow: () => ({
        drm: {
          enabled: opts?.enabled ?? true,
          provider: opts?.provider ?? 'gumlet',
          gumlet: FULL_GUMLET,
        },
      }),
    } as never,
  );
  return { service, prisma, gumlet, updates, row, fetchSpy };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('DrmVerificationService.verify - what actually counts as proof', () => {
  it('verifies only when the manifest is genuinely CENC-encrypted', async () => {
    const t = buildVerifier({ encrypted: true });
    const verdict = await t.service.verify('v_1');
    expect(verdict.playable).toBe(true);
    expect(t.updates.at(-1)?.drmVerifiedAt).toBeInstanceOf(Date);
  });

  it('REFUSES when Gumlet reports ready but the manifest is NOT encrypted', async () => {
    // The exact silent-downgrade this whole service exists to prevent.
    const t = buildVerifier({ encrypted: false });
    const verdict = await t.service.verify('v_1');
    expect(verdict.playable).toBe(false);
    // And it must CLEAR any prior success rather than leaving it standing.
    expect(t.updates.at(-1)?.drmVerifiedAt).toBeNull();
    expect(String(t.updates.at(-1)?.drmBlockedReason)).toMatch(/not CENC-encrypted/i);
  });

  it('clears a previously-good verification when the manifest later turns unencrypted', async () => {
    const t = buildVerifier({ encrypted: false });
    // Simulate a row that was verified an hour ago.
    (t.row as { drmVerifiedAt: Date | null }).drmVerifiedAt = new Date(Date.now() - 3600_000);
    const verdict = await t.service.verify('v_1');
    expect(verdict.playable).toBe(false);
    expect(t.updates.at(-1)?.drmVerifiedAt).toBeNull();
  });

  it('fails closed when the provider cannot be reached', async () => {
    const t = buildVerifier({ getAssetThrows: true });
    const verdict = await t.service.verify('v_1');
    expect(verdict.playable).toBe(false);
    expect(t.updates.at(-1)?.drmVerifiedAt).toBeNull();
  });

  it('fails closed when the manifest cannot be fetched', async () => {
    const t = buildVerifier({ fetchThrows: true });
    const verdict = await t.service.verify('v_1');
    expect(verdict.playable).toBe(false);
  });

  it('refuses an asset the provider reports as errored', async () => {
    const t = buildVerifier({ assetStatus: 'errored' });
    const verdict = await t.service.verify('v_1');
    expect(verdict.playable).toBe(false);
    if (!verdict.playable) expect(verdict.reason).toBe('ASSET_FAILED');
  });
});

describe('DrmVerificationService.evaluate - the playback-time gate', () => {
  const evaluate = (row: Partial<VideoForVerdict>, buildOpts?: Parameters<typeof buildVerifier>[0]) =>
    buildVerifier(buildOpts).service.evaluate(verifiedVideo(row));

  it('allows a freshly verified video', () => {
    expect(evaluate({}).playable).toBe(true);
  });

  it('denies when the database merely says READY but nothing was verified', () => {
    // THE core case: a row whose status was set by hand or by an old code path.
    const v = evaluate({ drmVerifiedAt: null, drmBlockedReason: 'never checked' });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('NOT_VERIFIED');
  });

  it('denies when the verification is older than the TTL', () => {
    const v = evaluate({ drmVerifiedAt: new Date(Date.now() - 7 * 3600_000) });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('VERIFICATION_STALE');
  });

  it('denies a video with no Gumlet asset', () => {
    const v = evaluate({ gumletAssetId: null });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('NO_GUMLET_ASSET');
  });

  it('denies a video whose asset was never requested with DRM', () => {
    const v = evaluate({ drmRequested: false });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('DRM_NOT_REQUESTED');
  });

  it('denies when the asset is still processing', () => {
    const v = evaluate({ gumletStatus: 'processing' });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('ASSET_NOT_READY');
  });

  it('denies everything when DRM is disabled platform-wide', () => {
    const v = evaluate({}, { enabled: false });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('DRM_DISABLED_ON_PLATFORM');
  });

  it('denies everything when signing is unconfigured, since no licence can be issued', () => {
    const v = evaluate({}, { signing: false });
    expect(v.playable).toBe(false);
    if (!v.playable) expect(v.reason).toBe('SIGNING_UNAVAILABLE');
  });
});

/**
 * PlaybackService, for real.
 *
 * `resolvePlaybackTarget` is the single function that decides what a student is
 * handed. These tests assert that when DRM verification fails it throws, and
 * that it NEVER returns a legacy HLS manifest, an R2 URL, or an unprotected DRM
 * block as a consolation prize.
 */
function playback(drm: unknown, videoOverrides?: Record<string, unknown>) {
  const gumlet = {
    signLicenseUrl: jest.fn(() => ({
      licenseUrl: 'https://widevine.gumlet.com/licence/org_1/a_1?token=T&expires=1&hardware_secure=true',
      certificateUrl: 'https://fairplay.gumlet.com/certificate/org_1',
      manifestUrl: null,
      expires: 1,
      expiresIso: new Date().toISOString(),
      signedString: '/org_1/a_1?expires=1&hardware_secure=true',
      hardwareSecure: true,
      videoRobustness: ['HW_SECURE_ALL'],
      audioRobustness: ['HW_SECURE_ALL'],
    })),
    signFairPlayLicenseUrl: jest.fn(() => 'https://fairplay.gumlet.com/licence/org_1/a_1?token=T'),
    dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
    hlsManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.m3u8'),
  };
  // Spied explicitly and returned, so a test can assert it was never reached.
  // Calling it is the fallback this gate exists to close, so silence on this mock
  // is the actual security property being verified.
  const manifest = {
    buildMasterUrl: jest.fn(() => 'https://api.example/playback/manifest/t_1/master.m3u8'),
  };
  const service = new PlaybackService(
    {} as never, {} as never, {} as never, {} as never, {} as never,
    manifest as never,
    {} as never, {} as never, gumlet as never, drm as never,
    {
      getOrThrow: jest.fn((k: string) =>
        k === 'video'
          ? { drm: { enabled: true, provider: 'gumlet', gumlet: FULL_GUMLET } }
          : { ticketTtl: 300 },
      ),
    } as never,
  );
  const video = {
    id: 'v_1',
    drmProvider: 'gumlet',
    gumletAssetId: 'a_1',
    gumletWorkspaceId: 'ws_1',
    gumletStatus: 'ready',
    ...videoOverrides,
  };
  return { service, video, gumlet, manifest };
}

describe('playback is fail-closed', () => {
  it('refuses to hand back ANY url when DRM is not verified', async () => {
    const { service, video, gumlet } = playback(denyDrm());
    await expect(
      service['resolvePlaybackTarget']('t_1', video as never, new Date(Date.now() + 60_000), 'web'),
    ).rejects.toThrow();
    // Nothing may be minted on the way to failing.
    expect(gumlet.signLicenseUrl).not.toHaveBeenCalled();
  });

  it('never falls back to the legacy HLS manifest when DRM verification fails', async () => {
    // The manifest builder injected into the service under test is the spied one,
    // so a real fallback would show up as a call on this exact mock. Passing an
    // unused local does not prove anything.
    const { service, video, manifest } = playback(denyDrm());
    await expect(
      service['resolvePlaybackTarget']('t_1', video as never, new Date(Date.now() + 60_000), 'web'),
    ).rejects.toThrow();

    // The gate refused. The legacy builder must have been left untouched: that is
    // the bypass this whole gate exists to close.
    expect(manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('refuses a legacy video (drmProvider null) outright - no AES-128 downgrade', async () => {
    const { service, manifest } = playback(denyDrm('NO_GUMLET_ASSET'));
    await expect(
      service['resolvePlaybackTarget'](
        't_1',
        { id: 'v_1', drmProvider: null, gumletAssetId: null, gumletWorkspaceId: null, gumletStatus: null } as never,
        new Date(Date.now() + 60_000),
        'web',
      ),
    ).rejects.toThrow();
    // Explicit: a video with no provider is NOT served unprotected as a fallback.
    expect(manifest.buildMasterUrl).not.toHaveBeenCalled();
  });

  it('reports "still preparing" for a processing asset so the app can be friendly', async () => {
    const { service, video } = playback(denyDrm('ASSET_NOT_READY'), { gumletStatus: 'processing' });
    await expect(
      service['resolvePlaybackTarget']('t_1', video as never, new Date(Date.now() + 60_000), 'web'),
    ).rejects.toMatchObject({ code: 'VIDEO_NOT_READY' });
  });

  it('reports unavailable (not "try later") for a failed asset', async () => {
    const { service, video } = playback(denyDrm('ASSET_FAILED'), { gumletStatus: 'errored' });
    await expect(
      service['resolvePlaybackTarget']('t_1', video as never, new Date(Date.now() + 60_000), 'web'),
    ).rejects.toMatchObject({ code: 'VIDEO_UNAVAILABLE' });
  });

  it('serves the DRM manifest only when verification passed', async () => {
    const { service, video, gumlet } = playback(allowDrm());
    const result = await service['resolvePlaybackTarget'](
      't_1', video as never, new Date(Date.now() + 60_000), 'web',
    );
    expect(result.manifestUrl).toBe('https://video.gumlet.io/ws_1/a_1/main.mpd');
    expect(result.drm.scheme).toBe('widevine');
    expect(result.drm.licenseUrl).toContain('widevine.gumlet.com');
    expect(gumlet.signLicenseUrl).toHaveBeenCalled();
    // Never a legacy manifest URL.
    expect(result.manifestUrl).not.toContain('/playback/manifest/');
  });

  it('refuses when the platform has DRM disabled, even for a verified video', async () => {
    const { video, gumlet } = playback(allowDrm());
    // Same wiring, but with DRM switched off at the platform level.
    const svc = new PlaybackService(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      { buildMasterUrl: jest.fn() } as never, {} as never, {} as never, gumlet as never,
      allowDrm() as never,
      {
        getOrThrow: jest.fn(() => ({ drm: { enabled: false, provider: 'none', gumlet: FULL_GUMLET } })),
      } as never,
    );
    await expect(
      svc['resolvePlaybackTarget']('t_1', video as never, new Date(Date.now() + 60_000), 'web'),
    ).rejects.toThrow();
  });
});