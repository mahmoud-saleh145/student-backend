import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { describeDatabaseError, isTransientDatabaseError } from '../database/transient-db-error';
import { VideosService } from '../modules/videos/videos.service';
import { RedisService } from '../redis/redis.service';

/**
 * One recovery sweep shortly after the WORKER starts.
 *
 * The laptop worker is routinely shut down, restarted, put to sleep and moved
 * between networks. The scheduled sweep (`recover-stranded-videos`, every 30
 * minutes) usually also runs right at boot, because its occurrence missed
 * while the laptop was off is overdue - but not always (the repeat may not
 * have come due yet, or the maintenance queue may be consumed elsewhere). This
 * makes "one sweep soon after every start" a guarantee.
 *
 * NEVER TWO SWEEPS AT ONCE: it runs through `recoverStrandedVideosExclusive`,
 * the same lock the scheduled sweep takes. If that sweep is running right now,
 * this one counts as done.
 *
 * NO STORM: a second marker (`boot-recovery`, BOOT_RECOVERY_LOCK_SECONDS) is
 * kept after a sweep, so Docker or Windows restarting several times in a row
 * runs at most one boot sweep per window. Both locks expire on their own if
 * the process dies.
 *
 * OUTAGES ARE NOT "DONE": a Redis error (as opposed to a lock that is held) or
 * a database error is retried every BOOT_RECOVERY_RETRY_MS, up to
 * BOOT_RECOVERY_MAX_TRIES, then left to the scheduled sweep - which runs again
 * every 30 minutes, so nothing is given up for good.
 *
 * The delay lets BullMQ's own stalled check run first: a job whose lock
 * expired while the laptop was off goes back to its queue through it.
 */
export const BOOT_RECOVERY_DELAY_MS = 90_000;
export const BOOT_RECOVERY_RETRY_MS = 120_000;
export const BOOT_RECOVERY_MAX_TRIES = 5;
export const BOOT_RECOVERY_LOCK_SECONDS = 600;

export type BootRecoveryOutcome = 'done' | 'sweep-running' | 'locked' | 'retry' | 'gave-up';

@Injectable()
export class BootRecovery implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BootRecovery');
  private timer?: NodeJS.Timeout;
  private tries = 0;

  constructor(
    private readonly videos: VideosService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.schedule(BOOT_RECOVERY_DELAY_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => void this.run(), ms);
    this.timer.unref();
  }

  /** One attempt. Public for tests. */
  async run(): Promise<BootRecoveryOutcome> {
    this.tries += 1;
    if (!this.redis) return this.retryLater('Redis is not available');

    const marker = await this.redis.tryLock('boot-recovery', BOOT_RECOVERY_LOCK_SECONDS);
    if (marker.status === 'held') {
      this.logger.log('BOOT_RECOVERY skipped: a boot sweep already ran within the last 10 minutes');
      return 'locked';
    }
    if (marker.status === 'error') return this.retryLater('Redis did not answer');

    try {
      const r = await this.videos.recoverStrandedVideosExclusive('boot');
      if (r.skipped === 'redis-unavailable') {
        await marker.release();
        return this.retryLater('Redis did not answer (sweep lock)');
      }
      if (r.skipped !== false) {
        // The scheduled sweep is running right now: that IS the boot sweep.
        this.logger.log('BOOT_RECOVERY done: the scheduled sweep is running now');
        return 'sweep-running';
      }
      this.logger.log(
        `BOOT_RECOVERY done: web requeued=${r.requeued} failed=${r.failed} gumletSynced=${r.synced}; ` +
          `mobile requeued=${r.mobile.requeued} failed=${r.mobile.failed}`,
      );
      // The marker is deliberately KEPT until it expires: that is what makes
      // repeated restarts within the window a no-op.
      return 'done';
    } catch (error) {
      await marker.release();
      return this.retryLater(
        isTransientDatabaseError(error) ? describeDatabaseError(error) : ((error as Error)?.message ?? String(error)),
      );
    }
  }

  private retryLater(why: string): 'retry' | 'gave-up' {
    if (this.tries >= BOOT_RECOVERY_MAX_TRIES) {
      this.logger.warn(`BOOT_RECOVERY gave up after ${this.tries} tries (${why}); the scheduled sweep takes over`);
      return 'gave-up';
    }
    this.logger.warn(`BOOT_RECOVERY postponed (${why}); trying again in ${BOOT_RECOVERY_RETRY_MS / 1000}s`);
    this.schedule(BOOT_RECOVERY_RETRY_MS);
    return 'retry';
  }
}
