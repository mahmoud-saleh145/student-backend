import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { hostname } from 'node:os';

import type { VideoConfig } from '../../config/configuration';
import { RedisService } from '../../redis/redis.service';
import {
  type DrmSweepResult,
  DrmVerificationSweepService,
  SWEEP_DEFAULT_BATCH_SIZE,
  SWEEP_VERIFY_ATTEMPTS,
} from './drm-verification-sweep.service';

/** Where the last completed sweep is recorded, for /meta/health/deep. */
export const DRM_LAST_SWEEP_KEY = 'drm:verification:last-sweep';

export interface DrmLastSweepRecord extends DrmSweepResult {
  at: string;
  host: string;
}

/**
 * Where the last sweep that THREW (DB down, unexpected error) is recorded, so
 * health can say "the last attempt failed" instead of only "overdue" two
 * intervals later. Time and host only: /meta/health/deep is public, and an
 * error message can carry connection details. The message goes to the log.
 */
export const DRM_LAST_SWEEP_FAILURE_KEY = 'drm:verification:last-sweep-failure';

export interface DrmLastSweepFailureRecord {
  at: string;
  host: string;
}

/**
 * DRM_SWEEP_INTERVAL_SECONDS as the scheduler applies it: unset means 900,
 * 0 / negative / non-numeric disables the sweep, anything else is floored to a
 * whole number of seconds and never below 60. /meta/health/deep uses the same
 * function, so "overdue" is always judged against the interval actually running.
 */
export function normalizeSweepIntervalSeconds(raw: string | undefined): number {
  const value = Number(raw ?? 900);
  return Number.isFinite(value) && value > 0 ? Math.max(60, Math.floor(value)) : 0;
}

/** Slack on top of the computed worst case, for DB reads/writes around the provider calls. */
const LOCK_MARGIN_SECONDS = 60;

/**
 * Upper bound on one sweep's wall time: every video in the batch makes two
 * provider requests (asset, manifest), each tried SWEEP_VERIFY_ATTEMPTS times
 * at the full HTTP timeout, with withRetry's linear backoff (250 ms x attempt)
 * between tries.
 */
export function worstCaseSweepSeconds(httpTimeoutMs: number): number {
  const backoffMs = Array.from({ length: SWEEP_VERIFY_ATTEMPTS - 1 }, (_v, i) => 250 * (i + 1)).reduce(
    (a, b) => a + b,
    0,
  );
  const perRequestMs = SWEEP_VERIFY_ATTEMPTS * httpTimeoutMs + backoffMs;
  return Math.ceil((SWEEP_DEFAULT_BATCH_SIZE * 2 * perRequestMs) / 1000);
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
  /**
   * Longer than the worst-case sweep at the CONFIGURED Gumlet timeout (up to
   * 30 s: ~3000 s for a full batch), so a slow run is never overlapped. The
   * old fixed 900 s only covered the 5 s default. If a lock ever does lapse
   * mid-run, a second sweep is harmless: verification writes are conditional
   * and idempotent.
   */
  readonly lockSeconds: number;
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly sweeper: DrmVerificationSweepService,
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.intervalSeconds = normalizeSweepIntervalSeconds(process.env.DRM_SWEEP_INTERVAL_SECONDS);
    const timeoutMs = config.get<VideoConfig>('video')?.drm.gumlet.httpTimeoutMs ?? 5000;
    this.lockSeconds = Math.max(this.intervalSeconds, worstCaseSweepSeconds(timeoutMs) + LOCK_MARGIN_SECONDS);
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
      const failure: DrmLastSweepFailureRecord = { at: new Date().toISOString(), host: hostname() };
      await this.redis.setJson(DRM_LAST_SWEEP_FAILURE_KEY, failure, 7 * 24 * 3600).catch(() => undefined);
      return null;
    } finally {
      await release();
    }
  }
}
