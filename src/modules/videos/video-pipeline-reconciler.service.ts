import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';

import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';

import { VideosService } from './videos.service';

/**
 * VIDEO_PIPELINE_RECONCILE_SECONDS as applied: unset means 120, 0 / negative /
 * non-numeric disables the reconciler, anything else is floored to a whole
 * number of seconds and never below 30.
 */
export function normalizeReconcileIntervalSeconds(raw: string | undefined): number {
  const value = Number(raw ?? 120);
  return Number.isFinite(value) && value > 0 ? Math.max(30, Math.floor(value)) : 0;
}

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
 * WHY IN-PROCESS, AND NOT A QUEUED JOB
 *
 * The existing recovery sweep is a BullMQ repeatable on the maintenance queue.
 * It only runs where a worker consumes that queue - in production, a laptop -
 * and it is itself stored in Redis. A recovery mechanism for "Redis was down"
 * and "no worker was running" cannot depend on Redis and a worker to start.
 * This runs in every process that loads VideosModule, the always-on API
 * included, exactly as the DRM verification sweep does.
 *
 * WHY NO LOCK
 *
 * Both enqueues it performs are idempotent by job id, so several processes
 * running it at once deliver each intent once. A lock would cost a Redis
 * request per tick to prevent nothing.
 *
 * COST
 *
 * One indexed database query per tick, and no Redis traffic unless an intent
 * is actually pending - which, outside an incident, is never. A host that
 * sleeps (an idle free-tier instance) simply runs no ticks while asleep; the
 * first tick after it wakes catches up.
 */
@Injectable()
export class VideoPipelineReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(VideoPipelineReconciler.name);
  readonly intervalSeconds = normalizeReconcileIntervalSeconds(process.env.VIDEO_PIPELINE_RECONCILE_SECONDS);
  private timer?: NodeJS.Timeout;
  private first?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly videos: VideosService) {}

  onApplicationBootstrap(): void {
    if (this.intervalSeconds === 0 || process.env.NODE_ENV === 'test') return;
    // Soon after boot: the case this exists for is a process that died between
    // the commit and the enqueue, and the replacement process is this one.
    this.first = setTimeout(() => void this.tick(), 20_000);
    this.first.unref();
    this.timer = setInterval(() => void this.tick(), this.intervalSeconds * 1000);
    this.timer.unref();
    this.logger.log(`video pipeline reconciler scheduled in-process every ${this.intervalSeconds}s`);
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass. Never throws; a tick that overlaps a slow one is skipped. */
  async tick(): Promise<Awaited<ReturnType<VideosService['reconcilePendingIntents']>> | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.videos.reconcilePendingIntents();
    } catch (error) {
      // A database blip is routine and says nothing about the videos; the next
      // tick tries again. Anything else is worth a line in the log.
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
