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
    // and not at 19:09. The job is a single indexed query when nothing is due,
    // which is almost always — cheap enough to run at this rate.
    await schedule(
      this.maintenance as never,
      MAINTENANCE_JOBS.dispatchAnnouncements,
      '* * * * *',
    );

    // Frequent, cheap: reclaim streaming slots so a crashed client doesn't
    // block the student's next video for long.
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.reclaimStreamSlots, '*/2 * * * *');
    await schedule(this.maintenance as never, MAINTENANCE_JOBS.expireTickets, '*/10 * * * *');

    // Videos whose job vanished (Redis eviction, a worker killed mid-job) are
    // put back on the queue instead of sitting in QUEUED forever.
    await schedule(
      this.maintenance as never,
      MAINTENANCE_JOBS.recoverStrandedVideos,
      '*/10 * * * *',
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
