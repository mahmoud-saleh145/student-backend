import { Prisma } from '@prisma/client';

const AnnouncementStatus = {
  SCHEDULED: 'SCHEDULED',
  SENT: 'SENT',
} as const;

type AnnouncementStatus = (typeof AnnouncementStatus)[keyof typeof AnnouncementStatus];

const AnnouncementFrequency = {
  DAILY: 'DAILY',
  ONCE: 'ONCE',
} as const;

type AnnouncementFrequency = (typeof AnnouncementFrequency)[keyof typeof AnnouncementFrequency];

import { AnnouncementsService } from '../../src/modules/notifications/announcements.service';

/**
 * Dispatch.
 *
 * One property matters more than everything else here: **a push cannot be
 * recalled**. There is no undo, no edit, and no apology that reaches the
 * notification tray. So the tests below are almost entirely about not sending
 * twice, and about failing in a way that does not become a second send on the
 * next tick.
 */

const NOW = new Date('2026-09-20T16:00:00Z');

interface Options {
  /** Simulate another worker having claimed this occurrence already. */
  alreadyClaimed?: boolean;
  recipients?: number;
  frequency?: AnnouncementFrequency;
  occurrenceCount?: number;
  maxOccurrences?: number | null;
  fanOutFails?: boolean;
  /**
   * State of the pre-existing claim when `alreadyClaimed` is set: a live owner
   * (unfinished, just started) versus one that died (finished, or started long
   * ago). This is the distinction the wedge fix turns on.
   */
  existingClaim?: { startedAt: Date; finishedAt: Date | null; error?: string } | null;
}

function build(options: Options = {}) {
  const announcement = {
    id: 'ann_1',
    title: 'Revision week starts Sunday',
    titleAr: null,
    body: 'Sessions run every evening.',
    bodyAr: null,
    route: null,
    sendPush: true,
    audienceRule: { academicYearIds: ['y2'] } as Prisma.JsonValue,
    courseId: null,
    universityId: null,
    academicYearId: null,
    status: AnnouncementStatus.SCHEDULED,
    frequency: options.frequency ?? AnnouncementFrequency.DAILY,
    sendAtLocal: '19:00',
    timezone: 'Africa/Cairo',
    weekdays: [] as number[],
    dayOfMonth: null,
    startsOn: null,
    endsOn: null,
    maxOccurrences: options.maxOccurrences ?? null,
    occurrenceCount: options.occurrenceCount ?? 0,
    nextOccurrenceAt: NOW,
  };

  const recipientCount = options.recipients ?? 3;
  const users = Array.from({ length: recipientCount }, (_, i) => ({ id: `usr_${i}` }));

  const claimed = { value: options.alreadyClaimed ?? false };

  const dispatchCreate = jest.fn(async (_args: { data: unknown }) => {
    if (claimed.value) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      });
    }
    claimed.value = true;
    return { id: 'disp_1' };
  });

  const dispatchUpdate = jest.fn(async (_args: { where: unknown; data: unknown }) => ({}));
  const announcementUpdate = jest.fn(async (_args: { where: unknown; data: unknown }) => ({}));

  const prisma = {
    announcement: {
      findUnique: jest.fn(async (_args: { where: unknown }) => announcement),
      update: announcementUpdate,
      findMany: jest.fn(async (_args: unknown) => [
        { id: 'ann_1', nextOccurrenceAt: NOW },
      ]),
    },
    announcementDispatch: {
      create: dispatchCreate,
      update: dispatchUpdate,
      // The abandoned-claim sweep, run at the top of every dispatchDue. Empty by
      // default: these tests are about the due path, not about recovery.
      findMany: jest.fn(async () => []),
      // Only consulted when the insert lost the race.
      findUnique: jest.fn(async () =>
        options.existingClaim === undefined || options.existingClaim === null
          ? null
          : {
              id: 'disp_0',
              startedAt: options.existingClaim.startedAt,
              finishedAt: options.existingClaim.finishedAt,
              error: options.existingClaim.error ?? null,
            },
      ),
    },
    user: {
      count: jest.fn(async (_args: unknown) => recipientCount),
      findMany: jest.fn(async (_args: unknown) => users),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const createForMany = jest.fn(
    async (userIds: string[], _input: unknown): Promise<{ created: number }> => {
      if (options.fanOutFails) throw new Error('queue unavailable');
      return { created: userIds.length };
    },
  );

  const notifications = { createForMany };

  const service = new AnnouncementsService(prisma as never, notifications as never);

  return { service, prisma, createForMany, dispatchCreate, announcementUpdate, dispatchUpdate };
}

describe('claiming an occurrence', () => {
  it('claims before writing a single notification', async () => {
    const { service, dispatchCreate, createForMany } = build();

    await service.dispatch('ann_1', NOW);

    // Ordering is the guarantee, not merely that both happened: if the send
    // came first, a crash between the two would resend everything next tick.
    const claimOrder = dispatchCreate.mock.invocationCallOrder[0] as number;
    const sendOrder = createForMany.mock.invocationCallOrder[0] as number;
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('claims the scheduled instant, not the time the worker happened to run', async () => {
    // Otherwise two workers a few milliseconds apart would claim different
    // keys and both send.
    const { service, dispatchCreate } = build();

    await service.dispatch('ann_1', new Date(NOW.getTime() + 45_000));

    expect(dispatchCreate.mock.calls[0][0]).toMatchObject({
      data: { announcementId: 'ann_1', occurrenceAt: NOW },
    });
  });

  it('sends nothing when another worker already holds the occurrence', async () => {
    // A live owner: claimed moments ago, still unfinished.
    const { service, createForMany } = build({
      alreadyClaimed: true,
      existingClaim: { startedAt: new Date(NOW.getTime() - 30_000), finishedAt: null },
    });

    const result = await service.dispatch('ann_1', NOW);

    expect(result).toMatchObject({ skipped: 'already-claimed' });
    expect(createForMany).not.toHaveBeenCalled();
  });

  it('treats a lost race as ordinary, not as an error', async () => {
    // Two workers racing is the normal case with several replicas; it must not
    // surface as a failure anyone has to investigate.
    const { service } = build({
      alreadyClaimed: true,
      existingClaim: { startedAt: new Date(NOW.getTime() - 30_000), finishedAt: null },
    });

    await expect(service.dispatch('ann_1', NOW)).resolves.toBeDefined();
  });

  it('leaves the schedule alone while the owner is still working', async () => {
    // Advancing here would double-schedule: the live worker advances too, and the
    // announcement would skip an occurrence.
    const { service, announcementUpdate } = build({
      alreadyClaimed: true,
      existingClaim: { startedAt: new Date(NOW.getTime() - 60_000), finishedAt: null },
    });

    await service.dispatch('ann_1', NOW);

    expect(announcementUpdate).not.toHaveBeenCalled();
  });
});

describe('recovering from a worker that died holding the claim', () => {
  /**
   * The wedge: a worker claimed an occurrence and died before advancing. The row
   * stays SENDING with the same `nextOccurrenceAt`, so `dispatchDue` re-selects it
   * every minute, re-loses the claim race forever, and the recurring
   * announcement never fires again and never reaches SENT — one stranded row per
   * crash, re-examined on every tick.
   */
  const DEAD = {
    alreadyClaimed: true as const,
  };

  it('advances the schedule when the claim is older than the lease', async () => {
    const { service, announcementUpdate } = build({
      ...DEAD,
      existingClaim: { startedAt: new Date(NOW.getTime() - 10 * 60_000), finishedAt: null },
    });

    const result = await service.dispatch('ann_1', NOW);

    expect(result).toMatchObject({ skipped: 'recovered-stale-claim' });

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: AnnouncementStatus; occurrenceCount: number; nextOccurrenceAt: Date };
    };
    expect(final.data.occurrenceCount).toBe(1);
    expect(final.data.nextOccurrenceAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(final.data.status).toBe(AnnouncementStatus.SCHEDULED);
  });

  it('does not resend — a push cannot be recalled', async () => {
    // The dead worker may already have reached some students. `notifications` has
    // no unique constraint on (userId, announcementId), so a resend would show
    // duplicates in exactly the trays that already got the first one.
    const { service, createForMany } = build({
      ...DEAD,
      existingClaim: { startedAt: new Date(NOW.getTime() - 10 * 60_000), finishedAt: null },
    });

    await service.dispatch('ann_1', NOW);

    expect(createForMany).not.toHaveBeenCalled();
  });

  it('treats an unfinished-but-failed claim as abandoned, not as live', async () => {
    // The owner recorded an error, so it is not still fanning out.
    const { service, createForMany } = build({
      ...DEAD,
      existingClaim: {
        startedAt: new Date(NOW.getTime() - 10 * 60_000),
        finishedAt: null,
        error: 'queue unavailable',
      },
    });

    const result = await service.dispatch('ann_1', NOW);

    expect(result).toMatchObject({ skipped: 'recovered-stale-claim', error: 'queue unavailable' });
    expect(createForMany).not.toHaveBeenCalled();
  });

  it('treats a finished claim as spent rather than waiting for the lease', async () => {
    // A worker that finished is not coming back, so there is no reason to make
    // the schedule wait out the lease.
    const { service, announcementUpdate } = build({
      ...DEAD,
      existingClaim: {
        startedAt: new Date(NOW.getTime() - 10_000),
        finishedAt: new Date(NOW.getTime() - 5_000),
      },
    });

    await service.dispatch('ann_1', NOW);

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as { data: { occurrenceCount: number } };
    expect(final.data.occurrenceCount).toBe(1);
  });

  it('finishes a one-off instead of stranding it in SENDING forever', async () => {
    const { service, announcementUpdate } = build({
      ...DEAD,
      frequency: AnnouncementFrequency.ONCE,
      existingClaim: { startedAt: new Date(NOW.getTime() - 10 * 60_000), finishedAt: null },
    });

    await service.dispatch('ann_1', NOW);

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: AnnouncementStatus; nextOccurrenceAt: Date | null };
    };
    expect(final.data.status).toBe(AnnouncementStatus.SENT);
    expect(final.data.nextOccurrenceAt).toBeNull();
  });

  it('retires an announcement that has used all its occurrences', async () => {
    const { service, announcementUpdate } = build({
      ...DEAD,
      occurrenceCount: 4,
      maxOccurrences: 5,
      existingClaim: { startedAt: new Date(NOW.getTime() - 10 * 60_000), finishedAt: null },
    });

    await service.dispatch('ann_1', NOW);

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: AnnouncementStatus; nextOccurrenceAt: Date | null };
    };
    expect(final.data.status).toBe(AnnouncementStatus.SENT);
    expect(final.data.nextOccurrenceAt).toBeNull();
  });

  it('still defers when the claim is younger than the lease', async () => {
    // The boundary case: young enough that the owner may still be working, so
    // advancing would risk a double-schedule.
    const { service, announcementUpdate } = build({
      ...DEAD,
      existingClaim: { startedAt: new Date(NOW.getTime() - 60_000), finishedAt: null },
    });

    const result = await service.dispatch('ann_1', NOW);

    expect(result).toMatchObject({ skipped: 'already-claimed' });
    expect(announcementUpdate).not.toHaveBeenCalled();
  });

  it('defers when the claim row has disappeared', async () => {
    // Raced with a worker that released it; the occurrence is still pending, so
    // the next tick must get another chance at it.
    const { service, announcementUpdate } = build({ ...DEAD, existingClaim: null });

    const result = await service.dispatch('ann_1', NOW);

    expect(result).toMatchObject({ skipped: 'already-claimed' });
    expect(announcementUpdate).not.toHaveBeenCalled();
  });
});

describe('sending', () => {
  it('reaches everyone the rule matches', async () => {
    const { service, createForMany } = build({ recipients: 3 });

    const result = await service.dispatch('ann_1', NOW);

    expect(result).toMatchObject({ recipients: 3, created: 3 });
    expect(createForMany.mock.calls[0][0]).toEqual(['usr_0', 'usr_1', 'usr_2']);
  });

  it('tags every notification with the announcement it came from', async () => {
    const { service, createForMany } = build();

    await service.dispatch('ann_1', NOW);

    expect(createForMany.mock.calls[0][1]).toMatchObject({ announcementId: 'ann_1' });
  });

  it('refuses an audience past the safety limit', async () => {
    const { service, createForMany } = build({ recipients: 50_001 });

    await expect(service.dispatch('ann_1', NOW)).rejects.toMatchObject({
      code: 'AUDIENCE_TOO_LARGE',
    });
    expect(createForMany).not.toHaveBeenCalled();
  });
});

describe('advancing the schedule', () => {
  it('schedules the next occurrence and stays SCHEDULED', async () => {
    const { service, announcementUpdate } = build({
      frequency: AnnouncementFrequency.DAILY,
    });

    await service.dispatch('ann_1', NOW);

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: AnnouncementStatus; occurrenceCount: number; nextOccurrenceAt: Date };
    };

    expect(final.data.status).toBe(AnnouncementStatus.SCHEDULED);
    expect(final.data.occurrenceCount).toBe(1);
    expect(final.data.nextOccurrenceAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('marks a one-off SENT with nothing further due', async () => {
    const { service, announcementUpdate } = build({
      frequency: AnnouncementFrequency.ONCE,
    });

    await service.dispatch('ann_1', NOW);

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { status: AnnouncementStatus; nextOccurrenceAt: Date | null };
    };

    expect(final.data.status).toBe(AnnouncementStatus.SENT);
    expect(final.data.nextOccurrenceAt).toBeNull();
  });

  it('skips missed occurrences rather than replaying them', async () => {
    // A worker down for three days must send once on return, not three times.
    const { service, announcementUpdate } = build({ frequency: AnnouncementFrequency.DAILY });

    const threeDaysLate = new Date(NOW.getTime() + 3 * 24 * 3600 * 1000);
    await service.dispatch('ann_1', threeDaysLate);

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { nextOccurrenceAt: Date };
    };

    // The next send is computed from now, so it is in the future — not a
    // backlog of yesterday and the day before.
    expect(final.data.nextOccurrenceAt.getTime()).toBeGreaterThan(threeDaysLate.getTime());
  });
});

describe('when the fan-out fails', () => {
  it('keeps the claim, so the failure cannot become a double send', async () => {
    // Releasing the claim would retry next minute and resend to everyone
    // already reached before the error.
    const { service, dispatchUpdate } = build({ fanOutFails: true });

    await expect(service.dispatch('ann_1', NOW)).rejects.toThrow('queue unavailable');

    const update = dispatchUpdate.mock.calls.at(-1)?.[0] as {
      data: { error?: string };
    };
    expect(update.data.error).toContain('queue unavailable');
  });

  it('records the error rather than failing silently', async () => {
    const { service, dispatchUpdate } = build({ fanOutFails: true });

    await expect(service.dispatch('ann_1', NOW)).rejects.toThrow();

    expect(dispatchUpdate).toHaveBeenCalled();
  });

  it('still advances, so one broken announcement does not block its own schedule', async () => {
    const { service, announcementUpdate } = build({ fanOutFails: true });

    await expect(service.dispatch('ann_1', NOW)).rejects.toThrow();

    const final = announcementUpdate.mock.calls.at(-1)?.[0] as {
      data: { occurrenceCount: number };
    };
    expect(final.data.occurrenceCount).toBe(1);
  });
});

describe('dispatching everything due', () => {
  it('reports a failure without abandoning the rest of the batch', async () => {
    const { service } = build({ fanOutFails: true });

    const result = await service.dispatchDue(NOW);

    expect(result.considered).toBe(1);
    expect(result.results[0]).toMatchObject({ announcementId: 'ann_1' });
  });
});
