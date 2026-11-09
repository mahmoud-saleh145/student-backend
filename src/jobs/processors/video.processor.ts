import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { VideoConfig } from '../../config/configuration';
import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';
import {
  GumletAdoptionNotRecordedError,
  GumletIngestService,
} from '../../modules/videos/gumlet-ingest.service';
import { VideosService } from '../../modules/videos/videos.service';
import { QUEUE_NAMES, VIDEO_JOBS, type TranscodeJobData } from '../queue.constants';
import { RESPONSIVE_WORKER } from '../queue.tuning';
import { HlsTranscoder, TranscodeEnvironmentError } from './hls-transcoder';

/**
 * Primary (web) video processing.
 *
 * Runs in the worker process (`npm run worker`), never in the API.
 *
 * Two pipelines share this job, chosen by the video's `drmProvider` as read
 * from the database:
 *
 *  - `gumlet`: the source is handed to Gumlet (`GumletIngestService`), which
 *    transcodes, packages and DRM-encrypts it on its own infrastructure. This
 *    is every production video today. The mobile ladder for the same upload is
 *    produced by `MobileVideoProcessor` on its own queue.
 *  - anything else (legacy): the source is transcoded here into AES-128 HLS on
 *    R2 by `HlsTranscoder`, which is the same code the mobile pipeline uses.
 *
 * Scratch is always cleaned up, including on failure: a partial transcode of a
 * 2 GB source left behind fills the disk within a day.
 */
@Processor(QUEUE_NAMES.video, {
  // One video at a time per worker: ffmpeg already uses every core, so
  // parallel jobs just thrash.
  concurrency: 1,
  lockDuration: 30 * 60_000,
  // `stalledInterval` comes from the shared profile; the explicit 60s here was
  // the same value, and centralising it keeps the Redis polling budget in one
  // place. `drainDelay` is the one that was never set and cost the most.
  ...RESPONSIVE_WORKER,
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);
  private readonly cfg: VideoConfig;

  constructor(
    private readonly transcoder: HlsTranscoder,
    private readonly videos: VideosService,
    private readonly gumletIngest: GumletIngestService,
    config: ConfigService,
  ) {
    super();
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  async process(job: Job<TranscodeJobData>): Promise<unknown> {
    if (job.name !== VIDEO_JOBS.transcode) return null;

    const { videoId, sourceKey, ladder, encrypt } = job.data;
    const workDir = join(this.cfg.workDir, videoId);

    this.logger.log(`transcoding video ${videoId} (job ${job.id})`);

    try {
      const claimed = await this.videos.markProcessing(videoId, sourceKey);
      if (!claimed) {
        this.logger.warn(`skipping stale transcode job ${job.id} for video ${videoId}`);
        return { videoId, skipped: true };
      }

      // --- provider branch -------------------------------------------------
      // Exactly one place decides between the two delivery pipelines. It reads
      // `drmProvider` from the database, NOT from the job payload, so a stale or
      // replayed job can never reroute a legacy R2/HLS video onto the Gumlet
      // path. Non-Gumlet videos return `handled: false` and fall through to the
      // ffmpeg path below.
      const gumlet = await this.gumletIngest.processFromJob(videoId, sourceKey);
      if (gumlet.handled) {
        this.logger.log(
          `video ${videoId} handled by Gumlet ingest (status ${gumlet.status ?? 'n/a'}, playable ${gumlet.playable === true})`,
        );
        return {
          videoId,
          provider: 'gumlet',
          status: gumlet.status ?? null,
          playable: gumlet.playable === true,
        };
      }

      // --- legacy local pipeline ---------------------------------------------
      const result = await this.transcoder.run({
        videoId,
        sourceKey,
        workDir,
        ladder,
        encrypt,
        onProgress: (pct) => job.updateProgress(pct),
      });

      await this.videos.markReady(videoId, {
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

      this.logger.log(`video ${videoId} ready (${result.renditions.length} renditions)`);
      return { videoId, renditions: result.renditions.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // A DATABASE OUTAGE IS NOT A VERDICT ON THE VIDEO.
      //
      // Writing FAILED here was wrong in both directions. While the database
      // was still unreachable, `markFailed` failed the same way and replaced
      // the original error. Once it was reachable again, a Gumlet video whose
      // asset was healthy got stamped FAILED - which the recovery sweep never
      // looks at - with the raw Prisma text (naming the database host) as the
      // reason shown in the dashboard.
      //
      // So the row is left exactly as the last successful write left it, and
      // the error goes back to BullMQ for its bounded, jittered retry. Every
      // state that can be left behind is one the sweep already resumes: QUEUED
      // is re-queued, a Gumlet row with an asset id is re-synced against the
      // provider, and a stale local PROCESSING row is failed with a retryable
      // reason after the sweep's cutoff.
      if (isTransientDatabaseError(error)) {
        this.logger.warn(
          `video ${videoId}: database unreachable during processing (${describeDatabaseError(error)}; ` +
            `job ${job.id}, attempt ${job.attemptsMade + 1} of ${job.opts?.attempts ?? 1}). ` +
            'The row is left unchanged; a queue retry or the recovery sweep resumes it.',
        );
        throw error;
      }

      // GUMLET SUCCEEDED, THE DATABASE DID NOT.
      //
      // A retry would create a second asset, so this must not be retried, and
      // the database is the thing that is down, so there is nowhere to write a
      // failure either. The message names the asset for the operator.
      if (error instanceof GumletAdoptionNotRecordedError) {
        this.logger.error(`transcode for ${videoId} stopped without retry: ${message}`);
        throw new UnrecoverableError(message);
      }

      const reason =
        error instanceof TranscodeEnvironmentError
          ? `Worker could not run the encode (${message}); it will be retried`
          : message;
      this.logger.error(`transcode failed for ${videoId}: ${message}`);
      try {
        await this.videos.markFailed(videoId, reason);
      } catch (markError) {
        // Never let the bookkeeping failure replace the reason the job failed.
        this.logger.error(
          `video ${videoId}: could not record the failure (` +
            (isTransientDatabaseError(markError)
              ? describeDatabaseError(markError)
              : (markError as Error)?.message ?? String(markError)) +
            '); keeping the original error',
        );
      }
      throw error;
    } finally {
      // Always clean up. A leftover 2 GB scratch directory per failed job
      // fills the disk within a day.
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
