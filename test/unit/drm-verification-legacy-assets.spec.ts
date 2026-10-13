import { DrmVerificationService } from '../../src/modules/playback/drm-verification.service';

/**
 * Three videos were migrated onto Gumlet BEFORE the migration that added the
 * `drmRequested` column, so their rows read `drmRequested: false` by default
 * even though their assets were created with DRM enabled.
 *
 * `verify()`'s precheck judged that flag and refused them outright, so a real,
 * CENC-encrypted asset could never be verified. The fix forces the flag during
 * the precheck (exactly as it already forces `gumletStatus`) and relies on the
 * CENC check below, which is the actual proof.
 *
 * The case these tests must ALSO keep red: an asset created WITHOUT DRM is still
 * denied, now by the CENC check rather than by the intent flag.
 *
 * Recovery Fix 2: verifying alone was not enough - the hot path still refused
 * `drmRequested=false`. A successful verification now also records
 * `drmRequested=true`, but only when the request is on record (ours, or
 * Gumlet's `input.transformations.drm.type` naming Widevine).
 */

const CENC_MANIFEST =
  '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="k"/></AdaptationSet></MPD>';
const UNENCRYPTED = '<MPD><AdaptationSet><Segment/></AdaptationSet></MPD>';

function build(opts: {
  row?: Record<string, unknown>;
  manifest?: string;
  assetStatus?: string;
  /** Gumlet's record of the DRM systems the asset was created with. */
  drmSystems?: string[] | null;
}) {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    text: async () => opts.manifest ?? CENC_MANIFEST,
  } as never);

  const updateMany = jest.fn(async (a: { data: Record<string, unknown> }) => {
    Object.assign(row, a.data);
    return { count: 1 };
  });
  const update = jest.fn(async (a: { data: Record<string, unknown> }) => {
    Object.assign(row, a.data);
    return row;
  });
  const findFirst = jest.fn(async () => row);

  const row = {
    id: 'v_old',
    drmProvider: 'gumlet',
    // The default a pre-migration adoption leaves behind.
    drmRequested: false,
    drmVerifiedAt: null,
    drmBlockedReason: null,
    gumletAssetId: 'a_legacy',
    gumletStatus: 'ready',
    gumletWorkspaceId: 'ws_1',
    status: 'READY',
    ...opts.row,
  };

  const gumlet = {
    isSigningConfigured: jest.fn(() => true),
    dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_legacy/main.mpd'),
    assetHasDrm: (t: string) =>
      /schemeIdUri="urn:mpeg:dash:mp4protection:2011"/.test(t) && /cenc:default_KID="/.test(t),
    getAsset: jest.fn(async () => ({
      assetId: 'a_legacy',
      status: opts.assetStatus ?? 'ready',
      progress: 100,
      playbackUrl: null,
      dashPlaybackUrl: null,
      error: null,
      // What Gumlet reports for every production asset today.
      drmSystems: opts.drmSystems === undefined ? ['widevine', 'fairplay'] : opts.drmSystems,
    })),
    isAssetPlayable: (s: string) => s === 'ready',
  };

  const service = new DrmVerificationService(
    { video: { findFirst, update, updateMany } } as never,
    gumlet as never,
    { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: {} } }) } as never,
  );
  return { service, row, update, updateMany };
}

afterEach(() => {
  (global.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe('DrmVerificationService.verify - pre-migration videos', () => {
  it('verifies a pre-migration asset whose manifest is genuinely CENC', async () => {
    const { service, row } = build({});
    const v = await service.verify('v_old');
    expect(v.playable).toBe(true);
    expect(row.drmVerifiedAt).toBeInstanceOf(Date);
  });

  it('STILL denies an asset that was created without DRM', async () => {
    // The safety case. Forcing the intent flag must not create a bypass: a
    // manifest with no CENC still fails, and now it fails on the real proof.
    const { service, row } = build({ manifest: UNENCRYPTED });
    const v = await service.verify('v_old');
    expect(v.playable).toBe(false);
    expect(v.reason).toBe('NOT_VERIFIED');
    expect(row.drmVerifiedAt).toBeNull();
    expect(row.drmBlockedReason).toContain('not CENC-encrypted');
  });

  it('STILL denies when the provider reports a dead asset', async () => {
    const { service, row } = build({ assetStatus: 'errored' });
    const v = await service.verify('v_old');
    expect(v.playable).toBe(false);
    expect(row.drmVerifiedAt).toBeNull();
  });

  it('STILL denies when DRM is disabled platform-wide', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => CENC_MANIFEST,
    } as never);
    const updateMany = jest.fn(async () => ({ count: 1 }));
    const findFirst = jest.fn(async () => ({
      id: 'v_old',
      drmProvider: 'gumlet',
      drmRequested: false,
      drmVerifiedAt: null,
      drmBlockedReason: null,
      gumletAssetId: 'a_legacy',
      gumletStatus: 'ready',
      gumletWorkspaceId: 'ws_1',
      status: 'READY',
    }));
    const service = new DrmVerificationService(
      { video: { findFirst, update: jest.fn(), updateMany } } as never,
      {
        isSigningConfigured: jest.fn(() => true),
        dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_legacy/main.mpd'),
        assetHasDrm: () => true,
        getAsset: jest.fn(),
        isAssetPlayable: () => true,
      } as never,
      { getOrThrow: () => ({ drm: { enabled: false, provider: 'gumlet', gumlet: {} } }) } as never,
    );
    const v = await service.verify('v_old');
    expect(v.playable).toBe(false);
    expect(v.reason).toBe('DRM_DISABLED_ON_PLATFORM');
  });

  it('STILL denies when signing is unconfigured', async () => {
    const findFirst = jest.fn(async () => ({
      id: 'v_old',
      drmProvider: 'gumlet',
      drmRequested: false,
      drmVerifiedAt: null,
      drmBlockedReason: null,
      gumletAssetId: 'a_legacy',
      gumletStatus: 'ready',
      gumletWorkspaceId: 'ws_1',
      status: 'READY',
    }));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => CENC_MANIFEST,
    } as never);
    const service = new DrmVerificationService(
      { video: { findFirst, update: jest.fn(), updateMany: jest.fn(async () => ({ count: 1 })) } } as never,
      {
        isSigningConfigured: jest.fn(() => false),
        dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_legacy/main.mpd',
        ),
        assetHasDrm: () => true,
        getAsset: jest.fn(),
        isAssetPlayable: () => true,
      } as never,
      { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: {} } }) } as never,
    );
    const v = await service.verify('v_old');
    expect(v.playable).toBe(false);
    expect(v.reason).toBe('SIGNING_UNAVAILABLE');
  });

  // Superseded policy (recovery Fix 2). Leaving drmRequested=false after a
  // successful verification is what made every pre-column asset unplayable:
  // evaluate() refuses it as DRM_NOT_REQUESTED on every ticket. The flag is now
  // established at verification - but ONLY from a record of the request.
  it('establishes drmRequested from the provider record of the DRM request, so the hot path agrees', async () => {
    const { service, row } = build({});
    await service.verify('v_old');
    expect(row.drmRequested).toBe(true);
    expect(service.evaluate(row as never)).toEqual({ playable: true, reason: null });
  });

  it('does not establish drmRequested without any record of the request, even for a CENC manifest', async () => {
    const { service, row } = build({ drmSystems: null });
    const v = await service.verify('v_old');
    expect(v).toMatchObject({ playable: false, reason: 'DRM_NOT_REQUESTED' });
    expect(row.drmRequested).toBe(false);
    expect(row.drmVerifiedAt).toBeNull();
  });

  it('a verification failure never sets drmRequested', async () => {
    const { service, row } = build({ manifest: UNENCRYPTED });
    await service.verify('v_old');
    expect(row.drmRequested).toBe(false);
  });
});
