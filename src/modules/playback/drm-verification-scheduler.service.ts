import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { hostname } from 'node:os';

import { RedisService } from '../../redis/redis.service';
import { type DrmSweepResult, DrmVerificationSweepService } from './drm-verification-sweep.service';

/** Where the last completed sweep is recorded, for /meta/health/deep. */
export const DRM_LAST_SWEEP_KEY = 'drm:verification:last-sweep';

export interface DrmLastSweepRecord extends DrmSweepResult {
  at: string;
  host: string;
}

/**
 * Runs the DRM re-verification sweep IN PROCESS, on a timer, under a Redis lock.
 *
 * WHY NOT A BULLMQ REPEATABLE
 *
 * The sweep used to be a BullMQ job consumed only where RUN_WORKERS=true - in
 * production a PC-hosted container. An older worker build completes job names
 * it does not know, so it silently swallowed the sweep, and with no worker at
 * all nothing ran. Either way verified videos lapsed and stopped playing.
 *
 * Here every process that loads PlaybackModule (the always-on API, and any
 * worker of this build) runs the timer; the lock means one sweep at a time
 * across all of them, and no queue is involved, so no other process can
 * consume or drop it. Playback does not even depend on this: the ticket path
 * refreshes a lapsed proof itself (DrmVerificationService.ensurePlayable). The
 * sweep only keeps proofs warm so that rarely costs a student a provider call.
 *
 * DRM_SWEEP_INTERVAL_SECONDS (default 900; 0 disables). A host that sleeps
 * (e.g. an idle free-tier instance) simply runs no ticks while asleep.
 */
@Injectable()
export class DrmVerificationScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(DrmVerificationScheduler.name);
  readonly intervalSeconds: number;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly sweeper: DrmVerificationSweepService,
    private readonly redis: RedisService,
  ) {
    const raw = Number(process.env.DRM_SWEEP_INTERVAL_SECONDS ?? 900);
    this.intervalSeconds = Number.isFinite(raw) && raw > 0 ? Math.max(60, Math.floor(raw)) : 0;
  }

  /**
   * Longer than the worst-case sweep (25 videos x 2 attempts x 2 requests x
   * the HTTP timeout), so a slow run is never overlapped. If a lock ever does
   * lapse mid-run, a second sweep is harmless: verification writes are
   * conditional and idempotent.
   */
  get lockSeconds(): number {
    return Math.max(this.intervalSeconds, 900);
  }

  onApplicationBootstrap(): void {
    if (this.intervalSeconds === 0 || process.env.NODE_ENV === 'test') return;
    // Soon after boot - a freshly woken or redeployed API refreshes promptly -
    // then on the interval.
    this.first = setTimeout(() => void this.tick(), 30_000);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    this.timer.unref();
    this.logger.log(`DRM verification sweep scheduled in-process every ${this.intervalSeconds}s`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One locked sweep. Returns null when another process holds the lock (or Redis is down). */
  async tick(): Promise<DrmSweepResult | null> {
    const release = await this.redis.acquireLock('drm-verification-sweep', this.lockSeconds);
    if (!release) return null;
    try {
      const result = await this.sweeper.sweep();
      const record: DrmLastSweepRecord = { ...result, at: new Date().toISOString(), host: hostname() };
      await this.redis.setJson(DRM_LAST_SWEEP_KEY, record, 7 * 24 * 3600).catch(() => undefined);
      return result;
    } catch (error) {
      this.logger.error(`DRM verification sweep failed: ${(error as Error).message}`);
      return null;
    } finally {
      await release();
    }
  }
}
