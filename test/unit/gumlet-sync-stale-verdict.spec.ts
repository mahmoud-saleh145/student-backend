import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';

/**
 * A verdict from an older attempt must never overwrite a newer one.
 * ---------------------------------------------------------------------------
 *
 * The recovery path REPLACES a dead provider asset with a fresh one. That
 * creates a window in which two things are asking about the same video: the
 * attempt that read the OLD asset, and the attempt that is working on the NEW
 * one.
 *
 * `sync()` used to write its result with an unconditional `video.update({ id })`.
 * If the asset was replaced in the meantime, the OLD asset's verdict - "the
 * asset failed", "the asset is not encrypted" - was written straight over the
 * NEW asset's state. A video that had just been recovered was marked failed
 * again by a reply to a question about an asset that no longer existed.
 *
 * The fix is the same conditional write the DRM verifier already uses: a result
 * may only be written while the row still holds the asset the result is about.
 *
 * This file also pins the other half of the contract: the provider's own error
 * has to reach the place a failure is actually read, or an operator is shown
 * "Processing failed" with no reason at all.
 */

interface Row {
  id: string;
  status: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
  gumletStatus: string | null;
  gumletError: string | null;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  processingError: string | null;
  lessonId: string | null;
  courseId: string | null;
}

function build(opts: {
  asset: { status: string; error?: string | null; errorCode?: string | null };
  /** The asset id the row holds once the provider call returns. */
  assetIdAfterRead?: string;
  playable?: boolean;
  platformUsable?: boolean;
} ) {
  const row: Row = {
    id: 'vid_1',
    status: 'PROCESSING',
    drmProvider: 'gumlet',
    gumletAssetId: 'asset_old',
    gumletWorkspaceId: 'ws',
    gumletStatus: 'processing',
    gumletError: null,
    width: null,
    height: null,
    frameRate: null,
    processingError: null,
    lessonId: 'les_1',
    courseId: 'crs_1',
  };

  const updateManyCalls: Array<{ where?: Record<string, unknown>; data: Record<string, unknown> }> = [];
  const updates: Array<Record<string, unknown>> = [];

  const prisma = {
    video: {
      // A SNAPSHOT, exactly as Prisma returns one: the caller keeps the row it
      // read, even if the stored row changes underneath it.
      findFirst: jest.fn(async () => ({ ...row })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        Object.assign(row, args.data);
        return row;
      }),
      updateMany: jest.fn(async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push(args);
        updates.push(args.data);
        // Honour the guard exactly as the database would: the write only
        // lands while the row still holds the asset the caller read.
        const guarded = args.where?.gumletAssetId;
        const matches = guarded === undefined || guarded === row.gumletAssetId;
        if (matches) Object.assign(row, args.data);
        return { count: matches ? 1 : 0 };
      }),
      findUniqueOrThrow: jest.fn(async () => ({ status: row.status })),
    },
  };

  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    getAsset: jest.fn(async () => {
      // The asset is replaced WHILE the provider call is in flight - the
      // exact race this file is about.
      if (opts.assetIdAfterRead !== undefined) {
        row.gumletAssetId = opts.assetIdAfterRead;
      }
      return {
        assetId: row.gumletAssetId,
        status: opts.asset.status,
        progress: 0,
        playbackUrl: null,
        dashPlaybackUrl: null,
        error: opts.asset.error ?? null,
        errorCode: opts.asset.errorCode ?? null,
        durationSeconds: 100,
        width: 1920,
        height: 1080,
        frameRate: 25,
      };
    }),
    dashManifestUrl: ({ assetId }: { assetId: string }) => `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };

  const drmVerification = {
    evaluate: jest.fn(),
    verify: jest.fn(async () =>
      opts.playable === false
        ? { playable: false, reason: 'MANIFEST_NOT_ENCRYPTED', detail: 'not CENC' }
        : { playable: true, reason: 'OK', detail: '' },
    ),
    isPlatformUsable: () => opts.platformUsable ?? true,
  };

  const config = {
    getOrThrow: () => ({
      drm: {
        enabled: true,
        provider: 'gumlet',
        gumlet: { workspaceId: 'ws', resolutions: ['720p', '1080p'] },
      },
    }),
  };

  const service = new GumletIngestService(
    prisma as never,
    { isConfigured: true, exists: jest.fn(async () => true) } as never,
    gumlet as never,
    drmVerification as never,
    config as never,
    { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) } as never,
    { record: jest.fn() } as never,
  );

  return { service, prisma, row, gumlet, drmVerification, updateManyCalls, updates };
}

describe('GumletIngestService.sync - a stale verdict cannot overwrite a newer attempt', () => {
  it('writes nothing when the asset was replaced while the provider was being read', async () => {
    const h = build({
      asset: { status: 'errored', error: 'We had trouble downloading the input video/audio file' },
      // The row now points at a different asset than the one this call read.
      assetIdAfterRead: 'asset_new',
    });

    await h.service.sync('vid_1');

    // The write was attempted but refused by the guard.
    expect(h.updateManyCalls.length).toBeGreaterThan(0);
    const guard = h.updateManyCalls.at(-1)!.where!;
    expect(guard).toMatchObject({ id: 'vid_1', gumletAssetId: 'asset_old' });

    // Nothing about the OLD asset's failure reached the row.
    expect(h.row.status).not.toBe('FAILED');
    expect(h.row.gumletError).toBeNull();
  });

  it('still records a provider failure when the asset is the current one', async () => {
    const h = build({
      asset: {
        status: 'errored',
        error: 'The uploaded video duration exceeds the storage minutes quota for your account.',
      },
    });

    await h.service.sync('vid_1');

    expect(h.row.status).toBe('FAILED');
    // The provider's own words are kept...
    expect(h.row.gumletError).toMatch(/storage minutes quota/);
    // ...and the place a failure is actually read now explains the remedy.
    expect(h.row.processingError).toMatch(/allowance is exhausted/i);
  });
});

describe('GumletIngestService.sync - no false READY', () => {
  it('never marks a video READY when the manifest is not CENC-encrypted', async () => {
    const h = build({ asset: { status: 'ready' }, playable: false });

    await h.service.sync('vid_1');

    expect(h.row.status).toBe('FAILED');
    expect(h.drmVerification.verify).toHaveBeenCalled();
  });

  it('marks a video READY only when the provider says ready AND the DRM verdict agrees', async () => {
    const h = build({ asset: { status: 'ready' }, playable: true });

    await h.service.sync('vid_1');

    expect(h.row.status).toBe('READY');
    expect(h.row.processingError).toBeNull();
  });

  it('clears a stale failure reason once the video is playable', async () => {
    const h = build({ asset: { status: 'ready' }, playable: true });
    h.row.processingError = 'an old failure that no longer applies';

    await h.service.sync('vid_1');

    expect(h.row.processingError).toBeNull();
  });
});
