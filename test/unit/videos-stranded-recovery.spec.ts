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
};

/** Mirrors the service's QUEUED / PROCESSING selection, via the `where` it passes. */
function matches(where: Record<string, unknown>, row: Row): boolean {
  if ((where as { deletedAt?: { equals: null } }).deletedAt?.equals === null) {
    if (row.deletedAt !== null) return false;
  }

  const or = (where as { OR?: Array<Record<string, unknown>> }).OR ?? [];
  return or.some((clause) => {
    if (clause.status !== undefined && clause.status !== row.status) return false;

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
    ...over,
  };
}

function build(rows: Row[]) {
  const enqueued: unknown[] = [];
  const failed: Array<{ id: string; reason: string }> = [];

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
  );

  return { service, enqueued, failed };
}

describe('recoverStrandedVideos selection', () => {
  const now = new Date('2026-10-10T12:00:00Z');

  it('ignores a PROCESSING video whose processingStartedAt is null', async () => {
    // The shape `adopt()` now writes: no local job, so no local job timestamp.
    const { service, enqueued } = build([
      row({ processingStartedAt: null, processingJobId: null }),
    ]);

    const result = await service.recoverStrandedVideos(now);

    expect(result).toEqual({ requeued: 0, failed: 0 });
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

    expect(result).toEqual({ requeued: 0, failed: 0 });
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

    expect(result).toEqual({ requeued: 0, failed: 0 });
    expect(enqueued).toHaveLength(0);
  });
});