import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoStatus } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { StorageService } from '../storage/storage.service';
import { GumletDrmService } from '../playback/gumlet-drm.service';

/**
 * Gumlet-backed video lifecycle.
 *
 * WHY THIS IS SEPARATE FROM THE R2 PIPELINE
 *
 * The legacy pipeline transcodes locally with ffmpeg and writes AES-128 HLS to
 * R2, with manifests generated on demand by this API. Gumlet does its own
 * ingest, packaging and DRM encryption and serves the result from its own CDN
 * as CENC-encrypted DASH. Those are genuinely different pipelines, so a video
 * picks exactly one: `Video.drmProvider` is 'gumlet' or null. There is no shared
 * code path between them, and nothing here can put a legacy video onto the
 * Gumlet path or vice versa.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 *   * It never deletes or touches R2 objects. A Gumlet video keeps its source
 *     object so a rollback to the legacy pipeline stays possible.
 *   * It never marks a video PLAYABLE before Gumlet reports `ready` AND the
 *     manifest is confirmed CENC-encrypted. Both checks must pass.
 *   * It never silently retries forever: a failure is recorded with its reason
 *     so staff can act on it.
 */
/**
 * How long one transcode job will keep polling Gumlet before handing the video
 * back to the recovery sweep. Gumlet processing for a short clip is well under
 * this; a 40-minute source is the worst case.
 */
const GUMLET_JOB_POLL_BUDGET_MS = 20 * 60 * 1000;
const GUMLET_POLL_INTERVAL_MS = 5000;

@Injectable()
export class GumletIngestService {
  private readonly logger = new Logger(GumletIngestService.name);
  private readonly cfg: VideoConfig['drm']['gumlet'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly gumlet: GumletDrmService,
    config: ConfigService,
  ) {
    const videoCfg = config.getOrThrow<VideoConfig>('video');
    this.cfg = videoCfg.drm.gumlet;
  }

  /**
   * Adopt a video for Gumlet delivery.
   *
   * Called from the upload flow once the source object exists in R2. The source
   * is handed to Gumlet as a short-lived presigned URL, so this API never
   * proxies video bytes.
   *
   * Idempotent: if the row already carries a Gumlet asset, the existing asset is
   * refreshed rather than a second one created, so a double-submitted job cannot
   * create duplicate (and duplicate-billed) assets.
   */
  async adopt(videoId: string): Promise<{ assetId: string; status: string }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: {
        id: true,
        sourceKey: true,
        sourceMimeType: true,
        sourceSizeBytes: true,
        gumletAssetId: true,
        drmProvider: true,
        lesson: { select: { title: true } },
      },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (!video.sourceKey) {
      throw new BadRequestException('This video has no uploaded source to hand to Gumlet');
    }

    // Already adopted: re-sync rather than create a duplicate asset.
    if (video.gumletAssetId) {
      const state = await this.sync(videoId);
      return { assetId: state.assetId, status: state.status };
    }

    if (!this.gumlet.isAssetApiConfigured()) {
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        message: 'Gumlet asset API is not configured (GUMLET_API_KEY / GUMLET_WORKSPACE_ID)',
      });
    }

    // A short-lived, viewer-unbound URL Gumlet can fetch exactly once.
    const sourceUrl = await this.storage.signMediaUrl({
      objectKey: video.sourceKey,
      expiresInSeconds: 3600,
      userId: 'system',
      sessionId: 'system',
      deviceId: null,
      ticketId: null,
      maxHeight: null,
    });

    const created = await this.gumlet.createAsset({
      sourceUrl,
      title: video.lesson?.title ?? undefined,
      enableDrm: true,
      tag: [`edu-video:${video.id}`],
    });

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        drmProvider: 'gumlet',
        gumletAssetId: created.assetId,
        gumletWorkspaceId: this.cfg.workspaceId,
        gumletStatus: created.status,
        gumletError: null,
        gumletUpdatedAt: new Date(),
        // The video is not playable until Gumlet reports ready.
        status: VideoStatus.PROCESSING,
      },
    });

    this.logger.log(
      `video ${videoId} adopted by Gumlet as asset ${created.assetId} (status ${created.status})`,
    );

    return { assetId: created.assetId, status: created.status };
  }

  /**
   * Poll Gumlet and mirror the result onto the video row.
   *
   * Sets READY only when BOTH conditions hold:
   *   1. Gumlet reports the asset as ready.
   *   2. The DASH manifest is actually CENC-encrypted (a `default_KID` exists).
   *
   * The second check catches the case where DRM was not applied at processing
   * time - Gumlet would report `ready` while the content is unprotected, and
   * playing that through the DRM player would be a silent downgrade.
   */
  async sync(videoId: string): Promise<{ assetId: string; status: string; playable: boolean }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: { id: true, gumletAssetId: true, gumletWorkspaceId: true, gumletStatus: true },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (!video.gumletAssetId) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video is not backed by a Gumlet asset',
      });
    }

    const asset = await this.gumlet.getAsset(video.gumletAssetId);
    const playable = this.gumlet.isAssetPlayable(asset.status);

    const update: Record<string, unknown> = {
      gumletStatus: asset.status,
      gumletUpdatedAt: new Date(),
    };

    if (asset.error) update.gumletError = asset.error;

    if (playable) {
      // Confirm CENC before allowing playback. Never trust status alone.
      const manifestUrl =
        asset.dashPlaybackUrl ??
        this.gumlet.dashManifestUrl({ assetId: asset.assetId, workspaceId: video.gumletWorkspaceId });
      let drmConfirmed = false;
      try {
        const manifest = await fetch(manifestUrl);
        drmConfirmed = manifest.ok && this.gumlet.assetHasDrm(await manifest.text());
      } catch (e) {
        this.logger.warn(`manifest check failed for asset ${asset.assetId}: ${(e as Error).message}`);
      }

      if (drmConfirmed) {
        update.status = VideoStatus.READY;
        update.gumletError = null;
        update.processedAt = new Date();
        // `durationSeconds` is intentionally NOT written here. For a legacy
        // transcode the worker measures it locally with ffprobe; for a Gumlet
        // asset the backend has no source and must not invent a value. Prisma
        // treats `undefined` as "leave unchanged", so previously it was a
        // silent no-op that read as if it cleared the field.
      } else {
        // Fail-closed: Gumlet says ready but the media is not encrypted.
        update.status = VideoStatus.FAILED;
        update.gumletError =
          'Gumlet reported the asset ready but the DASH manifest is not CENC-encrypted. ' +
          'This video was packaged without DRM and must be reprocessed before it can be played.';
        this.logger.error(`asset ${asset.assetId} ready but NOT encrypted - refusing to mark playable`);
      }
    } else if (asset.status === 'errored' || asset.status === 'failed') {
      update.status = VideoStatus.FAILED;
      update.gumletError = asset.error ?? `Gumlet processing ended with status "${asset.status}"`;
    }

    await this.prisma.video.update({ where: { id: videoId }, data: update });

    const final = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: { status: true },
    });

    return { assetId: video.gumletAssetId, status: asset.status, playable: final.status === VideoStatus.READY };
  }

  /**
   * Called by the transcode worker.
   *
   * Returns `{ handled: false }` for every non-Gumlet video so the caller falls
   * through to the existing ffmpeg path untouched. Only a video explicitly
   * assigned `drmProvider = 'gumlet'` takes this branch, and the row is read
   * from the database rather than trusted from the job payload, so a stale or
   * forged job cannot reroute a legacy video.
   */
  async processFromJob(
    videoId: string,
    sourceKey: string,
  ): Promise<{ handled: boolean; status?: string; playable?: boolean }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: { id: true, drmProvider: true, sourceKey: true, status: true },
    });

    if (!video || video.drmProvider !== 'gumlet') {
      return { handled: false };
    }

    // A Gumlet video whose source changed under us is stale; refuse rather than
    // ship the wrong media to a paying student.
    if (video.sourceKey !== sourceKey) {
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.FAILED,
          gumletError: `Source object changed under this job (expected ${sourceKey}, found ${video.sourceKey ?? 'none'}).`,
          gumletUpdatedAt: new Date(),
        },
      });
      return { handled: true, status: 'failed', playable: false };
    }

    const { assetId } = await this.adopt(videoId);

    // Poll with a bounded budget. Gumlet's own processing is asynchronous and
    // can outlive a single job execution, so a timeout is recorded on the row
    // and a later `sync` call (staff or scheduler) finishes the job. This is
    // deliberately not an infinite loop: a stuck job holds a worker for a long
    // ffmpeg-scale duration.
    const deadline = Date.now() + GUMLET_JOB_POLL_BUDGET_MS;
    let last = 'unknown';

    while (Date.now() < deadline) {
      const state = await this.sync(videoId);
      last = state.status;
      if (state.playable) return { handled: true, status: state.status, playable: true };
      if (state.status === 'errored' || state.status === 'failed') {
        return { handled: true, status: state.status, playable: false };
      }
      await new Promise((r) => setTimeout(r, GUMLET_POLL_INTERVAL_MS));
    }

    // Still processing when the budget ran out: leave it PROCESSING so the
    // recovery sweep re-checks it. Never mark playable.
    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        status: VideoStatus.PROCESSING,
        gumletStatus: last,        gumletError: `Gumlet processing did not finish within the job budget (asset ${assetId}). It will be re-checked automatically.`,        gumletUpdatedAt: new Date(),
      },
    });

    return { handled: true, status: last, playable: false };
  }

  /** Staff-facing view of a Gumlet video's provisioning state. */  async status(videoId: string): Promise<{
    assetId: string | null;
    gumletStatus: string | null;
    videoStatus: VideoStatus;
    error: string | null;
    playable: boolean;
  }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: {
        id: true,
        status: true,
        drmProvider: true,
        gumletAssetId: true,
        gumletStatus: true,
        gumletError: true,
      },
    });
    if (!video) throw new NotFoundException('Video not found');

    return {
      assetId: video.gumletAssetId,
      gumletStatus: video.gumletStatus,
      videoStatus: video.status,
      error: video.gumletError,
      playable: video.status === VideoStatus.READY,
    };
  }
}
