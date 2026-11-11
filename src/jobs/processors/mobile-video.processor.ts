import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DelayedError, type Job } from 'bullmq';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { VideoConfig } from '../../config/configuration';
import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';
import { VideosService } from '../../modules/videos/videos.service';
import { MOBILE_VIDEO_JOBS, QUEUE_NAMES, type MobileTranscodeJobData } from '../queue.constants';
import { RESPONSIVE_WORKER } from '../queue.tuning';
import {
  HlsTranscoder,
  TranscodeDiskPressureError,
  TranscodeEnvironmentError,
  TranscodeOutputError,
} from './hls-transcoder';
import {
  DEFER_FOR_ENCODE_SLOT_MS,
  DEFER_FOR_UPLOADS_MS,
  isHistoricalMobileJob,
  MobileEncodeScheduler,
  type EncodeSlot,
} from './mobile-encode-scheduler';
import { formatBytes, ScratchGuard } from './scratch-guard';

/** How long a deferred job waits before the worker looks at it again. */
export const DEFER_WHEN_PAUSED_MS = 60_000;
export const DEFER_WHEN_DISK_LOW_MS = 5 * 60_000;

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
 * Before a job is CLAIMED it can be DEFERRED (moved back to the delayed set
 * without using an attempt and without touching the row's state):
 *  - the operator paused mobile processing (ScratchGuard pause flag);
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
  ...RESPONSIVE_WORKER,
})
export class MobileVideoProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(MobileVideoProcessor.name);
  private readonly cfg: VideoConfig;
  /** Deferral intervals; a field only so a real-queue test can shorten them. */
  protected deferMs = {
    paused: DEFER_WHEN_PAUSED_MS,
    uploads: DEFER_FOR_UPLOADS_MS,
    disk: DEFER_WHEN_DISK_LOW_MS,
    slot: DEFER_FOR_ENCODE_SLOT_MS,
  };

  constructor(
    private readonly transcoder: HlsTranscoder,
    private readonly videos: VideosService,
    config: ConfigService,
    private readonly guard: ScratchGuard,
    private readonly scheduler: MobileEncodeScheduler,
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
    const root = join(this.cfg.workDir, 'mobile');
    const stale = await readdir(root).catch(() => [] as string[]);
    if (stale.length === 0) return;
    await Promise.all(
      stale.map((entry) => rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined)),
    );
    this.logger.warn(`removed ${stale.length} stale scratch director${stale.length === 1 ? 'y' : 'ies'} under ${root}`);
  }

  async process(job: Job<MobileTranscodeJobData>, token?: string): Promise<unknown> {
    if (job.name !== MOBILE_VIDEO_JOBS.transcode) return null;

    const { videoId, sourceKey, ladder, encrypt, trigger, durationSeconds } = job.data;
    const workDir = join(this.cfg.workDir, 'mobile', videoId);

    // --- gates that defer rather than fail ----------------------------------
    const pause = await this.guard.pauseState();
    if (pause.paused) {
      this.logger.log(`mobile processing is paused (${pause.reason ?? 'no reason given'}); deferring ${videoId}`);
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

    try {
      const claimed = await this.videos.markMobileProcessing(videoId, sourceKey, String(job.id));
      if (!claimed) {
        this.logger.warn(`skipping stale mobile job ${job.id} for video ${videoId}`);
        return { videoId, skipped: true };
      }

      const result = await this.transcoder.run({
        videoId,
        sourceKey,
        workDir,
        ladder,
        encrypt,
        durationSeconds,
        onProgress: async (pct) => {
          this.guard.noteProgress(videoId, pct);
          await job.updateProgress(pct);
        },
      });

      await this.videos.markMobileReady(videoId, {
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
        encryptionKeyId: result.isEncrypted ? `derived:${videoId}` : undefined,
        renditions: result.renditions,
      });

      this.logger.log(`video ${videoId} mobile READY (${result.renditions.length} renditions)`);
      return { videoId, renditions: result.renditions.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A database outage is not a verdict on the video: leave the row as it
      // is and let the queue's bounded, jittered retry come back to it.
      if (isTransientDatabaseError(error)) {
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
          .markMobileDeferred(videoId, `Paused for disk space: ${message}`)
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
      try {
        await this.videos.markMobileFailed(videoId, reason);
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
}
