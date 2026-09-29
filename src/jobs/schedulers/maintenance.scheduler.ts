import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

import {
  ANALYTICS_JOBS,
  MAINTENANCE_JOBS,
  QUEUE_NAMES,
  type AnalyticsJobData,
  type MaintenanceJobData,
} from '../queue.constants';

/**
 * Recurring jobs.
 *
 * Registered as BullMQ repeatable jobs rather than @nestjs/schedule crons,
 * deliberately: with several API replicas a decorator-based cron fires once
 * per replica, so the expiry sweep would run four times at 03:00. BullMQ keeps
 * the schedule in Redis, so exactly one instance executes each occurrence
 * however many processes are running.
 *
 * Every job id is stable, so restarts re-register the same schedule instead of
 * accumulating duplicates.
 */
@Injectable()
export class MaintenanceScheduler implements OnModuleInit {
  private readonly logger = new Logger(MaintenanceScheduler.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.maintenance)
    private readonly maintenance: Queue<MaintenanceJobData>,
    @InjectQueue(QUEUE_NAMES.analytics)
    private readonly analytics: Queue<AnalyticsJobData>,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.register();
      this.logger.log('recurring maintenance jobs registered');
    } catch (e) {
      // Redis down at boot must not stop the API from serving.
      this.logger.error(`could not register scheduled jobs: ${(e as Error).message}`);
    }
  }

  private async register(): Promise<void> {
    const schedule = async (
      queue: Queue<never>,
      name: string,
      pattern: string,
    ): Promise<void> => {
      await (queue as unknown as Queue).add(
        name,
        { triggeredBy: 'schedule' } as never,
        {
          repeat: { pattern, tz: 'UTC' },
          jobId: `repeat:${name}`,
          removeOnComplete: 50,
          removeOnFail: 100,
        },
      );
    };

    // Every minute, because a send scheduled for 19:00 should happen at 19:00
    // and not at 19:09. The job body is a single indexed query when nothing is
    // due, which is almost always — but the *scheduling* is not free: on a
    // per-request Redis plan each occurrence costs roughly a dozen commands
    // between the delayed-set move, the fetch script, the completion and the
    // re-schedule. At one a minute that is ~1,400 occurrences a day.
    //
    // Left at one minute because punctuality is the feature. It is the single
    // largest remaining scheduled cost, so it is configurable: set
    // ANNOUNCEMENT_SWEEP_CRON to '*/5 * * * *' to trade nine minutes of
    // worst-case lateness for four fifths of this line's Redis traffic.
    await schedule(
      this.maintenance as never,
      MAINTENANCE_JOBS.dispatchAnnouncements,
      process.env.ANNOUNCEMENT_SWEEP_CRON?.trim() || '* * * * *',
    );

    // Reclaim streaming slots so a crashed client doesn't block the student's
    // next video for long. Every five minutes rather than every two: each
    // occurrence is a dozen-odd Redis commands on a per-request plan, and the
    // slot lease already expires on its own — this sweep only shortens the
    // wait, it is not what makes the slot recoverable.
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.reclaimStreamSlots, '*/5 * * * *');
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.expireTickets, '*/15 * * * *');

    // Videos whose job vanished (Redis eviction, a worker killed mid-job) are
    // put back on the queue instead of sitting in QUEUED forever. This is a
    // rare-failure backstop, not a hot path — half-hourly is soon enough, and
    // `POST /videos/:id/complete` re-enqueues immediately in the normal case.
    await schedule(
      this.maintenance as never,
      MAINTENANCE_JOBS.recoverStrandedVideos,
      '*/30 * * * *',
    );

    // Hourly bookkeeping.
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.expireEnrollments, '15 * * * *');
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.expireCodes, '25 * * * *');

    // Nightly, off-peak for an Egypt-centric audience (03:00 UTC ≈ 05:00 local).
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.pruneSessions, '0 3 * * *');
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.pruneIdempotency, '10 3 * * *');
    await schedule(this.analytics as never, ANALYTICS_JOBS.rollupDaily, '30 3 * * *');

    // Reminders in the morning, not the middle of the night.
    await schedule(
      this.maintenance as never,
      MAINTENANCE_JOBS.courseExpiryReminders,
      '0 7 * * *',
    );
  }
}
