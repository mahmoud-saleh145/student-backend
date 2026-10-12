import { planVideo, planBatch } from '../../src/modules/videos/gumlet-migration.plan';

const deadGumlet = {
  id: 'cmv45oru1003pew013zmveffo',
  status: 'FAILED' as const,
  drmProvider: 'gumlet',
  gumletAssetId: 'asset_dead',
  gumletStatus: 'errored',
  sourceKey: 'source/videos/x.mp4',
  masterPlaylistKey: null,
  deletedAt: null,
};

const deadLegacy = {
  ...deadGumlet,
  id: 'cmv1jekin002deh01ixfuam3u',
  status: 'READY' as const,
  drmProvider: null,
};

describe('planVideo - repairing a video already on the Gumlet path', () => {
  it('plans "verify" by default for a failed gumlet video (no silent repair)', () => {
    const plan = planVideo(deadGumlet, { allowGumletProviderReplacement: false });
    expect(plan.action).toBe('verify');
    expect(plan.reason).toBe('CANDIDATE_GUMLET_PENDING');
  });

  it('plans "replace" when repair is explicitly requested', () => {
    const plan = planVideo(deadGumlet, { allowGumletProviderReplacement: true });
    expect(plan.action).toBe('replace');
    expect(plan.reason).toBe('REPAIR_FAILED_GUMLET_ASSET');
  });

  it('refuses to repair a NON-terminal asset status even when asked', () => {
    const plan = planVideo(
      { ...deadGumlet, gumletStatus: 'processing' },
      { allowGumletProviderReplacement: true },
    );
    expect(plan.action).toBe('verify');
  });

  it('refuses to repair a video with no source object', () => {
    // The planner falls through to "verify" here rather than "skip": the row
    // carries a dead asset, so it is reported as pending rather than dropped.
    // What matters is that it is never planned as a replacement - a replacement
    // has nothing to be built from.
    const plan = planVideo(
      { ...deadGumlet, sourceKey: null },
      { allowGumletProviderReplacement: true },
    );
    expect(plan.action).not.toBe('replace');
    expect(plan.action).toBe('verify');
  });

  it('refuses to touch a soft-deleted video', () => {
    const plan = planVideo(
      { ...deadGumlet, deletedAt: new Date() },
      { allowGumletProviderReplacement: true },
    );
    expect(plan.action).toBe('skip');
    expect(plan.reason).toBe('SOFT_DELETED');
  });

  it('still requires an explicit flag for the LEGACY replacement path', () => {
    const plan = planVideo(deadLegacy);
    expect(plan.action).toBe('verify');
    const gated = planVideo(deadLegacy, { allowAssetReplacement: true });
    expect(gated.action).toBe('replace');
    expect(gated.reason).toBe('REPLACE_FAILED_GUMLET_ASSET');
  });

  it('never mixes the two hats: repair does not fire for a legacy video', () => {
    const plan = planVideo(deadLegacy, { allowGumletProviderReplacement: true });
    expect(plan.action).toBe('verify');
  });
});

describe('planBatch - threading the repair option', () => {
  it('forwards allowGumletProviderReplacement through planBatch', () => {
    const plans = planBatch([deadGumlet as never], undefined, {
      allowGumletProviderReplacement: true,
    });
    expect(plans[0].action).toBe('replace');
    expect(plans[0].reason).toBe('REPAIR_FAILED_GUMLET_ASSET');
  });

  it('defaults to no repair when the flag is absent', () => {
    const plans = planBatch([deadGumlet as never]);
    expect(plans[0].action).toBe('verify');
  });
});
