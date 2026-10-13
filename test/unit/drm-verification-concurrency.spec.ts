import { DrmVerificationService } from '../../src/modules/playback/drm-verification.service';
import { fetchManifestViaGlobalFetch } from './helpers/drm-doubles';

/**
 * Two verifications of the same video can overlap: the recurring sweep and a
 * provider webhook, or two workers once the sweep is scaled. Whichever finishes
 * last writes last, so without a guard a check that STARTED earlier can finish
 * later and push `drmVerifiedAt` backwards - and, worse, overwrite a success
 * with one that was made against older evidence.
 */

/** The same fixture shape `GumletDrmService.assetHasDrm()` requires. */
const CENC_MANIFEST =
  '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="k"/></AdaptationSet></MPD>';

afterEach(() => {
  (global.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

type WriteArgs = { where: Record<string, unknown>; data: Record<string, unknown> };

function build(updateManyResult: { count: number }) {
  jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    text: async () => CENC_MANIFEST,
  } as never);
  const updateMany = jest.fn(async (_args: WriteArgs) => updateManyResult);
  const update = jest.fn(async (_args: WriteArgs) => ({}));
  const findFirst = jest.fn(async (_args?: { where?: { id?: string } }): Promise<typeof ROW> => ROW);

  const gumlet = {
    isSigningConfigured: jest.fn(() => true),
    dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
    fetchManifest: fetchManifestViaGlobalFetch,
    assetHasDrm: jest.fn(() => true),
    getAsset: jest.fn(async () => ({
      assetId: 'a_1',
      status: 'ready',
      progress: 100,
      playbackUrl: null,
      dashPlaybackUrl: null,
      error: null,
    })),
    isAssetPlayable: jest.fn(() => true),
  };

  const service = new DrmVerificationService(
    { video: { findFirst, update, updateMany } } as never,
    gumlet as never,
    { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: {} } }) } as never,
  );
  return { service, updateMany, update, findFirst };
}

const ROW = {
  id: 'v_1',
  drmProvider: 'gumlet',
  drmRequested: true,
  drmVerifiedAt: null as Date | null,
  drmBlockedReason: null,
  gumletAssetId: 'a_1',
  gumletStatus: 'ready',
  gumletWorkspaceId: 'ws_1',
  status: 'READY',
};

describe('DrmVerificationService.verify - concurrent writes', () => {
  it('writes the proof when nothing newer exists', async () => {
    const { service, updateMany } = build({ count: 1 });
    const v = await service.verify('v_1');
    expect(v.playable).toBe(true);
    // Two writes: the concurrency claim taken before the provider call, then the
    // proof itself, conditional on that claim still being ours.
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[0][0].data).toEqual({ drmCheckedAt: expect.any(Date) });
    expect(updateMany.mock.calls[1][0].data).toMatchObject({ drmVerifiedAt: expect.any(Date) });
  });

  it('makes the write conditional on this check still owning the row', async () => {
    const { service, updateMany } = build({ count: 1 });
    await service.verify('v_1');
    const where = updateMany.mock.calls[1][0].where;
    // The guard: the row must still carry the claim this check took on entry,
    // and still hold the asset this check read.
    expect(where).toMatchObject({
      id: 'v_1',
      gumletAssetId: 'a_1',
      drmCheckedAt: expect.any(Date),
    });
  });

  it('does NOT regress the timestamp when a newer verification already won', async () => {
    // `count: 0` is what the conditional write returns when another verification
    // landed first. The loser must not move anything, so a slow check cannot
    // shorten a TTL that a fresh one just established - and it reports the
    // STORED state, which here is the winner's fresh proof.
    const { service, updateMany, findFirst } = build({ count: 0 });
    findFirst
      .mockResolvedValueOnce(ROW)
      .mockResolvedValueOnce({ ...ROW, drmVerifiedAt: new Date() });
    const v = await service.verify('v_1');
    expect(v.playable).toBe(true);
    expect(findFirst).toHaveBeenCalledTimes(2);
    // The claim plus the (rejected) proof write.
    expect(updateMany).toHaveBeenCalledTimes(2);
    // No unconditional write that would clobber the winner.
    expect(updateMany.mock.calls[1][0].where).toBeDefined();
  });

  it('a real failure clears a proof recorded BEFORE the check started (conditional write)', async () => {
    const gumletHasDrm = false;
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => '<MPD></MPD>',
    } as never);
    const updateMany = jest.fn(async (_args: WriteArgs) => ({ count: 1 }));
    const update = jest.fn(async (_args: WriteArgs) => ({}));
    const findFirst = jest.fn(async (_args?: { where?: { id?: string } }) => ({
      id: 'v_1',
      drmProvider: 'gumlet',
      drmRequested: true,
      // Recorded by an earlier check, i.e. before this one started.
      drmVerifiedAt: new Date(Date.now() - 60_000),
      drmBlockedReason: null,
      gumletAssetId: 'a_1',
      gumletStatus: 'ready',
      gumletWorkspaceId: 'ws_1',
      status: 'READY',
    }));
    const service = new DrmVerificationService(
      { video: { findFirst, update, updateMany } } as never,
      {
        isSigningConfigured: jest.fn(() => true),
        dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
        fetchManifest: fetchManifestViaGlobalFetch,
        assetHasDrm: jest.fn(() => gumletHasDrm),
        getAsset: jest.fn(async () => ({
          assetId: 'a_1',
          status: 'ready',
          progress: 100,
          playbackUrl: null,
          dashPlaybackUrl: null,
          error: null,
        })),
        isAssetPlayable: jest.fn(() => true),
      } as never,
      { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: {} } }) } as never,
    );

    const v = await service.verify('v_1');
    expect(v.playable).toBe(false);
    // The failure clears the proof - but conditionally: only while the row
    // holds the checked asset and no proof NEWER than this check's start is
    // stored (drm-verification-races.spec.ts runs the race end to end).
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledTimes(2);
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: {
        id: 'v_1',
        gumletAssetId: 'a_1',
        drmCheckedAt: expect.any(Date),
      },
      data: { drmVerifiedAt: null, drmBlockedReason: expect.stringContaining('not CENC-encrypted') },
    });
  });
});
