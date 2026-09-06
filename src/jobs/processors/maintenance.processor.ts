import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { EnrollmentState, NotificationKind } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../database/prisma.service';
import { CodesService } from '../../modules/codes/codes.service';
import { EnrollmentsService } from '../../modules/enrollments/enrollments.service';
import { NotificationsService } from '../../modules/notifications/notifications.service';
import { PlaybackService } from '../../modules/playback/playback.service';
import { MAINTENANCE_JOBS, QUEUE_NAMES, type MaintenanceJobData } from '../queue.constants';

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
@Processor(QUEUE_NAMES.maintenance, { concurrency: 1 })
export class MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(MaintenanceProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enrollments: EnrollmentsService,
    private readonly codes: CodesService,
    private readonly playback: PlaybackService,
    private readonly notifications: NotificationsService,
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
   * Deliberately narrow: only enrollments whose end date falls inside a single
   * 24-hour window, so re-running the job cannot spam the same student daily.
   */
  private async sendExpiryReminders() {
    const start = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    const end = new Date(start.getTime() + 24 * 3600 * 1000);

    const expiring = await this.prisma.enrollment.findMany({
      where: {
        state: EnrollmentState.ACTIVE,
        accessEndsAt: { gte: start, lt: end },
      },
      include: { course: { select: { id: true, title: true } } },
      take: 2000,
    });

    let sent = 0;

    for (const enrollment of expiring) {
      await this.notifications
        .createForUser({
          userId: enrollment.userId,
          kind: NotificationKind.COURSE_UPDATE,
          title: 'Your course access ends soon',
          titleAr: 'وصولك للكورس ينتهي قريبًا',
          body: `Access to ${enrollment.course.title} ends in 3 days.`,
          bodyAr: `ينتهي وصولك إلى ${enrollment.course.title} خلال ٣ أيام.`,
          route: `/course/${enrollment.courseId}`,
        })
        .then(() => {
          sent += 1;
        })
        .catch(() => undefined);
    }

    if (sent > 0) this.logger.log(`sent ${sent} expiry reminder(s)`);
    return { sent };
  }
}
