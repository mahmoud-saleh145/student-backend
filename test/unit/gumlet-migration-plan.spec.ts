/**
 * RECONSTRUCTED FILE — NOT THE ORIGINAL.
 *
 * `test/unit/gumlet-migration-plan.spec.ts` was an untracked, uncommitted file
 * that was destroyed by the workspace file-deletion incident of 2026-10-12 and
 * could not be recovered (it is absent from every commit, stash and dangling
 * object; see the audit report). Its subject, `src/modules/videos/gumlet-migration.plan.ts`,
 * survived intact.
 *
 * This file is therefore written FRESH against that surviving source. It is a
 * new test, not a reconstruction of the deleted text, and it makes no claim to
 * reproduce the original assertions. It covers the module's documented
 * invariants so the lost coverage is not lost with the file.
 */

import {
  planBatch,
  planVideo,
  summarize,
  type VideoRow,
} from '../../src/modules/videos/gumlet-migration.plan';

function row(overrides: Partial<VideoRow> = {}): VideoRow {
  return {
    id: 'vid_1',
    status: 'READY',
    drmProvider: null,
    gumletAssetId: null,
    gumletStatus: null,
    sourceKey: 'uploads/vid_1.mp4',
    masterPlaylistKey: 'hls/vid_1/master.m3u8',
    deletedAt: null,
    ...overrides,
  };
}

describe('planVideo', () => {
  it('never throws on unexpected data - a migration must not abort halfway', () => {
    const odd = row({
      status: 'SOMETHING_ELSE',
      drmProvider: 'Gumlet', // wrong case, i.e. a typo'd provider
      gumletAssetId: 'a_1',
      sourceKey: null,
      masterPlaylistKey: null,
    });
    expect(() => planVideo(odd)).not.toThrow();
    // A stored asset id short-circuits to `verify` BEFORE the provider check,
    // and that ordering is deliberate: an asset already exists, so the only
    // safe action is to re-check it. It must never be `adopt`.
    expect(planVideo(odd).action).not.toBe('adopt');
  });

  it('refuses to guess at a typo\'d provider when there is no asset yet', () => {
    expect(planVideo(row({ drmProvider: 'Gumlet' }))).toMatchObject({
      action: 'skip',
      reason: 'UNKNOWN_PROVIDER',
    });
  });

  it('skips a soft-deleted row - adopting it would resurrect removed content', () => {
    const plan = planVideo(row({ deletedAt: new Date() }));
    expect(plan).toMatchObject({ action: 'skip', reason: 'SOFT_DELETED', noOp: true });
  });

  describe('THE DUPLICATE-ASSET GUARD', () => {
    it('verifies an already-migrated READY video without ever adopting', () => {
      const plan = planVideo(
        row({ drmProvider: 'gumlet', gumletAssetId: 'a_1', status: 'READY', gumletStatus: 'ready' }),
      );
      expect(plan).toMatchObject({ action: 'verify', reason: 'ALREADY_MIGRATED_READY', noOp: true });
    });

    it('never returns "adopt" when an asset id is already stored', () => {
      // Even the inconsistent case: an asset id with a null provider.
      const plan = planVideo(row({ drmProvider: null, gumletAssetId: 'a_1', gumletStatus: 'processing' }));
      expect(plan.action).not.toBe('adopt');
      expect(plan.action).toBe('verify');
    });

    it('skips provider=gumlet with NO asset id rather than risking a duplicate', () => {
      const plan = planVideo(row({ drmProvider: 'gumlet', gumletAssetId: null }));
      expect(plan).toMatchObject({ action: 'skip', reason: 'NOT_SAFE_TO_MIGRATE', noOp: true });
    });
  });

  describe('legacy candidates', () => {
    it('adopts a working legacy video with a stored source', () => {
      expect(planVideo(row())).toMatchObject({
        action: 'adopt',
        reason: 'CANDIDATE_LEGACY_READY',
        noOp: false,
      });
    });

    it('skips when there is no source object to hand to Gumlet', () => {
      expect(planVideo(row({ sourceKey: null }))).toMatchObject({
        action: 'skip',
        reason: 'NO_SOURCE_OBJECT',
      });
    });

    it('never overwrites a row the local worker already owns', () => {
      for (const status of ['PROCESSING', 'QUEUED', 'UPLOADING']) {
        expect(planVideo(row({ status }))).toMatchObject({
          action: 'skip',
          reason: 'ALREADY_PROCESSING',
        });
      }
    });

    it('refuses to "migrate" a broken legacy row - that is a repair, not a migration', () => {
      const plan = planVideo(row({ status: 'FAILED', masterPlaylistKey: null }));
      expect(plan).toMatchObject({ action: 'skip', reason: 'NO_LEGACY_PLAYBACK' });
    });

    it('refuses to guess at an unrecognised provider', () => {
      expect(planVideo(row({ drmProvider: 'GUMLET' }))).toMatchObject({
        action: 'skip',
        reason: 'UNKNOWN_PROVIDER',
      });
    });
  });

  describe('replacement and repair escape hatches', () => {
    const deadLegacy = row({
      drmProvider: null,
      gumletAssetId: 'a_dead',
      gumletStatus: 'errored',
      status: 'READY',
    });
    const deadOnGumlet = row({
      drmProvider: 'gumlet',
      gumletAssetId: 'a_dead',
      gumletStatus: 'failed',
      status: 'FAILED',
    });

    it('never replaces without an explicit opt-in', () => {
      expect(planVideo(deadLegacy).action).toBe('verify');
      expect(planVideo(deadOnGumlet).action).toBe('verify');
    });

    it('replaces a dead asset on a still-working legacy video when asked', () => {
      expect(
        planVideo(deadLegacy, { allowAssetReplacement: true }),
      ).toMatchObject({ action: 'replace', reason: 'REPLACE_FAILED_GUMLET_ASSET' });
    });

    it('repairs a dead asset on the Gumlet path when asked', () => {
      expect(
        planVideo(deadOnGumlet, { allowGumletProviderReplacement: true }),
      ).toMatchObject({ action: 'replace', reason: 'REPAIR_FAILED_GUMLET_ASSET' });
    });

    it('will not replace when there is no stored source to rebuild from', () => {
      const noSource = { ...deadOnGumlet, sourceKey: null };
      expect(
        planVideo(noSource, { allowGumletProviderReplacement: true }).action,
      ).not.toBe('replace');
    });

    it('does not cross the wires: the legacy hatch never fires on the Gumlet path', () => {
      expect(
        planVideo(deadOnGumlet, { allowAssetReplacement: true }).action,
      ).not.toBe('replace');
    });
  });
});

describe('planBatch', () => {
  const rows = [
    row({ id: 'vid_adopt', drmProvider: null, sourceKey: 'uploads/a.mp4', masterPlaylistKey: 'hls/a.m3u8', status: 'READY' }),
    row({ id: 'vid_verify', drmProvider: 'gumlet', gumletAssetId: 'a_1', gumletStatus: 'ready', status: 'READY' }),
    row({ id: 'vid_skip', drmProvider: null, sourceKey: null, status: 'READY' }),
  ];

  it('puts verify before adopt before skip - cheapest and safest work first', () => {
    const order = planBatch(rows).map((p) => p.action);
    expect(order).toEqual(['verify', 'adopt', 'skip']);
  });

  it('breaks ties deterministically by video id, so a resumed run repeats itself', () => {
    const a = planBatch([row({ id: 'b' }), row({ id: 'a' })]);
    expect(a.map((p) => p.videoId)).toEqual(['a', 'b']);
  });

  it('applies the limit AFTER ordering, so a resumed run continues rather than re-deciding', () => {
    const first = planBatch(rows, 1);
    expect(first).toHaveLength(1);
    expect(first[0].action).toBe('verify');
  });

  it('ignores a non-positive limit rather than returning nothing', () => {
    expect(planBatch(rows, 0)).toHaveLength(3);
  });
});

describe('summarize', () => {
  it('counts plans by reason', () => {
    const counts = summarize(planBatch([
      row({ id: 'a', drmProvider: null, sourceKey: 'uploads/a.mp4' }),
      row({ id: 'b', drmProvider: null, sourceKey: 'uploads/b.mp4' }),
      row({ id: 'c', sourceKey: null }),
    ]));
    expect(counts).toMatchObject({ CANDIDATE_LEGACY_READY: 2, NO_SOURCE_OBJECT: 1 });
  });
});