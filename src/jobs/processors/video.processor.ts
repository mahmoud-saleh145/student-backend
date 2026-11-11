import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job } from 'bullmq';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { VideoConfig } from '../../config/configuration';
import { describeDatabaseError, isTransientDatabaseError } from '../../database/transient-db-error';
import { GumletCreationOutcomeUnknownError } from '../../modules/playback/gumlet-drm.service';
import {
  GumletAdoptionNotRecordedError,
  GumletIngestService,
} from '../../modules/videos/gumlet-ingest.service';
import { VideosService } from '../../modules/videos/videos.service';
import { QUEUE_NAMES, VIDEO_JOBS, type TranscodeJobData } from '../queue.constants';
import { RESPONSIVE_WORKER } from '../queue.tuning';
import { HlsTranscoder, TranscodeEnvironmentError } from './hls-transcoder';

/**
 * Hard ceiling on one Gumlet ingest inside a job.
 *
 * `processFromJob` has its own 20-minute poll budget and every provider call in
 * it is time-bounded, so in theory it always returns. In production on
 * 2026-11-10 one did not: a job went silent right after Gumlet accepted the
 * asset and stayed `active` for 11.5 hours. The worker kept renewing its lock,
 * so the stalled check never reclaimed it, and with `concurrency: 1` every
 * upload queued behind it waited too (nine videos, until the worker was
 * restarted by hand). Whatever never settled, this queue must not depend on it.
 *
 * The cause was found on 2026-11-11 (see src/database/bounded-operations.ts):
 * a Prisma query on a silently dead connection never settles. The worker now
 * bounds every database operation, which removes that cause. This deadline is
 * the backstop for anything else that might never settle.
 *
 * When it fires:
 *   - the ingest is ABORTED (its signal), so if it ever resumes it writes
 *     nothing - every write point checks the signal first;
 *   - the job ends WITHOUT an automatic retry (UnrecoverableError). A retry is
 *     the one path that could create a second billable Gumlet asset if the hang
 *     sat between "Gumlet created it" and "the row recorded it";
 *   - the row and any recorded asset are left untouched (not stamped FAILED:
 *     the asset may be fine). The recovery sweep re-syncs a PROCESSING Gumlet
 *     row with an asset within minutes - on 2026-11-10/11 it finished both hung
 *     videos - and a row without an asset is surfaced for a staff retry.
 * The deadline sits well past the 20-minute poll budget, so it only ever
 * fires on a hang.
 */
export const GUMLET_INGEST_JOB_DEADLINE_MS = 35 * 60_000;

/** The ingest promise did not settle within GUMLET_INGEST_JOB_DEADLINE_MS. */
export class GumletIngestStalledError extends Error {
  override readonly name = 'GumletIngestStalledError';
}

/**
 * `work`, or a GumletIngestStalledError once `ms` have passed. `onTimeout` runs
 * first (the caller aborts the work there). The timer never outlives the race,
 * and a rejection of the abandoned `work` is absorbed by the race, never left
 * unhandled.
 */
export function settleWithin<T>(work: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new GumletIngestStalledError(message));
    }, ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

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
  /** GUMLET_INGEST_JOB_DEADLINE_MS; a field only so a real-queue test can shorten it. */
  protected ingestDeadlineMs = GUMLET_INGEST_JOB_DEADLINE_MS;

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
      const ingest = new AbortController();
      const gumlet = await settleWithin(
        this.gumletIngest.processFromJob(videoId, sourceKey, { signal: ingest.signal }),
        this.ingestDeadlineMs,
        `Gumlet ingest for video ${videoId} did not settle within ` +
          `${Math.round(this.ingestDeadlineMs / 60_000)} minutes (job ${job.id})`,
        () => ingest.abort(),
      );
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

      // A HUNG INGEST IS NOT A VERDICT ON THE VIDEO EITHER.
      //
      // The asset may well be fine (both hung videos of 2026-11-10/11 were
      // ready and verified soon after). So the row is not stamped FAILED: it
      // stays as the ingest left it, the ingest has been aborted so it can no
      // longer write, and the slot is released. No automatic retry: the hang
      // may have sat between Gumlet creating the asset and the row recording
      // it, and a retry from there would create a second billable asset. The
      // recovery sweep re-syncs a PROCESSING row that records its asset.
      if (error instanceof GumletIngestStalledError) {
        this.logger.error(
          `${message}; ingest aborted and the queue slot released without an automatic retry. ` +
            'The row and its recorded Gumlet asset are left unchanged; the recovery sweep resumes a recorded asset.',
        );
        throw new UnrecoverableError(message);
      }

      // GUMLET MAY OR MAY NOT HAVE CREATED THE ASSET.
      //
      // The create request was sent but its answer never arrived. Retrying
      // could create a duplicate billable asset, so the job is not retried.
      // The row records no asset, so nothing can resume it automatically; it
      // is marked FAILED with a reason that names the Gumlet tag to check
      // before a staff retry (otherwise the sweep would fail it hours later
      // with a generic "retry" reason that invites the duplicate).
      if (error instanceof GumletCreationOutcomeUnknownError) {
        this.logger.error(`transcode for ${videoId} stopped without retry: ${message}`);
        await this.videos.markFailed(videoId, message).catch((markError: unknown) =>
          this.logger.error(
            `video ${videoId}: could not record the unknown creation outcome (` +
              (isTransientDatabaseError(markError)
                ? describeDatabaseError(markError)
                : (markError as Error)?.message ?? String(markError)) +
              ')',
          ),
        );
        throw new UnrecoverableError(message);
      }

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
