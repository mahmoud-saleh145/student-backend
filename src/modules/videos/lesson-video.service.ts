import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { PrismaService } from '../../database/prisma.service';
import { CoursesService } from '../courses/courses.service';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/** A video as it is exposed for a lecture that ATTACHES to it. */
export interface AttachedVideo {
  id: string;
  title: string | null;
  status: string;
  durationSeconds: number;
  width: number | null;
  height: number | null;
  drmProvider: string | null;
  gumletAssetId: string | null;
  deletedAt: Date | null;
  /**
   * True when this lecture OWNS the asset (uploaded to it), false when the asset
   * was reused from another lecture. Purely informational - it never changes
   * entitlement, which is always evaluated against the requesting lecture.
   */
  ownedByThisLesson: boolean;
}

const notDeleted = { deletedAt: null } as const;

/**
 * Attachment of existing video assets to lectures.
 *
 * ## Why this exists
 *
 * `Video` is the single record that owns an upload: the R2 source object, the
 * Gumlet asset id, the DRM/CENC state and the processing status. Before this
 * service there was exactly one way to point a lecture at a video - by uploading
 * a file to it - so "use this same video in another course" had only two
 * possible implementations: overwrite `videos.lessonId` (which silently
 * re-points every other lecture away from its media) or duplicate the file
 * (a second upload, a second Gumlet asset, a second DRM state to keep in sync,
 * and a second copy of the bytes to store forever).
 *
 * This service implements the third option: attach the SAME `Video` row to
 * another lecture via `lesson_videos`. Nothing is uploaded, nothing is ingested,
 * no Gumlet asset is created and no metadata is copied.
 *
 * ## What reuse deliberately does NOT do
 *
 * Attaching shares an ASSET, not an ENTITLEMENT. Nothing in this service grants
 * access to a course: playback authorisation is evaluated per lecture in
 * `PlaybackService`, against the lecture the ticket was requested for. A student
 * enrolled in the destination course may play the shared asset there, and a
 * student who is not enrolled there gains nothing by knowing the video id or the
 * Gumlet asset id. Authorisation for the attach/detach itself is checked
 * against the DESTINATION course, so staff who can manage the source course but
 * not the destination cannot spread assets into it.
 */
@Injectable()
export class LessonVideoService {
  private readonly logger = new Logger(LessonVideoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
  ) {}

  /**
   * Resolves the video attached to a lecture.
   *
   * A lecture's OWNED video wins over a reused one, so the historical
   * "uploaded to this lecture" behaviour is preserved exactly. Ordering falls
   * back to `sortOrder` then the oldest link so the answer is deterministic
   * rather than dependent on insertion order.
   *
   * This is the single read path that understands reuse. Legacy readers that do
   * `lesson.video` only ever see the owned video, which is why attaching to a
   * second lecture cannot change the first lecture's behaviour.
   */
  async resolveAttachedVideo(lessonId: string): Promise<AttachedVideo | null> {
    const link = await this.prisma.lessonVideo.findFirst({
      where: { lessonId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: {
        video: {
          select: {
            id: true,
            status: true,
            durationSeconds: true,
            width: true,
            height: true,
            drmProvider: true,
            gumletAssetId: true,
            deletedAt: true,
            lessonId: true,
          },
        },
      },
    });

    if (!link) return null;
    return this.toAttachedVideo(link.video, link.video.lessonId === lessonId);
  }

  /**
   * Attaches an existing video to a lecture. Idempotent.
   *
   * Deliberately does NOT: create a video row, enqueue a transcode job, call
   * Gumlet, touch R2, or copy any metadata. The destination lecture inherits the
   * asset exactly as it is, including its duration and its DRM verification.
   *
   * @returns `created: false` when the mapping already existed, so callers can
   *          apply the same mapping repeatedly without creating duplicates.
   */
  async attach(params: {
    lessonId: string;
    videoId: string;
    actorId: string;
  }): Promise<{ created: boolean; video: AttachedVideo }> {
    const { lessonId, videoId, actorId } = params;

    const [lesson, video] = await Promise.all([
      this.prisma.lesson.findFirst({
        where: { id: lessonId, ...notDeleted },
        select: { id: true, title: true },
      }),
      this.prisma.video.findFirst({
        where: { id: videoId, ...notDeleted },
        select: { id: true, lessonId: true, status: true },
      }),
    ]);

    if (!lesson) throw new NotFoundException('Lesson not found');
    if (!video) throw new NotFoundException('Video not found');

    // The composite primary key is (lessonId, videoId), so this upsert is the
    // uniqueness guarantee. A second identical call is a no-op rather than a
    // duplicate row.
    const existing = await this.prisma.lessonVideo.findUnique({
      where: { lessonId_videoId: { lessonId, videoId } },
      select: { lessonId: true },
    });

    if (!existing) {
      // One live video per lecture. A second attachment would make lesson detail
      // and the ticket resolver disagree about which file the lecture plays.
      const occupied = await this.prisma.lessonVideo.findFirst({
        where: { lessonId, videoId: { not: videoId }, video: { ...notDeleted } },
        select: { videoId: true },
      });
      if (occupied) {
        throw new AppException(ErrorCode.CONFLICT, {
          message: 'This lecture already has a video. Remove it before attaching another.',
          details: { lessonId, attachedVideoId: occupied.videoId },
        });
      }

      await this.prisma.lessonVideo.create({
        data: { lessonId, videoId, createdById: actorId, sortOrder: 0 },
      });

      // The destination lecture's denormalised duration follows the asset.
      // Without this the destination would render a zero-length lecture until
      // something else happened to recompute it.
      await this.propagateDurationToAttachedLessons(videoId);
    }

    const attached = await this.resolveAttachedVideo(lessonId);
    if (!attached) throw new NotFoundException('Lesson not found');

    this.logger.log(
      `attached video ${videoId} to lesson ${lessonId}${existing ? ' (already attached)' : ''}`,
    );

    return { created: !existing, video: attached };
  }

  /**
   * Detaches a video from a lecture.
   *
   * Removing an attachment NEVER touches the shared asset while another lecture
   * still uses it. That is the whole hazard of reuse: a staff member detaching a
   * reused video from their own lecture must not delete the media, revoke the
   * other course's tickets or purge the source object that a different course
   * is still serving.
   *
   * @returns `assetDestroyed` - true only when this was the last attachment and
   *          the asset itself was removed. Callers that need to know whether the
   *          underlying video still exists can read it.
   */
  async detach(params: { lessonId: string; videoId: string }): Promise<{
    assetDestroyed: boolean;
    remainingAttachments: number;
  }> {
    const { lessonId, videoId } = params;

    await this.prisma.lessonVideo.deleteMany({ where: { lessonId, videoId } });

    const remaining = await this.prisma.lessonVideo.count({ where: { videoId } });

    this.logger.log(
      `detached video ${videoId} from lesson ${lessonId}; ${remaining} attachment(s) remain`,
    );

    // We deliberately do NOT delete the asset here. Even with zero attachments
    // left, `Video` may still be the record the ingest pipeline, the DRM sweep
    // or an in-flight worker job is operating on; destroying it is an explicit
    // staff decision made through VideosService.remove(), which is
    // association-aware. Reporting `remainingAttachments` lets the caller decide.
    return { assetDestroyed: false, remainingAttachments: remaining };
  }

  /**
   * How many lectures currently reference this asset, excluding soft-deleted
   * lessons. Used to decide whether deleting the video is safe.
   */
  async countLiveAttachments(videoId: string): Promise<number> {
    return this.prisma.lessonVideo.count({
      where: { videoId, lesson: { ...notDeleted } },
    });
  }

  /**
   * Writes the asset's duration onto EVERY attached lecture and recomputes the
   * affected course totals.
   *
   * This must fan out to all attachments. A reused lecture has no worker job of
   * its own - its video was uploaded elsewhere and will never be processed again
   * - so if the destination lesson's duration is not written here, it stays 0
   * forever and the dashboard shows a false `00` for a video that plays fine.
   */
  async propagateDurationToAttachedLessons(videoId: string, durationOverride?: number): Promise<number> {
    const video = await this.prisma.video.findUnique({
      where: { id: videoId },
      select: { id: true, durationSeconds: true, courseId: true },
    });
    if (!video) return 0;

    const durationSeconds = durationOverride ?? video.durationSeconds;
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return 0;

    const links = await this.prisma.lessonVideo.findMany({
      where: { videoId },
      select: { lessonId: true, lesson: { select: { courseId: true } } },
    });
    if (links.length === 0) return 0;

    await this.prisma.lesson.updateMany({
      where: { id: { in: links.map((l) => l.lessonId) } },
      data: { durationSeconds },
    });

    // Course totals are a denormalised SUM(lessons.durationSeconds), so they are
    // now stale for every course that just received the duration - the source
    // course as well as each destination.
    const courseIds = new Set<string>([video.courseId]);
    for (const link of links) {
      if (link.lesson?.courseId) courseIds.add(link.lesson.courseId);
    }

    for (const courseId of courseIds) {
      try {
        await this.courses.recountCourse(courseId);
      } catch (error) {
        // A stale total must never fail the sync that fixed the real data.
        this.logger.warn(`could not recount course ${courseId}: ${(error as Error).message}`);
      }
    }

    return links.length;
  }

  private toAttachedVideo(
    video: {
      id: string;
      status: string;
      durationSeconds: number;
      width: number | null;
      height: number | null;
      drmProvider: string | null;
      gumletAssetId: string | null;
      deletedAt: Date | null;
    },
    ownedByThisLesson: boolean,
  ): AttachedVideo {
    return {
      id: video.id,
      title: null,
      status: video.status,
      durationSeconds: video.durationSeconds,
      width: video.width,
      height: video.height,
      drmProvider: video.drmProvider,
      gumletAssetId: video.gumletAssetId,
      deletedAt: video.deletedAt,
      ownedByThisLesson,
    };
  }
}