import { Logger } from '@nestjs/common';

import { GumletIngestService } from '../../src/modules/videos/gumlet-ingest.service';

/**
 * REGRESSION SUITE - the 2026-10-15 production failure.
 *
 * WHAT HAPPENED
 *
 * Asset `6ad12efed14399f23655bb33` (video `cmv9ju1yz00ngcr01tztxv6u7`) was
 * created with a 3600-second R2 presigned URL. Gumlet's own record showed:
 *
 *   input.transformations.pre_processing_successful = true
 *   created_at -> updated_at                         86.8 minutes
 *   the URL expired at                               60.0 minutes
 *   error                                            ERR_ASSET_NOT_FOUND
 *
 * It had genuinely downloaded and probed the media (it reported the exact byte
 * size, duration and geometry), and then reported "trouble downloading the input
 * video/audio file" 27 minutes AFTER the signature had expired. SigV4 is checked
 * per request, so any (re-)attempt after expiry fails.
 *
 * The two things this file pins down:
 *   1. the URL is minted with the configured lifetime, never a bare 3600, and
 *      never shorter than the floor;
 *   2. a failure in the signing path leaves NO database write behind - the
 *      previous asset id, if any, must still be on the row.
 */

interface Row {
  id: string;
  status: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
  gumletStatus: string | null;
  gumletError: string | null;
  sourceKey: string | null;
  lesson?: { title: string } | null;
}

function build(opts: {
  row?: Partial<Row>;
  ttlSeconds?: number;
  presignFails?: boolean;
  createAssetFails?: boolean;
} = {}) {
  const row: Row = {
    id: 'v_1',
    status: 'FAILED',
    drmProvider: 'gumlet',
    gumletAssetId: 'asset_dead',
    gumletWorkspaceId: 'ws',
    gumletStatus: 'errored',
    gumletError: 'ERR_ASSET_NOT_FOUND',
    sourceKey: 'source/videos/v_1/a.mp4',
    lesson: { title: 'Lesson' },
    ...opts.row,
  };

  const updates: Array<Record<string, unknown>> = [];
  const updateManyCalls: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];

  const prisma = {
    video: {
      findFirst: jest.fn(async () => row),
      // `replaceFailedAsset`'s new tail guards the claim and the commit on the
      // dead asset id. NOTE: unlike `update`, a real Prisma `updateMany` does NOT
      // change the object `findFirst` already handed back - the service keeps
      // using its own in-memory copy of `video.gumletStatus`. The mock must not
      // mutate either, or it silently changes what the code under test sees.
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updateManyCalls.push(args);
        // Only succeeds while the row still points at the dead asset.
        return { count: row.gumletAssetId === args.where.gumletAssetId ? 1 : 0 };
      }),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        Object.assign(row, args.data);
        return row;
      }),
      findUniqueOrThrow: jest.fn(async () => ({ status: row.status })),
    },
  };

  const presignedUrls: Array<{ objectKey: string; expiresIn: number }> = [];
  const storage = {
    isConfigured: true,
    exists: jest.fn(async () => true),
    presignIngestionUrl: jest.fn(async (params: { objectKey: string; expiresIn?: number }) => {
      if (opts.presignFails) {
        throw new Error('R2 signing failed - credentials could not be loaded');
      }
      presignedUrls.push({ objectKey: params.objectKey, expiresIn: params.expiresIn ?? 0 });
      return 'https://r2.example/fresh?X-Amz-Signature=REDACTED';
    }),
  };

  const createdAssets: Array<{ sourceUrl: string; enableDrm?: boolean; tag?: string[] }> = [];
  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    createAsset: jest.fn(async (params: { sourceUrl: string; enableDrm?: boolean; tag?: string[] }) => {
      if (opts.createAssetFails) {
        throw Object.assign(new Error('provider rejected the input'), {
          // Mimics the GumletRequestError shape the real client raises.
          transient: false,
        });
      }
      createdAssets.push(params);
      return { assetId: 'asset_new', status: 'pre-queued', playbackUrl: null };
    }),
    getAsset: jest.fn(async () => ({
      assetId: 'asset_new',
      status: 'processing',
      progress: 0,
      playbackUrl: null,
      dashPlaybackUrl: null,
      error: null,
    })),
    dashManifestUrl: ({ assetId }: { assetId: string }) => `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };

  const config = {
    getOrThrow: () => ({
      drm: {
        enabled: true,
        provider: 'gumlet',
        gumlet: {
          apiKey: 'k',
          workspaceId: 'ws',
          orgId: 'o',
          signSecret: 's',
          // The value under test: what `configuration.ts` resolves from
          // GUMLET_INGEST_URL_TTL_SECONDS.
          ingestUrlTtlSeconds: opts.ttlSeconds ?? 6 * 60 * 60,
        },
      },
    }),
  };

  const audit = { record: jest.fn(async () => undefined) };
  const lessonVideos = { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) };

  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    { evaluate: jest.fn(), verify: jest.fn() } as never,
    config as never,
    lessonVideos as never,
    audit as never,
  );

  return {
    service, prisma, storage, gumlet, audit, row, updates, updateManyCalls,
    presignedUrls, createdAssets,
  };
}

describe('Gumlet ingest URL lifetime (regression: 2026-10-15 ERR_ASSET_NOT_FOUND)', () => {
  describe('a fresh adoption', () => {
    it('signs the URL with the CONFIGURED lifetime, not a bare 3600', async () => {
      const h = build({ row: { gumletAssetId: null } });

      await h.service.adopt('v_1');

      expect(h.presignedUrls).toHaveLength(1);
      expect(h.presignedUrls[0].expiresIn).toBe(6 * 60 * 60);
    });

    it('passes the configured value straight through from the environment', async () => {
      const h = build({ row: { gumletAssetId: null }, ttlSeconds: 12 * 60 * 60 });

      await h.service.adopt('v_1');

      expect(h.presignedUrls[0].expiresIn).toBe(12 * 60 * 60);
    });

    it('never signs with a lifetime below the one-hour floor', async () => {
      // A misconfiguration must not be able to restore the failing window.
      const h = build({ row: { gumletAssetId: null }, ttlSeconds: 60 });

      await h.service.adopt('v_1');

      expect(h.presignedUrls[0].expiresIn).toBeGreaterThanOrEqual(3600);
    });

    it('signs the exact source object, and still requests DRM', async () => {
      const h = build({ row: { gumletAssetId: null } });

      await h.service.adopt('v_1');

      expect(h.presignedUrls[0].objectKey).toBe('source/videos/v_1/a.mp4');
      expect(h.createdAssets).toHaveLength(1);
      expect(h.createdAssets[0].enableDrm).toBe(true);
      expect(h.createdAssets[0].tag).toEqual(['edu-video:v_1']);
    });

    it('hands the provider a FRESHLY SIGNED url, never a stale one', async () => {
      // The failure mode: the asset at Gumlet keeps an input URL that was signed
      // hours earlier and has since expired. A replacement must mint a new one.
      const h = build({ row: { gumletAssetId: null } });

      await h.service.adopt('v_1');

      expect(h.gumlet.createAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceUrl: 'https://r2.example/fresh?X-Amz-Signature=REDACTED',
        }),
      );
    });
  });

  describe('signing and provider failures leave the row intact', () => {
    it('REGRESSION: an R2 signing failure writes NOTHING and creates NO asset', async () => {
      // A fresh adoption: no asset id, so adopt() must sign. A signing failure
      // here must not write anything, or the row ends up half-adopted.
      const h = build({ presignFails: true, row: { gumletAssetId: null, gumletStatus: null } });

      await expect(h.service.adopt('v_1')).rejects.toThrow(/R2 signing failed/i);

      expect(h.updates).toHaveLength(0);
      expect(h.updateManyCalls).toHaveLength(0);
      expect(h.gumlet.createAsset).not.toHaveBeenCalled();
    });

    it('REGRESSION: a Gumlet rejection writes NOTHING either', async () => {
      const h = build({ createAssetFails: true, row: { gumletAssetId: null, gumletStatus: null } });

      await expect(h.service.adopt('v_1')).rejects.toThrow(/provider rejected the input/i);

      expect(h.updates).toHaveLength(0);
      expect(h.gumlet.createAsset).toHaveBeenCalledTimes(1);
      expect(h.row.gumletAssetId).toBeNull();
    });

    it('REGRESSION: a replacement failure leaves the row DIAGNOSABLE and REPLACEABLE', async () => {
      // The claim marker is rolled back to the terminal status, so the row is
      // not stuck at a value every guard reads as "not a terminal failure".
      const h = build({ createAssetFails: true });

      await expect(
        h.service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
      ).rejects.toThrow(/provider rejected the input/i);

      // The dead asset id survived, and the rollback restored the terminal state.
      expect(h.row.gumletAssetId).toBe('asset_dead');
      expect(h.row.gumletStatus).toBe('errored');
      // No adoption commit happened.
      expect(h.row.gumletStatus).not.toBe('replacing');
      expect(h.updates).toHaveLength(0);
    });

    it('REGRESSION: a signing failure during REPLACEMENT keeps the old asset id', async () => {
      const h = build({ presignFails: true });

      await expect(
        h.service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
      ).rejects.toThrow(/R2 signing failed/i);

      // This exact shape destroyed the asset reference in an earlier incident.
      expect(h.row.gumletAssetId).toBe('asset_dead');
      expect(h.updates).toHaveLength(0);
    });
  });

  describe('the replacement actually refreshes the URL', () => {
    it('mints a NEW presigned URL for the same source object', async () => {
      const h = build();

      const result = await h.service.replaceFailedAsset('v_1', {
        allowGumletProviderReplacement: true,
      });

      expect(result.assetId).toBe('asset_new');
      // A fresh signature, so the new asset is not born with a dead URL.
      expect(h.presignedUrls).toHaveLength(1);
      expect(h.presignedUrls[0].expiresIn).toBe(6 * 60 * 60);
      expect(h.presignedUrls[0].objectKey).toBe('source/videos/v_1/a.mp4');
      expect(h.createdAssets[0].sourceUrl).toBe(
        'https://r2.example/fresh?X-Amz-Signature=REDACTED',
      );
    });

    it('is NOT a plain re-sync of the dead asset', async () => {
      // `adopt()` with a live asset id only calls sync(). Replacing must create
      // a new asset, or the dead URL is simply re-read forever.
      const h = build();

      await h.service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true });

      expect(h.gumlet.createAsset).toHaveBeenCalledTimes(1);
      expect(h.gumlet.getAsset).not.toHaveBeenCalled();
    });

    it('records the old asset id in the audit trail and in the committed write', async () => {
      const h = build();

      await h.service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true });

      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          entity: 'video',
          entityId: 'v_1',
          before: { gumletAssetId: 'asset_dead', gumletStatus: 'errored' },
          after: { gumletAssetId: 'asset_new', gumletStatus: 'pre-queued' },
        }),
      );

      // The dead asset is NOT deleted at Gumlet, so the row keeps its address.
      const committed = h.updateManyCalls.map((c) => c.data);
      expect(committed).toHaveLength(2); // one claim, one commit
      expect(String(committed[1].gumletError)).toContain('asset_dead');
    });

    it('does not log or persist the signed URL itself', async () => {
      const h = build();
      // `service.logger` is a real Nest Logger, so it must be spied on rather
      // than assumed to already be a jest.fn().
      const logger = h.service['logger'] as unknown as Logger;
      const lines: string[] = [];
      const logSpy = jest.spyOn(logger, 'log').mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation((m: unknown) => {
        lines.push(String(m));
      });
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation((m: unknown) => {
        lines.push(String(m));
      });

      await h.service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true });

      logSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();

      // The URL never reaches a log line, and is never stored on the row.
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toContain('X-Amz-Signature');
        expect(line).not.toContain('r2.example/fresh');
      }
      const writes = [...h.updates, ...h.updateManyCalls.map((c) => c.data)];
      for (const w of writes) {
        expect(JSON.stringify(w)).not.toContain('r2.example/fresh');
      }
    });
  });
});
