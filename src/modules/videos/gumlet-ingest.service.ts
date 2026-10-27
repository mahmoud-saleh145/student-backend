import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoStatus, type UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import {
  describeDatabaseError,
  isTransientDatabaseError,
  withDatabaseRetry,
} from '../../database/transient-db-error';
import { StorageService } from '../storage/storage.service';
import { GumletDrmService } from '../playback/gumlet-drm.service';
import {
  DrmVerificationService,
  isTransientProviderError,
} from '../playback/drm-verification.service';
import { AuditService } from '../audit/audit.service';
import { LessonVideoService } from './lesson-video.service';
import { resolveGumletIngestUrlTtlSeconds } from './gumlet-ingest-url-ttl';
import { classifyGumletFailure, sanitizeProviderText } from './gumlet-failure';

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

/**
 * How many consecutive transient provider failures one job tolerates before it
 * stops polling and hands the video back to the recovery sweep.
 *
 * WHY THIS EXISTS
 *
 * `sync()` asks Gumlet for the asset, and `GumletDrmService.timedFetch` wraps
 * that call in `AbortSignal.timeout(GUMLET_HTTP_TIMEOUT_MS ?? 5000)`. When the
 * timeout fires, `sync()` THROWS rather than returning a state. The polling loop
 * below used to let that throw escape, so a single 5-second blip aborted the
 * entire 20-minute budget and failed the job - the exact opposite of what a
 * bounded, tolerant poll is for. Two jobs in production failed that way while
 * their assets were already `ready`.
 *
 * Bounded on purpose: an unbounded "retry forever" would hold a worker forever,
 * which is what the 20-minute budget exists to prevent. Five consecutive
 * failures at a 5-second interval is ~25 s of sustained inability to reach the
 * provider, which is well past a blip and firmly a real outage. That is handed
 * back for the recovery sweep instead of being retried here.
 */
const GUMLET_MAX_CONSECUTIVE_TRANSIENT = 5;

/**
 * How many consecutive DATABASE failures one poll loop tolerates, and how long
 * it waits between them.
 *
 * Kept apart from the Gumlet streak above on purpose. `sync()` reads and writes
 * the video row, so when the database is unreachable it throws a Prisma
 * connectivity error - which `isTransientProviderError` (true for anything that
 * is not a `GumletRequestError`) used to count as a "Gumlet timeout". Five of
 * those, 5 s apart, ended the poll with a misleading message and then attempted
 * one more database write, which failed the same way and escaped to the worker.
 *
 * A Neon resume or a home-network blip can take longer than 25 s, so database
 * failures get their own jittered exponential backoff (2 s, 4 s, 8 s, 16 s,
 * 30 s windows). If the database is still gone after that, the error is handed
 * back to the queue instead of being written down as a verdict: the asset id is
 * already recorded, so the retry resumes the same asset.
 */
const GUMLET_MAX_CONSECUTIVE_DB_FAILURES = 6;
const GUMLET_DB_BACKOFF_BASE_MS = 2000;
const GUMLET_DB_BACKOFF_MAX_MS = 30_000;

/**
 * Gumlet created an asset, but the database never learned its id.
 *
 * This is the one state in the ingest flow a retry cannot repair: the row still
 * has no `gumletAssetId`, so `adopt()` would create ANOTHER asset - a duplicate,
 * separately billed, and the first one orphaned. The worker therefore stops the
 * job without retrying (BullMQ `UnrecoverableError`) and the error names the
 * asset, so an operator can record it or delete it before reprocessing.
 */
export class GumletAdoptionNotRecordedError extends Error {
  constructor(
    readonly videoId: string,
    readonly assetId: string,
    readonly dbError: unknown,
  ) {
    super(
      `Gumlet created asset ${assetId} for video ${videoId}, but the database could not record it ` +
        `(${describeDatabaseError(dbError)}). Not retried automatically, because a retry would create a ` +
        `second asset. Record asset ${assetId} on this video, or delete it at Gumlet, before reprocessing.`,
    );
    this.name = 'GumletAdoptionNotRecordedError';
  }
}

/**
 * Claim marker written to `gumletStatus` while a failed asset is being replaced.
 *
 * It is not a Gumlet status - Gumlet never reports it. It exists because a
 * replacement must be atomic across several network round trips, and
 * `gumletStatus` is a plain string column, so it can carry a lock without a
 * migration. Every reader already treats an unrecognised value as neither
 * playable nor a terminal failure, which is exactly the right reading: the row
 * is mid-repair and no verdict exists for it yet.
 */
const GUMLET_ASSET_REPLACING = 'replacing';

/**
 * Is this provider failure worth running the SAME request again?
 *
 * Two rules, in this order:
 *
 *   1. An ACCOUNT-level failure never is. An exhausted allowance, a revoked
 *      key, a wrong workspace: the same request will be refused identically
 *      however many times it is made, and on a quota each attempt risks
 *      another dead asset. Retrying is not "persistence" here, it is waste.
 *   2. Otherwise the provider's own notion decides. A timeout, a dropped
 *      connection, a 5xx, a 429 - those clear on their own.
 *
 * The order matters: the provider's notion of transient treats "we could not
 * ask" as transient, and a quota rejection IS a definitive answer, so the
 * account-level rule has to be checked first or it would never apply.
 */
export function isRetryableProviderFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const classified = classifyGumletFailure({ message });
  if (classified.kind === 'QUOTA_EXCEEDED' || classified.kind === 'ACCOUNT_OR_CREDENTIALS') {
    return false;
  }
  return isTransientProviderError(error);
}

@Injectable()
export class GumletIngestService {
  private readonly logger = new Logger(GumletIngestService.name);
  private readonly cfg: VideoConfig['drm']['gumlet'];
  private readonly drm: VideoConfig['drm'];
  private readonly audit?: AuditService;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly gumlet: GumletDrmService,
    private readonly drmVerification: DrmVerificationService,
    config: ConfigService,
    private readonly lessonVideos: LessonVideoService,
    // Optional so the unit tests that build this service from plain doubles do
    // not have to carry a Nest module graph, and so an application that runs
    // without AuditModule still works. AuditModule is @Global, so in the real
    // app this resolves.
    @Optional() @Inject(AuditService) audit?: AuditService,
  ) {
    this.audit = audit;
    const videoCfg = config.getOrThrow<VideoConfig>('video');
    this.cfg = videoCfg.drm.gumlet;
    this.drm = videoCfg.drm;
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

    const created = await this.createGumletAsset(video);

    await this.markAdopted(videoId, created);

    return { assetId: created.assetId, status: created.status };
  }

  /**
   * Mint a fresh presigned source URL and ask Gumlet to create the asset.
   *
   * THE ORDERING IS THE SAFETY PROPERTY. Both network calls happen BEFORE any
   * database write, so an R2 signing failure or a Gumlet rejection throws while
   * the row still describes whatever asset it described before - nothing is
   * half-adopted, and no previously recorded asset id has been discarded.
   *
   * This is why `adopt()` and `replaceFailedAsset()` share it: both must be
   * able to fail without leaving an unrecoverable row.
   */
  private async createGumletAsset(video: {
    id: string;
    sourceKey: string | null;
    lesson?: { title: string } | null;
  }): Promise<{ assetId: string; status: string; playbackUrl: string | null }> {
    if (!video.sourceKey) {
      // Both callers assert this first, but the selected row is re-read data -
      // a null here would otherwise become a presign for the key "null".
      throw new BadRequestException('This video has no uploaded source to hand to Gumlet');
    }

    // A presigned URL that stays readable long enough for a QUEUED provider
    // side to actually reach the file. This is NOT `signMediaUrl`: that builds
    // a viewer-bound CDN URL (uid/sid/tid + HMAC) which the edge Worker refuses
    // for the `source/` namespace by design - cloudflare-worker.js:112-117,
    // "never serve the source upload, whatever the signature says". Handing
    // Gumlet that URL is what made asset creation succeed and then fail
    // instantly with ERR_ASSET_NOT_FOUND. A SigV4 presign bypasses the CDN and
    // stays scoped to this one private object until it expires.
    //
    // The lifetime is deliberately NOT derived from the source duration. The
    // 2026-10-15 failure proved duration does not predict it: a 47-minute source
    // took Gumlet 86.8 minutes, while a 63.5-minute source finished in 2.6. See
    // `gumlet-ingest-url-ttl.ts` for the evidence and the bounds.
    //
    // The resolver runs HERE as well as in `configuration.ts`. That is not
    // duplication for its own sake: configuration.ts resolves what the operator
    // asked for, but the only place the floor and ceiling are guaranteed to hold
    // is where the signature is actually produced. A caller that builds this
    // service with a hand-made config object (the migration CLI, a test, a
    // future script) would otherwise be able to sign a window shorter than the
    // one that already broke in production. The resolver is idempotent, so
    // resolving an already-resolved value changes nothing.
    //
    // The URL itself is never logged, never returned to a client, never stored.
    const sourceUrl = await this.storage.presignIngestionUrl({
      bucket: 'uploads',
      objectKey: video.sourceKey,
      expiresIn: resolveGumletIngestUrlTtlSeconds(this.cfg.ingestUrlTtlSeconds),
    });

    return this.gumlet.createAsset({
      sourceUrl,
      title: video.lesson?.title ?? undefined,
      enableDrm: true,
      tag: [`edu-video:${video.id}`],
    });
  }

  /**
   * Record a newly created asset on the row and move it into PROCESSING.
   *
   * Written by `update` rather than `updateMany` because `adopt()` has already
   * confirmed the row holds NO asset id - there is nothing to lose the race
   * against, and `replaceFailedAsset()` uses the stricter guarded variant below.
   */
  private async markAdopted(
    videoId: string,
    created: { assetId: string; status: string },
  ): Promise<void> {
    // THE ASSET ALREADY EXISTS AT THE PROVIDER.
    //
    // This write is the only record of it. Losing it to a database blip used to
    // mean the job failed, BullMQ retried, `adopt()` found no asset id and
    // created a second asset. So the write is retried in place (it sets fixed
    // values, so repeating it is safe), and if the database stays unreachable
    // the failure is escalated as non-retryable rather than handed to a retry
    // that would duplicate the asset.
    try {
      await withDatabaseRetry(
        () =>
          this.prisma.video.update({
            where: { id: videoId },
            data: this.buildAdoptionUpdate(created),
          }),
        {
          onRetry: (error, attempt, delayMs) =>
            this.logger.warn(
              `video ${videoId}: could not record new Gumlet asset ${created.assetId} ` +
                `(${describeDatabaseError(error)}, attempt ${attempt}); retrying in ${delayMs} ms`,
            ),
        },
      );
    } catch (error) {
      if (!isTransientDatabaseError(error)) throw error;
      this.logger.error(
        `ORPHANED_GUMLET_ASSET video ${videoId}: Gumlet created asset ${created.assetId} ` +
          `(tag edu-video:${videoId}) but the database stayed unreachable, so it was not recorded. ` +
          'The job will not be retried automatically, because a retry would create a second asset.',
      );
      throw new GumletAdoptionNotRecordedError(videoId, created.assetId, error);
    }

    this.logger.log(
      `video ${videoId} adopted by Gumlet as asset ${created.assetId} (status ${created.status})`,
    );
  }

  /**
   * The single definition of "this row now points at a brand-new Gumlet asset".
   *
   * Shared so the normal ingest path and the repair path can never disagree
   * about which fields an adoption resets.
   */
  private buildAdoptionUpdate(created: { assetId: string; status: string }): Record<string, unknown> {
    return {
      drmProvider: 'gumlet',
      // Records that WE asked for DRM. This is our intent, not proof - the
      // proof is drmVerifiedAt, which only verify() may set.
      drmRequested: true,
      // A new asset has never been checked. Clearing this is what stops a
      // previously-verified video from staying playable across a re-ingest.
      drmVerifiedAt: null,
      // ...and a definitive failure recorded against the PREVIOUS asset says
      // nothing about this one. Left set, the playback path would treat the
      // new asset as definitively failed and never verify it on demand.
      drmBlockedReason: null,
      gumletAssetId: created.assetId,
      gumletWorkspaceId: this.cfg.workspaceId,
      gumletStatus: created.status,
      gumletError: null,
      gumletUpdatedAt: new Date(),
      // The video is not playable until Gumlet reports ready.
      status: VideoStatus.PROCESSING,
      // No local transcode job is in flight for a Gumlet-backed video, so the
      // previous pipeline's job fields must not survive into this state.
      //
      // This nulling is deliberate and safe BECAUSE the recovery sweep now
      // looks at `drmProvider`/`gumletAssetId` too rather than requiring
      // `processingStartedAt` to be old - see `recoverStrandedVideos()`. A
      // Gumlet row therefore cannot be orphaned by having no local job, and it
      // still cannot be failed by a sweep that only understands ffmpeg jobs.
      processingStartedAt: null,
      processingJobId: null,
    };
  }

  /**
   * Replace a PERMANENTLY FAILED Gumlet asset with a freshly created one.
   *
   * WHY THIS EXISTS
   *
   * `adopt()` is idempotent by design: once a row carries a `gumletAssetId` it
   * re-syncs instead of creating anything. That is the right default and it is
   * what stops a re-run producing duplicate, double-billed assets.
   *
   * But it also means a video whose asset died at the provider - `errored`, or
   * `failed`, never `ready` and never going to be - can never be retried through
   * the normal path. Every subsequent sync just re-reads the same terminal
   * error. The only way forward is to discard the dead asset id and let
   * `adopt()` build a new one.
   *
   * THE GUARDS, AND WHY EACH ONE IS REQUIRED
   *
   *   1. There must be an asset id, and its mirrored status must be a TERMINAL
   *      failure. A `processing` or `ready` asset is refused: replacing one would
   *      be destroying a live asset and burning quota.
   *   2. The video must NOT be on the Gumlet path, UNLESS the caller explicitly
   *      opted into `allowGumletProviderReplacement`. That escape hatch exists
   *      for repairing a video whose asset failed while already routed to
   *      Gumlet: such a video is unplayable either way, there is no live asset
   *      to destroy, and refusing leaves no supported path back to a working
   *      state. It is opt-in per call and still requires a terminal failure.
   *   3. A stored source object must exist, because that is what the new asset
   *      is created from.
   *   4. The video must currently be playable, unless it is in the opt-in repair
   *      case above, where `FAILED` is the expected state.
   *
   * ORDERING - this is the safety property, not a style choice.
   *
   *   Every check (configuration, terminal failure, source presence) completes
   *   BEFORE the first write. An earlier version cleared `gumletAssetId` first
   *   and only then called `adopt()`, so a missing R2 credential destroyed the
   *   asset reference and then failed, leaving the row describing no asset at
   *   all. Clearing is now the last thing that happens, and only once `adopt()`
   *   is known to be reachable.
   *
   * Nothing is deleted. The failed asset is left at the provider (it is inert,
   * and the operator can delete it once the replacement is proven), and the R2
   * source object and any legacy HLS renditions are untouched - which is what
   * keeps the legacy rollback available throughout.
   */
  async replaceFailedAsset(
    videoId: string,
    options: {
      allowGumletProviderReplacement?: boolean;
      /**
       * Who asked for the repair, when a human did.
       *
       * Optional because the migration CLI has no user, and that run is a
       * deliberate operator action recorded in its own report. When an HTTP
       * caller supplies it, the audit row names that person - which is the
       * project's convention for every other write on `videos`.
       */
      actor?: { id: string; role: UserRole };
    } = {},
  ): Promise<{ assetId: string; status: string }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: {
        id: true,
        status: true,
        drmProvider: true,
        gumletAssetId: true,
        gumletStatus: true,
        gumletError: true,
        sourceKey: true,
        durationSeconds: true,
      },
    });
    if (!video) throw new NotFoundException('Video not found');

    // ---- configuration, asserted before anything is written ------------------
    // Same conditions preflight() enforces, checked again here so this method is
    // safe when called directly (dashboard, admin endpoint) and not only via the
    // CLI. This is the fix for the incident where an absent R2 credential was
    // discovered by `adopt()`, after the asset id had already been discarded.
    if (!this.storage.isConfigured) {
      throw new AppException(ErrorCode.STORAGE_UNAVAILABLE, {
        message: 'Object storage is not configured, so no replacement asset can be fetched',
      });
    }
    if (!this.gumlet.isAssetApiConfigured()) {
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        message: 'Gumlet asset API is not configured (GUMLET_API_KEY / GUMLET_WORKSPACE_ID)',
      });
    }
    if (!this.gumlet.isSigningConfigured()) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'Gumlet signing is not configured, so a replacement could never be played',
      });
    }
    if (!this.drm.enabled || this.drm.provider !== 'gumlet') {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'DRM is not enabled with the gumlet provider; refusing to replace an asset',
      });
    }

    const repairingGumletVideo =
      options.allowGumletProviderReplacement === true && video.drmProvider === 'gumlet';

    if (!video.gumletAssetId) {
      // A resumed replacement: a previous attempt already discarded the dead
      // asset id but failed before, or while, creating the replacement. There is
      // nothing left to clear, so go straight to adoption. Refusing here would
      // strand the video permanently, because no other path would ever clear it.
      const resumable =
        Boolean(video.sourceKey) &&
        (video.drmProvider !== 'gumlet'
          ? video.status === VideoStatus.READY
          : repairingGumletVideo && video.status === VideoStatus.FAILED);
      if (resumable) {
        this.logger.warn(
          `video ${videoId}: no asset id stored, so an earlier replacement did not complete; adopting now`,
        );
        return this.adopt(videoId);
      }
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video has no Gumlet asset to replace',
      });
    }
    if (video.drmProvider === 'gumlet' && !repairingGumletVideo) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message:
          'This video is currently served by its Gumlet asset. Replacing it is not a migration ' +
          'recovery and must be done deliberately.',
      });
    }
    if (video.gumletStatus !== 'errored' && video.gumletStatus !== 'failed') {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: `Refusing to replace a Gumlet asset whose status is "${video.gumletStatus ?? 'unknown'}". Only a terminal failure can be replaced.`,
      });
    }
    if (!video.sourceKey) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video has no stored source object to create a replacement asset from',
      });
    }
    if (!repairingGumletVideo && video.status !== VideoStatus.READY) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: `Refusing to replace the asset of a video whose status is "${video.status}". It is not currently playing, so this is a repair, not a migration recovery.`,
      });
    }

    /**
     * THE ACCOUNT HAS TO BE ABLE TO TAKE THE NEW ASSET.
     *
     * This is the check that makes "Retry" mean something.
     *
     * A quota rejection is permanent until an operator changes the plan, and a
     * new asset is rejected exactly like the old one. Creating one anyway
     * produces a second dead asset, a second provider-side object to clean up,
     * and - because the row now points at the newest dead asset rather than the
     * one the operator was shown - a video whose recorded reason no longer
     * matches the asset it names.
     *
     * So the allowance is ASKED for rather than assumed. Note what this does
     * NOT do: it does not treat a stale recorded error as the current truth.
     * The recorded reason is only used to decide whether the account's state is
     * worth checking; the account's live numbers decide the outcome. That is
     * what lets a video that failed on an exhausted plan recover immediately
     * after the plan is increased, instead of staying stuck on a reason that
     * stopped being true.
     */
    await this.assertAccountCanTakeAnotherAsset(video);

    // The source object must actually exist. A non-null `sourceKey` only means
    // it was recorded once; a missing object would otherwise produce a second
    // dead asset and another silent failure.
    const sourcePresent = await this.storage.exists('uploads', video.sourceKey);
    if (!sourcePresent) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message:
          'The stored R2 source object for this video is missing, so no replacement can be created',
      });
    }

    const failedAssetId = video.gumletAssetId;

    // ---- CLAIM the replacement ----------------------------------------------
    // Two callers hitting the same dead asset at once (an admin and a retry, or
    // two admin clicks) would otherwise BOTH pass every guard above, BOTH mint a
    // presigned URL and BOTH call createAsset - two live, double-billed assets
    // for one lesson. A conditional write is the only thing that makes this
    // atomic without a new column: the loser's `updateMany` matches zero rows.
    //
    // `gumletStatus` is a plain string column, so a claim marker can live in it
    // without a migration. Everything that reads the column already treats an
    // unrecognised value as "not playable / not a terminal failure".
    const claimed = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        deletedAt: null,
        gumletAssetId: failedAssetId,
        gumletStatus: video.gumletStatus,
      },
      data: { gumletStatus: GUMLET_ASSET_REPLACING, gumletUpdatedAt: new Date() },
    });

    if (claimed.count === 0) {
      // Either a concurrent caller won the race, or a newer sync() already
      // mirrored a different provider verdict. Either way a second asset must
      // not be created here.
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        message: `A replacement for Gumlet asset ${failedAssetId} is already in progress. Wait for the current attempt to finish.`,
      });
    }

    let created: { assetId: string; status: string; playbackUrl: string | null };
    try {
      // Create FIRST, write SECOND.
      //
      // The old implementation cleared `gumletAssetId` and only then called
      // `adopt()`. That order is why its own regression suite has a test about
      // a missing R2 credential destroying the asset reference: everything that
      // can fail (config, signing, source existence, Gumlet rejection) now
      // happens while the dead asset id is STILL on the row. A failure here
      // leaves the video exactly as diagnosable as it was before.
      created = await this.createGumletAsset(video);
    } catch (error) {
      // Restore the terminal marker so the row stays diagnosable AND still
      // replaceable. Without this, a failed attempt would leave `gumletStatus`
      // stuck at the claim marker forever, which every subsequent guard reads
      // as "not a terminal failure" and would refuse to repair.
      await this.prisma.video.updateMany({
        where: { id: videoId, gumletAssetId: failedAssetId },
        data: { gumletStatus: video.gumletStatus, gumletUpdatedAt: new Date() },
      });
      throw error;
    }

    // ---- COMMIT the replacement ---------------------------------------------
    // Guarded on the dead asset id AND the claim marker, so this write can only
    // land for the attempt that actually owns the row.
    const committed = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        deletedAt: null,
        gumletAssetId: failedAssetId,
        gumletStatus: GUMLET_ASSET_REPLACING,
      },
      data: {
        ...this.buildAdoptionUpdate(created),
        // The dead asset is NOT deleted from Gumlet, so the row has to be able
        // to say which asset it used to point at. That is the only record left
        // after the id is replaced, and it is what an operator needs to clean
        // up, or to understand why a video failed before.
        gumletError: `Replaced failed Gumlet asset ${failedAssetId} (was ${video.gumletStatus ?? 'unknown'}) with a freshly ingested asset. The old asset was left at the provider and can be deleted once this one is proven.`,
      },
    });

    this.logger.warn(
      `video ${videoId}: replaced failed Gumlet asset ${failedAssetId} with asset ${created.assetId}`,
    );

    await this.audit?.record({
      actorId: options.actor?.id ?? null,
      actorRole: options.actor?.role ?? null,
      action: 'UPDATE',
      entity: 'video',
      entityId: videoId,
      // Both ids travel in the audit `before`/`after` pair, so the trail keeps
      // the dead asset addressable even after the row has moved on.
      before: { gumletAssetId: failedAssetId, gumletStatus: video.gumletStatus },
      after: { gumletAssetId: created.assetId, gumletStatus: created.status },
      note: committed.count === 1
        ? 'Gumlet failed-asset replacement committed'
        : 'Gumlet failed-asset replacement created an asset but the row was already advanced',
    });

    if (committed.count === 0) {
      // A concurrent adoption already replaced the id. The new asset exists at
      // Gumlet and is now referenced only by this audit row; do not silently
      // paper over that.
      this.logger.error(
        `video ${videoId}: created replacement asset ${created.assetId} but the row no longer pointed at ${failedAssetId}; the asset is unreferenced and must be inspected manually`,
      );
    }

    return { assetId: created.assetId, status: created.status };
  }

  /**
   * Refuse to mint a replacement asset when the account cannot take one.
   *
   * The rule is deliberately narrow: the account is only interrogated when the
   * recorded failure is an ACCOUNT-level one (a spent allowance, a broken
   * credential). Every other failure - an unreachable input, a provider blip -
   * is exactly what a fresh ingest is for, and asking the account about it
   * would be noise.
   *
   * And when the allowance IS checked, the answer comes from the account's
   * live numbers, not from the recorded error. A video that failed on an
   * exhausted plan and is retried after the plan was increased passes here,
   * which is the whole point.
   *
   * If the account cannot be read, the attempt is ALLOWED. The provider is the
   * authority on whether it will accept the asset, and a provider that rejects
   * it produces an errored asset - which is recoverable, and costs nothing,
   * because an asset that never processed stored nothing. Refusing to try
   * because a status endpoint was briefly unreachable would be a worse
   * failure than trying.
   */
  private async assertAccountCanTakeAnotherAsset(video: {
    id: string;
    gumletError: string | null;
    durationSeconds: number;
  }): Promise<void> {
    const recorded = classifyGumletFailure({ message: video.gumletError });
    if (recorded.kind !== 'QUOTA_EXCEEDED' && recorded.kind !== 'ACCOUNT_OR_CREDENTIALS') {
      return;
    }

    let quota: Awaited<ReturnType<GumletDrmService['getAccountQuota']>>;
    try {
      quota = await this.gumlet.getAccountQuota();
    } catch (error) {
      this.logger.warn(
        `video ${video.id}: could not read the Gumlet account allowance (${(error as Error).message}); ` +
          'proceeding with the replacement and letting the provider decide',
      );
      return;
    }

    const { storageQuotaSeconds, storageUsageSeconds } = quota;
    if (storageQuotaSeconds === null || storageUsageSeconds === null) {
      return;
    }

    const free = storageQuotaSeconds - storageUsageSeconds;
    if (free <= 0) {
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        message:
          `The Gumlet account's storage allowance is exhausted ` +
          `(${Math.round(storageUsageSeconds / 60)} of ${Math.round(storageQuotaSeconds / 60)} minutes used). ` +
          'Increase the plan allowance before reprocessing this video - a new asset would be rejected the same way.',
      });
    }

    // The video's own length is only known once a provider has measured it, so
    // this is a best-effort check; the provider is still the authority.
    if (video.durationSeconds > 0 && video.durationSeconds > free) {
      throw new AppException(ErrorCode.VIDEO_PROCESSING_FAILED, {
        message:
          `The Gumlet account's storage allowance cannot fit this video ` +
          `(${Math.round(video.durationSeconds / 60)} minutes needed, ${Math.round(free / 60)} minutes free). ` +
          'Increase the plan allowance before reprocessing it.',
      });
    }

    this.logger.log(
      `video ${video.id}: the Gumlet account has room for another asset ` +
        `(${Math.round(storageUsageSeconds / 60)} of ${Math.round(storageQuotaSeconds / 60)} minutes used); ` +
        'proceeding with the replacement',
    );
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
      select: {
        id: true,
        lessonId: true,
        courseId: true,
        gumletAssetId: true,
        gumletWorkspaceId: true,
        gumletStatus: true,
        // Needed for the legacy-preservation guard below.
        drmProvider: true,
        status: true,
        // Needed so provider metadata only fills gaps, never overwrites a value
        // we already measured locally.
        width: true,
        height: true,
        frameRate: true,
      },
    });
    if (!video) throw new NotFoundException('Video not found');
    if (!video.gumletAssetId) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video is not backed by a Gumlet asset',
      });
    }

    /**
     * THE ASSET THIS CALL IS ABOUT.
     *
     * `adopt()` can replace a video's asset while this call is in flight, and a
     * replacement is exactly what a recovery does. Without this, the verdict
     * read from the OLD asset would be written over the NEW one - a stale
     * answer from a previous attempt overwriting the current one, which is how
     * a freshly recovered video ends up marked failed again. Every write below
     * is conditional on the row still holding this asset.
     *
     * Captured BEFORE the provider is called, because that is the moment the
     * question was asked. Reading it afterwards would answer a different
     * question - the one being asked now - and defeat the guard entirely.
     */
    const observedAssetId = video.gumletAssetId;

    const asset = await this.gumlet.getAsset(observedAssetId);
    const playable = this.gumlet.isAssetPlayable(asset.status);

    /**
     * WHAT THE PROVIDER'S ERROR MEANS.
     *
     * A quota rejection and an unreachable input read almost the same in prose
     * and need completely different remedies, so the provider's own words are
     * classified once here and the result is what the administrator is shown.
     */
    const failure = classifyGumletFailure({ code: asset.errorCode, message: asset.error });

    // THE LEGACY-PRESERVATION GUARD.
    //
    // `drmProvider` decides whether this video is actually being delivered by
    // Gumlet right now. If it is not, the video is still being served by the
    // legacy R2 + AES-128 HLS path, and writing FAILED would take a working
    // lesson offline: `issueTicket` rejects FAILED *before* it ever reaches
    // `resolvePlaybackTarget`, so there is no legacy fallback to catch it.
    //
    // A video can be in exactly this state legitimately - a migration attempt
    // recorded an asset id, the asset errored, and the video was rolled back to
    // legacy so students could keep watching. Re-syncing that asset must not
    // re-break the lesson.
    //
    // So: record the provider's verdict in `gumletError`, but only demote the
    // row to FAILED when Gumlet is genuinely the delivery path. Fail-closed
    // still holds where it matters - a video ON the Gumlet path that is not
    // verified playable is refused, never silently downgraded.
    const onGumletPath = video.drmProvider === 'gumlet';

    const update: Record<string, unknown> = {
      gumletStatus: asset.status,
      gumletUpdatedAt: new Date(),
    };

    if (asset.error) update.gumletError = asset.error;

    if (playable) {
      // Confirm CENC before allowing playback. Never trust status alone.
      //
      // DrmVerificationService owns this decision and is the only writer of
      // `drmVerifiedAt`. Delegating keeps ONE definition of "DRM works", so the
      // ingest path and the playback path can never disagree about it.
      const verdict = await this.drmVerification.verify(videoId);

      if (verdict.playable) {
        update.status = VideoStatus.READY;
        update.gumletError = null;
        // The video is playable, so whatever the previous attempt left behind
        // is no longer true of it. Leaving a stale reason on a working video
        // is how an operator ends up chasing a failure that has been fixed.
        update.processingError = null;
        update.processedAt = new Date();

        // PERSIST THE PROVIDER'S MEASURED METADATA.
        //
        // This block used to carry a comment saying durationSeconds was
        // "intentionally NOT written here ... the backend has no source and must
        // not invent a value". That premise was wrong: we are not inventing a
        // value, we are copying one the provider already measured and reported
        // in `input.duration` (float SECONDS).
        //
        // Because the legacy ffprobe path is the only other writer of
        // `durationSeconds`, and the worker returns early for Gumlet videos
        // (`if (gumlet.handled) return ...`) so `markReady()` is never reached,
        // nothing on the Gumlet path ever wrote a duration at all. Every Gumlet
        // lesson therefore kept the schema default of 0, which the dashboard
        // rendered as a confident "0:00".
        //
        // `normalizeProviderDurationSeconds` returns null for a missing/zero
        // value, so an asset the provider has not finished probing leaves any
        // previously-stored duration untouched instead of clobbering it with 0.
        const providerDuration = asset.durationSeconds;
        if (providerDuration !== null) {
          update.durationSeconds = providerDuration;
        }

        // Fill in the source geometry only where it is still unknown, so a
        // locally-measured value (legacy path) always wins over the provider's.
        if (video.width === null && asset.width !== null) update.width = asset.width;
        if (video.height === null && asset.height !== null) update.height = asset.height;
        if (video.frameRate === null && asset.frameRate !== null) update.frameRate = asset.frameRate;
      } else {
        // Fail-closed: never mark playable on an unproven asset. But say WHY.
        //
        // `playable === false` does NOT mean "the manifest is unencrypted".
        // `DrmVerificationService.verify()` runs `evaluate()` first, and
        // `evaluate()` returns DRM_DISABLED_ON_PLATFORM / SIGNING_UNAVAILABLE
        // from its very first branches. On such a process `verify()` returns at
        // drm-verification.service.ts:383 having called NEITHER `getAsset()` NOR
        // `fetchManifest()`, so the packaged media was never looked at.
        //
        // The old text asserted "the DASH manifest is not CENC-encrypted" in
        // both cases. A worker running with DRM_ENABLED=false therefore stamped
        // two healthy, fully CENC-encrypted assets (verified cbcs + default_KID +
        // Widevine PSSH) with a confident false claim, and that text is what an
        // operator reads. Only claim the manifest verdict when this process was
        // actually able to reach one.
        const checkedManifest = this.drmVerification.isPlatformUsable();

        update.gumletError = checkedManifest
          ? 'Gumlet reported the asset ready but the DASH manifest is not CENC-encrypted. ' +
            'This video was packaged without DRM and must be reprocessed before it can be played.'
          : 'Gumlet reports the asset ready, but this process is not configured for Gumlet DRM ' +
            '(DRM_ENABLED / DRM_PROVIDER / signing), so playability could not be established here. ' +
            'Nothing has been determined about how the media was packaged.';

        if (onGumletPath) {
          // NOTE: this still sets FAILED even when `checkedManifest` is false.
          //
          // That is deliberate for now, and it is a known wart rather than an
          // oversight - see the comment at the end of processFromJob(). There is
          // no VideoStatus that honestly means "the provider says ready and THIS
          // process could not judge it", and choosing one silently would change
          // what operators and the recovery sweep see. Left as-is deliberately.
          update.status = VideoStatus.FAILED;
          this.logger.error(
            checkedManifest
              ? `asset ${asset.assetId} ready but NOT encrypted - refusing to mark playable`
              : `asset ${asset.assetId} ready but DRM could not be verified on this process ` +
                '(platform not configured for Gumlet DRM) - refusing to mark playable',
          );
        } else {
          // Legacy is still serving this lesson. Leave `status` alone so it keeps
          // playing, and make the provider-side problem visible instead.
          this.logger.warn(
            checkedManifest
              ? `asset ${asset.assetId} ready but NOT encrypted; leaving legacy playback in place for video ${videoId}`
              : `asset ${asset.assetId} ready but DRM could not be verified on this process; ` +
                `leaving legacy playback in place for video ${videoId}`,
          );
        }
      }
    } else if (asset.status === 'errored' || asset.status === 'failed') {
      update.gumletError = asset.error ?? `Gumlet processing ended with status "${asset.status}"`;
      if (onGumletPath) {
        update.status = VideoStatus.FAILED;
        // The reason has to be visible where a failure is actually read.
        //
        // `processingError` is the column the dashboard's failure panel renders,
        // and until now a Gumlet failure left it null - so the operator saw
        // "Processing failed" with no reason at all, next to a provider string
        // they had to know to go and look for. The provider's own words stay in
        // `gumletError`; what lands here is the classified, actionable summary
        // that says whether a retry can help or an operator has to act.
        update.processingError = failure.adminMessage;
        this.logger.warn(
          `video ${videoId}: Gumlet asset ${asset.assetId} failed (${failure.kind}): ${sanitizeProviderText(asset.error)}`,
        );
      } else {
        // The asset failed, but this video is not being delivered by Gumlet.
        // Marking it FAILED would black out a lesson that is currently playing
        // on the legacy path, so record the reason and change nothing else.
        this.logger.warn(
          `asset ${asset.assetId} is "${asset.status}"; video ${videoId} stays on legacy playback`,
        );
      }
    }

    /**
     * THE WRITE IS CONDITIONAL ON THE ASSET.
     *
     * The same rule the DRM verifier uses (`drm-verification.service.ts`): a
     * result may only be written while the row still describes the thing the
     * result is about. A sync that lost the row to a replacement writes
     * nothing, so a stale verdict can never overwrite a newer attempt.
     */
    const written = await this.prisma.video.updateMany({
      where: { id: videoId, gumletAssetId: observedAssetId },
      data: update,
    });

    if (written.count === 0) {
      this.logger.warn(
        `video ${videoId}: the Gumlet asset was replaced while it was being read; keeping the newer state`,
      );
    }

    // Keep every ATTACHED lecture's denormalised duration in step.
    //
    // On the legacy path this is `markReady()`'s job, but a Gumlet video returns
    // from the worker before `markReady()` is ever reached, so nothing else does
    // it. Without this, `Lesson.durationSeconds` stays 0 even after the video row
    // is correct, and every consumer that reads the lesson - the dashboard
    // lecture row, `Course.totalDurationSeconds`, lesson analytics - keeps
    // reporting a zero-length lecture.
    //
    // It must fan out to EVERY attached lecture, not just `video.lessonId`: once
    // an asset is reused across courses, the other courses' lectures have no
    // other way to learn its length, and their own worker will never run again.
    if (typeof update.durationSeconds === 'number' && update.durationSeconds > 0) {
      await this.lessonVideos.propagateDurationToAttachedLessons(videoId, update.durationSeconds as number);
    }

    const final = await this.prisma.video.findUniqueOrThrow({
      where: { id: videoId },
      select: { status: true },
    });

    // `playable` means "this video is verified playable ON THE GUMLET PATH".
    // Gating on `onGumletPath` matters now that a legacy video can keep READY
    // while its Gumlet asset is errored: without it, a rolled-back video would
    // report `playable: true` on the strength of a stale asset, and a caller
    // would treat that as a finished migration.
    return {
      assetId: video.gumletAssetId,
      status: asset.status,
      playable: onGumletPath && final.status === VideoStatus.READY,
    };
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

    /**
     * CREATE THE ASSET, AND STOP IF THE PROVIDER SAYS NO PERMANENTLY.
     *
     * `adopt()` is where a new asset is created, and creating one is the step
     * that can be refused for an ACCOUNT reason: the allowance is spent, the
     * key was revoked, the workspace is wrong. Running that same request again
     * cannot change the answer - it can only spend another attempt and, on a
     * quota, produce another dead asset.
     *
     * So a permanent refusal is recorded and the job ends there. A transient
     * one is re-thrown, and the queue's bounded, jittered backoff decides when
     * to try again.
     */
    let assetId: string;
    try {
      ({ assetId } = await this.adopt(videoId));
    } catch (error) {
      // Neither of these is the provider's answer. A database blip is retried by
      // the queue; an asset that exists but could not be recorded must NOT be
      // classified (its message would otherwise be read as a provider refusal)
      // and must not be retried. Both are re-thrown untouched for the worker.
      if (isTransientDatabaseError(error) || error instanceof GumletAdoptionNotRecordedError) {
        throw error;
      }
      if (isRetryableProviderFailure(error)) throw error;

      const failure = classifyGumletFailure({
        message: error instanceof Error ? error.message : String(error),
      });
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.FAILED,
          processingError: failure.adminMessage,
          gumletError: sanitizeProviderText(
            error instanceof Error ? error.message : String(error),
          ),
          gumletUpdatedAt: new Date(),
        },
      });
      this.logger.error(
        `video ${videoId}: Gumlet refused the asset permanently (${failure.kind}); ` +
          'not retrying, because the same request cannot succeed until the account changes',
      );
      return { handled: true, status: 'failed', playable: false };
    }

    // Poll with a bounded budget. Gumlet's own processing is asynchronous and
    // can outlive a single job execution, so a timeout is recorded on the row
    // and a later `sync` call (staff or scheduler) finishes the job. This is
    // deliberately not an infinite loop: a stuck job holds a worker for a long
    // ffmpeg-scale duration.
    const deadline = Date.now() + GUMLET_JOB_POLL_BUDGET_MS;
    let last = 'unknown';
    let transientStreak = 0;
    let dbStreak = 0;

    while (Date.now() < deadline) {
      let state: { assetId: string; status: string; playable: boolean };

      try {
        state = await this.sync(videoId);
        transientStreak = 0;
        dbStreak = 0;
      } catch (error) {
        // THE DATABASE, NOT THE PROVIDER.
        //
        // Checked first, because `isTransientProviderError` below is true for
        // every non-Gumlet error and would otherwise count this as a provider
        // timeout. See GUMLET_MAX_CONSECUTIVE_DB_FAILURES.
        if (isTransientDatabaseError(error)) {
          dbStreak += 1;
          if (dbStreak >= GUMLET_MAX_CONSECUTIVE_DB_FAILURES) {
            this.logger.warn(
              `video ${videoId}: the database stayed unreachable for ${dbStreak} consecutive polls ` +
                `(${describeDatabaseError(error)}); handing the job back to the queue. Asset ${assetId} ` +
                'is recorded, so the retry resumes it rather than creating another.',
            );
            throw error;
          }
          const window = Math.min(
            GUMLET_DB_BACKOFF_BASE_MS * 2 ** (dbStreak - 1),
            GUMLET_DB_BACKOFF_MAX_MS,
          );
          const delayMs = Math.round(Math.random() * window);
          this.logger.warn(
            `video ${videoId}: database unreachable while polling Gumlet (${describeDatabaseError(error)}); ` +
              `retry ${dbStreak}/${GUMLET_MAX_CONSECUTIVE_DB_FAILURES - 1} in ${delayMs} ms`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        // The provider answered (or failed to), so the database did not.
        dbStreak = 0;

        // A provider blip is not a verdict on the asset.
        //
        // `timedFetch` raises a transient `GumletRequestError` when its
        // `AbortSignal.timeout` fires, and `sync()` lets that propagate. Without
        // this guard a single 5-second timeout escaped the loop and failed the
        // job outright, discarding the whole 20-minute budget over one blip.
        //
        // `isTransientProviderError` is the same predicate `verify()` uses: a
        // definitive answer from Gumlet (HTTP 4xx, unreadable body) is NOT
        // transient and still fails the job immediately, so this cannot mask a
        // genuinely dead asset.
        if (!isTransientProviderError(error)) throw error;

        transientStreak += 1;
        if (transientStreak >= GUMLET_MAX_CONSECUTIVE_TRANSIENT) {
          this.logger.warn(
            `video ${videoId}: giving up after ${transientStreak} consecutive Gumlet timeouts ` +
              `(${GUMLET_MAX_CONSECUTIVE_TRANSIENT} max); the recovery sweep will re-check it`,
          );
          break;
        }
        await new Promise((r) => setTimeout(r, GUMLET_POLL_INTERVAL_MS));
        continue;
      }

      last = state.status;
      if (state.playable) return { handled: true, status: state.status, playable: true };
      if (state.status === 'errored' || state.status === 'failed') {
        return { handled: true, status: state.status, playable: false };
      }

      // TERMINAL: the provider is DONE and this process CAN judge the media.
      //
      // `status === 'ready'` means Gumlet has finished packaging; re-polling
      // cannot change that. And `isPlatformUsable()` means `playable === false`
      // here is an actual verdict from the real CENC manifest check rather than
      // this process's own inability to look. Without that guard a DRM-disabled
      // process would exit early on a verdict it never made.
      //
      // Previously neither exit condition matched, so this combination spun for
      // the entire remaining budget - one `sync()` (and therefore one database
      // write plus one ERROR log) every ~6 seconds, for up to 20 minutes, per
      // video. Fail-closed is unchanged: the row was already left non-playable
      // by sync(); this only stops wasting the worker.
      if (state.status === 'ready' && this.drmVerification.isPlatformUsable()) {
        this.logger.warn(
          `video ${videoId}: Gumlet asset ${state.assetId} is ready but not playable; ` +
            'ending the poll budget early (a verified verdict, not a pending one)',
        );
        return { handled: true, status: state.status, playable: false };
      }

      await new Promise((r) => setTimeout(r, GUMLET_POLL_INTERVAL_MS));
    }

    // Still processing when the budget ran out: leave it PROCESSING so the
    // recovery sweep re-checks it. Never mark playable.
    // Retried in place: it sets fixed values, and losing it to a blip would
    // send an otherwise-healthy poll back through the queue for nothing.
    await withDatabaseRetry(() =>
      this.prisma.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.PROCESSING,
          gumletStatus: last,        gumletError: `Gumlet processing did not finish within the job budget (asset ${assetId}). It will be re-checked automatically.`,        gumletUpdatedAt: new Date(),
        },
      }),
    );

    // KNOWN AMBIGUITY, DELIBERATELY NOT RESOLVED HERE
    //
    // In sync(), a `ready` asset whose DRM could not be verified on this process
    // is still set to VideoStatus.FAILED. That is arguably wrong - the failure
    // is this process's misconfiguration, not the asset's - but there is no
    // honest status to put there instead, and choosing one silently would change
    // operational semantics:
    //
    //   * VideoStatus has no UNKNOWN / INCONCLUSIVE member
    //     (UPLOADING, QUEUED, PROCESSING, READY, FAILED, ARCHIVED).
    //   * Leaving it PROCESSING is also a lie, because no work is ongoing, and
    //     `recoverStrandedVideos()` (videos.service.ts) only reclaims PROCESSING
    //     rows after a 3-hour cutoff, then marks them FAILED with
    //     "Processing was interrupted (job completed); retry to process the
    //     stored file again" - which is a second misleading message and would
    //     invite an unnecessary re-ingest that creates a brand-new billed asset.
    //   * The DRM sweep selects `status: 'READY'` only, so a stranded PROCESSING
    //     row is never picked up again automatically.
    //
    // Both available answers mislead in a different direction, so the existing
    // fail-closed behaviour is preserved rather than changed unilaterally. The
    // correct fix is a product decision (a new status, or making the recovery
    // sweep responsible for re-verifying unjudged rows), not a drive-by edit.
    return { handled: true, status: last, playable: false };
  }

  /**
   * Staff-facing view of a Gumlet video's provisioning state.
   *
   * `drmState` is derived from the SAME verifier the playback path uses, so the
   * dashboard can never show "ready" for a video a student would be refused.
   * It is a derived label, never a stored flag an admin can set.
   */
  async status(videoId: string): Promise<{
    assetId: string | null;
    gumletStatus: string | null;
    videoStatus: VideoStatus;
    error: string | null;
    playable: boolean;
    drmVerified: boolean;
    drmState:
      | 'READY_DRM_VERIFIED'
      | 'PENDING_SUBMISSION'
      | 'PROCESSING'
      | 'FAILED'
      | 'DRM_NOT_VERIFIABLE';
    drmDetail: string | null;
  }> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: {
        id: true,
        status: true,
        drmProvider: true,
        drmRequested: true,
        drmVerifiedAt: true,
        drmBlockedReason: true,
        gumletAssetId: true,
        gumletWorkspaceId: true,
        gumletStatus: true,
        gumletError: true,
      },
    });
    if (!video) throw new NotFoundException('Video not found');

    const verdict = this.drmVerification.evaluate(video);
    const drmVerified = verdict.playable;

    const drmState = ((): 'READY_DRM_VERIFIED' | 'PENDING_SUBMISSION' | 'PROCESSING' | 'FAILED' | 'DRM_NOT_VERIFIABLE' => {
      if (drmVerified) return 'READY_DRM_VERIFIED';
      if (!video.gumletAssetId) return 'PENDING_SUBMISSION';
      if (video.gumletStatus === 'errored' || video.gumletStatus === 'failed') return 'FAILED';
      if (video.gumletStatus) return 'PROCESSING';
      return 'DRM_NOT_VERIFIABLE';
    })();

    return {
      assetId: video.gumletAssetId,
      gumletStatus: video.gumletStatus,
      videoStatus: video.status,
      error: video.gumletError,
      // Only ever true when the DRM verifier agrees - never merely because the
      // row happens to say READY.
      playable: drmVerified,
      drmVerified,
      drmState,
      drmDetail: verdict.playable ? null : verdict.detail,
    };
  }
}
