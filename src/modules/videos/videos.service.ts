import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  MobileVideoStatus,
  NotificationKind,
  type Prisma,
  type UserRole,
  VideoStatus,
} from '@prisma/client';
import { Queue } from 'bullmq';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import {
  DEFAULT_JOB_OPTIONS,
  MOBILE_JOB_ATTEMPTS,
  MOBILE_JOB_PRIORITY,
  MOBILE_VIDEO_JOBS,
  QUEUE_NAMES,
  VIDEO_JOBS,
  type MobileTranscodeJobData,
  type TranscodeJobData,
} from '../../jobs/queue.constants';
import {
  readMobileWorkerHeartbeat,
  readWorkerHeartbeat,
  type WorkerHeartbeatPayload,
} from '../../jobs/worker-heartbeat';
import {
  pauseHolds,
  readPauseState,
  writePauseState,
  type PauseScope,
  type PauseState,
} from '../../jobs/processors/scratch-guard';
import {
  MOBILE_DELIVERY_OVERRIDE_KEY,
  type MobileDeliveryOverride,
} from '../playback/mobile-delivery-override';
import { TRANSCODE_BACKOFF_BASE_MS, TRANSCODE_BACKOFF_JITTER } from '../../jobs/queue.tuning';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { assertObjectKeyInNamespace, StorageService } from '../storage/storage.service';
import { isTerminalGumletFailure, sanitizeProviderText } from './gumlet-failure';
import { GumletIngestService } from './gumlet-ingest.service';
import { LessonVideoService } from './lesson-video.service';
import {
  gumletStateOf,
  isLiveJobState,
  mobileJobIdFor,
  sourceStateOf,
  uploadTranscodeJobIdFor,
} from './pipeline-state';

/**
 * How long one queue operation may take before it is treated as "Redis is not
 * answering".
 *
 * BullMQ's connection is configured (as BullMQ requires) to retry a command
 * forever, so while Redis is unreachable `queue.add()` does not fail - it
 * simply never returns. Unbounded, that turned a Redis outage into an upload
 * request that hung until the browser gave up, for a file that was already
 * safely stored. Bounded, the request records its intent in the database and
 * answers; the reconciler enqueues when Redis is back.
 *
 * A command that timed out here may still be delivered when the connection
 * returns. Every job this file adds with a bound has a deterministic id, so a
 * late delivery is the same job, not a second one.
 */
export const QUEUE_OPERATION_TIMEOUT_MS = 5_000;

/** A queue operation exceeded QUEUE_OPERATION_TIMEOUT_MS. */
export class QueueTimeoutError extends Error {
  override readonly name = 'QueueTimeoutError';
}

export function withinQueueTimeout<T>(work: Promise<T>, what: string, ms = QUEUE_OPERATION_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QueueTimeoutError(`${what} did not answer within ${ms} ms`)), ms);
  });
  // The abandoned operation may reject later; that must not become an
  // unhandled rejection.
  work.catch(() => undefined);
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * How long a freshly recorded intent is left to the request that recorded it
 * before the reconciler considers it stranded.
 */
export const INTENT_RECONCILE_GRACE_MS = 45_000;

/**
 * A mobile row is PROCESSING but its job is no longer in the queue. After this
 * long the sweep treats it as orphaned. Only rows whose job is NOT live are
 * touched, so a long encode that is genuinely running is never interrupted.
 */
export const MOBILE_ORPHAN_AFTER_MS = 20 * 60_000;

/** Web/Gumlet states from which a video may be processed for mobile: all but UPLOADING. */
const MOBILE_MIGRATABLE_STATUSES: VideoStatus[] = [
  VideoStatus.READY,
  VideoStatus.ARCHIVED,
  VideoStatus.FAILED,
  VideoStatus.QUEUED,
  VideoStatus.PROCESSING,
];

/** Shown on the row while its intent is waiting for Redis. No infrastructure detail. */
export const WAITING_FOR_QUEUE_NOTE =
  'Waiting for the processing queue. It will be queued automatically - no action is needed.';

export type QueueJobPresence = 'live' | 'finished' | 'missing' | 'unknown';

export interface MobileEnqueueResult {
  jobId: string | null;
  /** True when an existing intent already covered this request. */
  alreadyQueued: boolean;
  /** False when the intent is recorded but Redis has not accepted the job yet. */
  enqueued: boolean;
}

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
]);

/**
 * Largest source a lecture upload can actually store.
 *
 * The dashboard uploads the file to Cloudflare R2 in ONE presigned PUT, and R2
 * caps a single PUT at 5 GiB minus 5 MiB (4.995 GiB, 5,363,466,240 bytes) -
 * anything larger needs the multipart API, which this flow does not use. The
 * limit used to be advertised as 8 GB, so a 5-8 GB file was accepted here, sent
 * in full over the uploader's connection, and then refused by R2: an upload
 * that could never succeed, discovered only after the whole transfer.
 */
export const MAX_SOURCE_BYTES = 5 * 1024 * 1024 * 1024 - 5 * 1024 * 1024;

/** Outcome of one pass of `migrateLibraryToMobile`. Video ids only. */
export interface MobileMigrationReport {
  dryRun: boolean;
  scanned: number;
  queued: string[];
  wouldQueue: string[];
  /** Source object gone from R2: needs a re-upload, reported and left untouched. */
  missingSource: string[];
  noSourceKey: string[];
  queueErrors: { videoId: string; error: string }[];
  /** Live videos still not mobile-READY after this pass. */
  remaining: number;
}

/**
 * Video lifecycle.
 *
 * The upload path is deliberately three steps rather than one multipart POST:
 *
 *   1. `initUpload`     — creates the Video row, returns a presigned PUT
 *   2. client → R2      — bytes never touch this API
 *   3. `completeUpload` — verifies the object landed, enqueues transcoding
 *
 * A 2 GB lecture streamed through Node would pin a worker for minutes and cap
 * concurrent uploads at one per process. Going direct to storage also means an
 * interrupted upload costs the client a retry, not the server a half-written
 * temp file.
 *
 * The source object is never exposed to students. Only the HLS output under
 * `hls/<videoId>/` is ever signed for playback, and only through a ticket.
 */
@Injectable()
export class VideosService {
  private readonly logger = new Logger(VideosService.name);
  private readonly cfg: VideoConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly access: CourseAccessService,
    private readonly courses: CoursesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    @InjectQueue(QUEUE_NAMES.video) private readonly queue: Queue<TranscodeJobData>,
    config: ConfigService,
    private readonly lessonVideos: LessonVideoService,
    // Only the recovery sweep uses this, and only for rows already routed to
    // Gumlet. `GumletIngestService`'s own graph never reaches back into
    // `VideosService`, so this introduces no cycle.
    private readonly gumletIngest: GumletIngestService,
    /**
     * The independent mobile pipeline's queue. Last so the many existing
     * tests that build this service positionally keep compiling; every use
     * is guarded, and a missing queue only means "mobile processing is off".
     */
    @InjectQueue(QUEUE_NAMES.mobileVideo)
    private readonly mobileQueue?: Queue<MobileTranscodeJobData>,
  ) {
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

  /**
   * Delivery provider that any upload carrying NEW content must use.
   *
   * Uploads are routed to Gumlet automatically whenever the platform is
   * configured for Gumlet DRM, so staff never opt a video in by hand and no
   * upload can land on the legacy AES-128 path by omission.
   *
   * This matters more than it looks: `processFromJob` reads `drmProvider` from
   * the database to choose the pipeline, so setting it here is both what turns
   * the Gumlet branch on AND what guarantees the legacy ffmpeg path can never
   * rescue a video whose Gumlet ingest or DRM packaging failed. The video stays
   * unavailable instead.
   *
   * Applies to both a first upload and a REPLACEMENT. Replacing the file of a
   * legacy lesson is a new recording, so it must not inherit the old row's
   * legacy provider and slip new content onto the unprotected pipeline.
   *
   * FAILS CLOSED. If the platform declares Gumlet DRM but the credentials are
   * incomplete, the upload is refused rather than quietly created (or replaced)
   * as unprotected legacy HLS.
   *
   * Videos nobody touches keep whatever they already have, so the legacy
   * library is never migrated as a side effect of uploading elsewhere.
   */
  private resolveNewVideoProvider(): string | null {
    const drm = this.cfg.drm;
    const gumletConfigured = Boolean(
      drm.gumlet.apiKey && drm.gumlet.workspaceId && drm.gumlet.orgId && drm.gumlet.signSecret,
    );

    if (!drm.enabled || drm.provider !== 'gumlet') {
      // The platform is explicitly not using Gumlet DRM. Legacy delivery stands.
      return null;
    }
    if (!gumletConfigured) {
      // On a DRM-only platform this is not a soft failure. Playback now refuses
      // ANY video that is not verifiably DRM-protected, so accepting an upload
      // that cannot be delivered with DRM would create a lesson that is broken
      // the moment it is uploaded - worse than refusing it now, while the admin
      // is still on the upload screen.
      throw new AppException(ErrorCode.UPLOAD_FAILED, {
        message:
          'Gumlet DRM is enabled but not fully configured, so a new video cannot be delivered with DRM. Refusing to create an unprotected video.',
      });
    }
    return 'gumlet';
  }

  async initUpload(
    params: {
      lessonId: string;
      filename: string;
      contentType: string;
      sizeBytes: number;
    },
    actor: { id: string; role: UserRole },
  ) {
    if (!ALLOWED_VIDEO_TYPES.has(params.contentType)) {
      throw AppException.validation({
        contentType: [`unsupported video type '${params.contentType}'`],
      });
    }
    if (params.sizeBytes > MAX_SOURCE_BYTES) {
      throw AppException.validation({
        sizeBytes: [`exceeds the ${MAX_SOURCE_BYTES} byte (4.99 GB) single-upload limit`],
      });
    }

    const lesson = await this.prisma.lesson.findFirst({
      where: { id: params.lessonId, ...notDeleted },
      select: {
        id: true,
        courseId: true,
        video: {
          select: {
            id: true,
            status: true,
            deletedAt: true,
            hlsPrefix: true,
            drmProvider: true,
            gumletAssetId: true,
          },
        },
        // Every video attached to this lecture, owned or reused.
        videoLinks: { select: { videoId: true, video: { select: { deletedAt: true } } } },
      },
    });
    if (!lesson) throw AppException.notFound('Lesson', params.lessonId);

    await this.access.assertCanManageCourse(actor.id, actor.role, lesson.courseId, 'content');

    // A lecture that plays a REUSED asset is not the place to upload: a new
    // owned video would give it two attachments and lesson detail and the
    // ticket resolver would disagree about which file it plays.
    const reusedHere = lesson.videoLinks.find(
      (link) => link.videoId !== lesson.video?.id && !link.video.deletedAt,
    );
    if (reusedHere) {
      throw new AppException(ErrorCode.CONFLICT, {
        message: 'This lecture plays a shared video. Remove it from this lecture before uploading a new one.',
        details: { lessonId: lesson.id, attachedVideoId: reusedHere.videoId },
      });
    }

    // Replacing the file REWRITES the shared row and clears its Gumlet asset,
    // so every other lecture that reuses it would silently start playing the
    // new recording (and stop playing until it is re-ingested). Refuse instead.
    if (lesson.video && !lesson.video.deletedAt) {
      const sharedWith = await this.prisma.lessonVideo.count({
        where: { videoId: lesson.video.id, lessonId: { not: lesson.id }, lesson: { ...notDeleted } },
      });
      if (sharedWith > 0) {
        throw new AppException(ErrorCode.CONFLICT, {
          message: `This video is also used by ${sharedWith} other lecture(s). Replacing it here would change them too.`,
          details: { videoId: lesson.video.id, otherLectures: sharedWith },
        });
      }
    }

    // Uploading over a LIVE video replaces the source a student streams. That
    // is the operation the "edit video URLs" switch governs; a first upload
    // onto an empty lesson — or onto one whose video was deleted — is
    // ordinary content authoring and is not gated by it.
    //
    // "Live" means READY: that is the only state a student can stream. A row
    // left at UPLOADING / FAILED (an interrupted or refused first upload) or
    // still QUEUED / PROCESSING has never been watched, so retrying it is still
    // the first upload. Gating those too meant a teacher whose first attempt
    // failed could never retry without the "edit video URLs" switch (off by
    // default) - the lecture stayed empty until an admin stepped in.
    const liveVideo =
      lesson.video && !lesson.video.deletedAt && lesson.video.status === VideoStatus.READY
        ? lesson.video
        : null;
    if (liveVideo) {
      await this.access.assertTeacherCapability(actor.role, 'editVideoUrls');
    }

    // A lecture holds one video row (lessonId is unique). Replacing — or
    // uploading after a delete — reuses it, so the lesson↔video relation and
    // every watch event that references it survive. `deletedAt` is cleared:
    // before this, a re-upload after a delete kept the tombstone, and
    // `complete` then answered "Video not found" for the video it had just
    // created.
    // Resolved BEFORE any write, so a misconfigured Gumlet deployment fails the
    // upload closed and leaves the existing row untouched, instead of replacing
    // a working lesson with an unprotected one.
    const requestedProvider = this.resolveNewVideoProvider();

    // The video row and its owner attachment are written in ONE transaction:
    // a video committed without its lesson_videos row is unplayable (the ticket
    // resolver fails closed on an empty attachment set).
    const video = await this.prisma.$transaction(async (tx) => {
      const written = lesson.video
        ? await tx.video.update({
            where: { id: lesson.video.id },
            data: {
              status: VideoStatus.UPLOADING,
              processingError: null,
              processingJobId: null,
              processingStartedAt: null,
              processedAt: null,
              deletedAt: null,
              uploadedById: actor.id,
              // Replacing the file of a Gumlet-backed video makes the previous
              // asset describe content that no longer exists. The provider is
              // KEPT (the lesson is still meant to be DRM-delivered) but the
              // asset identity is cleared, so the worker's adopt creates a fresh
              // asset from the new source instead of re-syncing the old one -
              // which would have marked the lesson READY while students kept
              // watching the previous recording.
              gumletAssetId: null,
              gumletStatus: null,
              gumletError: null,
              gumletUpdatedAt: null,
              // THE SOURCE IS NEW, SO NOTHING DERIVED FROM THE OLD ONE STANDS.
              //
              // `sourceSizeBytes` is the proof that the file reached storage,
              // and it described the previous file: left in place, the row
              // claimed a confirmed upload for bytes that have not been sent.
              //
              // The mobile ladder is the same problem with consequences. It
              // was encoded from the PREVIOUS recording, and a row that stayed
              // mobile-READY kept handing students that old recording over HLS
              // while the web played the new one. The mobile state is reset
              // exactly as the Gumlet asset is; `completeUpload` records a
              // fresh intent for the new file, and a job still queued for the
              // old source is recognised as stale by its source key.
              sourceSizeBytes: null,
              mobileStatus: MobileVideoStatus.NONE,
              mobileError: null,
              mobileJobId: null,
              mobileProcessingStartedAt: null,
              mobileProcessedAt: null,
              mobileRequestedAt: null,
              mobileEnqueuedAt: null,
              mobileTrigger: null,
              // A LEGACY row carrying NEW content must not keep its old provider:
              // that would send the new recording down the legacy ffmpeg/AES-128
              // pipeline on a DRM platform. A row already on Gumlet keeps it, with
              // only the stale asset identity cleared above. When the platform
              // does not require Gumlet, `requestedProvider` is null and the row
              // keeps whatever it had - the existing policy is preserved.
              ...(requestedProvider !== null && lesson.video.drmProvider !== 'gumlet'
                ? { drmProvider: requestedProvider }
                : {}),
            },
          })
        : await tx.video.create({
            data: {
              lessonId: lesson.id,
              courseId: lesson.courseId,
              status: VideoStatus.UPLOADING,
              uploadedById: actor.id,
              // Set here, not by a later staff action, so every new upload enters
              // the Gumlet workflow automatically. See resolveNewVideoProvider().
              drmProvider: requestedProvider,
            },
          });

      // THE ATTACHMENT ROW IS NOT OPTIONAL.
      //
      // `lesson_videos` is what `PlaybackService.issueTicket` resolves the
      // authorised lecture from. A video created without one has an empty
      // attachment set, the resolver cannot determine which lecture the viewer is
      // playing as, and it fails closed - so the lecture would be unplayable from
      // the moment it was uploaded.
      //
      // Every video therefore gets its owner link at creation, which is also what
      // keeps the "exactly one attachment" case unambiguous. Reuse then adds extra
      // rows; nothing ever removes this one implicitly. The upsert also HEALS a
      // row an older build created without its attachment, the next time that
      // lecture's video is replaced.
      await tx.lessonVideo.upsert({
        where: { lessonId_videoId: { lessonId: lesson.id, videoId: written.id } },
        update: {},
        create: { lessonId: lesson.id, videoId: written.id, createdById: actor.id, sortOrder: 0 },
      });

      return written;
    });

    const sourceKey = StorageService.keys.videoSource(video.id, params.filename);

    await this.prisma.video.update({
      where: { id: video.id },
      data: { sourceKey, sourceMimeType: params.contentType },
    });

    const upload = await this.storage.presignUpload({
      // Sources live in a separate bucket from delivered media, so a
      // misconfigured CDN can never serve an original file.
      bucket: 'uploads',
      objectKey: sourceKey,
      contentType: params.contentType,
      expiresIn: 6 * 3600,
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'video',
      entityId: video.id,
      after: { lessonId: lesson.id, sourceKey },
    });

    return {
      videoId: video.id,
      ...upload,
      /** Call this once the PUT finishes. */
      completeUrl: `/api/v1/videos/${video.id}/complete`,
    };
  }

  /**
   * Confirms the upload landed and queues processing.
   *
   * Verifying the object exists (and its size) closes the gap where a client
   * claims success without having uploaded anything — otherwise the queue
   * fills with jobs that fail minutes later in the worker.
   *
   * THIS ENDPOINT IS ALSO THE RECOVERY PATH, AND THAT IS DELIBERATE.
   *
   * A large direct-to-storage upload can fail in a way that leaves the file in
   * the bucket but the browser convinced that it did not. Cloudflare R2
   * documents its `InternalError` (HTTP 500) on `PutObject` as "retry the
   * request", and the failure this file was written for is exactly that: on
   * 2026-10-21 a 522 MB lecture was committed by R2 (the object is in
   * `edu-uploads`, byte-exact, `ftyp`+`mdat`+`moov`) and the browser was
   * answered with a 500. The client therefore never called `complete`, so:
   *
   *   - `sourceSizeBytes` stayed NULL, so the row did not describe reality;
   *   - no transcode job was enqueued, so nothing ever processed the file;
   *   - no Gumlet asset was created, because the ingest is driven by that job;
   *   - the row sat at `UPLOADING` forever, and the dashboard told the admin
   *     that "Gumlet is packaging this video" when Gumlet had never heard of
   *     it.
   *
   * The bytes were there the whole time. Nothing in the flow ever went back
   * and LOOKED.
   *
   * So `complete` is written to be safe to call at any time, for any reason:
   *
   *   - it is IDEMPOTENT. Calling it again on a video that is already queued
   *     or processing returns the current state instead of enqueuing a second
   *     job, so a client that retries after a dropped response cannot start
   *     the pipeline twice;
   *   - it RECOVERS. A row stranded at `UPLOADING` whose object is already in
   *     the bucket is completed here, with no re-upload - which is the
   *     difference between an administrator losing 522 MB of upload time and
   *     pressing one button;
   *   - it VERIFIES THE LENGTH. The client may declare how many bytes it
   *     sent; a stored object of a different length is a truncated upload and
   *     is refused rather than processed into a broken lecture;
   *   - it CLEANS UP. Once the current object is confirmed, the superseded
   *     objects left by earlier attempts are removed from the bucket.
   *
   * It never sets `READY`. Readiness is the worker's verdict, reached only
   * after the provider reports the asset ready AND the manifest is confirmed
   * CENC-encrypted.
   */
  async completeUpload(
    videoId: string,
    actor: { id: string; role: UserRole },
    declaredSizeBytes?: number | null,
  ) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: {
        id: true,
        courseId: true,
        sourceKey: true,
        status: true,
        lessonId: true,
        processingJobId: true,
        gumletAssetId: true,
      },
    });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    if (!video.sourceKey) {
      throw new AppException(ErrorCode.INVALID_STATE, { message: 'No upload was initialised' });
    }

    // "Not there" and "could not ask" are different answers. Only the first
    // one means the file has to be sent again.
    let size: number | null;
    try {
      size = await this.storage.objectSizeStrict('uploads', video.sourceKey);
    } catch (error) {
      this.logger.warn(
        `video ${videoId}: storage could not be asked about ${video.sourceKey}: ${(error as Error).message}`,
      );
      throw new AppException(ErrorCode.STORAGE_UNAVAILABLE, {
        message:
          'Storage could not be reached to confirm the upload. Nothing was lost - ' +
          'check again in a moment; do not upload the file again yet.',
      });
    }
    if (size === null) {
      // The bytes are not there. The message has to say what to do about it,
      // because the reader is looking at a failed upload and needs to know
      // whether re-sending the file is the fix.
      this.logger.warn(
        `video ${videoId}: complete found no stored object for key ${video.sourceKey}`,
      );
      throw new AppException(ErrorCode.UPLOAD_FAILED, {
        message:
          'The uploaded file was not found in storage, so the upload did not complete. ' +
          'Upload the file again.',
      });
    }

    if (declaredSizeBytes != null && size !== declaredSizeBytes) {
      // A stored object of a different length than the client sent is a
      // truncated upload. Processing it would produce a lecture that ends
      // mid-sentence, so it is refused and the file has to be sent again.
      this.logger.warn(
        `video ${videoId}: stored object is ${size} bytes but the client sent ${declaredSizeBytes}`,
      );
      throw new AppException(ErrorCode.UPLOAD_FAILED, {
        message:
          `The file in storage is ${size} bytes but ${declaredSizeBytes} bytes were uploaded, ` +
          'so the upload was cut short. Upload the file again.',
      });
    }

    // Record what is actually in the bucket before anything else, so the row
    // describes the stored file even if the queue write below fails.
    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        sourceSizeBytes: BigInt(size),
        processingError: null,
        processingStartedAt: null,
      },
    });

    // Already in the pipeline. A second job would process the same source
    // twice and race the first one to write the output - so the existing job
    // is reported instead. The one case that still needs work is a job that
    // is GONE: the video is stranded between "queued" and "running", and that
    // is exactly what a repeated `complete` should repair.
    if (video.status === VideoStatus.QUEUED || video.status === VideoStatus.PROCESSING) {
      const presence = await this.jobPresence(this.queue, video.processingJobId);
      // `unknown` = Redis did not answer. That is not evidence that the job is
      // gone, so nothing is re-queued on it: the intent is already durable and
      // the reconciler / sweep act once Redis can be read.
      if (presence === 'live' || presence === 'unknown') {
        this.logger.log(
          `video ${videoId}: complete called again on a video that is already ${video.status}; ` +
            'no second job was enqueued',
        );
        // An intent this video already has is made sure of; none is created.
        const mobile = await this.settleMobileIntentOnComplete(video, { accepting: false }, actor.id);
        return {
          videoId,
          status: video.status,
          jobId: video.processingJobId,
          sourceSizeBytes: size,
          alreadyQueued: true,
          upload: { state: 'VERIFIED' as const, sizeBytes: size },
          gumlet: { queued: presence === 'live' },
          mobile,
          ...(await this.workerStatus()),
        };
      }

      this.logger.warn(
        `video ${videoId}: the recorded job is gone, so the upload was never finished; re-queueing it`,
      );
    }

    // A video that is already READY has been through this endpoint. Queueing
    // it again would transcode a finished lecture for nothing.
    if (video.status === VideoStatus.READY || video.status === VideoStatus.ARCHIVED) {
      const mobile = await this.settleMobileIntentOnComplete(video, { accepting: false }, actor.id);
      return {
        videoId,
        status: video.status,
        jobId: video.processingJobId,
        sourceSizeBytes: size,
        alreadyQueued: true,
        upload: { state: 'VERIFIED' as const, sizeBytes: size },
        gumlet: { queued: true },
        mobile,
        ...(await this.workerStatus()),
      };
    }

    // -------------------------------------------------------------------------
    // THE MOBILE INTENT COMES FIRST, AND DEPENDS ON NOTHING BELOW.
    //
    // The source is verified. From this line on the video must be processed
    // for mobile whatever happens to the Gumlet side: a rejected asset, a
    // provider outage, an unreachable queue, a crash of this process. So the
    // intent is written to the database BEFORE the Gumlet job is even
    // attempted - it used to be queued last, and only if everything before it
    // had succeeded.
    // -------------------------------------------------------------------------
    const mobile = await this.settleMobileIntentOnComplete(video, { accepting: true }, actor.id);

    // The confirmed file is the one that stays. Anything an earlier attempt
    // left behind is removed, so a retried upload does not accumulate
    // gigabytes of unreachable originals.
    try {
      await this.storage.pruneSupersededSources(videoId, video.sourceKey);
    } catch (error) {
      // Housekeeping only. The upload itself is fine, so this must not fail
      // the request - it is logged and the objects are cleaned up on the next
      // successful completion.
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`video ${videoId}: could not prune superseded sources: ${message}`);
    }

    // -------------------------------------------------------------------------
    // AUTOMATIC GUMLET INGESTION
    //
    // The upload is confirmed and the object is verifiably in R2, so the video is
    // handed to Gumlet here without any staff action. That is the requirement:
    // an admin must never have to upload the same video twice.
    //
    // Enqueueing the existing `transcode` job is what triggers it. The worker
    // calls `GumletIngestService.processFromJob`, which reads `drmProvider` from
    // the DATABASE (never from the job payload) and hands the video to Gumlet
    // with `enable_drm: true`. Reusing that job rather than adding a second one
    // keeps a single, already-idempotent path: a duplicate job re-syncs the
    // existing asset instead of creating a second one.
    //
    // Asynchronous by construction - the admin's upload returns as soon as the
    // acceptance is durable, and any Gumlet slowness or failure is recorded on
    // the row rather than blocking or rolling back the upload the student will
    // later need.
    //
    // THE UPLOAD SUCCEEDS HERE EVEN IF THE QUEUE DOES NOT ANSWER. The source is
    // verified and the row says QUEUED, which is a durable instruction: the
    // reconciler enqueues the job as soon as Redis is reachable. Answering
    // "upload failed" for a file that is safely stored made administrators
    // send it again.
    // -------------------------------------------------------------------------

    const web = await this.queueUploadTranscode(
      { id: videoId, sourceKey: video.sourceKey, lessonId: video.lessonId, courseId: video.courseId },
      actor.id,
    );

    this.logger.log(
      web.queued
        ? `queued transcode job ${web.jobId} for video ${videoId} (${size} bytes)`
        : `video ${videoId} accepted (${size} bytes); its transcode job will be queued by the reconciler`,
    );

    return {
      videoId,
      status: VideoStatus.QUEUED,
      jobId: web.jobId,
      sourceSizeBytes: size,
      upload: { state: 'VERIFIED' as const, sizeBytes: size },
      gumlet: { queued: web.queued },
      mobile,
      ...(await this.workerStatus()),
    };
  }

  /**
   * The mobile half of finishing an upload.
   *
   * `accepting` is true only on the call that actually accepts the upload (the
   * row was not yet in the pipeline). Only that call may create an intent, and
   * only for a video that has never been processed for mobile from this
   * source: a stray `complete` on an old lecture must never start encoding
   * the back catalogue, and a FAILED ladder is retried by an explicit staff
   * action, not as a side effect.
   *
   * Every call, accepting or not, makes sure an intent that ALREADY exists has
   * its job - which is what lets a retried `complete` repair an enqueue that
   * Redis refused the first time.
   *
   * Never throws: nothing about the mobile pipeline may fail an upload.
   */
  private async settleMobileIntentOnComplete(
    video: { id: string; sourceKey: string | null },
    mode: { accepting: boolean },
    actorId: string,
  ): Promise<{ status: MobileVideoStatus; jobId: string | null; queued: boolean; automatic: boolean }> {
    const automatic = Boolean(this.mobileQueue) && this.cfg.mobile?.autoProcess !== false;
    try {
      const row = await this.prisma.video.findFirst({
        where: { id: video.id, ...notDeleted },
        select: { mobileStatus: true, mobileJobId: true, mobileEnqueuedAt: true },
      });
      const status = row?.mobileStatus ?? MobileVideoStatus.NONE;
      const current = { status, jobId: row?.mobileJobId ?? null, queued: Boolean(row?.mobileEnqueuedAt), automatic };
      if (!row || !video.sourceKey || !this.mobileQueue) return current;

      const createIntent = mode.accepting && automatic && status === MobileVideoStatus.NONE;
      const repairIntent = status === MobileVideoStatus.QUEUED && !row.mobileEnqueuedAt;
      if (!createIntent && !repairIntent) return current;

      const result = await this.enqueueMobileTranscode({ id: video.id, sourceKey: video.sourceKey }, 'upload', actorId);
      return { status: MobileVideoStatus.QUEUED, jobId: result.jobId, queued: result.enqueued, automatic };
    } catch (error) {
      this.logger.warn(`video ${video.id}: mobile intent not settled: ${(error as Error).message}`);
      return { status: MobileVideoStatus.NONE, jobId: null, queued: false, automatic };
    }
  }

  /**
   * Accepts a verified upload for web/Gumlet processing and queues its job.
   *
   * DURABLE FIRST. The row becomes QUEUED in the database before Redis is
   * touched, so the instruction survives whatever happens next. `processingJobId`
   * stays NULL until the job is really in Redis; "QUEUED with no job id" is
   * the outbox state the reconciler looks for.
   *
   * IDEMPOTENT. The job id is derived from the video and its source key, so a
   * finalisation request that is retried, doubled or raced maps to one job.
   * A finished job with the same id (the video failed and `complete` is being
   * used to recover it) is cleared first, because BullMQ would otherwise treat
   * the new request as a duplicate of the dead one.
   *
   * Never throws for a queue problem.
   */
  private async queueUploadTranscode(
    video: { id: string; sourceKey: string; lessonId: string | null; courseId: string },
    requestedById?: string,
  ): Promise<{ jobId: string | null; queued: boolean }> {
    const jobId = uploadTranscodeJobIdFor(video.id, video.sourceKey);

    await this.prisma.video.updateMany({
      where: { id: video.id, deletedAt: null, sourceKey: video.sourceKey },
      data: { status: VideoStatus.QUEUED, processingJobId: null, processingError: null },
    });

    try {
      const presence = await this.jobPresence(this.queue, jobId);
      if (presence === 'unknown') throw new QueueTimeoutError('the processing queue did not answer');
      if (presence === 'finished') {
        const stale = await withinQueueTimeout(this.queue.getJob(jobId), 'queue read');
        await withinQueueTimeout(Promise.resolve(stale?.remove()), 'queue cleanup');
      }
      if (presence !== 'live') {
        await withinQueueTimeout(
          this.queue.add(
            VIDEO_JOBS.transcode,
            {
              videoId: video.id,
              sourceKey: video.sourceKey,
              lessonId: video.lessonId,
              courseId: video.courseId,
              ladder: this.cfg.ladder,
              encrypt: this.cfg.encryptionEnabled,
              requestedById,
            },
            {
              ...DEFAULT_JOB_OPTIONS,
              attempts: 2,
              backoff: {
                type: 'exponential',
                delay: TRANSCODE_BACKOFF_BASE_MS,
                jitter: TRANSCODE_BACKOFF_JITTER,
              },
              jobId,
            },
          ),
          'queue write',
        );
      }
    } catch (error) {
      this.logger.error(
        `video ${video.id}: accepted, but its transcode job is not in the queue yet (${(error as Error).message}); ` +
          'the reconciler will queue it',
      );
      return { jobId: null, queued: false };
    }

    // Conditional on the source: a re-upload that started in the meantime owns
    // the row now, and its own completion will record its own job.
    await this.prisma.video.updateMany({
      where: { id: video.id, deletedAt: null, sourceKey: video.sourceKey, status: VideoStatus.QUEUED },
      data: { processingJobId: jobId },
    });
    return { jobId, queued: true };
  }

  /**
   * Whether a job is still in its queue.
   *
   *   live      waiting / delayed / prioritized / active: it will run or is running
   *   finished  completed or failed and still retained
   *   missing   not in Redis at all
   *   unknown   Redis did not answer in time - NOT evidence that the job is gone
   */
  private async jobPresence(
    queue: Queue<never> | Queue<TranscodeJobData> | Queue<MobileTranscodeJobData> | undefined,
    jobId: string | null,
  ): Promise<QueueJobPresence> {
    if (!jobId || !queue) return 'missing';
    try {
      const job = await withinQueueTimeout((queue as Queue).getJob(jobId), 'queue read');
      if (!job) return 'missing';
      const state = await withinQueueTimeout(job.getState(), 'queue read');
      if (isLiveJobState(state)) return 'live';
      return state === 'unknown' ? 'missing' : 'finished';
    } catch {
      return 'unknown';
    }
  }

  /**
   * Puts a transcode job on the queue and records it.
   *
   * The row only becomes QUEUED once the job is really in Redis. The previous
   * order — status first, `queue.add` second — left a video QUEUED with no job
   * behind it whenever Redis refused the write (a quota, a blip), and nothing
   * would ever pick it up. On failure the row returns to UPLOADING with the
   * reason, so the dashboard can offer the retry and the error is visible.
   *
   * `failureStatus` overrides that fallback. The legacy path wants UPLOADING,
   * because a video that never reached the queue is an unfinished upload. A
   * Gumlet video does not: its asset already exists at the provider, and
   * sending the row back to UPLOADING would report a live provider asset as an
   * upload that never happened. It falls back to PROCESSING instead, which the
   * recovery sweep knows how to re-check.
   */
  private async enqueueTranscode(
    video: { id: string; sourceKey: string; lessonId: string | null; courseId: string },
    requestedById?: string,
    options?: { failureStatus?: VideoStatus },
  ): Promise<string> {
    let jobId: string;
    try {
      // Bounded: an unreachable Redis makes `add` wait forever, not fail.
      const job = await withinQueueTimeout(this.queue.add(
        VIDEO_JOBS.transcode,
        {
          videoId: video.id,
          sourceKey: video.sourceKey,
          lessonId: video.lessonId,
          courseId: video.courseId,
          ladder: this.cfg.ladder,
          encrypt: this.cfg.encryptionEnabled,
          requestedById,
        },
        {
          ...DEFAULT_JOB_OPTIONS,
          // Transcoding is expensive; two attempts, not three.
          attempts: 2,
          /**
           * Bounded exponential backoff WITH JITTER.
           *
           * The queue default is a 5-second exponential curve with no
           * jitter, so a batch of videos that failed together - a provider
           * outage, a full disk - all comes back at the same instant and
           * repeats the load that caused the failure. Randomising the delay
           * spreads the retries out.
           */
          backoff: {
            type: 'exponential',
            delay: TRANSCODE_BACKOFF_BASE_MS,
            jitter: TRANSCODE_BACKOFF_JITTER,
          },
          jobId: `transcode:${video.id}:${Date.now()}`,
        },
      ), 'queue write');
      jobId = String(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.video.update({
        where: { id: video.id },
        data: {
          status: options?.failureStatus ?? VideoStatus.UPLOADING,
          processingError: `Could not queue processing: ${message}`.slice(0, 1000),
        },
      });
      this.logger.error(`could not enqueue transcode for ${video.id}: ${message}`);
      throw new AppException(ErrorCode.QUEUE_UNAVAILABLE, {
        message: 'The processing queue is unavailable. The upload is kept — try again shortly.',
      });
    }

    await this.prisma.video.update({
      where: { id: video.id },
      data: { status: VideoStatus.QUEUED, processingJobId: jobId },
    });

    return jobId;
  }

  /**
   * Whether any queue consumer has checked in recently. Returned with every
   * enqueue so the dashboard can say "no worker is running" instead of
   * showing QUEUED forever with no explanation.
   */
  async workerStatus(): Promise<{
    workerOnline: boolean;
    workerLastSeenAt: string | null;
    workerCanTranscode: boolean | null;
  }> {
    const beat = await readWorkerHeartbeat(this.redis);
    return {
      workerOnline: Boolean(beat),
      workerLastSeenAt: beat?.at ?? null,
      workerCanTranscode: beat ? beat.ffmpeg && beat.ffprobe : null,
    };
  }

  /**
   * Re-queues videos whose job is gone.
   *
   * Run by the maintenance scheduler. A job can disappear without the row
   * learning about it: Redis evicted or flushed, a worker killed mid-job
   * (out of memory on a large source), a retention sweep. Such a video sits
   * in QUEUED or PROCESSING indefinitely; this is what moves it again.
   */
  async recoverStrandedVideos(now = new Date()): Promise<{
    requeued: number;
    failed: number;
    synced: number;
    mobile: { requeued: number; failed: number };
  }> {
    const queuedCutoff = new Date(now.getTime() - 10 * 60_000);
    const processingCutoff = new Date(now.getTime() - 3 * 3600_000);
    // A Gumlet row is re-checked sooner than the 3-hour legacy cutoff, because
    // nothing about it is stuck locally - the only question is what the provider
    // says, and the provider can answer at any time.
    const gumletCutoff = new Date(now.getTime() - 5 * 60_000);

    const stranded = await this.prisma.video.findMany({
      where: {
        ...notDeleted,
        OR: [
          { status: VideoStatus.QUEUED, updatedAt: { lt: queuedCutoff } },
          { status: VideoStatus.PROCESSING, processingStartedAt: { lt: processingCutoff } },
          // Gumlet rows deliberately carry NO local job: `adopt()` nulls
          // `processingStartedAt` and `processingJobId` because transcoding
          // happens at the provider, not in a worker. The clause above required
          // `processingStartedAt` to be non-null AND old, and SQL never satisfies
          // `NULL < cutoff`, so every Gumlet row in PROCESSING was permanently
          // invisible to this sweep. That is the bug that left
          // cmv9ju1yz00ngcr01tztxv6u7 sitting in PROCESSING for 108 minutes with
          // a job budget that had already expired.
          //
          // These rows are handled by ASKING THE PROVIDER, never by requeue:
          // see the loop below. The 5-minute floor stops a row adopted seconds
          // ago from being swept on its very first run.
          {
            status: VideoStatus.PROCESSING,
            drmProvider: 'gumlet',
            gumletAssetId: { not: null },
            updatedAt: { lt: gumletCutoff },
          },
        ],
      },
      select: {
        id: true,
        status: true,
        sourceKey: true,
        lessonId: true,
        courseId: true,
        processingJobId: true,
        drmProvider: true,
        gumletAssetId: true,
      },
      take: 50,
    });

    let requeued = 0;
    let failed = 0;
    let synced = 0;

    for (const video of stranded) {
      // ---- Gumlet rows: the provider is the authority -----------------------
      // Treating these like ffmpeg rows is what made the sweep DANGEROUS rather
      // than merely useless: a Gumlet row always has a missing local job, so
      // `markFailed` fired on every one of them - including assets that were
      // still faithfully transcoding at the provider. That is exactly the
      // "observed in production as Processing was interrupted (job missing)"
      // failure this service already documents on `adopt()`.
      if (video.drmProvider === 'gumlet' && video.gumletAssetId) {
        try {
          // Idempotent and bounded: sync() mirrors whatever Gumlet says, so a
          // still-processing asset stays PROCESSING, a terminal failure becomes
          // FAILED, and a ready+drm-verified asset becomes READY. Repeated sweeps
          // converge rather than compounding.
          await this.gumletIngest.sync(video.id);
          synced += 1;
        } catch (error) {
          // Could not reach the provider. That says nothing about the asset, and
          // marking it failed here would replace a live asset with an outage.
          this.logger.warn(
            `Gumlet sweep could not sync video ${video.id}: ${(error as Error).message}`,
          );
        }
        continue;
      }

      const job = video.processingJobId ? await this.queue.getJob(video.processingJobId) : null;
      const state = job ? await job.getState() : 'missing';

      if (state === 'waiting' || state === 'active' || state === 'delayed' || state === 'prioritized' || state === 'waiting-children') {
        continue; // still genuinely in the pipeline
      }

      if (!video.sourceKey) continue;

      if (video.status === VideoStatus.PROCESSING) {
        // Conditional: a sync may have finished the video since it was read.
        const recorded = await this.markFailed(
          video.id,
          `Processing was interrupted (job ${state}); retry to process the stored file again`,
        );
        if (recorded) failed += 1;
        continue;
      }

      await this.enqueueTranscode({
        id: video.id,
        sourceKey: video.sourceKey,
        lessonId: video.lessonId,
        courseId: video.courseId,
      });
      requeued += 1;
    }

    if (requeued || failed || synced) {
      this.logger.warn(
        `stranded videos: requeued ${requeued}, marked failed ${failed}, gumlet synced ${synced}`,
      );
    }
    const mobile = await this.recoverStrandedMobileVideos(now).catch((error) => {
      this.logger.warn(`mobile recovery sweep failed: ${(error as Error).message}`);
      return { requeued: 0, failed: 0 };
    });
    return { requeued, failed, synced, mobile };
  }

  // ---------------------------------------------------------------------------
  // Independent mobile pipeline
  // ---------------------------------------------------------------------------

  /**
   * Records that a video must be processed for mobile, then makes sure the
   * job for that instruction is in the queue.
   *
   * TWO STEPS, IN THIS ORDER, AND THE ORDER IS THE POINT.
   *
   *   1. THE INTENT, in the database. One conditional write turns the row
   *      QUEUED, bumps `mobileGeneration` and stores the job id derived from
   *      it. From that moment "this video must be processed" is durable: it
   *      survives Redis being down, this process crashing, a deploy.
   *   2. THE JOB, in Redis, under that deterministic id. `mobileEnqueuedAt` is
   *      stamped only when Redis has really accepted it.
   *
   * The previous order was the reverse (job first, QUEUED after, FAILED when
   * the job could not be added). That lost the instruction whenever the
   * process stopped between the two, and reported a healthy video as FAILED
   * because of a queue outage that had nothing to do with it.
   *
   * IDEMPOTENT at both steps:
   *   - the intent is a compare-and-set on the generation, so two concurrent
   *     requests produce one intent, not two;
   *   - the job id is a function of the intent, so adding it again - by a
   *     retried request, another API process or the reconciler - is the same
   *     job. BullMQ ignores an `add` whose id already exists.
   *
   * A video that is already QUEUED or PROCESSING with a live job is left
   * alone. One whose job never reached Redis gets the SAME job added again.
   * One whose job finished or vanished without the row learning of it gets a
   * new intent.
   *
   * A queue outage does not throw and does not fail the video: the result says
   * `enqueued: false` and `reconcilePendingIntents` finishes the work.
   */
  async enqueueMobileTranscode(
    video: { id: string; sourceKey: string },
    trigger: MobileTranscodeJobData['trigger'],
    requestedById?: string,
  ): Promise<MobileEnqueueResult> {
    if (!this.mobileQueue) {
      throw new AppException(ErrorCode.QUEUE_UNAVAILABLE, {
        message: 'The mobile processing queue is not configured on this process',
      });
    }

    const current = await this.prisma.video.findFirst({
      where: { id: video.id, ...notDeleted },
      select: {
        mobileStatus: true,
        mobileJobId: true,
        mobileGeneration: true,
        mobileEnqueuedAt: true,
        mobileTrigger: true,
        durationSeconds: true,
      },
    });
    if (!current) throw AppException.notFound('Video', video.id);
    const generation = current.mobileGeneration ?? 0;
    const durationSeconds = current.durationSeconds > 0 ? current.durationSeconds : undefined;

    if (
      current.mobileStatus === MobileVideoStatus.QUEUED ||
      current.mobileStatus === MobileVideoStatus.PROCESSING
    ) {
      const presence = await this.jobPresence(this.mobileQueue, current.mobileJobId);
      if (presence === 'live') {
        if (!current.mobileEnqueuedAt) await this.stampMobileEnqueued(video.id, current.mobileJobId!);
        return { jobId: current.mobileJobId, alreadyQueued: true, enqueued: true };
      }
      if (presence === 'unknown') {
        // Redis did not answer. The intent stands; nothing is duplicated on a guess.
        return { jobId: current.mobileJobId, alreadyQueued: true, enqueued: false };
      }
      if (
        presence === 'missing' &&
        current.mobileStatus === MobileVideoStatus.QUEUED &&
        current.mobileJobId === mobileJobIdFor(video.id, generation)
      ) {
        // The same intent, whose job is not in Redis (the first add was
        // refused, or Redis lost it before a worker took it): the SAME job
        // again. No new generation, so a concurrent caller adds this very id.
        const added = await this.addMobileJob({
          videoId: video.id,
          sourceKey: video.sourceKey,
          jobId: current.mobileJobId,
          trigger: (current.mobileTrigger as MobileTranscodeJobData['trigger'] | null) ?? trigger,
          requestedById,
          durationSeconds,
        });
        return { jobId: current.mobileJobId, alreadyQueued: true, enqueued: added };
      }
      // The job finished or vanished and the row never heard (a worker killed
      // mid-encode, a job that exhausted its attempts): a new intent, below.
    }

    const nextGeneration = generation + 1;
    const jobId = mobileJobIdFor(video.id, nextGeneration);
    const claimed = await this.prisma.video.updateMany({
      where: { id: video.id, deletedAt: null, mobileGeneration: generation },
      data: {
        mobileStatus: MobileVideoStatus.QUEUED,
        mobileJobId: jobId,
        mobileGeneration: nextGeneration,
        mobileRequestedAt: new Date(),
        mobileEnqueuedAt: null,
        mobileTrigger: trigger,
        mobileError: null,
      },
    });
    if (claimed.count === 0) {
      // Another request recorded an intent between the read and this write.
      // Theirs stands, and they are adding its job.
      const latest = await this.prisma.video.findFirst({
        where: { id: video.id, ...notDeleted },
        select: { mobileJobId: true, mobileEnqueuedAt: true },
      });
      return {
        jobId: latest?.mobileJobId ?? null,
        alreadyQueued: true,
        enqueued: Boolean(latest?.mobileEnqueuedAt),
      };
    }

    const added = await this.addMobileJob({
      videoId: video.id,
      sourceKey: video.sourceKey,
      jobId,
      trigger,
      requestedById,
      durationSeconds,
    });
    return { jobId, alreadyQueued: false, enqueued: added };
  }

  /**
   * Step 2 of `enqueueMobileTranscode`: the job, under the intent's id.
   * Returns whether Redis accepted it. Never throws for a queue problem and
   * never marks the video FAILED - the intent is already safe in the database.
   */
  private async addMobileJob(params: {
    videoId: string;
    sourceKey: string;
    jobId: string;
    trigger: MobileTranscodeJobData['trigger'];
    requestedById?: string;
    durationSeconds?: number;
  }): Promise<boolean> {
    const priority = MOBILE_JOB_PRIORITY[params.trigger];
    try {
      await withinQueueTimeout(
        this.mobileQueue!.add(
          MOBILE_VIDEO_JOBS.transcode,
          {
            videoId: params.videoId,
            sourceKey: params.sourceKey,
            ladder: this.cfg.ladder,
            encrypt: this.cfg.encryptionEnabled,
            // Known for every Gumlet-processed row; lets the worker size its
            // scratch preflight before it downloads anything.
            durationSeconds: params.durationSeconds,
            trigger: params.trigger,
            requestedById: params.requestedById,
          },
          {
            ...DEFAULT_JOB_OPTIONS,
            attempts: MOBILE_JOB_ATTEMPTS,
            backoff: {
              type: 'exponential',
              delay: TRANSCODE_BACKOFF_BASE_MS,
              jitter: TRANSCODE_BACKOFF_JITTER,
            },
            jobId: params.jobId,
            // Historical work goes behind every upload/retry in this queue.
            ...(priority ? { priority } : {}),
          },
        ),
        'mobile queue write',
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `video ${params.videoId}: mobile intent ${params.jobId} is recorded but its job is not in the queue yet ` +
          `(${message}); the reconciler will queue it`,
      );
      await this.prisma.video
        .updateMany({
          where: { id: params.videoId, mobileJobId: params.jobId, mobileStatus: MobileVideoStatus.QUEUED },
          data: { mobileError: WAITING_FOR_QUEUE_NOTE },
        })
        .catch(() => undefined);
      return false;
    }
    await this.stampMobileEnqueued(params.videoId, params.jobId);
    return true;
  }

  /**
   * Marks the intent as delivered to Redis. Conditional on the job id, so a
   * newer intent is never stamped by an older one, and the "waiting for the
   * queue" note is cleared only where it was the thing being shown.
   */
  private async stampMobileEnqueued(videoId: string, jobId: string): Promise<void> {
    await this.prisma.video
      .updateMany({ where: { id: videoId, mobileJobId: jobId, mobileEnqueuedAt: null }, data: { mobileEnqueuedAt: new Date() } })
      .catch((e: Error) => this.logger.warn(`video ${videoId}: could not stamp the mobile enqueue (${e.message})`));
    await this.prisma.video
      .updateMany({ where: { id: videoId, mobileJobId: jobId, mobileError: WAITING_FOR_QUEUE_NOTE }, data: { mobileError: null } })
      .catch(() => undefined);
  }

  /**
   * Staff action: run (or re-run) the mobile transcode for one video.
   *
   * Touches the mobile pipeline only. Nothing here reads or writes `status`
   * or any Gumlet field, so retrying mobile can never reset, restart or fail
   * the Gumlet side.
   *
   * Refused when it would duplicate work: a video that is already queued or
   * being encoded keeps the job it has, and a READY ladder is not thrown away
   * and re-encoded unless an administrator explicitly forces it.
   */
  async retryMobileProcessing(
    videoId: string,
    actor: { id: string; role: UserRole },
    options: { force?: boolean } = {},
  ) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: { id: true, courseId: true, sourceKey: true, mobileStatus: true },
    });
    if (!video) throw AppException.notFound('Video', videoId);
    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');
    if (!video.sourceKey) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'No source file to process for mobile — re-upload the video',
      });
    }
    if (video.mobileStatus === MobileVideoStatus.READY) {
      if (!options.force) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: 'This video is already processed for mobile. There is nothing to retry.',
        });
      }
      if (actor.role !== 'ADMIN' && actor.role !== 'MASTER') {
        throw new AppException(ErrorCode.FORBIDDEN, {
          message: 'Only an administrator can re-encode a video that is already ready for mobile',
        });
      }
    }
    if (!(await this.storage.exists('uploads', video.sourceKey))) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message:
          'The stored source file is no longer in storage, so this video cannot be processed ' +
          'for mobile — re-upload the file',
      });
    }
    const result = await this.enqueueMobileTranscode(
      { id: video.id, sourceKey: video.sourceKey },
      'retry',
      actor.id,
    );
    await this.audit.record({
      action: AuditAction.UPDATE,
      actorId: actor.id,
      actorRole: actor.role,
      entity: 'video',
      entityId: videoId,
      after: { mobileRetry: true, ...result },
    });
    return { videoId, ...result, ...(await this.mobileWorkerStatus()) };
  }

  /**
   * Migration of the existing library onto the mobile pipeline.
   *
   * Walks every live video that is not yet mobile-READY and, when its source
   * object is still in R2, queues a mobile transcode. A video whose source is
   * gone is REPORTED, never marked anything: it needs a re-upload, and a row
   * that claimed to be migrated with no media behind it would be worse than an
   * honest gap. `dryRun` does the full scan and queues nothing.
   */
  async migrateLibraryToMobile(params: {
    dryRun: boolean;
    limit: number;
    actorId: string;
  }): Promise<MobileMigrationReport> {
    // Eligibility is about the SOURCE, not about Gumlet. Any video whose
    // upload was accepted qualifies, whatever Gumlet made of it: a lecture
    // Gumlet rejected is exactly the one mobile most needs. Only UPLOADING is
    // left out - there is no confirmed file to encode yet.
    const pending = {
      ...notDeleted,
      status: { in: MOBILE_MIGRATABLE_STATUSES },
      mobileStatus: { in: [MobileVideoStatus.NONE, MobileVideoStatus.FAILED] },
    };
    const candidates = await this.prisma.video.findMany({
      where: pending,
      select: { id: true, sourceKey: true },
      orderBy: { createdAt: 'asc' },
      take: Math.max(1, Math.min(params.limit, 500)),
    });

    const report: MobileMigrationReport = {
      dryRun: params.dryRun,
      scanned: candidates.length,
      queued: [],
      wouldQueue: [],
      missingSource: [],
      noSourceKey: [],
      queueErrors: [],
      remaining: 0,
    };

    for (const video of candidates) {
      if (!video.sourceKey) {
        report.noSourceKey.push(video.id);
        continue;
      }
      if (!(await this.storage.exists('uploads', video.sourceKey))) {
        report.missingSource.push(video.id);
        continue;
      }
      if (params.dryRun) {
        report.wouldQueue.push(video.id);
        continue;
      }
      try {
        const result = await this.enqueueMobileTranscode(
          { id: video.id, sourceKey: video.sourceKey },
          'migration',
          params.actorId,
        );
        report.queued.push(video.id);
        if (!result.enqueued) {
          report.queueErrors.push({
            videoId: video.id,
            error: 'intent recorded; the queue did not answer, so the reconciler will deliver the job',
          });
        }
      } catch (error) {
        report.queueErrors.push({ videoId: video.id, error: (error as Error).message });
      }
    }

    report.remaining = await this.prisma.video.count({ where: pending });

    if (!params.dryRun) {
      await this.audit.record({
        action: AuditAction.UPDATE,
        actorId: params.actorId,
        entity: 'video',
        entityId: 'mobile-migration',
        after: {
          queued: report.queued.length,
          missingSource: report.missingSource.length,
          noSourceKey: report.noSourceKey.length,
        },
      });
    }
    return report;
  }

  /**
   * The migration dashboard: counts per mobile state, what is left, how fast
   * the worker has been going and what that implies for the remainder, the
   * worker's own view of its host (scratch, load, pause, active job), and the
   * queue's view of the jobs. Everything an operator needs to decide whether
   * to queue the next batch, in one read.
   */
  async mobilePipelineOverview(): Promise<{
    byStatus: Record<MobileVideoStatus, number>;
    liveVideos: number;
    /** Live videos the migration targets (READY or ARCHIVED on the web pipeline). */
    migratable: number;
    remaining: number;
    progressPercent: number;
    throughput: {
      /** Encode seconds per content second over the most recent READY videos (null until one finished). */
      secondsPerContentSecond: number | null;
      sampleSize: number;
      /** Content seconds still to process. */
      remainingContentSeconds: number;
      estimatedRemainingHours: number | null;
      estimatedRemainingMinutes: number | null;
    };
    output: { readyVideos: number; totalBytes: number; averageBytesPerContentHour: number | null };
    queue: Record<string, number> | null;
    pause: PauseState;
    deliveryOverride: MobileDeliveryOverride | null;
    worker: Awaited<ReturnType<VideosService['workerStatus']>> & {
      detail: Pick<WorkerHeartbeatPayload, 'host' | 'build' | 'queues' | 'scratch' | 'load' | 'activeJobs' | 'lastDeferral'> | null;
    };
    recentFailures: { videoId: string; error: string | null; at: string | null }[];
  }> {
    const migratableWhere = {
      ...notDeleted,
      status: { in: MOBILE_MIGRATABLE_STATUSES },
    };
    const pendingWhere = {
      ...migratableWhere,
      mobileStatus: { in: [MobileVideoStatus.NONE, MobileVideoStatus.FAILED, MobileVideoStatus.QUEUED, MobileVideoStatus.PROCESSING] },
    };
    const [rows, migratable, pendingAgg, recent, output, failures, beat, pause, deliveryOverride, queue] =
      await Promise.all([
        this.prisma.video.groupBy({ by: ['mobileStatus'], where: notDeleted, _count: { _all: true } }),
        this.prisma.video.count({ where: migratableWhere }),
        this.prisma.video.aggregate({ where: pendingWhere, _count: { _all: true }, _sum: { durationSeconds: true } }),
        this.prisma.video.findMany({
          where: { ...notDeleted, mobileStatus: MobileVideoStatus.READY, mobileProcessedAt: { not: null }, mobileProcessingStartedAt: { not: null } },
          orderBy: { mobileProcessedAt: 'desc' },
          take: 20,
          select: { durationSeconds: true, mobileProcessedAt: true, mobileProcessingStartedAt: true },
        }),
        this.prisma.videoRendition.aggregate({
          where: { video: { ...notDeleted, mobileStatus: MobileVideoStatus.READY } },
          _sum: { sizeBytes: true },
        }),
        this.prisma.video.findMany({
          where: { ...notDeleted, mobileStatus: MobileVideoStatus.FAILED },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          select: { id: true, mobileError: true, updatedAt: true },
        }),
        readWorkerHeartbeat(this.redis),
        readPauseState(this.redis),
        this.redis.getJson<MobileDeliveryOverride>(MOBILE_DELIVERY_OVERRIDE_KEY),
        this.mobileQueue ? this.mobileQueue.getJobCounts().catch(() => null) : Promise.resolve(null),
      ]);

    const byStatus = Object.fromEntries(
      Object.values(MobileVideoStatus).map((s) => [s, 0]),
    ) as Record<MobileVideoStatus, number>;
    let liveVideos = 0;
    for (const row of rows) {
      byStatus[row.mobileStatus] = row._count._all;
      liveVideos += row._count._all;
    }

    const samples = recent
      .map((r) => ({
        content: r.durationSeconds,
        encode: (r.mobileProcessedAt!.getTime() - r.mobileProcessingStartedAt!.getTime()) / 1000,
      }))
      .filter((s) => s.content > 0 && s.encode > 0);
    const contentTotal = samples.reduce((a, s) => a + s.content, 0);
    const encodeTotal = samples.reduce((a, s) => a + s.encode, 0);
    const secondsPerContentSecond = contentTotal > 0 ? encodeTotal / contentTotal : null;
    const remainingContentSeconds = pendingAgg._sum.durationSeconds ?? 0;
    const remaining = pendingAgg._count._all;
    const readyMigratable = Math.max(0, migratable - remaining);
    const readyContentHours =
      (await this.prisma.video.aggregate({
        where: { ...notDeleted, mobileStatus: MobileVideoStatus.READY },
        _sum: { durationSeconds: true },
      }))._sum.durationSeconds ?? 0;
    const totalBytes = Number(output._sum.sizeBytes ?? 0);

    return {
      byStatus,
      liveVideos,
      migratable,
      remaining,
      progressPercent: migratable > 0 ? Math.round((readyMigratable / migratable) * 1000) / 10 : 100,
      throughput: {
        secondsPerContentSecond: secondsPerContentSecond === null ? null : Math.round(secondsPerContentSecond * 1000) / 1000,
        sampleSize: samples.length,
        remainingContentSeconds,
        estimatedRemainingHours:
          secondsPerContentSecond === null
            ? null
            : Math.round(((remainingContentSeconds * secondsPerContentSecond) / 3600) * 10) / 10,
        estimatedRemainingMinutes:
          secondsPerContentSecond === null
            ? null
            : Math.round((remainingContentSeconds * secondsPerContentSecond) / 60),
      },
      output: {
        readyVideos: byStatus[MobileVideoStatus.READY],
        totalBytes,
        averageBytesPerContentHour: readyContentHours > 0 ? Math.round(totalBytes / (readyContentHours / 3600)) : null,
      },
      queue,
      pause,
      deliveryOverride,
      worker: {
        ...(await this.workerStatus()),
        detail: beat
          ? {
              host: beat.host,
              build: beat.build ?? null,
              queues: beat.queues,
              scratch: beat.scratch,
              load: beat.load,
              activeJobs: beat.activeJobs,
              lastDeferral: beat.lastDeferral ?? null,
            }
          : null,
      },
      recentFailures: failures.map((f) => ({ videoId: f.id, error: f.mobileError, at: f.updatedAt?.toISOString() ?? null })),
    };
  }

  /**
   * Operator pause of mobile encodes. Takes effect before the next job is
   * claimed; the encode already running completes. Recorded in the audit log.
   */
  async setMobileProcessingPaused(
    paused: boolean,
    actor: { id: string; role: UserRole },
    reason?: string,
    scope?: PauseScope,
  ): Promise<PauseState> {
    const state = await writePauseState(this.redis, paused, actor.id, reason, scope);
    await this.audit.record({
      action: AuditAction.UPDATE,
      actorId: actor.id,
      actorRole: actor.role,
      entity: 'video',
      entityId: 'mobile-pipeline',
      after: { paused: state.paused, reason: state.reason, scope: state.scope },
    });
    return state;
  }

  /**
   * Emergency routing switch for mobile playback, without a redeploy or an
   * app release: `gumlet` sends every bound mobile device back to Gumlet for
   * every video (the pre-migration behaviour); `null` restores the configured
   * behaviour. Authorization is untouched either way - this only picks which
   * of the two gated pipelines mints the ticket.
   */
  async setMobileDeliveryOverride(
    override: MobileDeliveryOverride | null,
    actor: { id: string; role: UserRole },
  ): Promise<MobileDeliveryOverride | null> {
    if (override) {
      await this.redis.setJsonPersistent(MOBILE_DELIVERY_OVERRIDE_KEY, {
        ...override,
        by: actor.id,
        at: new Date().toISOString(),
      });
    } else {
      await this.redis.del(MOBILE_DELIVERY_OVERRIDE_KEY);
    }
    await this.audit.record({
      action: AuditAction.UPDATE,
      actorId: actor.id,
      actorRole: actor.role,
      entity: 'video',
      entityId: 'mobile-delivery',
      after: { override },
    });
    return this.redis.getJson<MobileDeliveryOverride>(MOBILE_DELIVERY_OVERRIDE_KEY);
  }

  /**
   * Claims a video for mobile processing. False when the job is stale: the
   * video was deleted, its source was replaced, or ANOTHER live job owns it.
   */
  async markMobileProcessing(videoId: string, sourceKey: string, jobId: string): Promise<boolean> {
    // The source key is the staleness guard: a re-upload changes it, and a
    // deleted row is excluded. The mobile state alone is deliberately NOT part
    // of the claim. `enqueueMobileTranscode` writes QUEUED only after the job is
    // in Redis, so a worker on the same network can pick the job up while the
    // row still reads NONE - a plain status filter here made exactly that job
    // "stale" and the video was never encoded. (The API now records the intent
    // BEFORE adding the job, so this window only exists against an older API.)
    const current = await this.prisma.video.findFirst({
      where: { id: videoId, deletedAt: null, sourceKey },
      select: { mobileStatus: true, mobileJobId: true },
    });
    if (!current) return false;

    // A FINISHED LADDER IS NOT RE-ENCODED BY A JOB THAT DOES NOT OWN THE ROW.
    // Re-encoding a READY video is a deliberate act, and a deliberate act
    // records its intent first (QUEUED, with this job's id). A job that finds
    // the row READY under somebody else's id is therefore a leftover - a
    // pending retry of an attempt the row has since moved past, a duplicate
    // from an older build - and running it would throw away a good ladder to
    // produce the same one again.
    if (current.mobileStatus === MobileVideoStatus.READY && current.mobileJobId !== jobId) {
      this.logger.warn(
        `mobile job ${jobId} for video ${videoId} steps aside: the video is already mobile-READY (job ${current.mobileJobId ?? 'unknown'})`,
      );
      return false;
    }

    // NO DUPLICATE ENCODES. When the row is QUEUED/PROCESSING for a DIFFERENT
    // job that is still live in the queue (waiting, delayed, or active - also
    // after a worker restart, while the stalled check hands it back), that job
    // owns the video and this one steps aside. A job re-claiming its own row
    // after a restart, or one whose recorded job is gone, proceeds.
    if (
      current.mobileJobId &&
      current.mobileJobId !== jobId &&
      (current.mobileStatus === MobileVideoStatus.QUEUED ||
        current.mobileStatus === MobileVideoStatus.PROCESSING) &&
      (await this.mobileJobIsLive(current.mobileJobId))
    ) {
      this.logger.warn(
        `mobile job ${jobId} for video ${videoId} steps aside: job ${current.mobileJobId} owns it and is still live`,
      );
      return false;
    }

    // Compare-and-set, so two DIFFERENT jobs racing past the check above
    // cannot both win the claim. The row may hold the id just read, or THIS
    // job's id: `enqueueMobileTranscode` records the id right after adding
    // the job, and that write can land between the read above and this one.
    const claimed = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        deletedAt: null,
        sourceKey,
        OR: [{ mobileJobId: current.mobileJobId }, { mobileJobId: jobId }],
      },
      data: {
        mobileStatus: MobileVideoStatus.PROCESSING,
        mobileJobId: jobId,
        mobileProcessingStartedAt: new Date(),
        mobileError: null,
      },
    });
    return claimed.count > 0;
  }

  /**
   * Records a finished mobile ladder. Touches only the HLS output fields and
   * the mobile state; `status` and every Gumlet field stay exactly as they
   * were, and metadata Gumlet already supplied (duration, size, poster) is
   * only filled in where it is missing.
   */
  async markMobileReady(
    videoId: string,
    result: Parameters<VideosService['markReady']>[1],
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.video.findUniqueOrThrow({
        where: { id: videoId },
        select: { durationSeconds: true, width: true, height: true, thumbnailKey: true },
      });
      await tx.videoRendition.deleteMany({ where: { videoId } });
      await tx.video.update({
        where: { id: videoId },
        data: {
          hlsPrefix: result.hlsPrefix,
          masterPlaylistKey: result.masterPlaylistKey,
          isEncrypted: result.isEncrypted,
          encryptionKeyId: result.encryptionKeyId,
          ...(current.durationSeconds > 0 ? {} : { durationSeconds: result.durationSeconds }),
          ...(current.width ? {} : { width: result.width, height: result.height }),
          ...(current.thumbnailKey || !result.thumbnailKey ? {} : { thumbnailKey: result.thumbnailKey }),
          frameRate: result.frameRate,
          videoCodec: result.videoCodec,
          audioCodec: result.audioCodec,
          mobileStatus: MobileVideoStatus.READY,
          mobileError: null,
          mobileProcessedAt: new Date(),
          renditions: {
            create: result.renditions.map((r) => ({
              height: r.height,
              width: r.width,
              bitrateKbps: r.bitrateKbps,
              playlistKey: r.playlistKey,
              sizeBytes: r.sizeBytes ? BigInt(r.sizeBytes) : null,
            })),
          },
        },
      });
    });
    this.logger.log(`video ${videoId} is mobile-READY (${result.renditions.length} renditions)`);
  }

  /**
   * The encode was stopped for a reason that is not the video's (disk pressure
   * on the worker): back to QUEUED with the note, so the dashboard explains the
   * wait and the sweep does not count it as a failure.
   */
  async markMobileDeferred(videoId: string, note: string): Promise<void> {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { mobileStatus: MobileVideoStatus.QUEUED, mobileError: note.slice(0, 1000) },
    });
    this.logger.warn(`video ${videoId} mobile processing deferred: ${note}`);
  }

  /**
   * An attempt failed and the queue is going to run the job again. The row
   * goes back to QUEUED with the reason - the job is still in Redis (delayed
   * for its backoff), so QUEUED is simply what is true - and it is written
   * only while this job still owns the row.
   */
  async markMobileRetrying(
    videoId: string,
    jobId: string,
    error: string,
    attempt: number,
    attempts: number,
  ): Promise<void> {
    await this.prisma.video.updateMany({
      where: { id: videoId, mobileJobId: jobId, mobileStatus: MobileVideoStatus.PROCESSING },
      data: {
        mobileStatus: MobileVideoStatus.QUEUED,
        mobileError: `Attempt ${attempt} of ${attempts} failed (${error}). It will be retried automatically.`.slice(0, 1000),
      },
    });
    this.logger.warn(`video ${videoId} mobile attempt ${attempt} of ${attempts} failed, retry pending: ${error}`);
  }

  async markMobileFailed(videoId: string, error: string): Promise<void> {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { mobileStatus: MobileVideoStatus.FAILED, mobileError: error.slice(0, 1000) },
    });
    this.logger.error(`video ${videoId} mobile processing failed: ${error}`);
  }

  /**
   * Repairs mobile rows whose job is gone.
   *
   *   QUEUED, job not in the queue      -> its job is added again (same intent)
   *                                        or a new intent when the old job
   *                                        finished without the row knowing;
   *   PROCESSING, job not in the queue  -> an orphan: the worker died (or the
   *                                        job exhausted its stalled budget)
   *                                        mid-encode. Marked FAILED with the
   *                                        reason and re-queued in one pass, so
   *                                        nothing stays PROCESSING for ever.
   *
   * A job that is waiting, delayed (paused, deferred) or active is LIVE and is
   * never touched, however long it has been there: an hour-long encode and a
   * job parked behind an operator pause are both exactly where they should be.
   * When Redis does not answer, nothing is decided at all.
   */
  async recoverStrandedMobileVideos(now = new Date()): Promise<{ requeued: number; failed: number }> {
    if (!this.mobileQueue) return { requeued: 0, failed: 0 };
    const queuedCutoff = new Date(now.getTime() - 10 * 60_000);
    const processingCutoff = new Date(now.getTime() - MOBILE_ORPHAN_AFTER_MS);

    const stranded = await this.prisma.video.findMany({
      where: {
        ...notDeleted,
        OR: [
          { mobileStatus: MobileVideoStatus.QUEUED, updatedAt: { lt: queuedCutoff } },
          {
            mobileStatus: MobileVideoStatus.PROCESSING,
            mobileProcessingStartedAt: { lt: processingCutoff },
          },
        ],
      },
      select: { id: true, sourceKey: true, mobileStatus: true, mobileJobId: true, mobileTrigger: true },
      take: 50,
    });

    let requeued = 0;
    let failed = 0;
    for (const video of stranded) {
      const presence = await this.jobPresence(this.mobileQueue, video.mobileJobId);
      if (presence === 'live' || presence === 'unknown') continue;
      if (!video.sourceKey) continue;
      if (video.mobileStatus === MobileVideoStatus.PROCESSING) {
        await this.markMobileFailed(
          video.id,
          'Mobile processing was interrupted (job gone); the sweep re-queues it',
        );
        failed += 1;
      }
      try {
        // An interrupted upload keeps its place in front of historical work.
        const trigger = video.mobileTrigger === 'upload' || video.mobileTrigger === 'retry' ? video.mobileTrigger : 'recovery';
        await this.enqueueMobileTranscode({ id: video.id, sourceKey: video.sourceKey }, trigger);
        requeued += 1;
      } catch (error) {
        this.logger.warn(`video ${video.id}: mobile re-queue failed: ${(error as Error).message}`);
      }
    }
    if (requeued || failed) {
      this.logger.warn(`stranded mobile videos: requeued ${requeued}, marked failed ${failed}`);
    }
    return { requeued, failed };
  }

  /**
   * THE OUTBOX DRAIN: enqueues every durable instruction that has no job yet.
   *
   * Two kinds of row, both written by `completeUpload` before Redis is touched:
   *
   *   mobile  `mobileStatus = QUEUED` and `mobileEnqueuedAt IS NULL`
   *   web     `status = QUEUED` and `processingJobId IS NULL`
   *
   * In normal operation neither exists for more than a moment, because the
   * request that records the intent also delivers it. They persist only when
   * that delivery did not happen: Redis was unreachable, or the process stopped
   * between the database commit and the enqueue. This is what turns those
   * cases from "the video is lost until somebody notices" into "the video is
   * queued a couple of minutes late".
   *
   * COST. One indexed database query per run and NO Redis traffic at all when
   * there is nothing to deliver, which is nearly always - deliberately, because
   * Redis here is billed per request.
   *
   * SAFE TO RUN ANYWHERE, CONCURRENTLY. Both enqueues are idempotent by job
   * id, so the API and a worker (or two API instances) running this at the
   * same moment produce one job per intent. It runs in-process on a timer
   * (VideoPipelineReconciler) rather than as a queued job precisely so that it
   * does not depend on a worker - or on Redis - to get started.
   */
  async reconcilePendingIntents(now = new Date()): Promise<{
    mobile: { pending: number; queued: number };
    web: { pending: number; queued: number };
  }> {
    const cutoff = new Date(now.getTime() - INTENT_RECONCILE_GRACE_MS);
    const pending = await this.prisma.video.findMany({
      where: {
        ...notDeleted,
        sourceKey: { not: null },
        OR: [
          {
            mobileStatus: MobileVideoStatus.QUEUED,
            mobileEnqueuedAt: null,
            mobileRequestedAt: { lt: cutoff },
          },
          {
            status: VideoStatus.QUEUED,
            processingJobId: null,
            sourceSizeBytes: { not: null },
            updatedAt: { lt: cutoff },
          },
        ],
      },
      select: {
        id: true,
        sourceKey: true,
        lessonId: true,
        courseId: true,
        status: true,
        processingJobId: true,
        sourceSizeBytes: true,
        mobileStatus: true,
        mobileEnqueuedAt: true,
        mobileRequestedAt: true,
        mobileTrigger: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'asc' },
      take: 25,
    });

    const report = { mobile: { pending: 0, queued: 0 }, web: { pending: 0, queued: 0 } };
    for (const video of pending) {
      if (!video.sourceKey) continue;

      const mobilePending =
        Boolean(this.mobileQueue) &&
        video.mobileStatus === MobileVideoStatus.QUEUED &&
        !video.mobileEnqueuedAt &&
        video.mobileRequestedAt !== null &&
        video.mobileRequestedAt < cutoff;
      if (mobilePending) {
        report.mobile.pending += 1;
        try {
          const trigger = (video.mobileTrigger as MobileTranscodeJobData['trigger'] | null) ?? 'recovery';
          const result = await this.enqueueMobileTranscode({ id: video.id, sourceKey: video.sourceKey }, trigger);
          if (result.enqueued) report.mobile.queued += 1;
        } catch (error) {
          this.logger.warn(`video ${video.id}: mobile intent not delivered: ${(error as Error).message}`);
        }
      }

      const webPending =
        video.status === VideoStatus.QUEUED &&
        !video.processingJobId &&
        video.sourceSizeBytes !== null &&
        video.updatedAt < cutoff;
      if (webPending) {
        report.web.pending += 1;
        try {
          const result = await this.queueUploadTranscode({
            id: video.id,
            sourceKey: video.sourceKey,
            lessonId: video.lessonId,
            courseId: video.courseId,
          });
          if (result.queued) report.web.queued += 1;
        } catch (error) {
          this.logger.warn(`video ${video.id}: transcode intent not delivered: ${(error as Error).message}`);
        }
      }
    }

    if (report.mobile.pending || report.web.pending) {
      this.logger.warn(
        `pending intents: mobile ${report.mobile.queued}/${report.mobile.pending} queued, ` +
          `web ${report.web.queued}/${report.web.pending} queued`,
      );
    }
    return report;
  }

  private async mobileJobIsLive(jobId: string | null): Promise<boolean> {
    return (await this.jobPresence(this.mobileQueue, jobId)) === 'live';
  }

  /**
   * Liveness of whichever worker consumes the MOBILE queue, which is not
   * necessarily the one that handles Gumlet ingests.
   */
  async mobileWorkerStatus(): Promise<{
    workerOnline: boolean;
    workerLastSeenAt: string | null;
    workerCanTranscode: boolean | null;
  }> {
    const beat = await readMobileWorkerHeartbeat(this.redis);
    return {
      workerOnline: Boolean(beat),
      workerLastSeenAt: beat?.at ?? null,
      workerCanTranscode: beat ? beat.ffmpeg && beat.ffprobe : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  /**
   * Which course owns this video. The ownership gate the Gumlet ingest
   * endpoints call before doing anything, so a staff member can only act on
   * content inside their scope - the same check every other write here runs.
   */
  async getCourseForVideo(videoId: string): Promise<{ id: string; courseId: string } | null> {
    return this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: { id: true, courseId: true },
    });
  }

  /**
   * Content-scope ownership check, named for its intent rather than for the
   * underlying access API, so callers read as "can this person manage this
   * course's content".
   */
  /** Course that owns a lecture. Used to authorise reuse against the DESTINATION. */
  async getCourseForLesson(
    lessonId: string,
  ): Promise<{ id: string; courseId: string; title: string } | null> {
    return this.prisma.lesson.findFirst({
      where: { id: lessonId, ...notDeleted },
      select: { id: true, courseId: true, title: true },
    });
  }

  async assertCanManageCourseContent(userId: string, role: UserRole, courseId: string): Promise<void> {
    await this.access.assertCanManageCourse(userId, role, courseId, 'content');
  }

  async status(videoId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId },
      include: {
        renditions: { orderBy: { height: 'asc' } },
        captions: true,
        lesson: { select: { id: true, title: true, courseId: true } },
        // How many lectures currently reference this asset. A count above 1 means
        // the file is shared, which changes what "delete" and "replace" mean and
        // must be visible in the UI rather than implied.
        lessonLinks: {
          where: { lesson: notDeleted },
          select: { lessonId: true },
        },
      },
    });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    // --- the mobile pipeline's live context ---------------------------------
    // Read only while the answer can explain a wait, and from the worker's
    // heartbeat (one key it already publishes) rather than from the queue:
    // the panel polls this endpoint every few seconds and Redis is billed per
    // request. The heartbeat carries the active encode's progress and the
    // pause flag, so a waiting video costs one GET per poll.
    const mobileWaiting =
      video.mobileStatus === MobileVideoStatus.QUEUED || video.mobileStatus === MobileVideoStatus.PROCESSING;
    const mobileBeat = mobileWaiting ? await readMobileWorkerHeartbeat(this.redis) : null;
    const mobileActive = mobileBeat?.activeJobs?.find((job) => job.videoId === video.id) ?? null;
    const pause: PauseState | null = mobileWaiting
      ? (mobileBeat?.pause ?? (await readPauseState(this.redis).catch(() => null)))
      : null;
    const heldByPause =
      video.mobileStatus === MobileVideoStatus.QUEUED &&
      Boolean(pause && pauseHolds(pause, video.mobileTrigger as MobileTranscodeJobData['trigger'] | null));
    const isAdmin = actor.role === 'ADMIN' || actor.role === 'MASTER';
    const sourceState = sourceStateOf(video);
    const gumletState = gumletStateOf(video);
    const mobileAutomatic = Boolean(this.mobileQueue) && this.cfg.mobile?.autoProcess !== false;

    return {
      id: video.id,
      lessonId: video.lessonId,
      courseId: video.courseId,
      /**
       * THE ORIGINAL FILE. Independent of both processing pipelines: VERIFIED
       * means the bytes are in storage and their length is recorded, whatever
       * Gumlet or the mobile worker go on to do with them.
       */
      source: {
        state: sourceState,
        sizeBytes: video.sourceSizeBytes ? Number(video.sourceSizeBytes) : null,
      },
      /**
       * THE GUMLET PIPELINE, as one normalised state. `status` /
       * `gumletStatus` / `processingError` below remain for existing clients;
       * this is the same information without having to combine them.
       */
      gumlet: {
        state: gumletState,
        providerStatus: video.gumletStatus,
        hasAsset: Boolean(video.gumletAssetId),
        /** False while the accepted upload is still waiting to reach the queue. */
        queued: video.status === VideoStatus.QUEUED ? video.processingJobId !== null : null,
        error:
          gumletState === 'FAILED' ? (video.gumletError ?? video.processingError ?? null) : null,
        updatedAt: video.gumletUpdatedAt?.toISOString() ?? null,
        drmVerified: Boolean(video.drmVerifiedAt),
        canRetry: gumletState === 'FAILED' && sourceState === 'VERIFIED',
      },
      /**
       * Live lectures attached to this asset, including the owning one.
       * 1 = an ordinary single-course video. >1 = shared/reused.
       */
      attachmentCount: video.lessonLinks.length,
      /**
       * True when this asset is used by more than one lecture. Client-facing so
       * the panel can say "shared" instead of offering a destructive
       * "delete" action that would not do what the button says.
       */
      shared: video.lessonLinks.length > 1,
      status: video.status,
      drmProvider: video.drmProvider,
      gumletAssetId: video.gumletAssetId,
      gumletStatus: video.gumletStatus,
      gumletError: video.gumletError,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      isEncrypted: video.isEncrypted,
      renditions: video.renditions.map((r) => ({
        height: r.height,
        width: r.width,
        bitrateKbps: r.bitrateKbps,
        sizeBytes: r.sizeBytes ? Number(r.sizeBytes) : null,
      })),
      /** The independent mobile pipeline, separate from `status` (web/Gumlet). */
      mobile: {
        status: video.mobileStatus,
        // Sanitised: an encode error can quote a URL, and this is shown to teachers.
        error: video.mobileError ? sanitizeProviderText(video.mobileError) : null,
        jobId: video.mobileJobId,
        /** When the current processing intent was recorded (queued since). */
        requestedAt: video.mobileRequestedAt?.toISOString() ?? null,
        /**
         * False while the intent is recorded but the queue has not accepted
         * the job yet (it is delivered automatically). Null when not queued.
         */
        queued: video.mobileStatus === MobileVideoStatus.QUEUED ? video.mobileEnqueuedAt !== null : null,
        /** How many times processing has been requested for this video. */
        attempts: video.mobileGeneration ?? 0,
        trigger: video.mobileTrigger ?? null,
        processingStartedAt: video.mobileProcessingStartedAt?.toISOString() ?? null,
        processedAt: video.mobileProcessedAt?.toISOString() ?? null,
        renditions: video.mobileStatus === MobileVideoStatus.READY ? video.renditions.length : 0,
        /** 0-100 while a worker is encoding this video; null otherwise. Up to a minute old. */
        progress: mobileActive ? mobileActive.progress : null,
        /** A worker has this video on its bench right now. */
        active: Boolean(mobileActive),
        /** Mobile encoding is paused by an operator and this video is waiting for it. */
        paused: heldByPause,
        // The reason can name the operator's network or machine: administrators only.
        pauseReason: heldByPause && isAdmin ? (pause?.reason ?? null) : null,
        /** Whether new uploads are queued for mobile automatically on this deployment. */
        automatic: mobileAutomatic,
        ...(mobileWaiting
          ? {
              workerOnline: Boolean(mobileBeat),
              workerLastSeenAt: mobileBeat?.at ?? null,
              workerCanTranscode: mobileBeat ? mobileBeat.ffmpeg && mobileBeat.ffprobe : null,
            }
          : {}),
        /**
         * Whether "Retry mobile" would do something: a failed ladder, or a
         * verified source that was never processed. Never while a job exists.
         */
        canRetry:
          sourceState === 'VERIFIED' &&
          (video.mobileStatus === MobileVideoStatus.FAILED || video.mobileStatus === MobileVideoStatus.NONE),
      },
      captions: video.captions.map((c) => ({
        language: c.language,
        label: c.label,
        isDefault: c.isDefault,
      })),
      processingError: video.processingError,
      processingStartedAt: video.processingStartedAt?.toISOString() ?? null,
      processedAt: video.processedAt?.toISOString() ?? null,
      sourceSizeBytes: video.sourceSizeBytes ? Number(video.sourceSizeBytes) : null,
      /**
       * True when the bytes were CONFIRMED in storage.
       *
       * `sourceSizeBytes` is only written by `completeUpload`, after a HEAD on
       * the object proved it is really there. So this is the difference between
       * "an upload was started" and "the file is in the bucket".
       *
       * The dashboard needs that distinction because a video whose upload was
       * interrupted can sit at `UPLOADING` with no job and no provider asset,
       * and the honest thing to say about that is "the file did not arrive",
       * not "it is being processed". It is also what makes the recovery
       * button meaningful: it is offered exactly when the file has not been
       * confirmed.
       */
      uploadConfirmed: video.sourceSizeBytes !== null,
      deleted: Boolean(video.deletedAt),
      // Only worth a Redis read while the answer can explain a wait.
      ...(video.status === VideoStatus.QUEUED || video.status === VideoStatus.PROCESSING
        ? await this.workerStatus()
        : {}),
    };
  }

  /**
   * Is this video's local job still in the queue?
   *
   * A video can be QUEUED or PROCESSING and still have nothing running: the
   * job can have been evicted, removed, or lost when a worker was killed
   * mid-transcode. The maintenance sweep finds those every thirty minutes,
   * but an administrator looking at a stuck lecture should not have to wait
   * for a timer to find out that nothing is happening.
   *
   * The states below are the ones BullMQ considers "still in the pipeline".
   * A job that is `completed`, `failed` or absent is NOT live, and the video
   * is stranded - which is exactly the condition a reprocess is for.
   */
  private async localJobIsLive(processingJobId: string | null): Promise<boolean> {
    if (!processingJobId) return false;
    const job = await this.queue.getJob(processingJobId).catch(() => null);
    if (!job) return false;
    const state = await job.getState().catch(() => 'missing');
    return (
      state === 'waiting' ||
      state === 'active' ||
      state === 'delayed' ||
      state === 'prioritized' ||
      state === 'waiting-children'
    );
  }

  /**
   * Re-run processing for a video that failed.
   *
   * WHAT THIS ACTUALLY DOES, AND WHY IT IS NOT ONE THING
   *
   * A video reaches this endpoint in one of two very different states, and
   * treating them the same is what made "Try processing again" a button that
   * could never work.
   *
   * On the LEGACY path (local ffmpeg → AES-128 HLS in R2) the right action is
   * to run the transcode again from the stored source. That is what this
   * endpoint always did, and it is still what it does.
   *
   * On the GUMLET path the transcode happens at the provider, and the video's
   * state is an asset id. A Gumlet asset that reached a terminal failure
   * (`errored` / `failed`) is DEAD: the provider will not revive it, and
   * `adopt()` is idempotent by design - a row that already carries an asset id
   * is re-synced, never re-created, so that a repeated job cannot mint a
   * second (and separately billed) asset. The consequence is that re-syncing a
   * dead asset re-reads the same terminal verdict, forever.
   *
   * So for a terminally failed Gumlet asset the only repair is to discard the
   * dead id and ingest a fresh one from the SAME stored source. That is what
   * `GumletIngestService.replaceFailedAsset()` does, and this endpoint now
   * routes to it. Without that, the sequence was: upgrade the plan, press
   * Retry, watch the same video stay failed - because the plan was never the
   * thing that was broken. The plan was the reason the ASSET died; the asset
   * was the thing that stayed dead.
   *
   * GUARANTEES
   *
   *   * The source object is verified to still exist BEFORE anything is
   *     enqueued or created, so a doomed attempt is never started.
   *   * A repeated click is safe. A replacement is claimed atomically, so a
   *     second concurrent attempt is refused rather than minting a second
   *     asset, and a click that arrives while the new asset is in flight is
   *     refused as already in progress.
   *   * A video that is already queued or processing is not given a second
   *     job.
   *   * The source video, the R2 object and any valid output are preserved. A
   *     failed provider asset is left at the provider, inert, for the operator
   *     to delete once the replacement is proven.
   */
  async retryProcessing(videoId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: {
        id: true,
        courseId: true,
        lessonId: true,
        sourceKey: true,
        status: true,
        drmProvider: true,
        gumletAssetId: true,
        gumletStatus: true,
        processingJobId: true,
      },
    });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    if (!video.sourceKey) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'No source file to reprocess — re-upload the video',
      });
    }
    // Narrowed once, so the branch below does not have to re-prove it.
    const sourceKey = video.sourceKey;

    // The source object has to still be there. A recorded key only says it was
    // written once; a missing object would otherwise produce another doomed
    // attempt - and on the Gumlet path, another dead asset.
    const sourcePresent = await this.storage.exists('uploads', sourceKey);
    if (!sourcePresent) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message:
          'The stored source file is no longer in storage, so this video cannot be reprocessed — ' +
          're-upload the file and it will be processed from scratch',
      });
    }

    if (video.drmProvider === 'gumlet') {
      return this.retryGumletProcessing({ ...video, sourceKey }, actor);
    }

    // Already in the pipeline. A second job would transcode the same source
    // twice and race the first one to write the output - UNLESS the job is
    // gone, in which case the video is stranded and a new one is exactly what
    // is being asked for.
    if (video.status === VideoStatus.QUEUED || video.status === VideoStatus.PROCESSING) {
      if (await this.localJobIsLive(video.processingJobId)) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message:
            video.status === VideoStatus.QUEUED
              ? 'This video is already queued for processing'
              : 'This video is already being processed',
        });
      }
      this.logger.warn(
        `video ${videoId}: the recorded job is gone, so the video is stranded; reprocessing it`,
      );
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { processingError: null, processingStartedAt: null },
    });

    const jobId = await this.enqueueTranscode(
      { id: video.id, sourceKey, lessonId: video.lessonId, courseId: video.courseId },
      actor.id,
    );

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'video',
      entityId: videoId,
      note: 'Reprocessing requested (legacy ffmpeg path); a new transcode job was queued',
    });

    return { videoId, status: VideoStatus.QUEUED, jobId, provider: 'legacy', ...(await this.workerStatus()) };
  }

  /**
   * The Gumlet half of "reprocess".
   *
   * Three cases, and the difference between them is the whole point:
   *
   *   1. The asset reached a TERMINAL failure. The asset is dead and only a
   *      fresh ingest can replace it, so the dead id is discarded and a new
   *      asset is created from the same stored source.
   *   2. The asset is alive but not finished (or was never created). A poll is
   *      all that is needed - re-syncing is idempotent and safe.
   *   3. The video is already queued or processing. Refused, so a repeated
   *      click cannot start a second attempt.
   */
  private async retryGumletProcessing(
    video: {
      id: string;
      courseId: string;
      lessonId: string | null;
      sourceKey: string;
      status: VideoStatus;
      gumletAssetId: string | null;
      gumletStatus: string | null;
      processingJobId: string | null;
    },
    actor: { id: string; role: UserRole },
  ) {
    // `deleted` included: a deleted asset is as dead as a failed one, and only a
    // fresh ingest can bring the lecture back. See isTerminalGumletFailure().
    const terminalAssetFailure = isTerminalGumletFailure(video.gumletStatus);

    if (terminalAssetFailure) {
      // Mint a replacement asset. This is atomic: a concurrent attempt loses
      // the claim and is refused, so two clicks can never produce two live,
      // separately billed assets. It also checks the account's allowance
      // first, so an exhausted plan is reported as such instead of producing
      // another dead asset.
      const replaced = await this.gumletIngest.replaceFailedAsset(video.id, {
        allowGumletProviderReplacement: true,
        actor: { id: actor.id, role: actor.role },
      });

      // A poll job so the worker drives the new asset to READY rather than
      // leaving it to the half-hourly sweep.
      const jobId = await this.enqueueTranscode(
        { id: video.id, sourceKey: video.sourceKey, lessonId: video.lessonId, courseId: video.courseId },
        actor.id,
        // The asset already exists at the provider, so a queue failure must
        // not send the row back to UPLOADING: that would misreport a live
        // provider asset as an unfinished upload.
        { failureStatus: VideoStatus.PROCESSING },
      );

      await this.audit.record({
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.UPDATE,
        entity: 'video',
        entityId: video.id,
        after: { gumletAssetId: replaced.assetId, gumletStatus: replaced.status },
        note: 'Reprocessing requested (Gumlet path); the failed provider asset was replaced with a fresh ingest of the same stored source',
      });

      this.logger.warn(
        `video ${video.id}: replaced the failed Gumlet asset with ${replaced.assetId} at the request of ${actor.id}`,
      );

      return {
        videoId: video.id,
        status: VideoStatus.QUEUED,
        jobId,
        provider: 'gumlet',
        assetId: replaced.assetId,
        recovered: true,
        ...(await this.workerStatus()),
      };
    }

    // The asset is alive (or absent). Re-syncing it is idempotent, so a poll
    // job is safe - but a video that is already in the pipeline is not given
    // a second one.
    if (video.status === VideoStatus.QUEUED || video.status === VideoStatus.PROCESSING) {
      if (await this.localJobIsLive(video.processingJobId)) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message:
            video.status === VideoStatus.QUEUED
              ? 'This video is already queued for processing'
              : 'This video is already being processed by Gumlet — wait for it to finish',
        });
      }
      // The job is gone but the provider asset is alive: the video is stranded
      // between the two. Re-queue a poll so the worker drives the asset to
      // READY instead of waiting for the next sweep.
      this.logger.warn(
        `video ${video.id}: the recorded job is gone, so the video is stranded; re-queueing a poll`,
      );
    }

    await this.prisma.video.update({
      where: { id: video.id },
      data: { processingError: null, processingStartedAt: null },
    });

    const jobId = await this.enqueueTranscode(
      { id: video.id, sourceKey: video.sourceKey, lessonId: video.lessonId, courseId: video.courseId },
      actor.id,
      { failureStatus: VideoStatus.PROCESSING },
    );

    return {
      videoId: video.id,
      status: VideoStatus.QUEUED,
      jobId,
      provider: 'gumlet',
      recovered: false,
      ...(await this.workerStatus()),
    };
  }

  // ---------------------------------------------------------------------------
  // Called by the worker
  // ---------------------------------------------------------------------------

  /**
   * Claims a video for processing. Returns false for a job that is no longer
   * current — the video was deleted, or re-uploaded so its source changed —
   * which the worker then skips instead of overwriting the newer state.
   */
  async markProcessing(videoId: string, sourceKey?: string): Promise<boolean> {
    const claimed = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        deletedAt: null,
        ...(sourceKey ? { sourceKey } : {}),
        // UPLOADING is included because `enqueueTranscode` writes QUEUED only
        // after the job is in Redis; a fast worker can claim the job first and
        // must not treat that window as a stale job.
        status: {
          in: [VideoStatus.UPLOADING, VideoStatus.QUEUED, VideoStatus.PROCESSING, VideoStatus.FAILED],
        },
      },
      data: { status: VideoStatus.PROCESSING, processingStartedAt: new Date(), processingError: null },
    });
    return claimed.count > 0;
  }

  async markReady(
    videoId: string,
    result: {
      durationSeconds: number;
      width: number;
      height: number;
      frameRate?: number;
      videoCodec?: string;
      audioCodec?: string;
      hlsPrefix: string;
      masterPlaylistKey: string;
      thumbnailKey?: string;
      isEncrypted: boolean;
      encryptionKeyId?: string;
      renditions: {
        height: number;
        width: number;
        bitrateKbps: number;
        playlistKey: string;
        sizeBytes?: number;
      }[];
    },
  ): Promise<void> {
    // Every course whose lecture just received this duration; recounted below.
    const touchedCourseIds = new Set<string>();

    const video = await this.prisma.$transaction(async (tx) => {
      await tx.videoRendition.deleteMany({ where: { videoId } });

      const updated = await tx.video.update({
        where: { id: videoId },
        data: {
          status: VideoStatus.READY,
          durationSeconds: result.durationSeconds,
          width: result.width,
          height: result.height,
          frameRate: result.frameRate,
          videoCodec: result.videoCodec,
          audioCodec: result.audioCodec,
          hlsPrefix: result.hlsPrefix,
          masterPlaylistKey: result.masterPlaylistKey,
          thumbnailKey: result.thumbnailKey,
          isEncrypted: result.isEncrypted,
          encryptionKeyId: result.encryptionKeyId,
          processedAt: new Date(),
          processingError: null,
          // The legacy local transcode produces exactly the mobile pipeline's
          // output, so a video that finished here is mobile-ready too.
          mobileStatus: MobileVideoStatus.READY,
          mobileError: null,
          mobileProcessedAt: new Date(),
          renditions: {
            create: result.renditions.map((r) => ({
              height: r.height,
              width: r.width,
              bitrateKbps: r.bitrateKbps,
              playlistKey: r.playlistKey,
              sizeBytes: r.sizeBytes ? BigInt(r.sizeBytes) : null,
            })),
          },
        },
        include: { lesson: { select: { id: true, title: true, courseId: true } } },
      });

      // The duration belongs to every LECTURE this asset is attached to, not just
      // the one that uploaded it. A reused lecture has no worker of its own, so
      // if it is not written here it would keep rendering a zero-length lecture
      // for a video that plays perfectly.
      const attachedLessonIds = await tx.lessonVideo.findMany({
        where: { videoId },
        select: { lessonId: true, lesson: { select: { courseId: true } } },
      });
      const lessonIds = new Set(attachedLessonIds.map((link) => link.lessonId));
      if (updated.lessonId) lessonIds.add(updated.lessonId);

      touchedCourseIds.add(updated.courseId);
      for (const link of attachedLessonIds) touchedCourseIds.add(link.lesson.courseId);
      if (updated.lesson?.courseId) touchedCourseIds.add(updated.lesson.courseId);

      if (lessonIds.size > 0) {
        await tx.lesson.updateMany({
          where: { id: { in: [...lessonIds] } },
          data: { durationSeconds: result.durationSeconds },
        });
      }

      return updated;
    });

    // Course totals are SUM(lesson durations): every course that just received
    // the duration is stale, destinations included - not only the uploader's.
    for (const courseId of touchedCourseIds) {
      await this.courses.recountCourse(courseId);
    }

    // Tell enrolled students. This is the "new video" notification from §63.
    //
    // Skipped when the asset has no origin lecture (a reused asset whose author
    // lesson was removed). There is no lesson to link to, and a notification
    // pointing at the wrong lecture would be worse than none.
    if (video.lesson && video.lessonId) {
      await this.notifications
        .notifyCourseStudents(video.courseId, {
          kind: NotificationKind.NEW_VIDEO,
          title: 'New video available',
          titleAr: 'فيديو جديد متاح',
          body: `${video.lesson.title} is ready to watch.`,
          bodyAr: `${video.lesson.title} أصبح جاهزًا للمشاهدة.`,
          route: `/lesson/${video.lessonId}`,
        })
        .catch((e) => this.logger.warn(`new-video notification failed: ${e.message}`));
    }

    this.logger.log(`video ${videoId} is READY (${result.renditions.length} renditions)`);
  }

  /**
   * Records a processing failure - unless the video is already READY.
   *
   * Conditional on purpose: the sweep and a failing job both decide from a row
   * they read earlier, and meanwhile a provider sync (or a duplicate job) may
   * have finished the video. A READY video is never turned back into FAILED.
   * Returns whether the failure was recorded.
   */
  async markFailed(videoId: string, error: string): Promise<boolean> {
    const { count } = await this.prisma.video.updateMany({
      where: { id: videoId, status: { not: VideoStatus.READY } },
      data: { status: VideoStatus.FAILED, processingError: error.slice(0, 1000) },
    });
    if (count === 0) {
      this.logger.warn(`video ${videoId}: failure not recorded, the video is already READY (or gone): ${error}`);
      return false;
    }
    this.logger.error(`video ${videoId} processing failed: ${error}`);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Captions
  // ---------------------------------------------------------------------------

  async addCaption(
    videoId: string,
    input: { language: string; label: string; objectKey: string; isDefault?: boolean },
    actor: { id: string; role: UserRole },
  ) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId } });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    // The key is signed for every viewer of this video on each ticket, so it
    // must be one issued for THIS video's captions. Without the check a staff
    // member could point a caption at any object in storage (another course's
    // attachment, a paid library PDF) and receive a signed URL for it.
    assertObjectKeyInNamespace(input.objectKey, `captions/${videoId}/`, 'objectKey');

    if (input.isDefault) {
      await this.prisma.captionTrack.updateMany({
        where: { videoId },
        data: { isDefault: false },
      });
    }

    return this.prisma.captionTrack.upsert({
      where: { videoId_language: { videoId, language: input.language } },
      create: {
        videoId,
        language: input.language,
        label: input.label,
        objectKey: input.objectKey,
        isDefault: input.isDefault ?? false,
      },
      update: {
        label: input.label,
        objectKey: input.objectKey,
        isDefault: input.isDefault ?? false,
      },
    });
  }

  async removeCaption(videoId: string, language: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId } });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    await this.prisma.captionTrack.deleteMany({ where: { videoId, language } });
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  /**
   * Removes a video from ONE lecture, archiving the asset only when no other
   * live lecture still uses it.
   *
   * `lessonId` names the lecture the staff member is removing it from. It is
   * required whenever the asset is attached to more than one live lecture:
   * guessing would detach the wrong lecture (historically it always detached
   * the uploading lecture, so "remove from this lecture" in a destination course
   * silently stripped the SOURCE course instead).
   *
   * When the asset is archived, the row stays because watch events reference
   * it; the bytes go because storage costs money and an archived lecture does
   * not need to remain streamable. The Gumlet asset is never deleted here.
   */
  async remove(
    videoId: string,
    actor: { id: string; role: UserRole },
    purgeObjects = true,
    lessonId?: string,
  ) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId, ...notDeleted } });
    if (!video) throw AppException.notFound('Video', videoId);

    const links = await this.loadAttachments(videoId);
    const live = links.filter((l) => !l.lesson.deletedAt);
    const target = this.resolveRemovalTarget(videoId, live, lessonId);

    // Authorise in the course the staff member is acting in: the target
    // lecture's course. For a reused asset that is the DESTINATION course,
    // not whichever course happened to upload the file.
    const actingCourseId = target ? target.lesson.courseId : video.courseId;
    await this.access.assertCanManageCourse(actor.id, actor.role, actingCourseId, 'content');
    await this.access.assertTeacherCapability(actor.role, 'deleteVideos');

    const others = live.filter((l) => l.lessonId !== target?.lessonId);
    if (others.length > 0) {
      // Still in use elsewhere: detach from the target lecture only.
      return this.detachFromLesson(video, target as AttachmentRow, actor, others.length);
    }

    // Archiving the asset and purging its bytes is a decision about the
    // uploading course's media, so it also needs that course's permission when
    // the last live lecture belongs to a different course.
    if (actingCourseId !== video.courseId) {
      await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');
    }

    const now = new Date();
    const attachedLessonIds = links.map((l) => l.lessonId);

    await this.prisma.$transaction(async (tx) => {
      await tx.video.update({
        where: { id: videoId },
        data: { status: VideoStatus.ARCHIVED, deletedAt: now },
      });

      // Anyone mid-stream loses the grant at the next playlist fetch rather
      // than watching a video that no longer exists until the ticket lapses.
      await tx.playbackTicket.updateMany({
        where: { videoId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Video deleted' },
      });

      // The duration came from this video, so it is reset on the lectures that
      // were attached to THIS video - and only if they have no other live video.
      await this.clearDurationOfVideolessLessons(tx, videoId, attachedLessonIds);
    });

    // Drop any job still waiting so a deleted video is not transcoded later.
    if (video.processingJobId) {
      await this.queue
        .getJob(video.processingJobId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }

    for (const courseId of uniqueCourseIds(video.courseId, links)) {
      await this.courses.recountCourse(courseId);
    }

    // THE PURGE IS THE DANGEROUS PART, so it is gated on the same condition as
    // the archive: bytes are only deleted once no live lecture points at this asset.
    if (purgeObjects) {
      if (video.hlsPrefix) {
        await this.storage.deletePrefix('media', video.hlsPrefix).catch(() => undefined);
      }
      if (video.sourceKey) {
        await this.storage.deleteObject('uploads', video.sourceKey).catch(() => undefined);
      }
      // The whole source prefix, not just the key the row points at.
      //
      // Every upload attempt mints a fresh key, so a video that was uploaded
      // more than once has objects under this prefix that no row references.
      // Deleting only the current one left those behind — unreachable bytes
      // that still cost money, on a bucket that is supposed to hold nothing
      // but live material.
      await this.storage
        .deletePrefix('uploads', `source/videos/${videoId}/`)
        .catch(() => undefined);
    }

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'video',
      entityId: videoId,
      note: purgeObjects ? 'Metadata archived, media objects purged' : 'Metadata archived',
    });

    return { ok: true, detached: false, remainingAttachments: 0 };
  }

  /**
   * Detaches a video from one lecture and NEVER archives or purges the asset,
   * even when this was its last lecture (that stays an explicit `remove()`).
   * Authorised against the lecture's own course.
   */
  async detach(videoId: string, lessonId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId, ...notDeleted } });
    if (!video) throw AppException.notFound('Video', videoId);

    const live = (await this.loadAttachments(videoId)).filter((l) => !l.lesson.deletedAt);
    const target = this.resolveRemovalTarget(videoId, live, lessonId) as AttachmentRow;

    await this.access.assertCanManageCourse(actor.id, actor.role, target.lesson.courseId, 'content');

    const remaining = live.filter((l) => l.lessonId !== target.lessonId).length;
    return this.detachFromLesson(video, target, actor, remaining);
  }

  /** Every attachment row of THIS video, with the lecture's course and deletion state. */
  private async loadAttachments(videoId: string): Promise<AttachmentRow[]> {
    if (!videoId) throw new Error('loadAttachments requires a videoId');
    return this.prisma.lessonVideo.findMany({
      where: { videoId },
      select: { lessonId: true, lesson: { select: { courseId: true, deletedAt: true } } },
    });
  }

  /**
   * Which lecture a removal applies to. Never guessed: an explicit lesson must
   * be one of the asset's live lectures, and a shared asset requires one.
   * Returns null only when the asset has no live lecture at all.
   */
  private resolveRemovalTarget(
    videoId: string,
    live: AttachmentRow[],
    lessonId: string | undefined,
  ): AttachmentRow | null {
    if (lessonId) {
      const match = live.find((l) => l.lessonId === lessonId);
      if (!match) {
        throw new AppException(ErrorCode.NOT_FOUND, {
          message: 'This video is not attached to that lecture',
          details: { videoId, lessonId },
        });
      }
      return match;
    }
    if (live.length <= 1) return live[0] ?? null;
    throw new AppException(ErrorCode.CONFLICT, {
      message: `This video is used by ${live.length} lectures. Say which lecture to remove it from.`,
      details: { videoId, attachedLessons: live.length },
    });
  }

  private async detachFromLesson(
    video: { id: string; lessonId: string | null },
    target: AttachmentRow,
    actor: { id: string; role: UserRole },
    remainingAttachments: number,
  ) {
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.lessonVideo.deleteMany({ where: { lessonId: target.lessonId, videoId: video.id } });

      // Students watching through THIS lecture lose the grant; other courses'
      // streams of the same asset are untouched.
      await tx.playbackTicket.updateMany({
        where: { videoId: video.id, lessonId: target.lessonId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Video removed from this lecture' },
      });

      // Detaching the uploading lecture releases the legacy one-video-per-lesson
      // pointer. Left set, lesson detail would keep showing the "owned" video on
      // a lecture that can no longer play it, and the unique index would block a
      // new upload to that lecture.
      if (video.lessonId === target.lessonId) {
        await tx.video.update({ where: { id: video.id }, data: { lessonId: null } });
      }

      await this.clearDurationOfVideolessLessons(tx, video.id, [target.lessonId]);
    });

    await this.courses.recountCourse(target.lesson.courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'video',
      entityId: video.id,
      note: `Detached from lesson ${target.lessonId}; asset kept for ${remainingAttachments} other lecture(s)`,
    });

    return { ok: true, detached: true, remainingAttachments };
  }

  /**
   * Zeroes `durationSeconds` on the given lectures, skipping any that still
   * have ANOTHER live video attached. The id list is always explicit: an empty
   * or undefined filter here would rewrite every lecture on the platform.
   */
  private async clearDurationOfVideolessLessons(
    tx: Prisma.TransactionClient,
    videoId: string,
    lessonIds: string[],
  ): Promise<void> {
    const ids = [...new Set(lessonIds.filter((id): id is string => typeof id === 'string' && id.length > 0))];
    if (ids.length === 0) return;

    const stillPlaying = await tx.lessonVideo.findMany({
      where: { lessonId: { in: ids }, videoId: { not: videoId }, video: { deletedAt: null } },
      select: { lessonId: true },
    });
    const keep = new Set(stillPlaying.map((l) => l.lessonId));
    const clear = ids.filter((id) => !keep.has(id));
    if (clear.length === 0) return;

    await tx.lesson.updateMany({
      where: { id: { in: clear } },
      data: { durationSeconds: 0 },
    });
  }
}

type AttachmentRow = { lessonId: string; lesson: { courseId: string; deletedAt: Date | null } };

function uniqueCourseIds(ownerCourseId: string, links: AttachmentRow[]): string[] {
  return [...new Set([ownerCourseId, ...links.map((l) => l.lesson.courseId)])];
}
