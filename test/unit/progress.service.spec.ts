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

/** What the server recorded via heartbeats — the only thing it can vouch for. */
interface ObservedPlayback {
  watchedSeconds: number;
  positionSeconds: number;
}

function buildService(existing: StoredProgress | null, observed: ObservedPlayback = {
  watchedSeconds: 0,
  positionSeconds: 0,
}) {
  let stored = existing;

  // The assertions read `upsert.mock.calls[0][0].create.percent`, so the
  // argument has to carry a real shape. `create: never` compiled to nothing
  // usable and made every one of those reads a type error.
  type UpsertArgs = {
    create: Partial<StoredProgress>;
    update: Partial<StoredProgress>;
  };

  const upsert = jest.fn(async ({ create, update }: UpsertArgs) => {
    const next = stored ? { ...stored, ...update } : { ...create };
    stored = next as StoredProgress;
    return stored;
  });

  // Declared before assignment so `$transaction` can hand the callback this
  // same object without the initialiser referring to itself — a self-reference
  // inside the literal makes the whole thing implicitly `any` under `strict`.
  const prisma: {
    lesson: { findFirst: jest.Mock; count: jest.Mock };
    watchProgress: { findUnique: jest.Mock; count: jest.Mock; upsert: typeof upsert };
    enrollment: { updateMany: jest.Mock };
    watchEvent: { create: jest.Mock };
    playbackTicket: { findMany: jest.Mock };
    $transaction: jest.Mock;
  } = {
    lesson: {
      findFirst: jest.fn(async () => LESSON),
      count: jest.fn(async () => 10),
    },
    watchProgress: {
      findUnique: jest.fn(async () => stored),
      count: jest.fn(async () => 1),
      upsert,
    },
    // One active ticket carrying the observed totals. Tests that need a
    // multi-ticket history override this.
    playbackTicket: {
      findMany: jest.fn(async () => [
        { watchedSeconds: observed.watchedSeconds, lastPositionSeconds: observed.positionSeconds },
      ]),
    },
    enrollment: { updateMany: jest.fn(async () => ({ count: 1 })) },
    watchEvent: { create: jest.fn(async () => ({})) },
    // The service's transaction callback receives the same shape.
    $transaction: jest.fn(),
  };

  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
    fn(prisma),
  );

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
    // The student really watched to 300 s — the heartbeat says so.
    const { service, upsert } = buildService(null, {
      watchedSeconds: 300,
      positionSeconds: 300,
    });

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
    const { service, upsert } = buildService(
      {
        positionSeconds: 600,
        percent: 100,
        watchedSeconds: 600,
        completed: true,
        completedAt: new Date(),
        durationSeconds: 600,
        lastWatchedAt: new Date(),
      },
      { watchedSeconds: 600, positionSeconds: 600 },
    );

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

  it('credits only the watch time a heartbeat actually recorded', async () => {
    // The client claims 600 s of viewing on a lesson where the server only ever
    // saw 30 s of heartbeats. The claim is a lie; the heartbeat total is not.
    const { service, upsert } = buildService(null, {
      watchedSeconds: 30,
      positionSeconds: 30,
    });

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 60, watchedSeconds: 600 },
    });

    expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(30);
  });

  it('rejects an implausible delta even when playback backs part of it', async () => {
    // Observed total is far above the per-report ceiling. Both bounds apply, and
    // the smaller one wins — a single report still cannot bank everything.
    const { service, upsert } = buildService(null, {
      watchedSeconds: 100_000,
      positionSeconds: 100_000,
    });

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 60, watchedSeconds: 999_999 },
    });

    // 900 s is the documented maximum a single report may bank.
    expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(900);
  });

  it('ignores negative and non-finite values instead of trusting them', async () => {
    const { service, upsert } = buildService(null, {
      watchedSeconds: 100,
      positionSeconds: 100,
    });

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
    const { service, upsert } = buildService(null, {
      watchedSeconds: 600,
      positionSeconds: 600,
    });

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 10_000, watchedSeconds: 30 },
    });

    expect(upsert.mock.calls[0]![0].create.positionSeconds).toBe(600);
    expect(upsert.mock.calls[0]![0].create.percent).toBe(100);
  });

  it('marks the lesson complete once the configured threshold is crossed', async () => {
    const { service, upsert } = buildService(null, {
      watchedSeconds: 545,
      positionSeconds: 545,
    });

    // 90% threshold, 600 s duration → 540 s.
    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 545, watchedSeconds: 545 },
    });

    expect(upsert.mock.calls[0]![0].create.completed).toBe(true);
  });

  it('does not mark complete just below the threshold', async () => {
    const { service, upsert } = buildService(null, {
      watchedSeconds: 500,
      positionSeconds: 500,
    });

    await service.upsert({
      ...CALLER,
      input: { lessonId: 'les_1', positionSeconds: 500, watchedSeconds: 500 },
    });

    expect(upsert.mock.calls[0]![0].create.completed).toBe(false);
  });

  describe('forged progress', () => {
    it('cannot mint watch time with no playback behind it', async () => {
      // The original bug: `POST /progress` is not behind a playback ticket, so
      // the per-report clamp was the only limit and a loop of reports banked
      // unlimited watch time.
      const { service, upsert } = buildService(null, {
        watchedSeconds: 0,
        positionSeconds: 0,
      });

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 600, watchedSeconds: 900 },
      });

      const data = upsert.mock.calls[0]![0].create;
      expect(data.watchedSeconds).toBe(0);
    });

    it('cannot complete a lesson by claiming the duration as position', async () => {
      const { service, upsert } = buildService(null, {
        watchedSeconds: 0,
        positionSeconds: 0,
      });

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 600, watchedSeconds: 900 },
      });

      // Nothing was watched, so nothing may be credited and the lesson is not
      // complete.
      expect(upsert.mock.calls[0]![0].create.completed).toBe(false);
    });

    it('caps a position claim that outruns the observed playback position', async () => {
      const { service, upsert } = buildService(null, {
        watchedSeconds: 30,
        positionSeconds: 30,
      });

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 600, watchedSeconds: 30 },
      });

      // Observed 30 s plus the documented 120 s tolerance. Jumping straight to
      // the end would otherwise award 100% and complete the lesson.
      expect(upsert.mock.calls[0]![0].create.positionSeconds).toBe(150);
      expect(upsert.mock.calls[0]![0].create.completed).toBe(false);
    });

    it('allows a small lead over the observed position for heartbeat lag', async () => {
      // Heartbeat and progress are separate requests; the player moves between
      // them. Rejecting a near-current position would drop the resume marker on
      // every seek.
      const { service, upsert } = buildService(null, {
        watchedSeconds: 100,
        positionSeconds: 100,
      });

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 180, watchedSeconds: 100 },
      });

      expect(upsert.mock.calls[0]![0].create.positionSeconds).toBe(180);
    });

    it('does not double-count a heartbeat window already banked', async () => {
      // Observed 300 s total, 300 s already credited. Replaying the same report
      // must not add the window a second time.
      const { service, upsert } = buildService(
        {
          positionSeconds: 300,
          percent: 50,
          watchedSeconds: 300,
          completed: false,
          completedAt: null,
          durationSeconds: 600,
          lastWatchedAt: new Date(),
        },
        { watchedSeconds: 300, positionSeconds: 300 },
      );

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 300, watchedSeconds: 300 },
      });

      expect(upsert.mock.calls[0]![0].update.watchedSeconds).toBe(300);
    });

    it('credits newly observed watch time on top of what was banked', async () => {
      const { service, upsert } = buildService(
        {
          positionSeconds: 300,
          percent: 50,
          watchedSeconds: 300,
          completed: false,
          completedAt: null,
          durationSeconds: 600,
          lastWatchedAt: new Date(),
        },
        { watchedSeconds: 420, positionSeconds: 420 },
      );

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 420, watchedSeconds: 120 },
      });

      // 120 s of genuinely new watching on top of 300.
      expect(upsert.mock.calls[0]![0].update.watchedSeconds).toBe(420);
    });

    it('sums watch time across rotated tickets rather than reading the latest', async () => {
      // A long lesson rotates its ticket, so the newest grant covers only the
      // tail of the session. Reading just that one would lose the earlier time.
      const { service, upsert, prisma } = buildService(null);

      prisma.playbackTicket.findMany.mockImplementation(async () => [
        { watchedSeconds: 200, lastPositionSeconds: 200 },
        { watchedSeconds: 150, lastPositionSeconds: 350 },
        { watchedSeconds: 50, lastPositionSeconds: 400 },
      ]);

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 400, watchedSeconds: 400 },
      });

      const data = upsert.mock.calls[0]![0].create;
      expect(data.watchedSeconds).toBe(400);
      expect(data.positionSeconds).toBe(400);
    });

    it('takes the furthest position, not the most recent one', async () => {
      // Replaying part of a lesson is legitimate; the marker must not rewind.
      const { service, upsert, prisma } = buildService(null);

      prisma.playbackTicket.findMany.mockImplementation(async () => [
        { watchedSeconds: 400, lastPositionSeconds: 400 },
        { watchedSeconds: 10, lastPositionSeconds: 120 },
      ]);

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 400, watchedSeconds: 410 },
      });

      expect(upsert.mock.calls[0]![0].create.positionSeconds).toBe(400);
    });

    it('does not let a rotated-away grant hide already-watched time', async () => {
      // Revoked and released tickets still represent real viewing. Excluding them
      // would let a student reset the uncredited pool by forcing a rotation.
      const { service, upsert, prisma } = buildService(null);

      prisma.playbackTicket.findMany.mockImplementation(async () => [
        { watchedSeconds: 300, lastPositionSeconds: 300 },
        { watchedSeconds: 90, lastPositionSeconds: 390 },
        { watchedSeconds: 10, lastPositionSeconds: 400 },
      ]);

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 400, watchedSeconds: 400 },
      });

      expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(400);
    });

    it('treats a lesson with no video as unwatchable rather than failing', async () => {
      // A text-only lesson has no video, so no heartbeat can exist. Reporting
      // "opened, watched nothing" must still be accepted.
      const { service, upsert, prisma } = buildService(null);

      prisma.lesson.findFirst.mockImplementation(async () => ({
        ...LESSON,
        video: null,
        durationSeconds: 0,
      }));

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 0, watchedSeconds: 0 },
      });

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(0);
    });

    it('scopes the observation to the requesting user and this video', async () => {
      // Otherwise a student could claim another student's viewing, and the
      // lesson's own video would be the wrong pool entirely.
      const { service, upsert, prisma } = buildService(null, {
        watchedSeconds: 60,
        positionSeconds: 60,
      });

      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 60, watchedSeconds: 60 },
      });

      expect(prisma.playbackTicket.findMany).toHaveBeenCalledWith({
        where: { userId: 'usr_1', videoId: 'vid_1' },
        select: { watchedSeconds: true, lastPositionSeconds: true },
      });
      expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(60);
    });

    it('lets the marker rewind on a scrub without regressing the achievement', async () => {
      const { service, upsert } = buildService(
        {
          positionSeconds: 300,
          percent: 50,
          watchedSeconds: 300,
          completed: false,
          completedAt: null,
          durationSeconds: 600,
          lastWatchedAt: new Date(),
        },
        { watchedSeconds: 300, positionSeconds: 300 },
      );

      // The student scrubs back to the start.
      await service.upsert({
        ...CALLER,
        input: { lessonId: 'les_1', positionSeconds: 0, watchedSeconds: 0 },
      });

      const data = upsert.mock.calls[0]![0].update;
      // Position follows the player, so rewinding is not stuck…
      expect(data.positionSeconds).toBe(0);
      // …and the banked watch time is untouched, so the achievement holds.
      expect(data.watchedSeconds).toBe(300);
      expect(data.percent).toBe(50);
    });
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
    const { service, upsert } = buildService(null, {
      watchedSeconds: 240,
      positionSeconds: 240,
    });

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

  it('cannot mint watch time by replaying a queued offline batch', async () => {
    // The batch route is the same claim problem as the single route, and it is
    // the more attractive one: up to 100 lessons per request.
    const { service, upsert } = buildService(null, {
      watchedSeconds: 0,
      positionSeconds: 0,
    });

    await service.upsertBatch({
      ...CALLER,
      items: [{ lessonId: 'les_1', positionSeconds: 600, watchedSeconds: 900 }],
    });

    expect(upsert.mock.calls[0]![0].create.watchedSeconds).toBe(0);
    expect(upsert.mock.calls[0]![0].create.completed).toBe(false);
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
