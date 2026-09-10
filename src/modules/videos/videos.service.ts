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
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { StorageService } from '../storage/storage.service';

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
    @InjectQueue(QUEUE_NAMES.video) private readonly queue: Queue<TranscodeJobData>,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  // ---------------------------------------------------------------------------
  // Upload
  // ---------------------------------------------------------------------------

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
      select: { id: true, courseId: true, video: { select: { id: true, status: true } } },
    });
    if (!lesson) throw AppException.notFound('Lesson', params.lessonId);

    await this.access.assertCanManageCourse(actor.id, actor.role, lesson.courseId, 'content');

    // Uploading over an existing video replaces the source a student streams.
    // That is the operation the "edit video URLs" switch governs; a first
    // upload onto an empty lesson is ordinary content authoring and is not
    // gated by it.
    if (lesson.video) {
      await this.access.assertTeacherCapability(actor.role, 'editVideoUrls');
    }

    // Replacing a video: reuse the row so the lesson↔video relation and every
    // watch event that references it survive.
    const video = lesson.video
      ? await this.prisma.video.update({
          where: { id: lesson.video.id },
          data: {
            status: VideoStatus.UPLOADING,
            processingError: null,
            uploadedById: actor.id,
          },
        })
      : await this.prisma.video.create({
          data: {
            lessonId: lesson.id,
            courseId: lesson.courseId,
            status: VideoStatus.UPLOADING,
            uploadedById: actor.id,
          },
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

    await this.prisma.video.update({
      where: { id: videoId },
      data: {
        status: VideoStatus.QUEUED,
        sourceSizeBytes: BigInt(size),
        processingError: null,
        processingStartedAt: null,
      },
    });

    const job = await this.queue.add(
      VIDEO_JOBS.transcode,
      {
        videoId,
        sourceKey: video.sourceKey,
        lessonId: video.lessonId,
        courseId: video.courseId,
        ladder: this.cfg.ladder,
        encrypt: this.cfg.encryptionEnabled,
        requestedById: actor.id,
      },
      {
        ...DEFAULT_JOB_OPTIONS,
        // Transcoding is expensive; two attempts, not three.
        attempts: 2,
        jobId: `transcode:${videoId}:${Date.now()}`,
      },
    );

    await this.prisma.video.update({
      where: { id: videoId },
      data: { processingJobId: String(job.id) },
    });

    this.logger.log(`queued transcode job ${job.id} for video ${videoId} (${size} bytes)`);

    return { videoId, status: VideoStatus.QUEUED, jobId: job.id };
  }

  // ---------------------------------------------------------------------------
  // Status
  // ---------------------------------------------------------------------------

  async status(videoId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId },
      include: {
        renditions: { orderBy: { height: 'asc' } },
        captions: true,
        lesson: { select: { id: true, title: true, courseId: true } },
      },
    });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');

    return {
      id: video.id,
      lessonId: video.lessonId,
      courseId: video.courseId,
      status: video.status,
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
    };
  }

  async retryProcessing(videoId: string, actor: { id: string; role: UserRole }) {
    const video = await this.prisma.video.findFirst({ where: { id: videoId } });
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
      data: { status: VideoStatus.QUEUED, processingError: null },
    });

    const job = await this.queue.add(
      VIDEO_JOBS.transcode,
      {
        videoId,
        sourceKey: video.sourceKey,
        lessonId: video.lessonId,
        courseId: video.courseId,
        ladder: this.cfg.ladder,
        encrypt: this.cfg.encryptionEnabled,
        requestedById: actor.id,
      },
      { ...DEFAULT_JOB_OPTIONS, attempts: 2 },
    );

    return { videoId, status: VideoStatus.QUEUED, jobId: job.id };
  }

  // ---------------------------------------------------------------------------
  // Called by the worker
  // ---------------------------------------------------------------------------

  async markProcessing(videoId: string): Promise<void> {
    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.PROCESSING, processingStartedAt: new Date() },
    });
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

      // The lesson's duration comes from the video, so cards and progress
      // calculations stay accurate without a manual entry step.
      await tx.lesson.update({
        where: { id: updated.lessonId },
        data: { durationSeconds: result.durationSeconds },
      });

      return updated;
    });

    await this.courses.recountCourse(video.courseId);

    // Tell enrolled students. This is the "new video" notification from §63.
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
    const video = await this.prisma.video.findFirst({ where: { id: videoId } });
    if (!video) throw AppException.notFound('Video', videoId);

    await this.access.assertCanManageCourse(actor.id, actor.role, video.courseId, 'content');
    await this.access.assertTeacherCapability(actor.role, 'deleteVideos');

    await this.prisma.video.update({
      where: { id: videoId },
      data: { status: VideoStatus.ARCHIVED, deletedAt: new Date() },
    });

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

    return { ok: true };
  }
}
