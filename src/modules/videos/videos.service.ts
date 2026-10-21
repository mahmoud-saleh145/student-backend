import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
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
  QUEUE_NAMES,
  VIDEO_JOBS,
  type TranscodeJobData,
} from '../../jobs/queue.constants';
import { readWorkerHeartbeat } from '../../jobs/worker-heartbeat';
import { TRANSCODE_BACKOFF_BASE_MS, TRANSCODE_BACKOFF_JITTER } from '../../jobs/queue.tuning';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
import { GumletIngestService } from './gumlet-ingest.service';
import { LessonVideoService } from './lesson-video.service';

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-matroska',
  'video/webm',
  'video/x-msvideo',
]);

const MAX_SOURCE_BYTES = 8 * 1024 * 1024 * 1024; // 8 GB

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
        sizeBytes: [`exceeds the ${MAX_SOURCE_BYTES / 1024 ** 3} GB limit`],
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
    const liveVideo = lesson.video && !lesson.video.deletedAt ? lesson.video : null;
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
   */
  async completeUpload(videoId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: { id: true, courseId: true, sourceKey: true, status: true, lessonId: true },
    });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    if (!video.sourceKey) {
      throw new AppException(ErrorCode.INVALID_STATE, { message: 'No upload was initialised' });
    }

    const size = await this.storage.objectSize('uploads', video.sourceKey);
    if (size === null) {
      throw new AppException(ErrorCode.UPLOAD_FAILED, {
        message: 'The uploaded object was not found in storage',
      });
    }

    if (video.status === VideoStatus.PROCESSING) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This video is already being processed',
      });
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        sourceSizeBytes: BigInt(size),
        processingError: null,
        processingStartedAt: null,
      },
    });

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
    // Asynchronous by construction - the admin's upload returns as soon as this
    // enqueue succeeds, and any Gumlet slowness or failure is recorded on the row
    // rather than blocking or rolling back the upload the student will later need.
    // -------------------------------------------------------------------------

    const jobId = await this.enqueueTranscode(
      { id: videoId, sourceKey: video.sourceKey, lessonId: video.lessonId, courseId: video.courseId },
      actor.id,
    );

    this.logger.log(`queued transcode job ${jobId} for video ${videoId} (${size} bytes)`);

    return { videoId, status: VideoStatus.QUEUED, jobId, ...(await this.workerStatus()) };
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
      const job = await this.queue.add(
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
      );
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
  async recoverStrandedVideos(now = new Date()): Promise<{ requeued: number; failed: number; synced: number }> {
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
        await this.markFailed(
          video.id,
          `Processing was interrupted (job ${state}); retry to process the stored file again`,
        );
        failed += 1;
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
    return { requeued, failed, synced };
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

    return {
      id: video.id,
      lessonId: video.lessonId,
      courseId: video.courseId,
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
      captions: video.captions.map((c) => ({
        language: c.language,
        label: c.label,
        isDefault: c.isDefault,
      })),
      processingError: video.processingError,
      processingStartedAt: video.processingStartedAt?.toISOString() ?? null,
      processedAt: video.processedAt?.toISOString() ?? null,
      sourceSizeBytes: video.sourceSizeBytes ? Number(video.sourceSizeBytes) : null,
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
    const terminalAssetFailure = video.gumletStatus === 'errored' || video.gumletStatus === 'failed';

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
        status: { in: [VideoStatus.QUEUED, VideoStatus.PROCESSING, VideoStatus.FAILED] },
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

  async markFailed(videoId: string, error: string): Promise<void> {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.FAILED, processingError: error.slice(0, 1000) },
    });
    this.logger.error(`video ${videoId} processing failed: ${error}`);
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
