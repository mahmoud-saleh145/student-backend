import { EnrollmentState, NotificationKind } from '@prisma/client';

import { MaintenanceProcessor } from '../../src/jobs/processors/maintenance.processor';
import { MAINTENANCE_JOBS } from '../../src/jobs/queue.constants';

/**
 * The expiry-reminder job.
 *
 * This is the only maintenance job that messages a human, so it is the only one
 * where running twice is not merely wasteful but visible and annoying. Every
 * other job here converges: a conditional state write, a delete, a lease, or a
 * comparison against live queue state. Reminder delivery had none of those, and
 * leaned on a 24-hour window plus a daily cron — which is an assumption about
 * cadence rather than a guarantee. A retry, a manual re-run, or a duplicated
 * delivery would have messaged the student again.
 *
 * The tests therefore pin the guarantee to the database, not to the clock.
 */

type Enrollment = {
  id: string;
  userId: string;
  courseId: string;
  course: { title: string };
};

/** What `createOnce` is handed: the notification plus its idempotency key. */
type ReminderRow = {
  dedupeKey: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  titleAr: string;
  body: string;
  bodyAr: string;
  route: string;
};

/** A prisma-style query argument, typed so `mock.calls` is inspectable. */
type QueryArgs = { where?: Record<string, unknown>; take?: number };

function build(expiring: Enrollment[], insertCount?: number) {
  const findMany = jest.fn(async (_args: QueryArgs) => expiring);
  const createMany = jest.fn(async (_args: QueryArgs) => ({ count: insertCount ?? expiring.length }));

  const prisma = { enrollment: { findMany } };
  const notifications = {
    createOnce: jest.fn(async (_rows: ReminderRow[]) => ({ created: 0, skipped: 0 })),
  };

  const processor = new MaintenanceProcessor(
    prisma as never, // PrismaService
    {} as never, // EnrollmentsService
    {} as never, // CodesService
    {} as never, // PlaybackService
    notifications as never, // NotificationsService
    {} as never, // AnnouncementsService
    {} as never, // VideosService
  );

  return { processor, findMany, createMany, notifications };
}

const EXPIRING: Enrollment[] = [
  { id: 'enr_1', userId: 'stu_1', courseId: 'crs_1', course: { title: 'Pharmacology' } },
  { id: 'enr_2', userId: 'stu_2', courseId: 'crs_2', course: { title: 'Anatomy' } },
];

function run(processor: MaintenanceProcessor) {
  return processor.process({
    name: MAINTENANCE_JOBS.courseExpiryReminders,
    data: { triggeredBy: 'schedule' },
  } as never);
}

describe('scheduling the sweep', () => {
  it('only considers active enrollments inside a three-day window', async () => {
    const { processor, findMany } = build(EXPIRING);

    await run(processor);

    const where = findMany.mock.calls[0][0].where ?? {};
    expect(where.state).toBe(EnrollmentState.ACTIVE);

    // The window is expressed as a 24-hour band three days out. It narrows the
    // candidates; it is not what makes the send once-only.
    const { gte, lt } = where.accessEndsAt as { gte: Date; lt: Date };
    const daysOut = (gte.getTime() - Date.now()) / (24 * 3600 * 1000);
    expect(daysOut).toBeGreaterThan(2.9);
    expect(daysOut).toBeLessThan(3.1);
    expect(lt.getTime() - gte.getTime()).toBe(24 * 3600 * 1000);
  });

  it('does nothing at all when nobody is lapsing', async () => {
    // No candidates means no write, not an empty insert.
    const { processor, notifications } = build([]);

    await expect(run(processor)).resolves.toEqual({ sent: 0, skipped: 0 });
    expect(notifications.createOnce).not.toHaveBeenCalled();
  });
});

describe('idempotency', () => {
  it('gives every reminder a key derived from the enrollment and the day', async () => {
    const { processor, notifications } = build(EXPIRING);

    await run(processor);

    const rows = notifications.createOnce.mock.calls[0][0];
    expect(rows.map((r) => r.dedupeKey)).toEqual([
      expect.stringMatching(/^course-expiry:enr_1:\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^course-expiry:enr_2:\d{4}-\d{2}-\d{2}$/),
    ]);
  });

  it('derives the same key on a re-run, so the second run inserts nothing', async () => {
    const { processor, notifications } = build(EXPIRING);

    await run(processor);
    await run(processor);

    const first = (notifications.createOnce.mock.calls[0][0]).map(
      (r) => r.dedupeKey,
    );
    const second = (notifications.createOnce.mock.calls[1][0]).map(
      (r) => r.dedupeKey,
    );

    expect(second).toEqual(first);
  });

  it('keys on the enrollment, not the student, so two courses warn separately', async () => {
    const { processor, notifications } = build([
      { id: 'enr_1', userId: 'stu_1', courseId: 'crs_1', course: { title: 'Pharmacology' } },
      { id: 'enr_2', userId: 'stu_1', courseId: 'crs_2', course: { title: 'Anatomy' } },
    ]);

    await run(processor);

    const keys = (notifications.createOnce.mock.calls[0][0]).map(
      (r) => r.dedupeKey,
    );
    expect(new Set(keys).size).toBe(2);
  });

  it('reports what the database actually accepted', async () => {
    // The returned counts come from the insert, not from a tally of calls that
    // happened to resolve. That is the difference between "sent" and "attempted".
    const { processor, notifications } = build(EXPIRING);
    (notifications.createOnce as jest.Mock).mockResolvedValue({ created: 1, skipped: 1 });

    await expect(run(processor)).resolves.toEqual({ sent: 1, skipped: 1 });
  });

  it('survives a push that is already present without failing the job', async () => {
    const { processor, notifications } = build(EXPIRING);
    (notifications.createOnce as jest.Mock).mockResolvedValue({ created: 0, skipped: 2 });

    await expect(run(processor)).resolves.toEqual({ sent: 0, skipped: 2 });
  });
});

describe('visibility of failure', () => {
  it('propagates an insert failure instead of reporting success', async () => {
    // The previous shape caught every error per row and continued, so a
    // notification store that started rejecting writes made this job look like
    // it had succeeded, logged nothing, and was never retried.
    const { processor, notifications } = build(EXPIRING);
    (notifications.createOnce as jest.Mock).mockRejectedValue(new Error('write failed'));

    await expect(run(processor)).rejects.toThrow('write failed');
  });

  it('does not swallow a failure into a silent zero', async () => {
    const { processor, notifications } = build(EXPIRING);
    (notifications.createOnce as jest.Mock).mockResolvedValue({ created: 0, skipped: 2 });

    // Two candidates and two rows not inserted is reported as two not sent. A
    // separate "failed" column would have been wrong here: `skipped` already
    // accounts for every row that was not written, so subtracting it again
    // always yields zero and would report a healthy run.
    await expect(run(processor)).resolves.toEqual({ sent: 0, skipped: 2 });
  });
});

describe('content of the reminder', () => {
  it('renders the course title and links into the course', async () => {
    const { processor, notifications } = build([EXPIRING[0]]);

    await run(processor);

    expect(notifications.createOnce.mock.calls[0][0]).toEqual([
      expect.objectContaining({
        userId: 'stu_1',
        kind: NotificationKind.COURSE_UPDATE,
        title: expect.stringContaining('ends soon'),
        body: expect.stringContaining('Pharmacology'),
        route: '/course/crs_1',
      }),
    ]);
  });

  it('names the same course in both languages', async () => {
    const { processor, notifications } = build([EXPIRING[0]]);

    await run(processor);

    const [row] = notifications.createOnce.mock.calls[0][0];
    // The Arabic body is shown to a student reading the app in Arabic, so it has
    // to identify the course rather than shipping the English sentence wrapped in
    // Arabic prose.
    expect(row.bodyAr).toContain(EXPIRING[0].course.title);
    expect(row.titleAr).not.toBe(row.title);
  });

  it('bounds the batch so one sweep cannot fan out without limit', async () => {
    const { processor, findMany } = build(EXPIRING);

    await run(processor);

    expect(findMany.mock.calls[0][0].take).toBe(2000);
  });
});