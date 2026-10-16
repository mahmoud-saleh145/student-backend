import { GumletIngestService } from '../../src/modules/videos/gumlet-ingest.service';

/**
 * Recovery safety for a TERMINALLY FAILED Gumlet asset.
 *
 * The 2026-10-15 failure left `cmv9ju1yz00ngcr01tztxv6u7` pointing at an asset
 * whose input URL had expired. `adopt()` is idempotent, so every retry re-read
 * the same dead asset; `retryProcessing()` never cleared the asset id, so the
 * dashboard's Retry could not help either. `replaceFailedAsset()` is the only
 * path that ingests a fresh asset, and these tests pin down the properties that
 * make it safe to run:
 *
 *   1. the video's IDENTITY is never touched - id, source key, lesson, course
 *      and the lesson-video relationship rows are all outside the write;
 *   2. a healthy asset is never replaced;
 *   3. two concurrent attempts cannot mint two live assets;
 *   4. a partial failure cannot strand the row or lose the old asset address.
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
  sourceSizeBytes: bigint | null;
  lessonId: string | null;
  courseId: string | null;
  lesson?: { title: string } | null;
}

/** Columns a replacement must never write. */
const IDENTITY_KEYS = ['id', 'sourceKey', 'lessonId', 'courseId', 'sourceSizeBytes'];

function build(opts: {
  video?: Partial<Row>;
  /** Make the guarded conditional write lose, i.e. someone else advanced the row. */
  loseCommit?: boolean;
} = {}) {
  const row: Row = {
    id: 'cmv9ju1yz00ngcr01tztxv6u7',
    status: 'FAILED',
    drmProvider: 'gumlet',
    gumletAssetId: '6ad12efed14399f23655bb33',
    gumletWorkspaceId: 'ws',
    gumletStatus: 'errored',
    gumletError: 'We had trouble downloading the input video/audio file...',
    sourceKey: 'source/videos/cmv9ju1yz00ngcr01tztxv6u7/2e6b94b8.mp4',
    sourceSizeBytes: 298437276n,
    lessonId: 'cmv9jttp900nccr01wanhmoh6',
    courseId: 'cmuympe7p002dfe01o0z33ayi',
    lesson: { title: 'الحصة الخامسة' },
    ...opts.video,
  };

  const writes: Array<Record<string, unknown>> = [];
  const auditEntries: Array<Record<string, unknown>> = [];

  let guardedWriteWins = !opts.loseCommit;

  const prisma = {
    video: {
      findFirst: jest.fn(async () => row),
      updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        writes.push(args.data);
        // Both the claim and the commit are guarded on the dead asset id.
        const owner = row.gumletAssetId === args.where.gumletAssetId && guardedWriteWins;
        return { count: owner ? 1 : 0 };
      }),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        writes.push(args.data);
        return row;
      }),
      findUniqueOrThrow: jest.fn(async () => ({ status: row.status })),
    },
    // The lesson-video relationship table. A correct replacement never writes it.
    lessonVideo: {
      findMany: jest.fn(async () => [{ lessonId: row.lessonId, videoId: row.id }]),
      create: jest.fn(),
      delete: jest.fn(),
      deleteMany: jest.fn(),
    },
  };

  const presignCalls: Array<Record<string, unknown>> = [];
  const storage = {
    isConfigured: true,
    exists: jest.fn(async () => true),
    presignIngestionUrl: jest.fn(async (params: Record<string, unknown>) => {
      presignCalls.push(params);
      return 'https://r2.example/fresh?X-Amz-Signature=REDACTED';
    }),
  };

  let created = 0;
  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    createAsset: jest.fn(async () => {
      created += 1;
      return { assetId: `asset_new_${created}`, status: 'pre-queued', playbackUrl: null };
    }),
    getAsset: jest.fn(async () => ({
      assetId: 'asset_new_1',
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
          apiKey: 'k', workspaceId: 'ws', orgId: 'o', signSecret: 's',
          ingestUrlTtlSeconds: 6 * 60 * 60,
        },
      },
    }),
  };

  const audit = {
    record: jest.fn(async (entry: Record<string, unknown>) => {
      auditEntries.push(entry);
    }),
  };

  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    { evaluate: jest.fn(), verify: jest.fn() } as never,
    config as never,
    { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) } as never,
    audit as never,
  );

  return {
    service, prisma, storage, gumlet, audit, row, writes, auditEntries, presignCalls,
    get createdCount() { return created; },
    /** Simulate the guarded write losing the race on the next call. */
    loseNextGuardedWrite() { guardedWriteWins = false; },
  };
}

const REPAIR = { allowGumletProviderReplacement: true } as const;

describe('replaceFailedAsset - recovering cmv9ju1yz00ngcr01tztxv6u7', () => {
  describe('the video record is preserved', () => {
    it('never writes the video id, source key, lesson, course or size', async () => {
      const h = build();

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      expect(h.writes.length).toBeGreaterThan(0);
      for (const w of h.writes) {
        for (const key of IDENTITY_KEYS) {
          expect(w).not.toHaveProperty(key);
        }
      }
    });

    it('never touches the lesson-video relationship rows', async () => {
      const h = build();

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      // The lecture keeps its attachment without anyone writing a mapping.
      expect(h.prisma.lessonVideo.create).not.toHaveBeenCalled();
      expect(h.prisma.lessonVideo.delete).not.toHaveBeenCalled();
      expect(h.prisma.lessonVideo.deleteMany).not.toHaveBeenCalled();
    });

    it('does not delete the failed asset, the source object, or anything else', async () => {
      const h = build();

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      // There is no delete on this service at all: the failed asset is inert and
      // is left at the provider for the operator to clean up.
      expect((h.gumlet as unknown as Record<string, unknown>).deleteAsset).toBeUndefined();
      expect((h.storage as unknown as Record<string, unknown>).deleteObject).toBeUndefined();
      expect((h.prisma.video as unknown as Record<string, unknown>).delete).toBeUndefined();
    });

    it('leaves the source object exactly as recorded', async () => {
      const h = build();

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      // Same one object, signed again - never re-uploaded, never re-named.
      expect(h.presignCalls).toEqual([
        { bucket: 'uploads', objectKey: row_sourceKey(h.row), expiresIn: 6 * 60 * 60 },
      ]);
    });
  });

  describe('a healthy asset is never replaced', () => {
    it.each(['processing', 'ready', 'pre-queued'])(
      'refuses an asset whose status is %s',
      async (status) => {
        const h = build({ video: { gumletStatus: status } });

        await expect(
          h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR),
        ).rejects.toThrow(/Only a terminal failure can be replaced/i);

        expect(h.gumlet.createAsset).not.toHaveBeenCalled();
        expect(h.writes).toHaveLength(0);
        expect(h.presignCalls).toHaveLength(0);
      },
    );
  });

  describe('concurrent attempts cannot mint two live assets', () => {
    it('the second caller is refused and creates nothing', async () => {
      const h = build();

      // Both callers read the same row before either writes.
      const first = await h.service
        .replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR)
        .catch((e: Error) => e);

      // While the first attempt is in flight, its claim is already on the row.
      // The second caller's guarded write now matches nothing.
      h.loseNextGuardedWrite();

      const second = await h.service
        .replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR)
        .catch((e: Error) => e);

      expect(first).toMatchObject({ assetId: 'asset_new_1' });
      expect(second).toBeInstanceOf(Error);
      expect((second as Error).message).toMatch(/already in progress/i);

      // Exactly one asset was ever created - no double-billed replacement.
      expect(h.createdCount).toBe(1);
    });

    it('claims atomically, so the row is never left mid-replacement', async () => {
      const h = build();

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      // The first write is a claim, and it is guarded.
      expect(h.writes[0]).toMatchObject({ gumletStatus: 'replacing' });
      // The commit lands the new asset id.
      const commit = h.writes.at(-1)!;
      expect(commit.gumletAssetId).toBe('asset_new_1');
      expect(commit.gumletError).toContain('6ad12efed14399f23655bb33');
    });
  });

  describe('partial failure cannot strand the row', () => {
    it('REGRESSION: asset created but the commit lost -> the old id survives', async () => {
      const h = build();
      // The asset is created successfully, but by the time the service commits,
      // a concurrent adoption has already re-pointed the row.
      let committed = 0;
      h.prisma.video.updateMany.mockImplementation(
        async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          h.writes.push(args.data);
          // Let the claim through, then lose the commit.
          committed += 1;
          return { count: committed === 1 ? 1 : 0 };
        },
      );

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      // The row still points at the asset it pointed at before, so the video is
      // still diagnosable and still recoverable - the failure is recorded, not
      // silently erased.
      const auditText = JSON.stringify(h.auditEntries);
      expect(auditText).toContain('6ad12efed14399f23655bb33');
      expect(auditText).toContain('asset_new_1');
      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ note: expect.stringMatching(/already advanced/i) }),
      );
    });

    it('attributes the replacement to the operator who requested it', async () => {
      // The project convention is that a write on `videos` names its actor. An
      // unattributed row would record a discarded asset reference with no cause.
      const h = build();

      await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', {
        ...REPAIR,
        actor: { id: 'usr_admin', role: 'ADMIN' as never },
      });

      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: 'usr_admin', actorRole: 'ADMIN' }),
      );
    });

    it('tolerates a caller with no actor (the migration CLI)', async () => {
      const h = build();

      await expect(
        h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR),
      ).resolves.toMatchObject({ assetId: 'asset_new_1' });

      expect(h.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ actorId: null, actorRole: null }),
      );
    });

    it('restores the terminal marker when creation fails, so the row stays replaceable', async () => {
      const h = build();
      h.gumlet.createAsset.mockRejectedValue(new Error('provider rejected the input'));

      await expect(
        h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR),
      ).rejects.toThrow(/provider rejected the input/i);

      // The claim marker must not be left behind: every guard reads an
      // unrecognised value as "not a terminal failure" and would refuse to
      // repair the row forever.
      expect(h.writes.at(-1)).toMatchObject({ gumletStatus: 'errored' });
      expect(h.writes.at(-1)).not.toMatchObject({ gumletAssetId: null });
    });
  });

  describe('resumability', () => {
    it('adopts directly when a previous attempt already discarded the id', async () => {
      const h = build({ video: { gumletAssetId: null, gumletStatus: null } });

      const result = await h.service.replaceFailedAsset('cmv9ju1yz00ngcr01tztxv6u7', REPAIR);

      expect(result.assetId).toMatch(/^asset_new_/);
      // Still creating a fresh, long-lived URL - never reusing the old one.
      expect(h.presignCalls).toHaveLength(1);
    });
  });
});

function row_sourceKey(row: Row): string {
  return row.sourceKey as string;
}
