import { Logger } from '@nestjs/common';

import {
  GUMLET_ASSET_DELETED_MESSAGE,
  isTerminalGumletFailure,
} from 'src/modules/videos/gumlet-failure';
import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';
import { MAX_SOURCE_BYTES, VideosService } from 'src/modules/videos/videos.service';
import { buildDrmVerification } from './helpers/drm-doubles';

/**
 * A Gumlet asset that was DELETED at the provider.
 *
 * Observed in production: cmv09znia000thl01wixuismf is READY in the database
 * while Gumlet answers 200 for its asset with `status: "deleted"`. Playback was
 * refused correctly, but `deleted` was read everywhere as "not ready yet":
 *
 *   - "replace failed asset" refused it (only errored/failed were terminal);
 *   - "Try processing again" treated the asset as alive and queued a poll, which
 *     flipped the row to PROCESSING and polled a deleted asset for the full
 *     20-minute budget, leaving it PROCESSING for the sweep to re-poll forever.
 *
 * Non-terminal statuses must keep meaning "in progress".
 */

describe('isTerminalGumletFailure', () => {
  it.each(['errored', 'failed', 'deleted'])('%s is terminal', (s) => {
    expect(isTerminalGumletFailure(s)).toBe(true);
  });

  it.each(['pre-queued', 'queued', 'processing', 'ready', 'replacing', 'unknown', null, undefined])(
    '%s is NOT terminal',
    (s) => {
      expect(isTerminalGumletFailure(s as string | null | undefined)).toBe(false);
    },
  );
});

function harness(opts: { drmProvider?: string | null; status?: string; gumletStatus?: string } = {}) {
  const row: Record<string, unknown> = {
    id: 'cmv09znia000thl01wixuismf',
    lessonId: 'l1',
    courseId: 'c1',
    sourceKey: 'source/videos/cmv09znia000thl01wixuismf/a.mp4',
    status: opts.status ?? 'READY',
    drmProvider: opts.drmProvider === undefined ? 'gumlet' : opts.drmProvider,
    drmRequested: true,
    drmVerifiedAt: null,
    drmBlockedReason: null,
    gumletAssetId: 'old_asset',
    gumletWorkspaceId: 'ws',
    gumletStatus: opts.gumletStatus ?? 'ready',
    gumletError: null,
    durationSeconds: 600,
    width: 1280,
    height: 720,
    frameRate: 25,
    lesson: { title: 'حصة اختبار' },
  };
  const writes: Record<string, unknown>[] = [];
  const prisma = {
    video: {
      findFirst: jest.fn(async () => ({ ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ status: row.status })),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        writes.push(a.data);
        Object.assign(row, a.data);
        return { ...row };
      }),
      updateMany: jest.fn(async (a: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (a.where?.gumletAssetId !== undefined && a.where.gumletAssetId !== row.gumletAssetId) {
          return { count: 0 };
        }
        if (typeof a.where?.gumletStatus === 'string' && a.where.gumletStatus !== row.gumletStatus) {
          return { count: 0 };
        }
        writes.push(a.data);
        Object.assign(row, a.data);
        return { count: 1 };
      }),
    },
  };
  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    createAsset: jest.fn(async () => ({ assetId: 'new_asset', status: 'pre-queued', playbackUrl: null })),
    getAsset: jest.fn(async (id: string) => ({
      assetId: id,
      status: id === 'old_asset' ? 'deleted' : 'processing',
      progress: 0,
      playbackUrl: null,
      dashPlaybackUrl: null,
      error: null,
      errorCode: null,
      durationSeconds: null,
      width: null,
      height: null,
      frameRate: null,
      drmSystems: null,
    })),
    fetchManifest: jest.fn(async () => ({ status: 404, ok: false, text: '' })),
    assetHasDrm: () => false,
    dashManifestUrl: ({ assetId }: { assetId: string }) => `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };
  const drmVerification = buildDrmVerification({
    prisma: prisma as never,
    gumlet: gumlet as never,
    enabled: true,
    provider: 'gumlet',
    signingConfigured: true,
  });
  const service = new GumletIngestService(
    prisma as never,
    {
      isConfigured: true,
      exists: jest.fn(async () => true),
      presignIngestionUrl: jest.fn(async () => 'https://r2.example/x?X-Amz-Signature=REDACTED'),
    } as never,
    gumlet as never,
    drmVerification as never,
    {
      getOrThrow: () => ({
        drm: {
          enabled: true,
          provider: 'gumlet',
          gumlet: { workspaceId: 'ws', ingestUrlTtlSeconds: 6 * 3600 },
        },
      }),
    } as never,
    { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) } as never,
    { record: jest.fn(async () => undefined) } as never,
  );
  return { service, row, writes, gumlet, drmVerification };
}

describe('a deleted Gumlet asset', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('sync() marks a Gumlet-delivered video FAILED with an actionable reason', async () => {
    const t = harness();

    const res = await t.service.sync('cmv09znia000thl01wixuismf');

    expect(res).toEqual({ assetId: 'old_asset', status: 'deleted', playable: false });
    expect(t.row.status).toBe('FAILED');
    expect(t.row.gumletStatus).toBe('deleted');
    expect(t.row.processingError).toBe(GUMLET_ASSET_DELETED_MESSAGE);
  });

  it('sync() leaves a legacy-delivered video playing (the existing preservation guard)', async () => {
    const t = harness({ drmProvider: null });

    await t.service.sync('cmv09znia000thl01wixuismf');

    expect(t.row.status).toBe('READY');
    expect(t.row.gumletStatus).toBe('deleted');
  });

  it('ends the poll at once instead of polling a deleted asset for the whole budget', async () => {
    const t = harness({ status: 'PROCESSING', gumletStatus: 'deleted' });
    const sync = jest.spyOn(t.service, 'sync');

    const res = await t.service.processFromJob('cmv09znia000thl01wixuismf', t.row.sourceKey as string);

    expect(res).toEqual({ handled: true, status: 'deleted', playable: false });
    // One re-sync from adopt() (the asset is already recorded, so nothing is
    // created) and ONE poll - not a poll every 5 s for 20 minutes.
    expect(sync).toHaveBeenCalledTimes(2);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('can be replaced through the explicit repair path, from the same stored source', async () => {
    const t = harness({ gumletStatus: 'deleted' });

    const res = await t.service.replaceFailedAsset('cmv09znia000thl01wixuismf', {
      allowGumletProviderReplacement: true,
    });

    expect(res.assetId).toBe('new_asset');
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    expect(t.row.gumletAssetId).toBe('new_asset');
    expect(t.row.sourceKey).toBe('source/videos/cmv09znia000thl01wixuismf/a.mp4');
  });

  it('is never replaced without the explicit opt-in', async () => {
    const t = harness({ gumletStatus: 'deleted' });

    await expect(t.service.replaceFailedAsset('cmv09znia000thl01wixuismf')).rejects.toThrow();
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('a still-processing asset is NOT replaceable (non-terminal keeps its meaning)', async () => {
    const t = harness({ status: 'FAILED', gumletStatus: 'processing' });

    await expect(
      t.service.replaceFailedAsset('cmv09znia000thl01wixuismf', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/Only a terminal failure/);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('the verifier reports it as a failed asset, not one that is still on its way', () => {
    const t = harness({ gumletStatus: 'deleted' });
    const verdict = t.drmVerification.evaluate(t.row as never);
    expect(verdict.playable).toBe(false);
    expect(verdict.playable === false && verdict.reason).toBe('ASSET_FAILED');
  });
});

describe('upload size limit', () => {
  it('is Cloudflare R2’s single-PUT ceiling, not the 8 GB that could never be stored', () => {
    expect(MAX_SOURCE_BYTES).toBe(5_363_466_240);
  });

  it('refuses a larger file before creating anything', async () => {
    // Validation runs before the first database call, so no dependency is touched.
    const service = Object.create(VideosService.prototype) as VideosService;
    await expect(
      service.initUpload(
        { lessonId: 'l1', filename: 'a.mp4', contentType: 'video/mp4', sizeBytes: MAX_SOURCE_BYTES + 1 },
        { id: 'u1', role: 'ADMIN' as never },
      ),
    ).rejects.toThrow();
  });
});
