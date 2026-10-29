import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { RedisService } from '../../redis/redis.service';

import { AccountDeletionService, type DeletionSweepResult } from './account-deletion.service';

/** Hourly by default; `ACCOUNT_DELETION_SWEEP_INTERVAL_SECONDS=0` disables it on a process. */
export function normalizeDeletionSweepIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 3600;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return 3600;
  if (value === 0) return 0;
  return Math.max(300, Math.floor(value));
}

export const DELETION_SWEEP_LOCK = 'account-deletion-sweep';
const LOCK_SECONDS = 30 * 60;

/**
 * Runs the account-deletion sweep on the API process.
 *
 * Why not a timer per request: the decision (D5) rules out anything that
 * disappears on restart. Nothing is held in memory here except "check the
 * table again in an hour" - the due requests are re-read from Postgres on every
 * run, so a restart or a skipped run only delays erasure to the next sweep.
 *
 * Why the API and not the BullMQ worker: in this deployment the worker runs on
 * the owner's PC and is not guaranteed to be up, while the API always is (the
 * DRM verification sweep moved here for the same reason). The Redis lock keeps
 * it to one sweeper across replicas; if the lock ever lapsed, every transition
 * is conditional, so a second sweeper finds nothing to claim.
 */
@Injectable()
export class AccountDeletionScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(AccountDeletionScheduler.name);
  readonly intervalSeconds = normalizeDeletionSweepIntervalSeconds(
    process.env.ACCOUNT_DELETION_SWEEP_INTERVAL_SECONDS,
  );
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;

  constructor(
    private readonly deletion: AccountDeletionService,
    private readonly redis: RedisService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalSeconds === 0 || process.env.NODE_ENV === 'test') return;
    this.first = setTimeout(() => void this.tick(), 120_000);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    this.timer.unref();
    this.logger.log(`Account deletion sweep scheduled in-process every ${this.intervalSeconds}s`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One locked sweep; null when another process holds the lock or Redis is down. */
  async tick(): Promise<DeletionSweepResult | null> {
    const release = await this.redis.acquireLock(DELETION_SWEEP_LOCK, LOCK_SECONDS);
    if (!release) return null;
    try {
      const result = await this.deletion.sweep();
      if (result.claimed > 0 || result.skipped > 0) {
        this.logger.log(
          `account deletion sweep: completed=${result.completed} failed=${result.failed} skipped=${result.skipped}`,
        );
      }
      return result;
    } catch (error) {
      this.logger.error(`account deletion sweep failed: ${(error as Error).message}`);
      return null;
    } finally {
      await release();
    }
  }
}
