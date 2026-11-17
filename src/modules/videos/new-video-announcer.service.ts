import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationKind } from '@prisma/client';

import type { VideoConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/** Which pipeline made the lecture playable. Only used in the log line. */
export type AnnouncingPipeline = 'gumlet' | 'mobile' | 'local';

export type AnnouncementOutcome =
  /** Students were told. */
  | 'sent'
  /** This lecture was announced before (or is recorded as not needing it). */
  | 'already'
  /** Nothing to announce: no origin lecture, the video is gone, or the switch is off. */
  | 'skipped'
  /** The notification could not be written; the claim was released. */
  | 'failed';

/** How long the announcement may take before the caller stops waiting for it. */
export const ANNOUNCE_TIMEOUT_MS = 10_000;

const TIMED_OUT = Symbol('announce-timeout');

/**
 * Tells enrolled students that a lecture can be watched - ONCE.
 *
 * Why this is its own service
 * ---------------------------
 * A video now has two independent ways of becoming playable: the Gumlet asset
 * finishing, and the mobile HLS ladder finishing. Either may be first, either
 * may be the only one that ever succeeds, and they finish in different
 * processes (the API's recovery sweep, the Docker worker). The "new video"
 * notification used to live inside `VideosService.markReady()`, which only the
 * legacy local transcode reaches - so on the Gumlet path nothing sent it at
 * all.
 *
 * "Once" cannot be decided in memory when two processes can finish seconds
 * apart, so it is decided in the database: `videos.newVideoAnnouncedAt` is
 * claimed with a compare-and-set, and only the caller whose write changed the
 * row sends anything. The second pipeline to finish finds the claim taken and
 * says nothing.
 *
 * WHO MAY CALL IT, AND WHEN - this is the caller's part of the contract:
 *
 *   - the Gumlet side, only on the TRANSITION to READY (a re-sync of a video
 *     that already was READY is not news);
 *   - the mobile side, only while the Gumlet side is NOT READY (if it is, then
 *     Gumlet was first, and either it announced the lecture or the lecture
 *     predates this mechanism).
 *
 * Those two rules, not the claim, are what keep a backfill of old lectures
 * silent: an old lecture is Gumlet-READY, so encoding it for mobile announces
 * nothing, whatever the claim column holds. The migration additionally stamps
 * every lecture that had already been processed, which covers the remaining
 * case (an old lecture whose Gumlet asset is repaired later).
 *
 * Eligibility is unchanged from the original notification: the video must
 * still have its origin lecture, and the recipients are the course's ACTIVE
 * enrolments of ACTIVE accounts (`notifyCourseStudents`). Push preferences are
 * applied where they always were, in the push processor.
 *
 * Delivery is at-most-once. The claim is taken first and released only when
 * the notification rows could not be written, so a crash between the two
 * loses one announcement rather than ever sending two.
 *
 * NEVER THROWS. It is called after a pipeline has recorded its result; a
 * failure here must not fail that job - the queue would run the whole encode
 * again to retry a notification.
 */
@Injectable()
export class NewVideoAnnouncer {
  private readonly logger = new Logger(NewVideoAnnouncer.name);
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    @Optional() config?: ConfigService,
  ) {
    let enabled = true;
    try {
      enabled = config?.getOrThrow<VideoConfig>('video')?.newVideoNotifications !== false;
    } catch {
      // No video configuration (a unit test's bare double): the default applies.
    }
    this.enabled = enabled;
  }

  async announce(videoId: string, pipeline: AnnouncingPipeline): Promise<AnnouncementOutcome> {
    try {
      return await this.announceOnce(videoId, pipeline);
    } catch (error) {
      this.logger.warn(`new-video announcement for ${videoId} failed: ${(error as Error).message}`);
      return 'failed';
    }
  }

  private async announceOnce(videoId: string, pipeline: AnnouncingPipeline): Promise<AnnouncementOutcome> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, deletedAt: null },
      select: {
        id: true,
        courseId: true,
        lessonId: true,
        newVideoAnnouncedAt: true,
        lesson: { select: { id: true, title: true } },
      },
    });
    if (!video) return 'skipped';
    if (video.newVideoAnnouncedAt) return 'already';

    // No origin lecture (a reused asset whose author lesson was removed): there
    // is no lesson to link to, and a notification pointing at the wrong lecture
    // would be worse than none. Not claimed, so nothing is lost if one returns.
    if (!video.lesson || !video.lessonId) return 'skipped';

    const claimedAt = new Date();
    const claim = await this.prisma.video.updateMany({
      where: { id: videoId, deletedAt: null, newVideoAnnouncedAt: null },
      data: { newVideoAnnouncedAt: claimedAt },
    });
    if (claim.count === 0) return 'already';

    if (!this.enabled) {
      // The claim stays: switching the notification back on must not announce
      // every lecture that became playable while it was off.
      this.logger.log(`video ${videoId} playable via ${pipeline}; new-video notifications are switched off`);
      return 'skipped';
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const sent = await Promise.race([
        this.notifications.notifyCourseStudents(video.courseId, {
          kind: NotificationKind.NEW_VIDEO,
          title: 'New video available',
          titleAr: 'فيديو جديد متاح',
          body: `${video.lesson.title} is ready to watch.`,
          bodyAr: `${video.lesson.title} أصبح جاهزًا للمشاهدة.`,
          route: `/lesson/${video.lessonId}`,
        }),
        new Promise<typeof TIMED_OUT>((resolve) => {
          timer = setTimeout(() => resolve(TIMED_OUT), ANNOUNCE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);

      if (sent === TIMED_OUT) {
        // The inbox rows are written before the push is queued, and the queue
        // is the part that can hang (BullMQ does not answer while Redis is
        // unreachable). The claim is KEPT: releasing it here could send the
        // inbox notification a second time.
        this.logger.warn(`new-video announcement for ${videoId} did not finish in ${ANNOUNCE_TIMEOUT_MS} ms; not retried`);
        return 'sent';
      }
    } catch (error) {
      // The rows were not written. Give the claim back - but only if it is
      // still THIS claim - so the other pipeline, or a retry, can announce.
      await this.prisma.video
        .updateMany({ where: { id: videoId, newVideoAnnouncedAt: claimedAt }, data: { newVideoAnnouncedAt: null } })
        .catch(() => undefined);
      this.logger.warn(`new-video notification for ${videoId} failed: ${(error as Error).message}`);
      return 'failed';
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.logger.log(`video ${videoId} announced to the course (first playable pipeline: ${pipeline})`);
    return 'sent';
  }
}
