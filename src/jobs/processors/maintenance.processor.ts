import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EnrollmentState, NotificationKind } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../database/prisma.service';
import { CodesService } from '../../modules/codes/codes.service';
import { EnrollmentsService } from '../../modules/enrollments/enrollments.service';
import { AnnouncementsService } from '../../modules/notifications/announcements.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { PlaybackService } from '../../modules/playback/playback.service';
import { VideosService } from '../../modules/videos/videos.service';
import { MAINTENANCE_JOBS, QUEUE_NAMES, type MaintenanceJobData } from '../queue.constants';
import { BACKGROUND_WORKER } from '../queue.tuning';

/**
 * Housekeeping.
 *
 * Everything here is bookkeeping, never enforcement. The access engine
 * evaluates expiry live on every request, so a student never keeps access
 * because a job was late — these jobs exist to make the stored state match
 * reality for reporting, list filters and dashboards.
 *
 * Nothing in this processor deletes a business record. Sessions and
 * idempotency keys are the only rows pruned, and both are transient by
 * construction.
 */
@Processor(QUEUE_NAMES.maintenance, { concurrency: 1, ...BACKGROUND_WORKER })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollments: EnrollmentsService,
    private readonly codes: CodesService,
    private readonly playback: PlaybackService,
    private readonly notifications: NotificationsService,
    private readonly announcements: AnnouncementsService,
    private readonly videos: VideosService,
  ) {
    super();
  }

  async process(job: Job<MaintenanceJobData>): Promise<unknown> {
    switch (job.name) {
      case MAINTENANCE_JOBS.expireEnrollments:
        return { expired: await this.enrollments.expireLapsedEnrollments() };

      case MAINTENANCE_JOBS.expireCodes:
        return { expired: await this.codes.expireLapsedCodes() };

      case MAINTENANCE_JOBS.expireTickets:
        return { expired: await this.playback.expireLapsedTickets() };

      case MAINTENANCE_JOBS.reclaimStreamSlots:
        return { reclaimed: await this.playback.reclaimStaleSlots() };

      case MAINTENANCE_JOBS.pruneSessions:
        return this.pruneSessions();

      case MAINTENANCE_JOBS.pruneIdempotency:
        return this.pruneIdempotency();

      case MAINTENANCE_JOBS.courseExpiryReminders:
        return this.sendExpiryReminders();

      // The only job here that sends something people see. It is safe to run
      // every minute because each occurrence is claimed by a unique row before
      // any message is written, so a duplicate tick dispatches nothing.
      case MAINTENANCE_JOBS.dispatchAnnouncements:
        return this.announcements.dispatchDue(new Date());

      case MAINTENANCE_JOBS.recoverStrandedVideos:
        return this.videos.recoverStrandedVideos();

      default:
        this.logger.warn(`unknown maintenance job: ${job.name}`);
        return null;
    }
  }

  /**
   * Removes sessions and refresh tokens that expired more than 30 days ago.
   *
   * Safe to delete: they carry no business meaning once expired, and the audit
   * trail of who logged in when lives in security_events, not here.
   */
  private async pruneSessions() {
    const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000);

    const [tokens, sessions] = await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { expiresAt: { lt: cutoff } } }),
      this.prisma.session.deleteMany({
        where: { expiresAt: { lt: cutoff }, status: { not: 'ACTIVE' } },
      }),
    ]);

    if (sessions.count > 0 || tokens.count > 0) {
      this.logger.log(`pruned ${sessions.count} sessions, ${tokens.count} refresh tokens`);
    }

    return { sessions: sessions.count, refreshTokens: tokens.count };
  }

  private async pruneIdempotency() {
    const { count } = await this.prisma.idempotencyRecord.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return { pruned: count };
  }

  /**
   * Warns students three days before their access lapses.
   *
   * The 24-hour window is a *narrowing* of the candidate set, not the thing that
   * makes the send once-only — a sliding window re-selects the same enrollment
   * on every run, so any run more often than daily (a retry, a manual re-run, a
   * duplicated delivery) would message the student again. Idempotency comes from
   * the `dedupeKey` constraint instead, and the window key is the UTC date bucket
   * three days out, so a student is told once per lapsing period no matter how
   * often the job runs.
   */
  private async sendExpiryReminders() {
    const start = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);

    const expiring = await this.prisma.enrollment.findMany({
      where: {
        state: EnrollmentState.ACTIVE,
        accessEndsAt: { gte: start, lt: end },
      },
      select: {
        id: true,
        userId: true,
        courseId: true,
        course: { select: { title: true } },
      },
      take: 2000,
    });

    if (expiring.length === 0) return { sent: 0, skipped: 0 };

    // Anchored to the day, not to this run's clock. Two runs a minute apart
    // resolve to the same bucket and therefore to the same dedupe keys, which is
    // the point: the second one is a no-op rather than a second reminder.
    const windowKey = start.toISOString().slice(0, 10);

    // `skipped` is every row that was not inserted, so it needs no second
    // tally here: `expiring.length - created - skipped` would be zero by
    // construction and would report a healthy run even if writes were being
    // rejected. Errors are allowed to propagate instead — a failing insert
    // should fail the job so BullMQ can retry it and the failure is visible,
    // rather than the previous behaviour of catching every error per row,
    // logging nothing and never being retried.
    const { created, skipped } = await this.notifications.createOnce(
      expiring.map((enrollment) => ({
        dedupeKey: `course-expiry:${enrollment.id}:${windowKey}`,
        userId: enrollment.userId,
        kind: NotificationKind.COURSE_UPDATE,
        title: 'Your course access ends soon',
        titleAr: 'وصولك للكورس ينتهي قريبًا',
        body: `Access to ${enrollment.course.title} ends in 3 days.`,
        bodyAr: `ينتهي وصولك إلى ${enrollment.course.title} خلال ٣ أيام.`,
        route: `/course/${enrollment.courseId}`,
      })),
    );

    this.logger.log(
      `course expiry reminders: ${created} sent, ${skipped} not sent (already reminded this period)`,
    );

    return { sent: created, skipped };
  }
}
