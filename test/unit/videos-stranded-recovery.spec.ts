import { VideosService } from 'src/modules/videos/videos.service';

/**
 * Why this file exists
 * -------------------
 * A production race, observed on 2026-10-10: a video adopted into Gumlet was
 * marked FAILED roughly a minute later with
 *
 *   "Processing was interrupted (job missing); retry to process the stored file again"
 *
 * while its Gumlet asset was in fact processing normally.
 *
 * `adopt()` moves a row to PROCESSING but runs no local transcode, so the
 * `processingStartedAt` / `processingJobId` left behind by some earlier local
 * transcode belong to a different pipeline entirely. `recoverStrandedVideos()`
 * reads those fields to decide work was abandoned: it treats any PROCESSING row
 * whose `processingStartedAt` predates a three-hour cutoff as stranded.
 *
 * A freshly adopted row therefore satisfied a predicate describing a job it
 * never had, and was failed by the next sweep.
 *
 * These tests pin the SELECTION behaviour, not the literal query shape. The
 * fake `findMany` evaluates the `where` the service actually passes, using the
 * same three-valued logic the database applies - most importantly, that
 * `NULL < anyDate` is not true. Asserting the query object instead would only
 * restate the implementation; asserting which rows come back does not.
 */

type Row = {
  id: string;
  status: string;
  deletedAt: Date | null;
  updatedAt: Date;
  processingStartedAt: Date | null;
  processingJobId: string | null;
  sourceKey: string | null;
  lessonId: string | null;
  courseId: string | null;
  drmProvider: string | null;
  gumletAssetId: string | null;
};

/** Mirrors the service's QUEUED / PROCESSING selection, via the `where` it passes. */
function matches(where: Record<string, unknown>, row: Row): boolean {
  if ((where as { deletedAt?: { equals: null } }).deletedAt?.equals === null) {
    if (row.deletedAt !== null) return false;
  }

  const or = (where as { OR?: Array<Record<string, unknown>> }).OR ?? [];
  return or.some((clause) => {
    if (clause.status !== undefined && clause.status !== row.status) return false;

    const provider = (clause as { drmProvider?: string }).drmProvider;
    if (provider !== undefined && provider !== row.drmProvider) return false;

    const asset = (clause as { gumletAssetId?: { not: null } }).gumletAssetId;
    if (asset?.not === null && row.gumletAssetId === null) return false;

    const started = (clause as { processingStartedAt?: { lt: Date } }).processingStartedAt;
    if (started) {
      // SQL three-valued logic: a NULL column is never less than a date, and
      // Prisma's `lt` maps straight onto that comparison.
      if (row.processingStartedAt === null) return false;
      if (!(row.processingStartedAt < started.lt)) return false;
    }

    const updated = (clause as { updatedAt?: { lt: Date } }).updatedAt;
    if (updated) {
      if (row.updatedAt === null) return false;
      if (!(row.updatedAt < updated.lt)) return false;
    }

    return true;
  });
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: 'v1',
    status: 'PROCESSING',
    deletedAt: null,
    updatedAt: new Date('2026-10-10T12:00:00Z'),
    processingStartedAt: new Date('2026-10-10T12:00:00Z'),
    processingJobId: 'transcode:v1:1',
    sourceKey: 'source/videos/v1/a.mp4',
    lessonId: 'l1',
    courseId: 'c1',
    // A legacy row unless a test says otherwise.
    drmProvider: null,
    gumletAssetId: null,
    ...over,
  };
}

function build(rows: Row[]) {
  const enqueued: unknown[] = [];
  const failed: Array<{ id: string; reason: string }> = [];
  const synced: string[] = [];

  const prisma = {
    video: {
      // Evaluates the service's real predicate against in-memory rows.
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
        rows.filter((r) => matches(args.where, r)),
      ),
      update: jest.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
        ...rows.find((r) => r.id === args.where.id),
        ...args.data,
      })),
    },
  };

  const queue = {
    add: jest.fn(async (job: unknown) => {
      enqueued.push(job);
      return { id: `job-${enqueued.length}` };
    }),
    getJob: jest.fn(async () => null), // every recorded job is already gone
  };

  const config = {
    getOrThrow: () => ({ ladder: [360, 720], encryptionEnabled: true }),
  };

  const lessonVideos = { countLiveAttachments: jest.fn().mockResolvedValue(1) };
  // What the sweep calls for a Gumlet row. Returns a provider-shaped answer so
  // a test can make the asset still processing, ready, or failed.
  const gumletIngest = {
    sync: jest.fn(async (id: string) => {
      synced.push(id);
      return { assetId: 'a', status: 'processing', playable: false };
    }),
  };
  const service = new VideosService(
    prisma as never,
    {} as never, // storage
    {} as never, // access
    {} as never, // courses
    {} as never, // notifications
    {} as never, // audit
    {} as never, // redis
    queue as never,
    config as never,
    lessonVideos as never,
    gumletIngest as never,
  );

  return { service, enqueued, failed, synced, gumletIngest };
}

describe('recoverStrandedVideos selection', () => {
  const now = new Date('2026-10-10T12:00:00Z');

  it('ignores a LEGACY PROCESSING video whose processingStartedAt is null', async () => {
    // A legacy row with no local job timestamp is not something this sweep can
    // diagnose, and there is no provider to ask. It stays untouched.
    const { service, enqueued } = build([
      row({ processingStartedAt: null, processingJobId: null }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 0, failed: 0, synced: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it('still reclaims a PROCESSING video abandoned more than three hours ago', async () => {
    // The opposite guard: a genuinely stuck local job must still be caught.
    const { service, enqueued } = build([
      row({
        processingStartedAt: new Date('2026-10-10T08:00:00Z'), // 4h old
        processingJobId: 'transcode:v1:old',
      }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result.failed).toBe(1);
    expect(result.requeued).toBe(0);
    // PROCESSING rows are failed, not re-enqueued - they already ran.
    expect(enqueued).toHaveLength(0);
  });

  it('leaves a recent PROCESSING video alone', async () => {
    const { service, enqueued } = build([
      row({ processingStartedAt: new Date('2026-10-10T11:30:00Z') }), // 30m old
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 0, failed: 0, synced: 0 });
    expect(enqueued).toHaveLength(0);
  });

  it('still requeues a stale QUEUED video', async () => {
    const { service, enqueued } = build([
      row({ status: 'QUEUED', updatedAt: new Date('2026-10-10T11:00:00Z') }), // 1h old
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result.requeued).toBe(1);
    expect(result.failed).toBe(0);
    expect(enqueued).toHaveLength(1);
  });

  it('ignores a soft-deleted row', async () => {
    const { service, enqueued } = build([
      row({ processingStartedAt: null, deletedAt: new Date('2026-10-01T00:00:00Z') }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 0, failed: 0, synced: 0 });
    expect(enqueued).toHaveLength(0);
  });
});

/**
 * The Gumlet branch.
 *
 * WHY THIS IS THE PART THAT MATTERS
 *
 * A Gumlet row in PROCESSING carries NO local job by construction - `adopt()`
 * nulls `processingStartedAt`/`processingJobId` because transcoding happens at
 * the provider. The legacy clause requires `processingStartedAt` to be non-null
 * AND old, and `NULL < cutoff` is never true in SQL, so those rows were
 * permanently invisible to this sweep. Worse, had they been selected by the
 * legacy path they would have been marked FAILED, because they always have a
 * "missing" local job.
 *
 * That combination is what left cmv9ju1yz00ngcr01tztxv6u7 in PROCESSING for 108
 * minutes after its 20-minute poll budget expired. The sweep now selects these
 * rows and asks GULMLET, which is the only authority on whether the asset is
 * alive.
 */
describe('recoverStrandedVideos Gumlet branch', () => {
  const now = new Date('2026-10-10T12:00:00Z');

  /** The shape `adopt()` actually writes for a Gumlet video. */
  const gumletRow = (over: Partial<Row> = {}) =>
    row({
      drmProvider: 'gumlet',
      gumletAssetId: 'asset_1',
      processingStartedAt: null,
      processingJobId: null,
      updatedAt: new Date('2026-10-10T11:00:00Z'), // 1h old, well past the 5m floor
      ...over,
    });

  it('SELECTS a Gumlet PROCESSING row that the legacy clause cannot see', async () => {
    const { service, synced } = build([gumletRow()]);

    const result = await service.recoverStrandedVideos(now);

    // Not requeued, not failed: the provider was asked instead.
    expect(result).toEqual({ requeued: 0, failed: 0, synced: 1 });
    expect(synced).toEqual(['v1']);
  });

  it('REGRESSION: never marks a live Gumlet asset FAILED', async () => {
    const { service, failed, synced } = build([gumletRow()]);

    await service.recoverStrandedVideos(now);

    // The old behaviour called markFailed() here, because the row's local job
    // is definitionally missing. That is how a healthy asset gets taken offline.
    expect(failed).toHaveLength(0);
    expect(synced).toEqual(['v1']);
  });

  it('does NOT create a second asset - a sync is idempotent, adoption is not', async () => {
    const { service, enqueued, gumletIngest } = build([gumletRow()]);

    await service.recoverStrandedVideos(now);

    // One queue add would mean a fresh transcode job, which for a Gumlet row
    // would reach adopt() and could mint a second, double-billed asset.
    expect(enqueued).toHaveLength(0);
    expect(gumletIngest.sync).toHaveBeenCalledTimes(1);
  });

  it('ignores a Gumlet row adopted seconds ago', async () => {
    // The 5-minute floor: a row that just adopted should not be swept on the
    // very next tick, or every upload costs an extra provider round trip.
    const { service, synced } = build([
      gumletRow({ updatedAt: new Date('2026-10-10T11:59:00Z') }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 0, failed: 0, synced: 0 });
    expect(synced).toEqual([]);
  });

  it('ignores a Gumlet row that already carries an old LOCAL job timestamp', async () => {
    // This row has a genuine 4h-old local timestamp, so the LEGACY clause also
    // matches it. The Gumlet branch must win, or the row gets marked FAILED
    // while its asset is still transcoding at the provider.
    const { service, failed, synced } = build([
      gumletRow({
        processingStartedAt: new Date('2026-10-10T08:00:00Z'),
        processingJobId: 'transcode:v1:old',
      }),
    ]);

    await service.recoverStrandedVideos(now);

    expect(failed).toHaveLength(0);
    expect(synced).toEqual(['v1']);
  });

  it('leaves the row alone when Gumlet cannot be reached', async () => {
    const { service, synced, gumletIngest } = build([gumletRow()]);
    gumletIngest.sync.mockRejectedValueOnce(new Error('network error') as never);

    const result = await service.recoverStrandedVideos(now);

    // A provider outage must not be recorded as a provider verdict. The row
    // stays PROCESSING and is simply re-checked on the next sweep.
    expect(result).toEqual({ requeued: 0, failed: 0, synced: 0 });
    expect(synced).toEqual([]);
    expect(gumletIngest.sync).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across repeated sweeps', async () => {
    const { service, synced } = build([gumletRow()]);

    await service.recoverStrandedVideos(now);
    await service.recoverStrandedVideos(now);
    await service.recoverStrandedVideos(now);

    // Three identical sweeps, three identical syncs, nothing else. sync()
    // mirrors the provider, so repeat runs converge rather than compounding.
    expect(synced).toEqual(['v1', 'v1', 'v1']);
  });

  it('still requeues a stale QUEUED legacy video in the same pass', async () => {
    // The two branches must not interfere with each other.
    const { service, enqueued, synced } = build([
      gumletRow(),
      row({ id: 'v2', status: 'QUEUED', updatedAt: new Date('2026-10-10T11:00:00Z') }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 1, failed: 0, synced: 1 });
    expect(synced).toEqual(['v1']);
    expect(enqueued).toHaveLength(1);
  });

  it('leaves a Gumlet PROCESSING row with NO asset untouched', async () => {
    // Adopted, but the asset id never landed. That is `adopt()`'s own rare
    // failure shape - there is nothing to sync, and requeueing here would make
    // adopt() create the asset anyway, so the row must not be mistaken for work.
    const { service, enqueued, synced } = build([
      gumletRow({ gumletAssetId: null }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 0, failed: 0, synced: 0 });
    expect(enqueued).toHaveLength(0);
    expect(synced).toEqual([]);
  });
});
