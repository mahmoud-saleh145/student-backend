import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  NotificationKind,
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
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';
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
      },
    });
    if (!lesson) throw AppException.notFound('Lesson', params.lessonId);

    await this.access.assertCanManageCourse(actor.id, actor.role, lesson.courseId, 'content');

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

    const video = lesson.video
      ? await this.prisma.video.update({
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
      : await this.prisma.video.create({
          data: {
            lessonId: lesson.id,
            courseId: lesson.courseId,
            status: VideoStatus.UPLOADING,
            uploadedById: actor.id,
            // Set here, not by a later staff action, so every new upload enters
            // the Gumlet workflow automatically. See resolveNewVideoProvider().
            drmProvider: this.resolveNewVideoProvider(),
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
    // rows; nothing ever removes this one implicitly.
    await this.prisma.lessonVideo.upsert({
      where: { lessonId_videoId: { lessonId: lesson.id, videoId: video.id } },
      update: {},
      create: { lessonId: lesson.id, videoId: video.id, createdById: actor.id, sortOrder: 0 },
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
   */
  private async enqueueTranscode(
    video: { id: string; sourceKey: string; lessonId: string | null; courseId: string },
    requestedById?: string,
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
          jobId: `transcode:${video.id}:${Date.now()}`,
        },
      );
      jobId = String(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.prisma.video.update({
        where: { id: video.id },
        data: {
          status: VideoStatus.UPLOADING,
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
  async recoverStrandedVideos(now = new Date()): Promise<{ requeued: number; failed: number }> {
    const queuedCutoff = new Date(now.getTime() - 10 * 60_000);
    const processingCutoff = new Date(now.getTime() - 3 * 3600_000);

    const stranded = await this.prisma.video.findMany({
      where: {
        ...notDeleted,
        OR: [
          { status: VideoStatus.QUEUED, updatedAt: { lt: queuedCutoff } },
          { status: VideoStatus.PROCESSING, processingStartedAt: { lt: processingCutoff } },
        ],
      },
      select: {
        id: true,
        status: true,
        sourceKey: true,
        lessonId: true,
        courseId: true,
        processingJobId: true,
      },
      take: 50,
    });

    let requeued = 0;
    let failed = 0;

    for (const video of stranded) {
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

    if (requeued || failed) {
      this.logger.warn(`stranded videos: requeued ${requeued}, marked failed ${failed}`);
    }
    return { requeued, failed };
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

  async retryProcessing(videoId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId, ...notDeleted } });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    if (!video.sourceKey) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'No source file to reprocess — re-upload the video',
      });
    }
    if (video.status === VideoStatus.PROCESSING) {
      throw new AppException(ErrorCode.INVALID_STATE, { message: 'Already processing' });
    }

    await this.prisma.video.update({
      where: { id: videoId },
      data: { processingError: null, processingStartedAt: null },
    });

    const jobId = await this.enqueueTranscode(
      { id: video.id, sourceKey: video.sourceKey, lessonId: video.lessonId, courseId: video.courseId },
      actor.id,
    );

    return { videoId, status: VideoStatus.QUEUED, jobId, ...(await this.workerStatus()) };
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
        select: { lessonId: true },
      });
      const lessonIds = new Set(attachedLessonIds.map((link) => link.lessonId));
      if (updated.lessonId) lessonIds.add(updated.lessonId);

      if (lessonIds.size > 0) {
        await tx.lesson.updateMany({
          where: { id: { in: [...lessonIds] } },
          data: { durationSeconds: result.durationSeconds },
        });
      }

      return updated;
    });

    await this.courses.recountCourse(video.courseId);

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
   * Soft-deletes the metadata and purges the media objects.
   *
   * The row stays because watch events reference it; the bytes go because
   * storage costs money and an archived lecture does not need to remain
   * streamable.
   */
  async remove(videoId: string, actor: { id: string; role: UserRole }, purgeObjects = true) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId, ...notDeleted } });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');
    await this.access.assertTeacherCapability(actor.role, 'deleteVideos');

    const now = new Date();

    // How many OTHER lectures still reference this asset. This single number
    // decides whether removing the video may destroy the media, and it is the
    // whole reason reuse needs this method to be attachment-aware: deleting a
    // reused video from one lecture used to purge the source object and the HLS
    // output, blacking out every other course that was still streaming it.
    const remainingAttachments = await this.lessonVideos.countLiveAttachments(videoId);

    // The asset itself only disappears once nothing points at it any more. While
    // other lectures are still attached we leave the row live so their playback
    // keeps working; the lecture that asked for removal is detached instead.
    const destroyAsset = remainingAttachments <= 1;

    await this.prisma.$transaction(async (tx) => {
      if (destroyAsset) {
        await tx.video.update({
          where: { id: videoId },
          data: { status: VideoStatus.ARCHIVED, deletedAt: now },
        });
      } else {
        // Still in use elsewhere: detach from THIS lesson only.
        if (video.lessonId) {
          await tx.lessonVideo.deleteMany({
            where: { lessonId: video.lessonId, videoId },
          });
        }
      }

      // Anyone mid-stream loses the grant at the next playlist fetch rather
      // than watching a video that no longer exists until the ticket lapses.
      // Only revoked when the asset is really going away - a detach must not
      // interrupt students who are legitimately watching the same file in
      // another course.
      if (destroyAsset) {
        await tx.playbackTicket.updateMany({
          where: { videoId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Video deleted' },
        });
      }

      // The lecture's duration came from this video (see markReady). Reset it on
      // every lecture that no longer has a video.
      const detachedLessonIds = await tx.lessonVideo.findMany({
        where: { videoId: destroyAsset ? undefined : { not: video.lessonId ?? undefined } },
        select: { lessonId: true },
      });
      const lessonIdsToClear = destroyAsset
        ? detachedLessonIds.map((l) => l.lessonId)
        : [video.lessonId].filter((id): id is string => Boolean(id));

      if (lessonIdsToClear.length > 0) {
        await tx.lesson.updateMany({
          where: { id: { in: lessonIdsToClear } },
          data: { durationSeconds: 0 },
        });
      }
    });

    // Drop any job still waiting so a deleted video is not transcoded later.
    // Only when the asset is actually going away - an in-flight job for a shared
    // asset still has a destination lecture that needs it.
    if (destroyAsset && video.processingJobId) {
      await this.queue
        .getJob(video.processingJobId)
        .then((job) => job?.remove())
        .catch(() => undefined);
    }

    await this.courses.recountCourse(video.courseId);

    // THE PURGE IS THE DANGEROUS PART, so it is gated on the same condition as
    // the archive: bytes are only deleted once no lecture points at this asset.
    if (purgeObjects && destroyAsset) {
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
      note: destroyAsset
        ? purgeObjects
          ? 'Metadata archived, media objects purged'
          : 'Metadata archived'
        : `Detached from lesson; asset kept for ${remainingAttachments - 1} other attachment(s)`,
    });

    return { ok: true, detached: !destroyAsset, remainingAttachments };
  }
}
