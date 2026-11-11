import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { hostname } from 'node:os';

import { RedisService } from '../../redis/redis.service';
import { QUEUE_NAMES, VIDEO_JOBS, type TranscodeJobData } from '../queue.constants';

/**
 * Cross-queue scheduling for the mobile HLS pipeline.
 *
 * THE RULE (owner requirement, 2026-11-11): a newly uploaded video always goes
 * before historical mobile HLS work. The original upload pipeline and the
 * mobile pipeline are SEPARATE BullMQ queues with separate workers, so BullMQ
 * priorities cannot order one against the other. This class does it
 * explicitly, at the one moment that matters - before a mobile job claims its
 * video and starts ffmpeg:
 *
 *  1. Historical work yields to waiting uploads. A `migration` or `recovery`
 *     mobile job is deferred (no attempt used, row untouched) while a fresh
 *     upload is waiting in the original queue. An encode that is already
 *     running is never interrupted - it finishes and only the NEXT historical
 *     job waits.
 *  2. Inside the mobile queue, `upload` and staff `retry` jobs carry no BullMQ
 *     priority and historical jobs do (`MOBILE_JOB_PRIORITY`). BullMQ 5 drains
 *     the plain wait list before the prioritized set, so a new upload's mobile
 *     job is always taken before any historical one.
 *  3. One mobile encode at a time across EVERY worker process: a renewable
 *     Redis lease (`acquireEncodeSlot`). Per-process `concurrency: 1` alone
 *     would allow two encodes if a second worker container were ever started.
 *
 * WHAT DOES NOT BLOCK HISTORICAL WORK (so it cannot starve forever):
 *  - jobs in the original queue's `delayed` set (retry backoff, deferrals);
 *  - the original job that is already `active` (it has its slot; a Gumlet
 *    ingest is network-bound polling, not CPU);
 *  - an original queue that an operator PAUSED (the two pause controls stay
 *    independent: pausing uploads must not silently pause mobile too);
 *  - a waiting upload older than `UPLOAD_WAIT_STALE_MS`, which means no
 *    original-queue consumer is running at all - holding mobile work hostage
 *    to it would help nothing;
 *  - any other job name or queue metadata.
 */

export { isHistoricalMobileJob, MOBILE_JOB_PRIORITY } from '../queue.constants';

/** How long a historical job waits before looking again when uploads are queued. */
export const DEFER_FOR_UPLOADS_MS = 30_000;
/** How long a job waits when another process holds the encode slot. */
export const DEFER_FOR_ENCODE_SLOT_MS = 60_000;
/** A waiting upload older than this means the original queue has no consumer. */
export const UPLOAD_WAIT_STALE_MS = 3 * 60 * 60_000;
/** How many waiting original jobs are inspected (plenty: one is enough to yield). */
const UPLOAD_SCAN_LIMIT = 50;

export const ENCODE_SLOT_KEY = 'mobile:transcode:slot';
/** The lease outlives a stalled renewal briefly; a crashed holder frees it within this. */
export const ENCODE_SLOT_TTL_MS = 120_000;
export const ENCODE_SLOT_RENEW_MS = 30_000;

export interface UploadPressure {
  /** Fresh original-upload jobs waiting for their worker. */
  waiting: number;
  /** Waiting jobs ignored because they are older than UPLOAD_WAIT_STALE_MS. */
  ignoredStale: number;
  /** The original queue is paused by an operator; it does not hold mobile back. */
  originalQueuePaused: boolean;
}

export interface EncodeSlot {
  holder: string;
  release(): Promise<void>;
}

const RENEW_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  else
    return 0
  end`;
const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end`;

@Injectable()
export class MobileEncodeScheduler {
  private readonly logger = new Logger(MobileEncodeScheduler.name);
  private readonly host = hostname();

  constructor(
    @InjectQueue(QUEUE_NAMES.video) private readonly originalQueue: Queue<TranscodeJobData>,
    private readonly redis: RedisService,
  ) {}

  /**
   * Fresh upload work waiting in the ORIGINAL queue. Throws when Redis cannot
   * be read; the caller defers (a mobile job never starts on an unknown).
   */
  async uploadPressure(now = Date.now()): Promise<UploadPressure> {
    if (await this.originalQueue.isPaused()) {
      return { waiting: 0, ignoredStale: 0, originalQueuePaused: true };
    }
    const jobs = await this.originalQueue.getJobs(['wait', 'prioritized'], 0, UPLOAD_SCAN_LIMIT - 1);
    let waiting = 0;
    let ignoredStale = 0;
    for (const job of jobs) {
      if (!job || job.name !== VIDEO_JOBS.transcode) continue;
      if (now - (job.timestamp ?? now) > UPLOAD_WAIT_STALE_MS) {
        ignoredStale += 1;
        continue;
      }
      waiting += 1;
    }
    return { waiting, ignoredStale, originalQueuePaused: false };
  }

  /**
   * The single mobile encode slot, as a renewable lease. Returns null when
   * another job (in any process) holds it. The lease is renewed while the
   * encode runs and expires within ENCODE_SLOT_TTL_MS if the holder dies.
   */
  async acquireEncodeSlot(jobId: string): Promise<EncodeSlot | null> {
    const key = this.redis.key(ENCODE_SLOT_KEY);
    const holder = `${this.host}:${process.pid}:${jobId}`;
    const ok = await this.redis.client.set(key, holder, 'PX', ENCODE_SLOT_TTL_MS, 'NX');
    if (ok !== 'OK') return null;

    let lost = false;
    const timer = setInterval(() => {
      void this.redis.client
        .eval(RENEW_SCRIPT, 1, key, holder, String(ENCODE_SLOT_TTL_MS))
        .then((renewed) => {
          if (Number(renewed) === 0 && !lost) {
            lost = true;
            this.logger.warn(`mobile encode slot for job ${jobId} expired before renewal; the encode continues`);
          }
        })
        .catch((e: Error) => this.logger.warn(`could not renew the mobile encode slot: ${e.message}`));
    }, ENCODE_SLOT_RENEW_MS);
    timer.unref();

    return {
      holder,
      release: async () => {
        clearInterval(timer);
        await this.redis.client.eval(RELEASE_SCRIPT, 1, key, holder).catch(() => undefined);
      },
    };
  }

  /** Who holds the encode slot now (for the heartbeat / diagnostics). */
  async encodeSlotHolder(): Promise<string | null> {
    return this.redis.client.get(this.redis.key(ENCODE_SLOT_KEY)).catch(() => null);
  }
}
