import { Injectable, Logger, Optional, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { VideoStatus } from '@prisma/client';

import { PrismaService, notDeleted } from '../../database/prisma.service';
import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';
import { RedisService } from '../../redis/redis.service';
import { DrmVerificationService } from '../playback/drm-verification.service';
import { GumletDrmService } from '../playback/gumlet-drm.service';
import { isTerminalGumletFailure } from './gumlet-failure';
import { GumletIngestService } from './gumlet-ingest.service';
import { setGumletMonitorActive, takeGumletPendingHint } from './gumlet-monitor-signal';

/**
 * Finishes Gumlet videos in the BACKGROUND, so the web queue does not wait.
 *
 * WHY
 *
 * A web job used to submit the source to Gumlet and then poll it for up to 20
 * minutes, holding the queue's only slot (concurrency 1). On 2026-11-21 three
 * lectures uploaded overnight were processed one after another, each blocking
 * the next while Gumlet worked on the previous one. With this monitor running,
 * the job ends as soon as the asset id is recorded
 * (`GumletIngestService.processFromJob`), and the monitor finishes the video:
 * it asks Gumlet, and `sync()` marks READY only once Gumlet reports `ready` AND
 * DRM verification passes - the same single authority as before.
 *
 * OPT-IN AND DRM-GATED (review finding H1)
 *
 * It runs only where GUMLET_MONITOR_ENABLED=true is set AND this process can
 * verify DRM itself (DRM enabled, provider Gumlet, signing configured) AND can
 * call the Gumlet asset API AND has Redis. A local API, a test, or an operator
 * script that boots the app against production therefore never runs it by
 * accident. (sync() no longer marks anything FAILED for lack of configuration
 * either; this is the second layer.) Where it does not run, the web job keeps
 * its previous in-job polling (see gumlet-monitor-signal.ts).
 *
 * SCHEDULE AND COST (findings M3, M4)
 *
 *   - Checks are spaced by the time since the asset was SUBMITTED (first seen
 *     by a monitor; Redis key per video+asset), not since the upload: a video
 *     uploaded while the laptop was off is checked every minute once it is
 *     finally submitted.
 *   - The timer wakes every MONITOR_WAKE_MS but queries Neon only when the
 *     earliest row is due (or a submission was just made here), never more
 *     often than MONITOR_MIN_SCAN_GAP_MS, and at most every idle interval
 *     otherwise. A stuck asset is checked every 15-60 minutes, not every 30 s.
 *   - At most MAX_SYNCS_PER_TICK Gumlet reads per scan, each under a per-video
 *     Redis lock held for the whole check interval, so the worker and the API
 *     never check the same video twice in a row.
 *   - A failed check keeps the lock for a growing backoff (1 min doubling to
 *     30 min) across all processes, and a scan stops after
 *     MAX_ERRORS_PER_TICK failures (provider outage).
 */

/** How often the timer wakes; it only queries when something is due. */
export const MONITOR_WAKE_MS = 15_000;
/** Never scan more often than this. */
export const MONITOR_MIN_SCAN_GAP_MS = 30_000;
/** First scan after boot. */
export const MONITOR_BOOT_DELAY_MS = 25_000;
/** Upper bound of Gumlet reads per scan, whatever the backlog. */
export const MAX_SYNCS_PER_TICK = 5;
/** A provider outage stops the scan after this many failed checks. */
export const MAX_ERRORS_PER_TICK = 3;
/** Rows read per scan (four small columns; production has a handful). */
export const MAX_ROWS_PER_SCAN = 200;
/** Minimum per-video lock lifetime. */
export const VIDEO_LOCK_SECONDS = 60;
/** How long the "first seen" submission marker lives. */
export const SUBMITTED_MARKER_TTL_SECONDS = 14 * 24 * 3600;

/** GUMLET_MONITOR_ENABLED as applied: only an explicit true value enables it. */
export function monitorEnabledFlag(raw: string | undefined): boolean {
  // Same values the env schema's toBool() accepts.
  return ['true', '1'].includes((raw ?? '').trim().toLowerCase());
}

/** GUMLET_MONITOR_IDLE_SECONDS as applied: unset → 600; 0/invalid → monitor off; else ≥ 60. */
export function normalizeMonitorIdleSeconds(raw: string | undefined): number {
  const text = (raw ?? '').trim();
  const value = text === '' ? 600 : Number(text);
  return Number.isFinite(value) && value > 0 ? Math.max(60, Math.floor(value)) : 0;
}

/**
 * Time between two checks of one asset, by how long ago it was SUBMITTED.
 * Gumlet's own processing measured 2-90 minutes per lecture.
 */
export function gumletCheckIntervalMs(sinceSubmittedMs: number): number {
  if (sinceSubmittedMs < 3 * 3600_000) return 60_000;
  if (sinceSubmittedMs < 24 * 3600_000) return 5 * 60_000;
  if (sinceSubmittedMs < 72 * 3600_000) return 15 * 60_000;
  return 60 * 60_000;
}

/** Backoff after `failures` consecutive failed checks of one video (≥ 1). */
export function gumletErrorBackoffMs(failures: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, failures - 1), 30 * 60_000);
}

export interface MonitorConfigInput {
  flag: boolean;
  idleSeconds: number;
  drmUsable: boolean;
  assetApi: boolean;
  redis: boolean;
}

/** Why the monitor must not run in this process, or null when it may. */
export function monitorDisabledReason(c: MonitorConfigInput): string | null {
  if (!c.flag) return 'GUMLET_MONITOR_ENABLED is not true';
  if (c.idleSeconds === 0) return 'GUMLET_MONITOR_IDLE_SECONDS is 0';
  if (!c.drmUsable) return 'this process cannot verify DRM (DRM_ENABLED / DRM_PROVIDER=gumlet / signing)';
  if (!c.assetApi) return 'the Gumlet asset API is not configured';
  if (!c.redis) return 'Redis is not available';
  return null;
}

export interface MonitorTickResult {
  scanned: number;
  due: number;
  synced: number;
  ready: number;
  skippedLocked: number;
  errors: number;
  /** When this process will scan next (epoch ms). */
  nextScanAt: number;
}

interface Row {
  id: string;
  createdAt: Date;
  gumletUpdatedAt: Date | null;
  gumletAssetId: string | null;
}

@Injectable()
export class GumletStatusMonitor implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(GumletStatusMonitor.name);
  readonly idleSeconds = normalizeMonitorIdleSeconds(process.env.GUMLET_MONITOR_IDLE_SECONDS);
  /** Null when the monitor may run here; otherwise why not. */
  readonly disabledReason: string | null;
  private timer?: NodeJS.Timeout;
  private running = false;
  private lastScanAt = 0;
  private nextScanAt = 0;
  private dbFailures = 0;
  /** Consecutive failed checks per video, for the backoff. Process-local. */
  private readonly failures = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: GumletIngestService,
    private readonly drmVerification: DrmVerificationService,
    private readonly gumlet: GumletDrmService,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.disabledReason = monitorDisabledReason({
      flag: monitorEnabledFlag(process.env.GUMLET_MONITOR_ENABLED),
      idleSeconds: this.idleSeconds,
      drmUsable: this.drmVerification.isPlatformUsable(),
      assetApi: this.gumlet.isAssetApiConfigured(),
      redis: Boolean(this.redis),
    });
    // Tests construct the monitor directly and drive tick(); only a real
    // process tells the ingest that a monitor will finish its videos.
    setGumletMonitorActive(this.disabledReason === null && process.env.NODE_ENV !== 'test');
  }

  get enabled(): boolean {
    return this.disabledReason === null;
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(`Gumlet status monitor OFF in this process: ${this.disabledReason}`);
      return;
    }
    if (process.env.NODE_ENV === 'test') return;
    this.nextScanAt = Date.now() + MONITOR_BOOT_DELAY_MS;
    this.timer = setInterval(() => void this.wake(), MONITOR_WAKE_MS);
    this.timer.unref();
    this.logger.log(
      `Gumlet status monitor ON: first scan in ${MONITOR_BOOT_DELAY_MS / 1000}s, then when the earliest video is due ` +
        `(at most every ${MONITOR_MIN_SCAN_GAP_MS / 1000}s, at least every ${this.idleSeconds}s)`,
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    setGumletMonitorActive(false);
  }

  /** The timer callback: scans only when something is due. Returns whether it scanned. */
  async wake(now = Date.now()): Promise<boolean> {
    if (!this.enabled) return false;
    if (takeGumletPendingHint()) this.nextScanAt = Math.min(this.nextScanAt, now);
    if (now < this.nextScanAt || now - this.lastScanAt < MONITOR_MIN_SCAN_GAP_MS) return false;
    await this.tick(now);
    return true;
  }

  /** One scan-and-sync pass. Never throws; an overlapping call is skipped. */
  async tick(now = Date.now()): Promise<MonitorTickResult | null> {
    if (!this.enabled || this.running) return null;
    this.running = true;
    this.lastScanAt = now;
    const idleMs = this.idleSeconds * 1000;
    const result: MonitorTickResult = {
      scanned: 0,
      due: 0,
      synced: 0,
      ready: 0,
      skippedLocked: 0,
      errors: 0,
      nextScanAt: now + idleMs,
    };
    try {
      const rows: Row[] = await this.prisma.video.findMany({
        where: {
          ...notDeleted,
          status: VideoStatus.PROCESSING,
          drmProvider: 'gumlet',
          gumletAssetId: { not: null },
        },
        select: { id: true, createdAt: true, gumletUpdatedAt: true, gumletAssetId: true },
        // Least recently checked first; a row never checked comes first.
        orderBy: { gumletUpdatedAt: { sort: 'asc', nulls: 'first' } },
        take: MAX_ROWS_PER_SCAN,
      });
      this.dbFailures = 0;
      result.scanned = rows.length;
      const submittedAt = await this.submittedAt(rows, now);

      // When each row is next due: its last check plus its interval.
      const dueAt = new Map<string, number>();
      for (const r of rows) {
        const interval = gumletCheckIntervalMs(now - submittedAt.get(r.id)!);
        dueAt.set(r.id, r.gumletUpdatedAt ? r.gumletUpdatedAt.getTime() + interval : now);
      }
      const due = rows.filter((r) => dueAt.get(r.id)! <= now);
      result.due = due.length;

      let errors = 0;
      for (const row of due.slice(0, MAX_SYNCS_PER_TICK)) {
        if (errors >= MAX_ERRORS_PER_TICK) break;
        // ONE CHECK PER VIDEO PER INTERVAL, across every process: the lock lives
        // for the whole interval and is kept after the check. Without the lock
        // (another process has it, or Redis cannot answer) the video waits.
        const intervalMs = gumletCheckIntervalMs(now - submittedAt.get(row.id)!);
        const release = await this.redis!.acquireLock(
          `gumlet-monitor:${row.id}`,
          Math.max(VIDEO_LOCK_SECONDS, Math.ceil(intervalMs / 1000)),
        );
        if (!release) {
          result.skippedLocked += 1;
          // Next look when that lock (an interval or a backoff) runs out.
          dueAt.set(row.id, now + (await this.lockRemainingMs(row.id)));
          continue;
        }
        try {
          const state = await this.ingest.sync(row.id);
          result.synced += 1;
          this.failures.delete(row.id);
          dueAt.set(row.id, now + intervalMs);
          // A FINAL verdict frees the video at once, so a staff reprocess (new
          // asset) is not held back by this check's interval lock.
          if (state.playable || isTerminalGumletFailure(state.status)) {
            await release().catch(() => undefined);
            dueAt.delete(row.id);
          }
          if (state.playable) {
            result.ready += 1;
            dueAt.delete(row.id);
            this.logger.log(`GUMLET_MONITOR_READY video=${row.id} asset=${state.assetId}: Gumlet ready and DRM verified`);
          }
        } catch (error) {
          errors += 1;
          result.errors += 1;
          const n = (this.failures.get(row.id) ?? 0) + 1;
          this.failures.set(row.id, n);
          const backoffMs = gumletErrorBackoffMs(n);
          // BACKOFF FOR EVERY PROCESS: the lock this process holds now lives
          // exactly for the backoff, so no process checks the video sooner.
          await this.redis!.client
            .pexpire(this.redis!.key('lock', `gumlet-monitor:${row.id}`), backoffMs)
            .catch(() => release().catch(() => undefined));
          dueAt.set(row.id, now + backoffMs);
          this.logger.warn(
            `GUMLET_MONITOR_SYNC_DEFERRED video=${row.id} failures=${n} retryInS=${Math.round(backoffMs / 1000)} (${
              isTransientDatabaseError(error) ? describeDatabaseError(error) : ((error as Error)?.message ?? error)
            })`,
          );
        }
      }
      if (errors >= MAX_ERRORS_PER_TICK) {
        this.logger.warn(`GUMLET_MONITOR scan stopped after ${errors} failed checks (provider or database outage)`);
      }

      // NEXT SCAN: when the earliest remaining row is due, within [gap, idle].
      const earliest = Math.min(...dueAt.values(), now + idleMs);
      result.nextScanAt = Math.min(Math.max(earliest, now + MONITOR_MIN_SCAN_GAP_MS), now + idleMs);
      this.nextScanAt = result.nextScanAt;
      if (result.synced || result.errors) {
        this.logger.log(
          `GUMLET_MONITOR scanned=${result.scanned} due=${result.due} synced=${result.synced} ready=${result.ready} ` +
            `locked=${result.skippedLocked} errors=${result.errors} nextScanInS=${Math.round((result.nextScanAt - now) / 1000)}`,
        );
      }
      return result;
    } catch (error) {
      // The scan itself failed (database). Back off, bounded by the idle interval.
      this.dbFailures += 1;
      this.nextScanAt = now + Math.min(gumletErrorBackoffMs(this.dbFailures), idleMs);
      if (isTransientDatabaseError(error)) {
        this.logger.warn(`Gumlet monitor skipped: database unreachable (${describeDatabaseError(error)})`);
      } else {
        this.logger.error(`Gumlet monitor failed: ${(error as Error)?.message ?? error}`);
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  /** Remaining life of another process's per-video lock (60 s when unknown). */
  private async lockRemainingMs(videoId: string): Promise<number> {
    try {
      const ms = await this.redis!.client.pttl(this.redis!.key('lock', `gumlet-monitor:${videoId}`));
      return ms > 0 ? ms : VIDEO_LOCK_SECONDS * 1000;
    } catch {
      return VIDEO_LOCK_SECONDS * 1000;
    }
  }

  /**
   * When each row's CURRENT asset was submitted, as first seen by any monitor
   * (Redis `gumlet-monitor:seen:<videoId>` = `<assetId>|<epoch ms>`; a new asset
   * - a replacement - starts a fresh schedule). One MGET per scan, plus one SET
   * per newly seen asset. Without Redis an asset is treated as just submitted.
   */
  private async submittedAt(rows: Row[], now: number): Promise<Map<string, number>> {
    const out = new Map<string, number>(rows.map((r) => [r.id, now]));
    if (!rows.length) return out;
    const keys = rows.map((r) => this.redis!.key('gumlet-monitor', 'seen', r.id));
    try {
      const values = await this.redis!.client.mget(...keys);
      const fresh: Array<[string, string]> = [];
      rows.forEach((r, i) => {
        const [asset, at] = (values[i] ?? '').split('|');
        const ms = Number(at);
        if (asset === r.gumletAssetId && Number.isFinite(ms) && ms > 0 && ms <= now) out.set(r.id, ms);
        else fresh.push([keys[i]!, `${r.gumletAssetId}|${now}`]);
      });
      if (fresh.length) {
        const multi = this.redis!.client.multi();
        for (const [k, v] of fresh) multi.set(k, v, 'EX', SUBMITTED_MARKER_TTL_SECONDS);
        await multi.exec();
      }
    } catch {
      // Treated as just submitted: the shortest interval, still under the lock.
    }
    return out;
  }
}
