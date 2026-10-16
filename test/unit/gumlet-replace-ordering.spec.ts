import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';

import { GumletIngestService } from '../../src/modules/videos/gumlet-ingest.service';

/**
 * Regression tests for the incident that motivated this file.
 *
 * A replacement attempt was run with R2 credentials absent from the CLI's
 * environment. `replaceFailedAsset()` cleared `gumletAssetId` first and only
 * then called `adopt()`, which failed when it tried to sign an ingestion URL. The
 * row was left describing no asset at all, and the report blamed a missing
 * Gumlet credential rather than a missing R2 one.
 *
 * The invariant these tests pin down: NOTHING IS WRITTEN until every
 * configuration and source precondition has passed - and, since the 2026-10-15
 * incident, not until the replacement asset HAS BEEN CREATED. The old ordering
 * cleared the row and only then ingested; the current ordering claims the row,
 * creates the asset, and only then commits, so a failure at any point leaves the
 * previous asset id exactly where it was.
 */

function build(over: {
  video?: Record<string, unknown>;
  storageConfigured?: boolean;
  sourceExists?: boolean;
  assetApiConfigured?: boolean;
  signingConfigured?: boolean;
  drmEnabled?: boolean;
  drmProvider?: 'none' | 'gumlet';
} = {}) {
  const video = {
    id: 'v_1',
    status: 'FAILED',
    drmProvider: 'gumlet',
    gumletAssetId: 'asset_dead',
    gumletStatus: 'errored',
    sourceKey: 'source/videos/v_1/video.mp4',
    ...over.video,
  };

  const updates: Record<string, unknown>[] = [];
  const prisma = {
    video: {
      findFirst: jest.fn(async () => video),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      }),
      // The claim and the commit are both guarded conditional writes.
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(args.data);
        // Succeeds only while the row still points at the dead asset, which is
        // exactly the guard the service applies.
        return { count: args.where.gumletAssetId === video.gumletAssetId ? 1 : 0 };
      }),
    },
  };

  const storage = {
    isConfigured: over.storageConfigured ?? true,
    exists: jest.fn(async () => over.sourceExists ?? true),
    // The replacement now really does sign a fresh URL and create the asset, so
    // the double has to be able to answer both.
    presignIngestionUrl: jest.fn(async () => 'https://r2.example/fresh?X-Amz-Signature=REDACTED'),
  };

  const gumlet = {
    isAssetApiConfigured: jest.fn(() => over.assetApiConfigured ?? true),
    isSigningConfigured: jest.fn(() => over.signingConfigured ?? true),
  };

  const drmVerification = { evaluate: jest.fn(), verify: jest.fn() };

  const config = {
    getOrThrow: () => ({
      drm: {
        enabled: over.drmEnabled ?? true,
        provider: over.drmProvider ?? ('gumlet' as const),
        gumlet: { apiKey: 'k', workspaceId: 'w', orgId: 'o', signSecret: 's' },
      },
    }),
  };

  const lessonVideos = { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) };
  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    drmVerification as never,
    config as never,
    lessonVideos as never,
  );

  return { service, prisma, storage, gumlet, updates, video };
}

describe('GumletIngestService.replaceFailedAsset - ordering guarantees', () => {
  it('REGRESSION: a missing R2 credential writes nothing and creates no asset', async () => {
    const { service, prisma, updates, storage } = build({ storageConfigured: false });

    await expect(
      service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/storage is not configured/i);

    // The whole point: the asset id must survive a failed attempt.
    expect(prisma.video.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
    // And the source must not even be probed - no point paying for it.
    expect(storage.exists).not.toHaveBeenCalled();
  });

  it('REGRESSION: a missing signing secret writes nothing', async () => {
    const { service, prisma, updates } = build({ signingConfigured: false });
    await expect(
      service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/signing is not configured/i);
    expect(prisma.video.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('REGRESSION: a missing Gumlet asset API writes nothing', async () => {
    const { service, prisma, updates } = build({ assetApiConfigured: false });
    await expect(
      service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/asset API is not configured/i);
    expect(prisma.video.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('REGRESSION: DRM disabled writes nothing', async () => {
    const { service, prisma } = build({ drmEnabled: false });
    await expect(
      service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/DRM is not enabled/i);
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('REGRESSION: a missing R2 source object writes nothing', async () => {
    const { service, prisma, updates, storage } = build({ sourceExists: false });
    await expect(
      service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/source object for this video is missing/i);
    expect(storage.exists).toHaveBeenCalled();
    // Source probed, but still nothing written: the check precedes the clear.
    expect(prisma.video.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('still refuses a non-terminal asset even in repair mode', async () => {
    const { service, prisma } = build({
      video: { gumletStatus: 'processing' },
    });
    await expect(
      service.replaceFailedAsset('v_1', { allowGumletProviderReplacement: true }),
    ).rejects.toThrow(/Only a terminal failure can be replaced/i);
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('still refuses a gumlet-provider video WITHOUT the explicit opt-in', async () => {
    const { service, prisma } = build();
    await expect(service.replaceFailedAsset('v_1')).rejects.toThrow(
      /must be done deliberately/i,
    );
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('throws NotFound for an unknown video before touching anything', async () => {
    const { service, prisma } = build();
    jest.spyOn(prisma.video, 'findFirst').mockResolvedValueOnce(null as never);
    await expect(service.replaceFailedAsset('nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('creates the asset BEFORE writing, and never clears the row first', async () => {
    const { service, prisma, storage, gumlet, updates, video } = build();
    // A real asset creation result rather than a stubbed adopt(): the point of
    // this test is the ordering of writes AROUND the creation.
    (gumlet as unknown as { createAsset: jest.Mock }).createAsset = jest.fn(async () => ({
      assetId: 'asset_new',
      status: 'pre-queued',
      playbackUrl: null,
    }));

    const result = await service.replaceFailedAsset('v_1', {
      allowGumletProviderReplacement: true,
    });

    expect(result.assetId).toBe('asset_new');
    // The fresh URL really was minted.
    expect(storage.presignIngestionUrl).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: 'uploads', objectKey: 'source/videos/v_1/video.mp4' }),
    );

    // THE STRONGER INVARIANT.
    //
    // The old ordering wrote `{ gumletAssetId: null }` and then adopted, so the
    // row described no asset at all while adopt() signed a URL and called Gumlet
    // - and if that failed, nothing pointed back at the dead asset. The current
    // ordering never writes a null asset id at all.
    for (const write of updates) {
      expect(write).not.toMatchObject({ gumletAssetId: null });
    }

    // The dead asset id is still on the row: the commit re-pointed it, it was
    // never erased.
    expect(video.gumletAssetId).toBe('asset_dead');
    // One claim, one commit.
    expect(prisma.video.updateMany).toHaveBeenCalledTimes(2);
  });

  it('does not clear on the legacy path when status is not READY', async () => {
    const { service, prisma } = build({
      video: { drmProvider: null, status: 'FAILED' },
    });
    await expect(service.replaceFailedAsset('v_1')).rejects.toThrow(
      /not currently playing/i,
    );
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('is importable as a Nest provider (DI sanity)', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        {
          provide: (await import('../../src/database/prisma.service')).PrismaService,
          useValue: {},
        },
        {
          provide: (await import('../../src/modules/storage/storage.service')).StorageService,
          useValue: { isConfigured: true, exists: jest.fn() },
        },
        {
          provide: (await import('../../src/modules/playback/gumlet-drm.service'))
            .GumletDrmService,
          useValue: {},
        },
        {
          provide: (await import('../../src/modules/playback/drm-verification.service'))
            .DrmVerificationService,
          useValue: {},
        },
        {
          provide: (await import('@nestjs/config')).ConfigService,
          useValue: { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet' } }) },
        },
        {
          // GumletIngestService fans a measured duration out to every attached
          // lecture, so this dependency must be part of the graph.
          provide: (await import('../../src/modules/videos/lesson-video.service'))
            .LessonVideoService,
          useValue: { propagateDurationToAttachedLessons: jest.fn() },
        },
        GumletIngestService,
      ],
    }).compile();
    expect(moduleRef.get(GumletIngestService)).toBeInstanceOf(GumletIngestService);
    await moduleRef.close();
  });
});
