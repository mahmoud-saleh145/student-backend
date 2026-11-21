import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, Queue, type Job } from 'bullmq';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { MobileVideoStatus } from '@prisma/client';

import type { VideoConfig } from '../../config/configuration';
import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';
import { VideosService, withinQueueTimeout } from '../../modules/videos/videos.service';
import { MOBILE_PARK_MS } from '../mobile-park';
import { MOBILE_VIDEO_JOBS, QUEUE_NAMES, type MobileTranscodeJobData } from '../queue.constants';
import { RESPONSIVE_WORKER } from '../queue.tuning';
import { deferForTransientFailure, type WithTransientDeferral } from '../transient-deferral';
import {
  HlsTranscoder,
  type HlsLadderResult,
  TranscodeDiskPressureError,
  TranscodeEnvironmentError,
  TranscodeOutputError,
  TranscodeSupersededError,
} from './hls-transcoder';
import {
  DEFER_FOR_ENCODE_SLOT_MS,
  DEFER_FOR_UPLOADS_MS,
  isHistoricalMobileJob,
  MobileEncodeScheduler,
  type EncodeSlot,
} from './mobile-encode-scheduler';
import { formatBytes, pauseHolds, ScratchGuard, type PauseState } from './scratch-guard';

/** How long a deferred job waits before the worker looks at it again. */
export const DEFER_WHEN_PAUSED_MS = 60_000;
export const DEFER_WHEN_DISK_LOW_MS = 5 * 60_000;
/** See the processor options: interruptions of the host are routine here. */
export const MOBILE_MAX_STALLED_COUNT = 5;
/** How often the worker makes sure a full pause has also paused the queue. */
export const PAUSE_RECONCILE_MS = 30_000;
/**
 * In-place waits before re-trying a CLAIM or FINISH write that hit a transient
 * database error (≈ 3.8 min in total). Both writes are idempotent for the job
 * that owns the row (a compare-and-set claim; a transactional replace of the
 * ladder), so repeating one after a dropped connection is safe, and it saves
 * the whole encode that throwing would re-run: a finished 2-hour ladder used
 * to cost an attempt, and a full re-encode, for a brief Neon/network blip.
 */
export const DB_WRITE_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000];

/**
 * The CLAIM is retried in place only briefly (~50 s). Nothing has been done yet,
 * so a longer outage costs nothing to wait out in the delayed set instead,
 * where it holds no encode slot and uses no attempt (transient-deferral.ts).
 */
export const DB_CLAIM_RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

/**
 * The FINISH write is retried in place for much longer (~28 min): the ladder
 * is already encoded and on R2, and giving up means encoding it all again. On
 * 2026-11-20 one 17-minute lecture was fully encoded three times because this
 * window was 3.8 min and the outage was 5.5 h. Past this window the job is
 * deferred (no attempt used); the re-run overwrites the same R2 keys.
 */
/**
 * How often a running encode confirms it still owns the video (see
 * MobileVideoProcessor.watchOwnership). One indexed read per minute.
 */
export const OWNERSHIP_CHECK_MS = 60_000;

/**
 * A finished, verified ladder remembered in the job's own data, so a re-run of
 * the SAME job (its finish write was lost to an outage, or its lock expired
 * after the encode) records it instead of encoding the lecture again.
 */
export interface EncodedResultNote {
  jobId: string;
  sourceKey: string;
  at: string;
  result: HlsLadderResult;
}

export const DB_FINISH_RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000];

/**
 * The independent mobile pipeline.
 *
 * One job per video: the stored source is transcoded into the AES-128 HLS
 * ladder on R2 and the row's `mobileStatus` becomes READY. It never reads or
 * writes `Video.status` or any Gumlet field, so the web pipeline is unaffected
 * whether this job succeeds, fails or never runs.
 *
 * Runs on its own queue at concurrency 1: an encode holds a core for most of
 * an hour on a small host and must not sit in front of a Gumlet ingest.
 *
 * OPERATOR HOLDS ("park and release", see jobs/mobile-park.ts). A held job
 * is taken at most ONCE per hold, because every take risks a stall or an
 * attempt when the connection drops at that moment:
 *  - a FULL pause (flag without the `historical` scope) pauses the BullMQ
 *    queue itself; the job that noticed it is deferred once, and nothing is
 *    taken until the operator resumes. A flag written by something that does
 *    not pause the queue (the safety watchdog) is turned into a queue pause
 *    here and by a background check every PAUSE_RECONCILE_MS;
 *  - a HISTORICAL hold PARKS each `migration`/`recovery` job on its single
 *    take (delayed MOBILE_PARK_MS); resuming promotes exactly those jobs;
 *  - a pause flag that cannot be read defers the job (no attempt used), so
 *    an unreadable flag is never mistaken for a cleared one.
 *
 * Before a job is CLAIMED it can also be DEFERRED (moved back to the delayed
 * set without using an attempt and without touching the row's state):
 *  - it is HISTORICAL work (`migration`/`recovery`) and a new upload is waiting
 *    in the original queue (MobileEncodeScheduler: new uploads always first);
 *  - the scratch volume cannot hold this job's budget while keeping the
 *    configured reserve free (ScratchGuard.assess, before any download);
 *  - another process holds the single mobile encode slot (one ffmpeg ladder
 *    at a time across every worker, not just within this one).
 * A running encode that trips the reserve is killed by the disk watchdog and
 * deferred the same way; the row goes back to QUEUED with a note.
 *
 * Interruption model (laptop reboot, `docker stop`, a crash mid-encode):
 *  - a SIGTERM kills ffmpeg (HlsTranscoder.onModuleDestroy), the job fails as
 *    "interrupted" and the queue retries it with backoff;
 *  - a hard crash leaves the job `active` until its lock lapses
 *    (`lockDuration`), after which the stalled check moves it back to the
 *    queue; `recoverStrandedMobileVideos` is the belt to that brace;
 *  - scratch left behind by either is removed when the next worker boots
 *    (`onModuleInit`), so a crash never costs disk permanently;
 *  - a retry re-runs the whole video and overwrites the same R2 keys; READY is
 *    set only after every rung has been verified, so a half-uploaded ladder
 *    is never served.
 */
@Processor(QUEUE_NAMES.mobileVideo, {
  concurrency: 1,
  // BullMQ renews the lock on its own while the process lives, however long
  // the encode runs; this only decides how long a job from a worker that died
  // stays "active" before the stalled check hands it back. Five minutes, so a
  // laptop reboot costs minutes, not the half hour it did.
  lockDuration: 5 * 60_000,
  // How many times a job may be found abandoned (its worker stopped renewing
  // the lock) before BullMQ fails it outright. The library default is 1, which
  // suits a server and not this host: the encoder is a laptop that sleeps when
  // its lid closes, and a lecture that was interrupted by two sleeps was
  // failed permanently ("job stalled more than allowable limit") although
  // nothing was wrong with it. Each stall only costs a re-run of that video.
  maxStalledCount: MOBILE_MAX_STALLED_COUNT,
  ...RESPONSIVE_WORKER,
})
export class MobileVideoProcessor extends WorkerHost implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MobileVideoProcessor.name);
  private readonly cfg: VideoConfig;
  /** Deferral intervals; a field only so a real-queue test can shorten them. */
  protected deferMs = {
    paused: DEFER_WHEN_PAUSED_MS,
    uploads: DEFER_FOR_UPLOADS_MS,
    disk: DEFER_WHEN_DISK_LOW_MS,
    slot: DEFER_FOR_ENCODE_SLOT_MS,
  };
  /** Interval of the pause reconciler; a field only so a real-queue test can shorten it. */
  protected pauseReconcileMs = PAUSE_RECONCILE_MS;
  /**
   * In-place DB retry waits for BOTH writes; a field only so a test can shorten
   * them. When unset, the claim uses DB_CLAIM_RETRY_DELAYS_MS and the finish
   * DB_FINISH_RETRY_DELAYS_MS.
   */
  protected dbRetryDelaysMs: number[] | null = null;
  /** Ownership watch interval; a field only so a test can shorten it. */
  protected ownershipCheckMs = OWNERSHIP_CHECK_MS;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** One reconcile at a time: a hung Redis must not pile them up. */
  private reconciling = false;

  constructor(
    private readonly transcoder: HlsTranscoder,
    private readonly videos: VideosService,
    config: ConfigService,
    private readonly guard: ScratchGuard,
    private readonly scheduler: MobileEncodeScheduler,
    /**
     * This processor's own queue, to pause it when a full pause is in force.
     * Typed optional only so a test may leave it out; without it a full pause
     * falls back to deferring each job (the previous behaviour).
     */
    @InjectQueue(QUEUE_NAMES.mobileVideo) private readonly mobileQueue?: Queue<MobileTranscodeJobData>,
  ) {
    super();
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  /**
   * Nothing can be running in this host's scratch before this processor is
   * up (one worker per host, concurrency 1), so whatever is there is the
   * remains of an interrupted job.
   */
  async onModuleInit(): Promise<void> {
    this.startPauseReconciler();
    const root = join(this.cfg.workDir, 'mobile');
    const stale = await readdir(root).catch(() => [] as string[]);
    if (stale.length === 0) return;
    await Promise.all(
      stale.map((entry) => rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined)),
    );
    this.logger.warn(`removed ${stale.length} stale scratch director${stale.length === 1 ? 'y' : 'ies'} under ${root}`);
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
  }

  /**
   * Starts the background check that turns a full-pause FLAG into a paused
   * QUEUE (once now, then every `pauseReconcileMs`). Public for tests.
   */
  startPauseReconciler(): void {
    if (this.reconcileTimer || !this.mobileQueue) return;
    void this.reconcileQueuePause();
    this.reconcileTimer = setInterval(() => void this.reconcileQueuePause(), this.pauseReconcileMs);
    this.reconcileTimer.unref();
  }

  /**
   * A full pause in the flag and a queue that is still running: pause the
   * queue. This is how a pause written by something that only knows the flag
   * (the safety watchdog, an operator with redis-cli) stops the worker from
   * taking jobs at all. It NEVER resumes the queue - only the operator's
   * resume does that, after releasing parked jobs - so a flag that is cleared
   * or unreadable leaves the queue as it is. Errors are logged and ignored.
   * Returns whether it paused the queue (for tests).
   */
  async reconcileQueuePause(): Promise<boolean> {
    if (!this.mobileQueue || this.reconciling) return false;
    this.reconciling = true;
    try {
      const pause = await this.guard.pauseState();
      if (!pause.paused || pause.scope === 'historical') return false;
      return await this.ensureQueuePaused(pause, 'pause reconciler');
    } catch (error) {
      this.logger.warn(`pause reconciler: ${(error as Error)?.message ?? error}; will look again`);
      return false;
    } finally {
      this.reconciling = false;
    }
  }

  /**
   * Pauses the mobile queue at BullMQ level unless it already is. Never
   * throws: failing to pause leaves the previous behaviour (each job is
   * deferred), never a job that runs. Returns whether it paused the queue.
   */
  private async ensureQueuePaused(pause: PauseState, who: string): Promise<boolean> {
    if (!this.mobileQueue) return false;
    try {
      if (await withinQueueTimeout(this.mobileQueue.isPaused(), 'mobile queue read')) return false;
      await withinQueueTimeout(this.mobileQueue.pause(), 'mobile queue pause');
      this.logger.warn(
        `${who}: mobile processing is paused (${pause.reason ?? 'no reason given'}; by ${pause.by ?? 'unknown'}); ` +
          `paused the mobile queue so no job is taken until an operator resumes`,
      );
      return true;
    } catch (error) {
      this.logger.error(`${who}: could not pause the mobile queue (${(error as Error)?.message ?? error})`);
      return false;
    }
  }

  async process(
    job: Job<MobileTranscodeJobData & WithTransientDeferral & { encodedResult?: EncodedResultNote | null }>,
    token?: string,
  ): Promise<unknown> {
    if (job.name !== MOBILE_VIDEO_JOBS.transcode) return null;

    const { videoId, sourceKey, ladder, encrypt, trigger, durationSeconds } = job.data;
    const workDir = join(this.cfg.workDir, 'mobile', videoId);

    // --- operator holds (see the class comment) -----------------------------
    // A flag that cannot be read is not "not paused": the job is deferred,
    // which uses no attempt.
    let pause: PauseState;
    try {
      pause = await this.guard.pauseState();
    } catch (error) {
      this.logger.warn(`could not read the mobile pause flag (${(error as Error)?.message ?? error}); deferring ${videoId}`);
      this.guard.noteDeferred(videoId, 'pause state unreadable');
      return this.defer(job, token, this.deferMs.paused, 'pause state unreadable');
    }
    // A `historical` pause holds only the back catalogue; a new upload or a
    // staff retry goes through it. A pause without a scope holds everything.
    if (pauseHolds(pause, trigger)) {
      if (pause.scope === 'historical') {
        // Taken once, parked until the operator releases the hold.
        this.logger.log(
          `historical mobile work is held (${pause.reason ?? 'no reason given'}); ${videoId} parked until released`,
        );
        this.guard.noteDeferred(videoId, 'parked (historical hold)');
        return this.defer(job, token, MOBILE_PARK_MS, 'parked until released');
      }
      // Everything is held: stop the queue itself, so this is the last take.
      await this.ensureQueuePaused(pause, `job ${job.id}`);
      this.logger.log(
        `mobile processing is paused (${pause.scope}; ${pause.reason ?? 'no reason given'}); deferring ${videoId}`,
      );
      this.guard.noteDeferred(videoId, 'paused');
      return this.defer(job, token, this.deferMs.paused, 'paused');
    }

    // New uploads first. Read failures defer too: a historical encode never
    // starts on an unknown.
    if (isHistoricalMobileJob(trigger)) {
      const pressure = await this.scheduler.uploadPressure().catch((e: Error) => {
        this.logger.warn(`could not read the original upload queue (${e.message}); deferring ${videoId}`);
        return null;
      });
      if (!pressure || pressure.waiting > 0) {
        const why = pressure ? `${pressure.waiting} new upload(s) waiting` : 'upload queue unreadable';
        this.guard.noteDeferred(videoId, `upload priority: ${why}`);
        return this.defer(job, token, this.deferMs.uploads, `upload priority: ${why}`);
      }
    }

    const preflight = await this.transcoder.preflight({ workDir, sourceKey, durationSeconds, ladder, guardId: videoId });
    if (!preflight.sourceMissing && !preflight.assessment.ok) {
      const a = preflight.assessment;
      this.logger.warn(
        `deferring ${videoId}: needs ${formatBytes(preflight.budgetBytes)} of scratch, ` +
          `${formatBytes(a.freeBytes)} free, ${formatBytes(a.reservedByOthers)} reserved by other jobs, ` +
          `${formatBytes(a.minFreeBytes)} must stay free (short by ${formatBytes(a.shortfallBytes)})`,
      );
      this.guard.noteDeferred(videoId, `disk: short by ${formatBytes(a.shortfallBytes)}`);
      return this.defer(job, token, this.deferMs.disk, 'disk');
    }

    // One mobile encode at a time across every worker process.
    const slot: EncodeSlot | null = await this.scheduler.acquireEncodeSlot(String(job.id)).catch((e: Error) => {
      this.logger.warn(`could not take the mobile encode slot (${e.message}); deferring ${videoId}`);
      return null;
    });
    if (!slot) {
      this.guard.noteDeferred(videoId, 'another mobile encode holds the slot');
      return this.defer(job, token, this.deferMs.slot, 'encode slot busy');
    }

    this.logger.log(`mobile transcode ${videoId} (job ${job.id}, ${trigger})`);
    this.guard.noteActive({ videoId, jobId: String(job.id), startedAt: new Date().toISOString(), progress: 0 });

    // This attempt's ownership of the row, once claimed: the job id is the
    // generation, `claimedAt` tells two attempts of the same job apart.
    let owner: { jobId: string; claimedAt: Date } | null = null;
    try {
      const claim = await this.withDbRetry('claim', videoId, () =>
        this.videos.claimMobileProcessing(videoId, sourceKey, String(job.id)),
      );
      if (!claim) {
        // Includes "this generation is already mobile-READY": a job that the
        // laptop's sleep made BullMQ hand out a second time completes here,
        // without encoding anything or touching the READY row.
        this.logger.warn(`skipping stale mobile job ${job.id} for video ${videoId}`);
        return { videoId, skipped: true };
      }
      const mine = { jobId: String(job.id), claimedAt: claim.claimedAt };
      owner = mine;

      // REUSE a ladder this same job already encoded, verified and uploaded,
      // when only its finish write was lost (database outage, expired lock).
      const saved = job.data.encodedResult;
      let result: HlsLadderResult;
      if (saved && saved.jobId === owner.jobId && saved.sourceKey === sourceKey) {
        this.logger.warn(
          `MOBILE_ENCODE_REUSED video=${videoId} job=${job.id} encodedAt=${saved.at}: recording the ladder this job ` +
            'already encoded instead of encoding it again',
        );
        result = saved.result;
      } else {
        const stopWatch = this.watchOwnership(videoId, owner);
        try {
          result = await this.transcoder.run({
            videoId,
            sourceKey,
            workDir,
            ladder,
            encrypt,
            durationSeconds,
            // Progress is informational. It is not awaited: with Redis briefly
            // unreachable, awaiting it would stall (offline queue) or fail (error)
            // an encode that does not need Redis at all.
            onProgress: (pct) => {
              this.guard.noteProgress(videoId, pct);
              job.updateProgress(pct).catch(() => undefined);
            },
          });
        } finally {
          stopWatch();
        }
        // Remember it before the finish write, so a lost finish never costs a
        // second encode. Best effort: without Redis it is simply not reused.
        const note: EncodedResultNote = { jobId: owner.jobId, sourceKey, at: new Date().toISOString(), result };
        await Promise.resolve()
          .then(() => job.updateData({ ...job.data, encodedResult: note }))
          .catch(() => undefined);
      }

      const recorded = await this.withDbRetry('finish', videoId, () => this.videos.markMobileReady(
        videoId,
        {
          durationSeconds: Math.round(result.probe.durationSeconds),
          width: result.probe.width,
          height: result.probe.height,
          frameRate: result.probe.frameRate,
          videoCodec: result.probe.videoCodec,
          audioCodec: result.probe.audioCodec,
          hlsPrefix: result.hlsPrefix,
          masterPlaylistKey: result.masterPlaylistKey,
          thumbnailKey: result.thumbnailKey,
          isEncrypted: result.isEncrypted,
          encryptionKeyId: result.isEncrypted ? (result.encryptionKeyId ?? `derived:${videoId}`) : undefined,
          renditions: result.renditions,
        },
        // The file this encode read, and the attempt that encoded it: a result
        // for a replaced file, another generation, or an attempt that has been
        // superseded by a newer claim is not recorded; a generation that is
        // already READY is left exactly as it is.
        { sourceKey, jobId: mine.jobId, claimedAt: mine.claimedAt },
      ));
      if (recorded === false) {
        this.logger.warn(
          `mobile job ${job.id} for video ${videoId}: result not recorded (file replaced, or another job/attempt owns the row)`,
        );
        return { videoId, skipped: true };
      }

      this.logger.log(`video ${videoId} mobile READY (${result.renditions.length} renditions)`);
      return { videoId, renditions: result.renditions.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // THIS ATTEMPT WAS SUPERSEDED while it encoded: the generation became
      // READY elsewhere, or a newer attempt re-claimed the row. Nothing is
      // written; the job ends without spending an attempt or a failure.
      if (error instanceof TranscodeSupersededError) {
        this.logger.warn(`MOBILE_ATTEMPT_SUPERSEDED video=${videoId} job=${job.id}: ${message}; stopped, nothing recorded`);
        return { videoId, skipped: true, superseded: true };
      }

      // A database outage is not a verdict on the video, and it is not an
      // attempt either: the row is left as it is and the job is deferred with
      // a growing, jittered delay for a bounded window (transient-deferral.ts).
      // Only once that window is used up does it fall back to the queue's
      // attempts, as before. Safe to run again: the claim is a compare-and-set
      // on (sourceKey, job id) and the ladder overwrites the same R2 keys.
      if (isTransientDatabaseError(error)) {
        await deferForTransientFailure({
          job,
          token,
          kind: 'database',
          logger: this.logger,
          videoId,
          detail: describeDatabaseError(error),
        });
        this.logger.warn(
          `video ${videoId}: database unreachable during mobile processing (${describeDatabaseError(error)}; ` +
            `job ${job.id}, attempt ${job.attemptsMade + 1} of ${job.opts?.attempts ?? 1})`,
        );
        throw error;
      }

      // The disk watchdog stopped the encode. Not the video's fault and not
      // worth an attempt: the row goes back to QUEUED and the job waits for
      // space. Scratch is removed below; the source on R2 was never touched.
      if (error instanceof TranscodeDiskPressureError) {
        this.logger.warn(`video ${videoId}: ${message}; deferring until the scratch volume recovers`);
        await this.videos
          .markMobileDeferred(videoId, `Paused for disk space: ${message}`, owner ? { jobId: owner.jobId } : undefined)
          .catch((e: Error) => this.logger.error(`video ${videoId}: could not record the deferral (${e.message})`));
        this.guard.noteDeferred(videoId, 'disk pressure during encode');
        return this.defer(job, token, this.deferMs.disk, 'disk pressure');
      }

      const reason =
        error instanceof TranscodeEnvironmentError
          ? `Worker could not run the encode (${message}); it will be retried`
          : error instanceof TranscodeOutputError
            ? `Output failed verification and was not published (${message})`
            : message;
      this.logger.error(`mobile transcode failed for ${videoId}: ${message}`);
      // FAILED means "nothing more will happen on its own". While the queue
      // still has an attempt left for this job that is not true, and saying it
      // had two costs: the dashboard showed a failure for a video that was
      // about to be retried, and a staff "retry" pressed in that window queued
      // a SECOND job beside the one still pending. So an attempt that will be
      // retried leaves the row QUEUED with the reason, and only the last one
      // records FAILED.
      const attempt = job.attemptsMade + 1;
      const attempts = job.opts?.attempts ?? 1;
      try {
        if (attempt < attempts) {
          await this.videos.markMobileRetrying(videoId, String(job.id), reason, attempt, attempts, owner?.claimedAt);
        } else {
          await this.videos.markMobileFailed(videoId, reason, {
            sourceKey,
            jobId: String(job.id),
            ...(owner ? { claimedAt: owner.claimedAt } : {}),
          });
        }
      } catch (markError) {
        this.logger.error(
          `video ${videoId}: could not record the mobile failure (${(markError as Error)?.message ?? markError})`,
        );
      }
      throw error;
    } finally {
      this.guard.noteFinished(videoId);
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      await slot.release();
    }
  }

  /**
   * While an encode runs, confirm every `ownershipCheckMs` that this attempt
   * still owns the video. If the row became READY, belongs to another job, or
   * was re-claimed by a newer attempt of this job (its lock expired while the
   * laptop slept), the encode is stopped before it writes more of the shared
   * `hls/<id>/` objects. A read that fails (database outage) decides nothing.
   * Returns the function that stops the watch.
   */
  private watchOwnership(videoId: string, owner: { jobId: string; claimedAt: Date }): () => void {
    let checking = false;
    const timer = setInterval(() => {
      if (checking) return;
      checking = true;
      void this.videos
        .mobileOwnership(videoId)
        .then((row) => {
          if (row === undefined) return; // unknown: decide nothing
          const why =
            row === null
              ? 'the video no longer exists'
              : row.mobileStatus === MobileVideoStatus.READY
                ? `this generation is already mobile-READY (job ${row.mobileJobId ?? 'unknown'})`
                : row.mobileJobId !== owner.jobId
                  ? `job ${row.mobileJobId ?? 'none'} now owns the video`
                  : row.mobileProcessingStartedAt?.getTime() !== owner.claimedAt.getTime()
                    ? 'a newer attempt of this job re-claimed the video'
                    : null;
          if (why) this.transcoder.abortSuperseded(why);
        })
        .catch(() => undefined)
        .finally(() => {
          checking = false;
        });
    }, this.ownershipCheckMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /**
   * Puts the job back in the delayed set without consuming an attempt. BullMQ
   * requires the processor to throw DelayedError after moveToDelayed so the
   * worker does not also mark the job completed.
   */
  private async defer(
    job: Job<MobileTranscodeJobData>,
    token: string | undefined,
    ms: number,
    why: string,
  ): Promise<never> {
    await job.moveToDelayed(Date.now() + ms, token);
    this.logger.log(`job ${job.id} deferred ${Math.round(ms / 1000)} s (${why})`);
    throw new DelayedError();
  }

  /**
   * Runs an idempotent row write, re-trying it in place on a TRANSIENT
   * database error (see DB_WRITE_RETRY_DELAYS_MS). Any other error, or a
   * transient one that outlasts every wait, is thrown unchanged and handled
   * as before (attempt + backoff).
   */
  private async withDbRetry<T>(what: 'claim' | 'finish', videoId: string, op: () => Promise<T>): Promise<T> {
    const waits = this.dbRetryDelaysMs ?? (what === 'claim' ? DB_CLAIM_RETRY_DELAYS_MS : DB_FINISH_RETRY_DELAYS_MS);
    for (let i = 0; ; i += 1) {
      try {
        return await op();
      } catch (error) {
        if (!isTransientDatabaseError(error) || i >= waits.length) throw error;
        this.logger.warn(
          `video ${videoId}: ${what} hit a transient database error (${describeDatabaseError(error)}); ` +
            `retrying in place in ${Math.round(waits[i]! / 1000)} s (${i + 1}/${waits.length})`,
        );
        await new Promise((resolve) => setTimeout(resolve, waits[i]));
      }
    }
  }
}
