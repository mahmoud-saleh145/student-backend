import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';

import { VideosService } from './videos.service';

/**
 * VIDEO_PIPELINE_RECONCILE_SECONDS as applied: the interval of the BACKGROUND
 * scan. Unset means 600; 0 / negative / non-numeric disables the reconciler
 * altogether; anything else is floored to whole seconds, never below 60.
 */
export function normalizeReconcileIntervalSeconds(raw: string | undefined): number {
  const value = Number(raw ?? 600);
  return Number.isFinite(value) && value > 0 ? Math.max(60, Math.floor(value)) : 0;
}

/** How often the timer wakes. It only touches the database when it has a reason to. */
export const RECONCILE_WAKE_SECONDS = 30;
/** The first scan after boot: the case this exists for is a process that just died. */
export const RECONCILE_BOOT_DELAY_MS = 20_000;

/**
 * Delivers processing intents that never reached the queue.
 *
 * WHAT IT IS FOR
 *
 * When an upload is confirmed, the instruction to process it is written to the
 * database first and sent to Redis second (see VideosService.completeUpload).
 * Between those two steps the process can stop, or Redis can be unreachable.
 * The instruction is then safe but undelivered, and something has to deliver
 * it later. That something is this timer.
 *
 * WHEN IT ACTUALLY QUERIES THE DATABASE
 *
 * Three occasions, and deliberately no others:
 *
 *   1. Once, shortly after boot. A process that died between the commit and
 *      the enqueue is replaced by a new one - this one - and the stranded
 *      intent is found here.
 *   2. Every RECONCILE_WAKE_SECONDS, but ONLY while this process knows it
 *      failed to deliver something (VideosService.hasUndeliveredIntents). That
 *      is the Redis-outage case: fast recovery, at no cost when nothing is
 *      wrong, because the knowledge is in memory.
 *   3. A background scan every VIDEO_PIPELINE_RECONCILE_SECONDS (default ten
 *      minutes), for what this process cannot know about: an intent stranded
 *      by ANOTHER instance that never came back.
 *
 * So an idle system costs one small indexed query every ten minutes per
 * process and no Redis traffic at all - the previous fixed two-minute scan
 * would also have kept an otherwise idle serverless database awake.
 *
 * WHY IN-PROCESS, AND NOT A QUEUED JOB
 *
 * The existing recovery sweep is a BullMQ repeatable on the maintenance queue.
 * It only runs where a worker consumes that queue, and it is itself stored in
 * Redis. A recovery mechanism for "Redis was down" and "no worker was running"
 * cannot depend on Redis and a worker to start. This runs in every process
 * that loads VideosModule, the always-on API included, exactly as the DRM
 * verification sweep does.
 *
 * WHY NO LOCK
 *
 * Both enqueues it performs are idempotent by job id, so several processes
 * (two API instances, the API and a worker) running it at once deliver each
 * intent once. A lock would cost a Redis request per tick to prevent nothing.
 */
@Injectable()
export class VideoPipelineReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VideoPipelineReconciler.name);
  readonly intervalSeconds = normalizeReconcileIntervalSeconds(process.env.VIDEO_PIPELINE_RECONCILE_SECONDS);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running = false;
  private lastScanAt = 0;

  constructor(private readonly videos: VideosService) {}

  onApplicationBootstrap(): void {
    if (this.intervalSeconds === 0 || process.env.NODE_ENV === 'test') return;
    this.first = setTimeout(() => void this.tick(), RECONCILE_BOOT_DELAY_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.wake(), RECONCILE_WAKE_SECONDS * 1000);
    this.timer.unref();
    this.logger.log(
      `video pipeline reconciler: scan at boot, every ${RECONCILE_WAKE_SECONDS}s while a delivery is known to be pending, ` +
        `and every ${this.intervalSeconds}s in the background`,
    );
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * The timer's callback: scans only when there is a reason to. Returns
   * whether a scan ran (for tests).
   */
  async wake(now = Date.now()): Promise<boolean> {
    const knownPending = this.videos.hasUndeliveredIntents();
    const backgroundDue = now - this.lastScanAt >= this.intervalSeconds * 1000;
    if (!knownPending && !backgroundDue) return false;
    await this.tick();
    return true;
  }

  /** One scan. Never throws; a tick that overlaps a slow one is skipped. */
  async tick(): Promise<Awaited<ReturnType<VideosService['reconcilePendingIntents']>> | null> {
    if (this.running) return null;
    this.running = true;
    this.lastScanAt = Date.now();
    try {
      return await this.videos.reconcilePendingIntents();
    } catch (error) {
      // A database blip is routine and says nothing about the videos; the next
      // wake tries again. Anything else is worth a line in the log.
      if (isTransientDatabaseError(error)) {
        this.logger.warn(`reconcile skipped: database unreachable (${describeDatabaseError(error)})`);
      } else {
        this.logger.error(`reconcile failed: ${(error as Error)?.message ?? error}`);
      }
      return null;
    } finally {
      this.running = false;
    }
  }
}
