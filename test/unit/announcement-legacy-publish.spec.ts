import { Prisma } from '@prisma/client';

/**
 * Legacy announcement publication.
 *
 * `POST /notifications/announcements` and
 * `POST /notifications/announcements/:id/publish` are the original admin
 * broadcast routes. They used to carry their own publication code, separate from
 * everything in `AnnouncementsService`, and that separation was the bug: the
 * legacy path had no occurrence claim, no paging, and its own hand-rolled
 * audience query.
 *
 * The property under test throughout is **one press, one broadcast**. A push
 * cannot be recalled and `notifications` has no unique constraint on
 * `(userId, announcementId)`, so a duplicate here is not a wasted write — it is a
 * second message in a student's tray that nothing can take back.
 */

const AnnouncementStatus = {
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  CANCELLED: 'CANCELLED',
} as const;

type AnnouncementStatus = (typeof AnnouncementStatus)[keyof typeof AnnouncementStatus];

const AnnouncementFrequency = {
  ONCE: 'ONCE',
  DAILY: 'DAILY',
} as const;

type AnnouncementFrequency = (typeof AnnouncementFrequency)[keyof typeof AnnouncementFrequency];

import { AnnouncementsService } from '../../src/modules/notifications/announcements.service';

const NOW = new Date('2026-09-20T16:00:00Z');
const ACTOR = { id: 'admin_1' };

interface Stored {
  status: AnnouncementStatus;
  frequency?: AnnouncementFrequency;
  occurrenceCount?: number;
  nextOccurrenceAt?: Date | null;
}

interface Options {
  stored?: Stored;
  /** Throws P2002, as it does when another worker or request holds the claim. */
  claimTaken?: boolean;
  recipients?: number;
  audienceRule?: Prisma.JsonValue;
  /**
   * An unfinished claim left behind by a process that died mid-publish. Its
   * occurrence instant is what a retry must reuse.
   */
  unfinishedClaim?: { occurrenceAt: Date } | null;
  /** Claims the abandoned-claim sweep should consider on its next tick. */
  staleClaims?: Array<{
    id: string;
    announcementId: string;
    occurrenceAt: Date;
    startedAt: Date;
  }>;
  /** What the recovery path reads back when it inspects a claim. */
  existingClaim?: { startedAt: Date; finishedAt: Date | null; error?: string | null } | null;
  /** Announcements the scheduler considers due. Empty isolates the sweep. */
  due?: string[];
}

/**
 * A prisma stub that records what was written, so the tests can assert on the
 * stored row rather than on the shape of the call.
 */
function build(options: Options = {}) {
  const stored: Stored = { status: AnnouncementStatus.DRAFT, ...options.stored };

  const announcement = {
    id: 'ann_1',
    title: 'Midterm timetable',
    titleAr: null,
    body: 'Exams begin 09:00.',
    bodyAr: null,
    route: null,
    sendPush: true,
    audienceRule: options.audienceRule ?? ({} as Prisma.JsonValue),
    courseId: null,
    universityId: null,
    academicYearId: null,
    timezone: 'Africa/Cairo',
    weekdays: [] as number[],
    dayOfMonth: null,
    startsOn: null,
    endsOn: null,
    maxOccurrences: null,
    publishedAt: null,
    createdById: ACTOR.id,
    get status() {
      return stored.status;
    },
    get occurrenceCount() {
      return stored.occurrenceCount ?? 0;
    },
    get frequency() {
      return stored.frequency ?? AnnouncementFrequency.ONCE;
    },
    get nextOccurrenceAt() {
      return stored.nextOccurrenceAt ?? null;
    },
  };

  const recipientCount = options.recipients ?? 4;
  const users = Array.from({ length: recipientCount }, (_, i) => ({ id: `usr_${i}` }));

  const claimed = { taken: false };

  const create = jest.fn(async (_args: { data: unknown }) => {
    if (options.claimTaken) {
      throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: '6.19.3',
      });
    }
    return { id: 'disp_1' };
  });

  const announcementUpdate = jest.fn(async (args: { data: Partial<Stored> }) => {
    Object.assign(stored, args.data);
    return {};
  });

  const prisma = {
    announcement: {
      // `findUnique` returns a fresh view so getters read current `stored`.
      findUnique: jest.fn(async () => ({ ...announcement })),
      create: jest.fn(async (_args: { data: unknown }) => ({ ...announcement })),
      update: announcementUpdate,
      findMany: jest.fn(async () => (options.due ?? ['ann_1']).map((id) => ({ id, nextOccurrenceAt: null }))),
    },
    announcementDispatch: {
      create,
      update: jest.fn(async () => ({})),
      findUnique: jest.fn(async () => options.existingClaim ?? null),
      // `publishLegacy` asks for an unfinished claim so a retry reuses the same
      // occurrence instant instead of minting a new one and sending twice.
      findFirst: jest.fn(async () => options.unfinishedClaim ?? null),
      // The abandoned-claim sweep. Empty by default: nothing has crashed.
      findMany: jest.fn(async () => options.staleClaims ?? []),
    },
    user: {
      count: jest.fn(async () => recipientCount),
      // Keyset paging: no `take` would mean loading every recipient at once.
      findMany: jest.fn(async (args: { take?: number }) => users.slice(0, args?.take)),
    },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  const createForMany = jest.fn(async (userIds: string[]) => ({ created: userIds.length }));
  const notifications = { createForMany };

  const service = new AnnouncementsService(prisma as never, notifications as never);

  return { service, prisma, createForMany, create, announcementUpdate, stored };
}

describe('legacy broadcast creation', () => {
  it('sends on creation unless the caller asked for a draft', async () => {
    const { service, createForMany } = build();

    await service.createLegacy(
      { title: 'Midterm timetable', body: 'Exams begin 09:00.', publishNow: true },
      ACTOR,
    );

    expect(createForMany).toHaveBeenCalled();
  });

  it('holds a draft back until it is published', async () => {
    const { service, createForMany, prisma } = build();

    await service.createLegacy(
      { title: 'Midterm timetable', body: 'Exams begin 09:00.', publishNow: false },
      ACTOR,
    );

    // The audience is stored even for a draft, so publishing later cannot lose
    // the targeting the admin chose.
    expect(prisma.announcement.create.mock.calls[0][0]).toMatchObject({
      data: { audienceRule: {} },
    });
    expect(createForMany).not.toHaveBeenCalled();
  });

  it('converts legacy targeting columns into a stored rule', async () => {
    const { service, prisma } = build();

    await service.createLegacy(
      {
        title: 'Pharmacy only',
        body: 'Lab safety briefing.',
        courseId: 'crs_1',
        universityId: 'uni_1',
        publishNow: false,
      },
      ACTOR,
    );

    // Storing the rule rather than three columns means later sends re-evaluate it
    // through the same code path as a modern announcement.
    const written = prisma.announcement.create.mock.calls[0][0].data as Record<string, unknown>;
    expect(written).toMatchObject({
      audienceRule: { courseIds: ['crs_1'], universityIds: ['uni_1'] },
    });
    expect(written).not.toHaveProperty('courseId');
    expect(written).not.toHaveProperty('universityId');
  });

  it('pages the fan-out instead of loading every recipient at once', async () => {
    const { service, prisma } = build({ recipients: 10 });

    await service.createLegacy(
      { title: 'Midterm timetable', body: 'Exams begin 09:00.' },
      ACTOR,
    );

    for (const call of prisma.user.findMany.mock.calls) {
      expect(call[0]).toMatchObject({ take: 2000 });
    }
  });

  it('refuses an audience past the safety ceiling', async () => {
    const { service, createForMany } = build({ recipients: 50_001 });

    await expect(
      service.createLegacy({ title: 'Everyone', body: 'Listen up.' }, ACTOR),
    ).rejects.toMatchObject({ code: 'AUDIENCE_TOO_LARGE' });
    expect(createForMany).not.toHaveBeenCalled();
  });
});

describe('publishing a draft', () => {
  it('claims the occurrence before writing a single notification', async () => {
    const { service, create, createForMany } = build();

    await service.publishLegacy('ann_1');

    // Without a claim, a second press broadcasts the same message again — the
    // one property the legacy path did not have.
    const claimOrder = create.mock.invocationCallOrder[0] as number;
    const sendOrder = createForMany.mock.invocationCallOrder[0] as number;
    expect(claimOrder).toBeLessThan(sendOrder);
  });

  it('refuses a second publish rather than broadcasting again', async () => {
    const { service } = build({ stored: { status: AnnouncementStatus.SENT, occurrenceCount: 1 } });

    await expect(service.publishLegacy('ann_1')).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_NOT_EDITABLE',
    });
  });

  it('refuses a publish that already happened even if the status disagrees', async () => {
    // The count is the evidence a dispatch actually happened; trusting the
    // status alone would re-open the double-send if the two ever diverge.
    const { service } = build({ stored: { status: AnnouncementStatus.DRAFT, occurrenceCount: 1 } });

    await expect(service.publishLegacy('ann_1')).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_NOT_EDITABLE',
    });
  });

  it('refuses while a send is in flight', async () => {
    const { service } = build({ stored: { status: AnnouncementStatus.SENDING } });

    await expect(service.publishLegacy('ann_1')).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_NOT_EDITABLE',
    });
  });

  it('refuses a cancelled announcement', async () => {
    const { service } = build({ stored: { status: AnnouncementStatus.CANCELLED } });

    await expect(service.publishLegacy('ann_1')).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_NOT_EDITABLE',
    });
  });

  it('404s an announcement that does not exist', async () => {
    const { service, prisma } = build();
    prisma.announcement.findUnique.mockResolvedValueOnce(null as never);

    await expect(service.publishLegacy('ann_missing')).rejects.toMatchObject({ status: 404 });
  });

  it('sends nothing when the occurrence is already claimed', async () => {
    const { service, createForMany } = build({ claimTaken: true });

    const result = await service.publishLegacy('ann_1');

    expect(result).toMatchObject({ skipped: 'already-claimed' });
    expect(createForMany).not.toHaveBeenCalled();
  });

  it('consumes the scheduled occurrence when publishing a recurring draft early', async () => {
    const scheduled = new Date('2026-09-27T16:00:00Z');
    const { service, create } = build({
      stored: {
        status: AnnouncementStatus.DRAFT,
        frequency: AnnouncementFrequency.DAILY,
        nextOccurrenceAt: scheduled,
      },
    });

    await service.publishLegacy('ann_1');

    // Publishing early takes the occurrence that was already scheduled rather
    // than inventing a second one, so the schedule keeps its shape.
    expect(create.mock.calls[0][0]).toMatchObject({
      data: { announcementId: 'ann_1', occurrenceAt: scheduled },
    });
  });

  it('leaves a recurring draft on its own schedule once it has fired', async () => {
    const { service, announcementUpdate } = build({
      stored: {
        status: AnnouncementStatus.DRAFT,
        frequency: AnnouncementFrequency.DAILY,
        occurrenceCount: 1,
      },
    });

    await expect(service.publishLegacy('ann_1')).rejects.toMatchObject({
      code: 'ANNOUNCEMENT_NOT_EDITABLE',
    });
    expect(announcementUpdate).not.toHaveBeenCalled();
  });
});

describe('recovering a publish that was interrupted', () => {
  const T1 = new Date('2026-09-20T16:00:00Z');

  it('claims the interrupted occurrence instead of minting a new instant', async () => {
    // A legacy announcement has frequency ONCE and no nextOccurrenceAt, so the
    // only candidate instant used to be `new Date()` -- different on every
    // press. That missed the (announcementId, occurrenceAt) unique index, so a
    // second press after a crash created a *second* claim and sent again.
    const { service, create } = build({
      unfinishedClaim: { occurrenceAt: T1 },
      claimTaken: true,
      existingClaim: { startedAt: new Date(), finishedAt: null },
    });

    await service.publishLegacy('ann_1');

    // The retry lands on the instant the dead process used, so it collides with
    // the existing claim instead of racing past it.
    expect(create.mock.calls[0][0]).toMatchObject({
      data: { announcementId: 'ann_1', occurrenceAt: T1 },
    });
  });

  it('does not broadcast a second time while the interrupted send may still be running', async () => {
    const { service, createForMany } = build({
      unfinishedClaim: { occurrenceAt: T1 },
      claimTaken: true,
      // Younger than the lease: the owner may well be alive.
      existingClaim: { startedAt: new Date(), finishedAt: null },
    });

    const result = await service.publishLegacy('ann_1');

    expect(result).toMatchObject({ skipped: 'already-claimed' });
    expect(createForMany).not.toHaveBeenCalled();
  });

  it('spends the occurrence without resending when the owner is provably gone', async () => {
    const { service, createForMany, announcementUpdate } = build({
      unfinishedClaim: { occurrenceAt: T1 },
      claimTaken: true,
      // Older than the 5 minute lease, and never finished.
      existingClaim: {
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
        finishedAt: null,
      },
    });

    const result = await service.publishLegacy('ann_1');

    // Some students may already have it from the first attempt, and there is no
    // unique constraint on (userId, announcementId) to make a resend idempotent.
    expect(createForMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ skipped: 'recovered-stale-claim' });
    expect(announcementUpdate).toHaveBeenCalled();
  });

  it('sweeps a crashed publish that no scheduled query would ever reach', async () => {
    // The awkward case: the row is DRAFT, so `dispatchDue`'s due selection skips
    // it forever and the announcement is simply never sent.
    const { service, createForMany, announcementUpdate } = build({
      due: [],
      staleClaims: [{ id: 'disp_1', announcementId: 'ann_1', occurrenceAt: T1, startedAt: new Date(Date.now() - 10 * 60 * 1000) }],
      existingClaim: {
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
        finishedAt: null,
      },
    });

    const result = await service.dispatchDue();

    expect(createForMany).not.toHaveBeenCalled();
    expect(announcementUpdate).toHaveBeenCalled();
    expect(result.abandoned).toEqual([
      expect.objectContaining({ announcementId: 'ann_1', skipped: 'recovered-stale-claim' }),
    ]);
  });

  it('leaves a claim alone while its owner is still inside the lease', async () => {
    const { service, announcementUpdate } = build({
      due: [],
      staleClaims: [{ id: 'disp_1', announcementId: 'ann_1', occurrenceAt: T1, startedAt: new Date() }],
    });

    const result = await service.dispatchDue();

    // Advancing here would double-schedule: the live worker is about to advance
    // the same occurrence itself.
    expect(announcementUpdate).not.toHaveBeenCalled();
    expect(result.abandoned).toEqual([
      expect.objectContaining({ announcementId: 'ann_1', skipped: 'already-claimed' }),
    ]);
  });

  it('does not wedge the announcement when a stale claim exists', async () => {
    const { service, announcementUpdate } = build({
      unfinishedClaim: { occurrenceAt: T1 },
      claimTaken: true,
      existingClaim: {
        startedAt: new Date(Date.now() - 10 * 60 * 1000),
        finishedAt: null,
      },
    });

    await service.publishLegacy('ann_1');

    // Terminal outcome, not an exception and not a silent no-op: the occurrence
    // is marked spent and the schedule is moved on.
    expect(announcementUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ann_1' },
        data: expect.objectContaining({ status: AnnouncementStatus.SENT }),
      }),
    );
  });
});