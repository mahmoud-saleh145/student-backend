import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus, ContentStatus, CourseStatus, EnrollmentState, NotificationKind, UserRole, VideoStatus } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import type { VideoConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CourseAccessService } from '../courses/course-access.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  MOBILE_DELIVERY_OVERRIDE_KEY,
  MOBILE_DEVICE_PLATFORMS,
  effectiveMobileDelivery,
  type MobileDeliveryOverride,
} from '../playback/mobile-delivery-override';

/** Which pipeline made the lecture playable. Only used in log lines. */
export type AnnouncingPipeline = 'gumlet' | 'mobile' | 'local';

/**
 * `videos.newVideoAnnounceState`. NULL means nothing is owed: the lecture is
 * not playable yet, or it predates this mechanism.
 */
export const ANNOUNCE_STATE = {
  /** Playable, and the students have not been told yet. */
  PENDING: 'PENDING',
  /** One process holds the claim and is writing the notifications. */
  SENDING: 'SENDING',
  /** Told only the students who can play it in the app; the rest are owed one if Gumlet recovers. */
  MOBILE: 'MOBILE',
  /** Told (or recorded as not needing it). Final: never sent again, also not when the file is replaced. */
  DONE: 'DONE',
} as const;

export type AnnouncementOutcome =
  /** Notifications were written for every platform's audience. */
  | 'sent'
  /** Notifications were written for the students who can play it in the app. */
  | 'sent-mobile'
  /** Owed, and it cannot go out yet (draft lesson, Gumlet still working, another process has it). */
  | 'waiting'
  /** Nothing to do: already told, or nothing was ever owed. */
  | 'already'
  /** Dropped or silenced: no lecture to point at, an archived lecture, or the switch is off. */
  | 'skipped'
  /** The attempt failed; the announcement stays owed and is retried. */
  | 'failed';

/** How long one attempt may take before it is abandoned and retried later. */
export const ANNOUNCE_TIMEOUT_MS = 10_000;
/** After this long a SENDING claim belongs to a process that died; another may take it. */
export const ANNOUNCE_STALE_CLAIM_MS = 5 * 60_000;
/** How many owed announcements one reconciler pass looks at (newest first). */
export const ANNOUNCE_SETTLE_BATCH = 200;
/** Recipients are checked against the access gate this many at a time. */
const ACCESS_CHECK_CONCURRENCY = 8;

const OWED_STATES = [ANNOUNCE_STATE.PENDING, ANNOUNCE_STATE.SENDING];

type Audience = 'all' | 'mobile';
type Decision = { send: Audience } | { wait: string } | { drop: string };

const VIDEO_SELECT = {
  id: true,
  courseId: true,
  lessonId: true,
  status: true,
  mobileStatus: true,
  hlsPrefix: true,
  newVideoAnnounceState: true,
  newVideoAnnounceStateAt: true,
  _count: { select: { renditions: true } },
  lesson: {
    select: {
      id: true,
      title: true,
      status: true,
      deletedAt: true,
      sectionId: true,
      section: { select: { status: true, deletedAt: true } },
    },
  },
  course: { select: { status: true, deletedAt: true } },
} as const;

interface AnnounceableVideo {
  id: string;
  courseId: string;
  lessonId: string | null;
  status: string;
  mobileStatus: string;
  hlsPrefix: string | null;
  newVideoAnnounceState: string | null;
  newVideoAnnounceStateAt: Date | null;
  _count: { renditions: number };
  lesson: {
    id: string;
    title: string;
    status: string;
    deletedAt: Date | null;
    sectionId: string;
    section: { status: string; deletedAt: Date | null } | null;
  } | null;
  course: { status: string; deletedAt: Date | null } | null;
}

/**
 * Tells students that a lecture can be watched - once, and only when they can
 * actually open it.
 *
 * WHY IT IS A STATE AND NOT A FLAG
 * --------------------------------
 * A lecture becomes playable in one process (the Docker worker, the API's
 * recovery sweep) at a moment when the notification often must NOT go out yet:
 * the lesson is still a draft, or only one of its two pipelines has finished.
 * And when it may go out, the attempt can fail. So what is owed is recorded on
 * the video row (`newVideoAnnounceState`), and "sending it" is a separate step
 * that anything may trigger and that is safe to repeat:
 *
 *   NULL --first playable--> PENDING --claim--> SENDING --written--> DONE
 *                               ^                  |    \--written--> MOBILE --Gumlet READY--> (claim) --> DONE
 *                               \-----failed-------/
 *
 * WHO MAY CREATE THE DEBT (NULL -> PENDING) - the callers' part of the contract:
 *
 *   - the Gumlet side, only on the TRANSITION to READY;
 *   - the mobile side, only while the Gumlet side is NOT READY;
 *   - the legacy local transcode.
 *
 * Those rules are what keep old lectures silent: an old lecture is already
 * Gumlet-READY, so encoding it for mobile creates no debt, and the migration
 * marks every lecture that had been processed as DONE. Replacing a lecture's
 * file does not touch the state, so an announced lecture is never announced
 * again.
 *
 * WHEN IT GOES OUT (`settle`) - all of:
 *
 *   - the lesson and its section are PUBLISHED and the course is one enrolled
 *     students are served (PUBLISHED or HIDDEN) - otherwise it WAITS, and goes
 *     out when the lesson is published;
 *   - the lecture is playable where the student would open it:
 *       every platform  Gumlet is READY, and the app can play it (its own
 *                       ladder, or the Gumlet fallback)       -> everyone;
 *       app only        Gumlet has FAILED and the mobile ladder is READY and
 *                       served -> only students who have already played HLS
 *                       on an active phone, with wording that says "in the
 *                       mobile app". If Gumlet recovers, the others are told
 *                       then (the per-student key below stops a second one);
 *       Gumlet still working -> it WAITS for Gumlet to settle either way.
 *
 * WHO IS TOLD: ACTIVE enrolments of ACTIVE accounts on the course (the
 * original rule), narrowed by the same two gates the lesson endpoint applies
 * to a student: `assertContentAccess` (course state, access window) and
 * `assertSectionAccessible` (section- and part-scoped enrolments).
 *
 * WHAT IS GUARANTEED, AND WHAT IS NOT
 *
 *   - The in-app notification row is written at most once per student per
 *     lecture: each row carries `dedupeKey = new-video:<video>:<student>`,
 *     which the database enforces as unique. That is what makes a retry safe.
 *   - Two processes cannot dispatch at once: the claim is a compare-and-set.
 *   - A failed or interrupted attempt is not lost: the state stays owed and
 *     the pipeline reconciler retries it (a dead process's claim is taken over
 *     after ANNOUNCE_STALE_CLAIM_MS).
 *   - The PUSH is best effort and is not exactly-once. It is queued for the
 *     rows a pass newly wrote; if the process dies between writing the rows and
 *     queueing the push, the retry finds the rows present and queues nothing.
 *     Delivery to a phone then depends on the queue and the push provider.
 *
 * NEVER THROWS. It runs after a pipeline has recorded its result; a failure
 * here must not fail that job - the queue would encode the lecture again.
 */
@Injectable()
export class NewVideoAnnouncer {
  private readonly logger = new Logger(NewVideoAnnouncer.name);
  private readonly enabled: boolean;
  private readonly mobileCfg: { delivery: 'hls' | 'gumlet'; gumletFallback: boolean };
  /** An attempt failed (or is mid-flight) in this process: the reconciler should look again soon. */
  private attention = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly access: CourseAccessService,
    @Optional() config?: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {
    let video: Partial<VideoConfig> | undefined;
    try {
      video = config?.getOrThrow<VideoConfig>('video');
    } catch {
      // No video configuration (a unit test's bare double): the defaults apply.
    }
    this.enabled = video?.newVideoNotifications !== false;
    this.mobileCfg = {
      delivery: video?.mobile?.delivery === 'gumlet' ? 'gumlet' : 'hls',
      gumletFallback: video?.mobile?.gumletFallback !== false,
    };
  }

  /** True while this process knows of an attempt that failed or has not finished. */
  needsAttention(): boolean {
    return this.attention;
  }

  /**
   * A pipeline has just made the lecture playable for the first time: record
   * that an announcement is owed, then send it if it may go out now.
   */
  async onFirstPlayable(videoId: string, pipeline: AnnouncingPipeline): Promise<AnnouncementOutcome> {
    try {
      const owed = await this.prisma.video.updateMany({
        where: { id: videoId, deletedAt: null, newVideoAnnounceState: null },
        data: { newVideoAnnounceState: ANNOUNCE_STATE.PENDING, newVideoAnnounceStateAt: new Date() },
      });
      if (owed.count > 0) this.logger.log(`video ${videoId} became playable via ${pipeline}: announcement owed`);
      return await this.settleOnce(videoId);
    } catch (error) {
      this.attention = true;
      this.logger.warn(`new-video announcement for ${videoId} failed: ${(error as Error).message}`);
      return 'failed';
    }
  }

  /**
   * Sends the lecture's announcement if one is owed and it may go out now.
   * Safe to call at any time, any number of times, from any process.
   */
  async settle(videoId: string): Promise<AnnouncementOutcome> {
    try {
      return await this.settleOnce(videoId);
    } catch (error) {
      this.attention = true;
      this.logger.warn(`new-video announcement for ${videoId} failed: ${(error as Error).message}`);
      return 'failed';
    }
  }

  /** The lesson was just published: send what its lecture has been waiting to say. */
  async settleForLesson(lessonId: string): Promise<void> {
    try {
      const owed = await this.prisma.video.findMany({
        where: { lessonId, deletedAt: null, newVideoAnnounceState: { in: OWED_STATES } },
        select: { id: true },
      });
      for (const video of owed) await this.settle(video.id);
    } catch (error) {
      this.attention = true;
      this.logger.warn(`new-video announcements of lesson ${lessonId} not settled: ${(error as Error).message}`);
    }
  }

  /**
   * The reconciler's pass: every owed announcement is looked at again. This is
   * what retries a failed attempt, takes over a dead process's claim, and
   * notices a publish that has no hook of its own (a section or a course).
   */
  async settleDue(): Promise<{ examined: number; sent: number; waiting: number; failed: number }> {
    const owed = await this.prisma.video.findMany({
      where: { deletedAt: null, newVideoAnnounceState: { in: OWED_STATES } },
      select: { id: true, newVideoAnnounceState: true },
      orderBy: { newVideoAnnounceStateAt: 'desc' },
      take: ANNOUNCE_SETTLE_BATCH,
    });

    const tally = { examined: owed.length, sent: 0, waiting: 0, failed: 0 };
    let unfinished = false;
    for (const video of owed) {
      const outcome = await this.settle(video.id);
      if (outcome === 'sent' || outcome === 'sent-mobile') tally.sent += 1;
      else if (outcome === 'failed') tally.failed += 1;
      else if (outcome === 'waiting') {
        tally.waiting += 1;
        // A claim another process (or a dead one) holds resolves within minutes.
        if (video.newVideoAnnounceState === ANNOUNCE_STATE.SENDING) unfinished = true;
      }
    }
    this.attention = tally.failed > 0 || unfinished;
    if (tally.sent > 0 || tally.failed > 0) {
      this.logger.log(
        `owed new-video announcements: ${tally.examined} examined, ${tally.sent} sent, ` +
          `${tally.waiting} waiting, ${tally.failed} failed`,
      );
    }
    return tally;
  }

  // ---------------------------------------------------------------------------

  private async settleOnce(videoId: string): Promise<AnnouncementOutcome> {
    const video = (await this.prisma.video.findFirst({
      where: { id: videoId, deletedAt: null },
      select: VIDEO_SELECT,
    })) as AnnounceableVideo | null;
    if (!video) return 'skipped';

    const state = video.newVideoAnnounceState;
    if (state === null) return 'already';
    if (state === ANNOUNCE_STATE.DONE) return 'already';

    const claimAge = Date.now() - (video.newVideoAnnounceStateAt?.getTime() ?? 0);
    if (state === ANNOUNCE_STATE.SENDING && claimAge < ANNOUNCE_STALE_CLAIM_MS) return 'waiting';

    const decision = await this.decide(video);

    if ('drop' in decision) {
      // Only a debt is dropped. A MOBILE row has told someone; it stays.
      if (state !== ANNOUNCE_STATE.MOBILE) {
        await this.move(video, state, null);
        this.logger.log(`video ${videoId}: announcement dropped (${decision.drop})`);
      }
      return 'skipped';
    }

    if (!this.enabled) {
      // Recorded as done, so switching the notification back on does not
      // announce every lecture that became playable while it was off.
      await this.move(video, state, ANNOUNCE_STATE.DONE);
      this.logger.log(`video ${videoId} is playable; new-video notifications are switched off`);
      return 'skipped';
    }

    if ('wait' in decision) {
      // A dead process's claim is handed back, so the row reads as what it is.
      if (state === ANNOUNCE_STATE.SENDING) await this.move(video, state, ANNOUNCE_STATE.PENDING);
      return 'waiting';
    }

    const audience = decision.send;
    // The app-only audience has been told already; only "everyone" is left.
    if (state === ANNOUNCE_STATE.MOBILE && audience !== 'all') return 'already';

    // THE CLAIM. Compare-and-set on the exact state this call read: of two
    // processes that get here together, one changes the row and the other
    // changes nothing and steps aside.
    const claimedAt = new Date();
    const claim = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        deletedAt: null,
        newVideoAnnounceState: state,
        newVideoAnnounceStateAt: video.newVideoAnnounceStateAt,
      },
      data: { newVideoAnnounceState: ANNOUNCE_STATE.SENDING, newVideoAnnounceStateAt: claimedAt },
    });
    if (claim.count === 0) return 'waiting';

    try {
      const recipients = await this.recipients(video, audience);
      const written = await this.write(video, audience, recipients);

      await this.prisma.video.updateMany({
        where: { id: videoId, newVideoAnnounceState: ANNOUNCE_STATE.SENDING, newVideoAnnounceStateAt: claimedAt },
        data: {
          newVideoAnnounceState: audience === 'all' ? ANNOUNCE_STATE.DONE : ANNOUNCE_STATE.MOBILE,
          newVideoAnnounceStateAt: new Date(),
        },
      });
      this.logger.log(
        `video ${videoId} announced (${audience === 'all' ? 'every platform' : 'mobile app only'}): ` +
          `${recipients.length} eligible, ${written.created} notified, ${written.skipped} already had it`,
      );
      return audience === 'all' ? 'sent' : 'sent-mobile';
    } catch (error) {
      // Not written, or not known to be written. The debt stays, and the
      // per-student key makes the retry safe whichever it was.
      this.attention = true;
      await this.prisma.video
        .updateMany({
          where: { id: videoId, newVideoAnnounceState: ANNOUNCE_STATE.SENDING, newVideoAnnounceStateAt: claimedAt },
          data: { newVideoAnnounceState: ANNOUNCE_STATE.PENDING, newVideoAnnounceStateAt: new Date() },
        })
        .catch(() => undefined);
      this.logger.warn(`new-video notification for ${videoId} not sent, will be retried: ${(error as Error).message}`);
      return 'failed';
    }
  }

  /** Compare-and-set from the state this call read to `next`. */
  private async move(video: AnnounceableVideo, from: string, next: string | null): Promise<void> {
    await this.prisma.video.updateMany({
      where: { id: video.id, newVideoAnnounceState: from, newVideoAnnounceStateAt: video.newVideoAnnounceStateAt },
      data: { newVideoAnnounceState: next, newVideoAnnounceStateAt: new Date() },
    });
  }

  /** May the announcement go out now, and to whom? */
  private async decide(video: AnnounceableVideo): Promise<Decision> {
    const lesson = video.lesson;
    // No origin lecture (a reused asset whose author lesson was removed): there
    // is no lesson to link to. An archived lecture has been withdrawn.
    if (!lesson || !video.lessonId || lesson.deletedAt) return { drop: 'the lecture no longer exists' };
    if (lesson.status === ContentStatus.ARCHIVED) return { drop: 'the lecture is archived' };

    // PUBLISHED, the way the lesson endpoint defines it for a student.
    if (lesson.status !== ContentStatus.PUBLISHED) return { wait: `the lesson is ${lesson.status}` };
    if (!lesson.section || lesson.section.deletedAt || lesson.section.status !== ContentStatus.PUBLISHED) {
      return { wait: 'the section is not published' };
    }
    // PUBLISHED and HIDDEN (unlisted) are the two states in which
    // CourseAccessService.decide() serves an enrolled student.
    if (
      !video.course ||
      video.course.deletedAt ||
      (video.course.status !== CourseStatus.PUBLISHED && video.course.status !== CourseStatus.HIDDEN)
    ) {
      return { wait: 'the course is not being served to students' };
    }

    const web = video.status === VideoStatus.READY;
    const ladder =
      video.mobileStatus === 'READY' && Boolean(video.hlsPrefix) && video._count.renditions > 0;
    const gumletSettledFailed = video.status === VideoStatus.FAILED;
    // Neither side can carry it: nothing to say yet.
    if (!web && !ladder) return { wait: 'no pipeline has produced a playable lecture' };
    // Only the app could play it and Gumlet is still working: wait for Gumlet
    // to settle, so one announcement can be true for every platform.
    if (!web && !gumletSettledFailed) return { wait: 'Gumlet has not finished' };

    const override = this.redis
      ? await this.redis.getJson<MobileDeliveryOverride>(MOBILE_DELIVERY_OVERRIDE_KEY).catch(() => null)
      : null;
    const mode = effectiveMobileDelivery(this.mobileCfg, override);
    const appPlaysOwnLadder = ladder && mode.delivery === 'hls';
    const appPlaysGumlet = web && (mode.delivery === 'gumlet' || mode.gumletFallback);

    if (web && (appPlaysOwnLadder || appPlaysGumlet)) return { send: 'all' };
    if (web) return { wait: 'the mobile app cannot play it yet' };
    if (appPlaysOwnLadder) return { send: 'mobile' };
    return { wait: 'mobile HLS delivery is switched off and Gumlet has failed' };
  }

  /** The students who may open this lecture - and, for 'mobile', can play it in the app. */
  private async recipients(video: AnnounceableVideo, audience: Audience): Promise<string[]> {
    // The original rule: an ACTIVE enrolment of an ACTIVE, undeleted account.
    const enrolled = await this.prisma.enrollment.findMany({
      where: {
        courseId: video.courseId,
        state: EnrollmentState.ACTIVE,
        user: { status: AccountStatus.ACTIVE, deletedAt: null },
      },
      select: { userId: true },
    });

    // Narrowed by the gates the lesson endpoint applies to a student, so nobody
    // is told about a lecture the same account would be refused: the access
    // window and course state, then section- and part-scoped enrolments.
    const sectionId = video.lesson!.sectionId;
    const allowed: string[] = [];
    for (let i = 0; i < enrolled.length; i += ACCESS_CHECK_CONCURRENCY) {
      const batch = enrolled.slice(i, i + ACCESS_CHECK_CONCURRENCY);
      const verdicts = await Promise.all(batch.map(({ userId }) => this.mayOpen(userId, video.courseId, sectionId)));
      batch.forEach(({ userId }, index) => {
        if (verdicts[index]) allowed.push(userId);
      });
    }
    if (audience === 'all' || allowed.length === 0) return allowed;

    // APP ONLY. A phone that has been issued an HLS ticket is running a build
    // that plays the mobile ladder; a student without one would open the
    // notification onto a lecture their device reports as not ready.
    const devices = await this.prisma.device.findMany({
      where: { userId: { in: allowed }, status: 'ACTIVE' },
      select: { id: true, userId: true, platform: true },
    });
    const phones = devices.filter((d) => MOBILE_DEVICE_PLATFORMS.has(d.platform.trim().toLowerCase()));
    if (phones.length === 0) return [];
    const proven = await this.prisma.playbackTicket.findMany({
      where: { deviceId: { in: phones.map((d) => d.id) }, delivery: 'hls' },
      distinct: ['deviceId'],
      select: { deviceId: true },
    });
    const provenDevices = new Set(proven.map((t) => t.deviceId));
    const canPlay = new Set(phones.filter((d) => provenDevices.has(d.id)).map((d) => d.userId));
    return allowed.filter((userId) => canPlay.has(userId));
  }

  /** The lesson endpoint's two student gates. A refusal is an answer; anything else is a failure. */
  private async mayOpen(userId: string, courseId: string, sectionId: string): Promise<boolean> {
    try {
      await this.access.assertContentAccess({ userId, role: UserRole.STUDENT, courseId });
      await this.access.assertSectionAccessible({ userId, courseId, sectionId });
      return true;
    } catch (error) {
      if (error instanceof AppException) return false;
      throw error;
    }
  }

  /**
   * Writes the notification rows (and queues the push for the new ones).
   * `createOnce` skips a student who already has this lecture's row, which is
   * what makes every retry, takeover and second audience safe.
   */
  private async write(
    video: AnnounceableVideo,
    audience: Audience,
    recipients: string[],
  ): Promise<{ created: number; skipped: number }> {
    if (recipients.length === 0) return { created: 0, skipped: 0 };
    const title = video.lesson!.title;
    const text =
      audience === 'all'
        ? { body: `${title} is ready to watch.`, bodyAr: `${title} أصبح جاهزًا للمشاهدة.` }
        : {
            body: `${title} is ready to watch in the mobile app.`,
            bodyAr: `${title} أصبح جاهزًا للمشاهدة في تطبيق الهاتف.`,
          };
    const rows = recipients.map((userId) => ({
      userId,
      kind: NotificationKind.NEW_VIDEO,
      title: 'New video available',
      titleAr: 'فيديو جديد متاح',
      ...text,
      route: `/lesson/${video.lessonId}`,
      dedupeKey: newVideoDedupeKey(video.id, userId),
    }));

    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        this.notifications.createOnce(rows),
        // The rows are written before the push is queued, and the queue is the
        // part that can hang (BullMQ does not answer while Redis is
        // unreachable). Abandoning the attempt is safe: the retry finds the
        // rows and writes nothing twice.
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`no answer within ${ANNOUNCE_TIMEOUT_MS} ms`)),
            ANNOUNCE_TIMEOUT_MS,
          );
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** One notification per student per lecture, enforced by `notifications.dedupeKey`'s unique index. */
export function newVideoDedupeKey(videoId: string, userId: string): string {
  return `new-video:${videoId}:${userId}`;
}
