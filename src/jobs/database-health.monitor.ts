import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

import { PrismaService } from '../database/prisma.service';
import { describeDatabaseError, isTransientDatabaseError } from '../database/transient-db-error';
import { structured } from './transient-deferral';

/**
 * Is the DATABASE reachable from this worker - as opposed to "is the worker
 * process alive"?
 *
 * WHY THIS EXISTS
 *
 * On 2026-11-20 the worker's container health check stayed green for 5.5 hours
 * while every database call failed with P1001: the health check proves the
 * process beats into Redis, which it did. Nothing distinguished "worker alive"
 * from "worker can do its job". This monitor probes the database on its own
 * schedule and publishes the answer in the heartbeat (`db`), so the dashboard,
 * the health check output and an operator reading the beat can all see it.
 *
 * It is deliberately NOT wired into the container health status: restarting
 * the worker does not fix a network that cannot resolve Neon, and a restart
 * would interrupt encodes that do not need the database at that moment.
 *
 * Logs are structured and edge-triggered (`DB_UNREACHABLE` on the first
 * failure and every 10th after, `DB_RECOVERED` once, with the outage length),
 * so a long outage does not flood the log. The Prisma message (which names the
 * host) is never logged; only its code.
 */
export const DB_PROBE_INTERVAL_MS = 30_000;
export const DB_PROBE_TIMEOUT_MS = 10_000;

export interface DatabaseHealthSnapshot {
  ok: boolean | null;
  checkedAt: string | null;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  /** When the current outage started (first failed probe), if one is ongoing. */
  outageSince: string | null;
  lastProbeMs: number | null;
}

@Injectable()
export class DatabaseHealthMonitor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DatabaseHealth');
  private timer: NodeJS.Timeout | null = null;
  private probing = false;
  private state: DatabaseHealthSnapshot = {
    ok: null,
    checkedAt: null,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
    consecutiveFailures: 0,
    outageSince: null,
    lastProbeMs: null,
  };
  /** Overridable for tests. */
  protected intervalMs = DB_PROBE_INTERVAL_MS;
  protected timeoutMs = DB_PROBE_TIMEOUT_MS;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    void this.probe();
    this.timer = setInterval(() => void this.probe(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): DatabaseHealthSnapshot {
    return { ...this.state };
  }

  /** One bounded `SELECT 1`. Never throws. Public for tests. */
  async probe(now: () => number = Date.now): Promise<DatabaseHealthSnapshot> {
    if (this.probing) return this.snapshot();
    this.probing = true;
    const started = now();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.prisma.$queryRawUnsafe('SELECT 1'),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`probe timed out after ${this.timeoutMs} ms`)), this.timeoutMs);
        }),
      ]);
      this.recordOk(now(), now() - started);
    } catch (error) {
      this.recordFailure(now(), now() - started, error);
    } finally {
      clearTimeout(timer);
      this.probing = false;
    }
    return this.snapshot();
  }

  private recordOk(at: number, ms: number): void {
    const iso = new Date(at).toISOString();
    if (this.state.outageSince) {
      const seconds = Math.round((at - Date.parse(this.state.outageSince)) / 1000);
      this.logger.warn(
        structured('DB_RECOVERED', { outageS: seconds, failedProbes: this.state.consecutiveFailures, probeMs: ms }),
      );
    }
    this.state = {
      ...this.state,
      ok: true,
      checkedAt: iso,
      lastOkAt: iso,
      consecutiveFailures: 0,
      outageSince: null,
      lastProbeMs: ms,
    };
  }

  private recordFailure(at: number, ms: number, error: unknown): void {
    const iso = new Date(at).toISOString();
    const code = isTransientDatabaseError(error)
      ? describeDatabaseError(error)
      : error instanceof Error && /timed out/.test(error.message)
        ? 'probe timeout'
        : describeDatabaseError(error);
    const consecutive = this.state.consecutiveFailures + 1;
    const outageSince = this.state.outageSince ?? iso;
    if (consecutive === 1 || consecutive % 10 === 0) {
      this.logger.error(
        structured('DB_UNREACHABLE', {
          error: code,
          consecutive,
          since: outageSince,
          lastOkAt: this.state.lastOkAt,
          probeMs: ms,
        }),
      );
    }
    this.state = {
      ...this.state,
      ok: false,
      checkedAt: iso,
      lastFailureAt: iso,
      lastError: code,
      consecutiveFailures: consecutive,
      outageSince,
      lastProbeMs: ms,
    };
  }
}
