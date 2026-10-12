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
 * configuration and source precondition has passed.
 */

const READY_CFG = {
  accessKeyId: 'ak',
  secretAccessKey: 'sk',
  endpoint: 'https://example.r2.cloudflarestorage.com',
  buckets: { uploads: 'edu-uploads', media: 'edu-media', library: 'edu-library' },
};

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
    },
  };

  const storage = {
    isConfigured: over.storageConfigured ?? true,
    exists: jest.fn(async () => over.sourceExists ?? true),
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

  it('clears the dead asset id only after every check has passed', async () => {
    const { service, prisma, updates, video } = build();
    // adopt() is reached last; stub the tail so only the clearing is observed.
    jest
      .spyOn(service, 'adopt')
      .mockResolvedValue({ assetId: 'asset_new', status: 'pre-queued' });

    const result = await service.replaceFailedAsset('v_1', {
      allowGumletProviderReplacement: true,
    });

    expect(result.assetId).toBe('asset_new');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      gumletAssetId: null,
      gumletStatus: null,
      gumletError: null,
    });
    // The provider is NOT rewritten by the clear: adopt() owns that field.
    expect(updates[0]).not.toHaveProperty('drmProvider');
    expect(video.gumletAssetId).toBe('asset_dead');
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
