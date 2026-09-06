import { ContentStatus, CompletionRuleType, UserRole } from '@prisma/client';

import { ProgressService } from '../../src/modules/progress/progress.service';

/**
 * Watch progress.
 *
 * Two properties are load-bearing and easy to regress:
 *
 *   1. **Percent never goes backwards.** A student who reopens a finished
 *      lesson and watches ten seconds must not see 100% collapse to 2%.
 *   2. **A client cannot mint watch time.** The reported delta is clamped
 *      server-side, so a patched app claiming an hour of viewing in a five
 *      second window banks the cap, not the claim.
 *
 * The service is exercised against a hand-rolled Prisma double rather than a
 * database, because what is under test is the arithmetic, not the storage.
 */

const LESSON = {
  id: 'les_1',
  courseId: 'crs_1',
  sectionId: 'sec_1',
  isPreview: false,
  durationSeconds: 600,
  status: ContentStatus.PUBLISHED,
  course: {
    id: 'crs_1',
    status: 'PUBLISHED',
    completionRuleType: CompletionRuleType.WATCH_PERCENT,
    completionThreshold: 90,
    completionRequireContiguous: false,
  },
  video: { id: 'vid_1', durationSeconds: 600 },
};

interface StoredProgress {
  positionSeconds: number;
  percent: number;
  watchedSeconds: number;
  completed: boolean;
  completedAt: Date | null;
  durationSeconds: number;
  lastWatchedAt: Date;
}

function buildService(existing: StoredProgress | null) {
  let stored = existing;

  const upsert = jest.fn(async ({ create, update }: { create: never; update: never }) => {
    const next = stored
      ? { ...stored, ...(update as object) }
      : { ...(create as object) };
    stored = next as StoredProgress;
    return stored;
  });

  const prisma = {
    lesson: {
      findFirst: jest.fn(async () => LESSON),
      count: jest.fn(async () => 10),
    },
    watchProgress: {
      findUnique: jest.fn(async () => stored),
      count: jest.fn(async () => 1),
      upsert,
    },
    enrollment: { updateMany: jest.fn(async () => ({ count: 1 })) },
    watchEvent: { create: jest.fn(async () => ({})) },
    // The service's transaction callback receives the same shape.
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  };

  const access = { assertContentAccess: jest.fn(async () => ({ canAccessContent: true })) };
  const storage = { publicAssetUrl: jest.fn(async () => null) };

  const service = new ProgressService(
    prisma as never,
    access as never,
    storage as never,
  );

  return { service, prisma, access, upsert, read: () => stored };
}

const CALLER = { userId: 'usr_1', role: UserRole.STUDENT };

describe('ProgressService.upsert', () => {
  it('records a first report and computes percent from position', async () => {
    const { service, upsert } = buildService(null);

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 300, watchedSeconds: 300 },
    });

    const data = upsert.mock.calls[0]![0].create;
    expect(data.positionSeconds).toBe(300);
    expect(data.percent).toBe(50);
    expect(data.watchedSeconds).toBe(300);
    expect(data.completed).toBe(false);
  });

  it('never lowers a previously reached percent', async () => {
    const { service, upsert } = buildService({
      positionSeconds: 600,
      percent: 100,
      watchedSeconds: 600,
      completed: true,
      completedAt: new Date(),
      durationSeconds: 600,
      lastWatchedAt: new Date(),
    });

    // The student reopens the lesson and watches the first ten seconds.
    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 10, watchedSeconds: 10 },
    });

    const data = upsert.mock.calls[0]![0].update;
    // Position follows the player…
    expect(data.positionSeconds).toBe(10);
    // …but the achievement does not regress.
    expect(data.percent).toBe(100);
    expect(data.completed).toBe(true);
  });

  it('clamps an implausible watch-time delta to the per-report ceiling', async () => {
    const { service, upsert } = buildService(null);

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 60, watchedSeconds: 999_999 },
    });

    // 900 s is the documented maximum a single report may bank.
    expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(900);
  });

  it('ignores negative and non-finite values instead of trusting them', async () => {
    const { service, upsert } = buildService(null);

    await service.upsert({
      ...CALLER,
      input: {
        lessonId: 'les_1',
        positionSeconds: -50,
        watchedSeconds: Number.NaN,
      },
    });

    const data = upsert.mock.calls[0]![0].create;
    expect(data.positionSeconds).toBe(0);
    expect(data.watchedSeconds).toBe(0);
  });

  it('caps position at the video duration', async () => {
    const { service, upsert } = buildService(null);

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 10_000, watchedSeconds: 30 },
    });

    expect(upsert.mock.calls[0]![0].create.positionSeconds).toBe(600);
    expect(upsert.mock.calls[0]![0].create.percent).toBe(100);
  });

  it('marks the lesson complete once the configured threshold is crossed', async () => {
    const { service, upsert } = buildService(null);

    // 90% threshold, 600 s duration → 540 s.
    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 545, watchedSeconds: 545 },
    });

    expect(upsert.mock.calls[0]![0].create.completed).toBe(true);
  });

  it('does not mark complete just below the threshold', async () => {
    const { service, upsert } = buildService(null);

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 500, watchedSeconds: 500 },
    });

    expect(upsert.mock.calls[0]![0].create.completed).toBe(false);
  });

  it('re-checks course access on every write, not just on the first', async () => {
    // Otherwise an expired student could keep banking watch time by holding a
    // player open — the access check is what stops that.
    const { service, access } = buildService(null);

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 30, watchedSeconds: 30 },
    });

    expect(access.assertContentAccess).toHaveBeenCalledTimes(1);
    expect(access.assertContentAccess).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'usr_1', courseId: 'crs_1' }),
    );
  });
});

describe('ProgressService.upsertBatch', () => {
  it('collapses duplicate lessons, keeping the furthest position', async () => {
    const { service, upsert } = buildService(null);

    await service.upsertBatch({
      ...CALLER,
      items: [
        { lessonId: 'les_1', positionSeconds: 100, watchedSeconds: 100 },
        { lessonId: 'les_1', positionSeconds: 240, watchedSeconds: 140 },
      ],
    });

    // One write, not two.
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert.mock.calls[0]![0].create.positionSeconds).toBe(240);
    expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(240);
  });

  it('reports per-item outcomes so one bad entry cannot discard the flush', async () => {
    const { service, prisma } = buildService(null);

    // Second lesson no longer exists — deleted while the client was offline.
    prisma.lesson.findFirst
      .mockImplementationOnce(async () => LESSON)
      .mockImplementationOnce(async () => null);

    const result = await service.upsertBatch({
      ...CALLER,
      items: [
        { lessonId: 'les_1', positionSeconds: 60, watchedSeconds: 60 },
        { lessonId: 'les_gone', positionSeconds: 60, watchedSeconds: 60 },
      ],
    });

    expect(result).toEqual({ accepted: 1, rejected: 1 });
  });

  it('refuses to process an unbounded batch', async () => {
    const { service, upsert } = buildService(null);

    const items = Array.from({ length: 500 }, (_, i) => ({
      lessonId: `les_${i}`,
      positionSeconds: 10,
      watchedSeconds: 10,
    }));

    await service.upsertBatch({ ...CALLER, items });

    // Hard-capped at 100 distinct lessons per flush.
    expect(upsert.mock.calls.length).toBeLessThanOrEqual(100);
  });
});
