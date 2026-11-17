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
  appBuildStanding,
  effectiveMobileDelivery,
  parseAppBuild,
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
/**
 * What ONE publish (a lesson, a section, a whole course) may settle inside the
 * request that made it: this many lectures, and this much time. Anything left
 * is flagged for the reconciler, which wakes within half a minute.
 */
export const ANNOUNCE_PUBLISH_BATCH = 25;
export const ANNOUNCE_PUBLISH_BUDGET_MS = 3_000;
/**
 * How long after an app-only announcement the students it could not vouch for
 * are looked at again (they may sign in on a newer build in the meantime).
 */
export const ANNOUNCE_MOBILE_RECHECK_MS = 72 * 60 * 60_000;
/** Recipients are checked against the access gate this many at a time. */
const ACCESS_CHECK_CONCURRENCY = 8;

const OWED_STATES = [ANNOUNCE_STATE.PENDING, ANNOUNCE_STATE.SENDING];

type Audience = 'all' | 'mobile';
type Decision = { send: Audience } | { wait: string } | { drop: string };

/** Why a student with an active phone was, or was not, counted as able to play the app's own stream. */
export type PhoneVerdict = 'build' | 'declared' | 'unknown' | 'below-minimum';

/** Who an app-only announcement reached, and who it deliberately did not. */
export interface MobileAudienceReport {
  enrolled: number;
  /** Enrolled students with an ACTIVE android/ios device. */
  withPhone: number;
  /** Compatible because the build their phone signed in with is at or above the configured minimum. */
  byBuild: number;
  /** Compatible because the app on their phone has itself declared HLS support (an HLS ticket). */
  byDeclaration: number;
  /** Held back: the phone's build is not known, or no minimum is configured for its platform. */
  heldUnknown: number;
  /** Held back: the phone's build is older than the configured minimum. */
  heldBelowMinimum: number;
  /** Compatible students who already have this lecture's notification. */
  alreadyTold: number;
}

/** Work shared by the lectures of one pass, so a bulk publish does not repeat it per lecture. */
class Pass {
  readonly enrolled = new Map<string, Promise<string[]>>();
  readonly mayOpen = new Map<string, Promise<boolean>>();
}

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
      isPreview: true,
      deletedAt: true,
      sectionId: true,
      section: { select: { status: true, deletedAt: true, unlocksAt: true } },
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
    isPreview?: boolean;
    deletedAt: Date | null;
    sectionId: string;
    section: { status: string; deletedAt: Date | null; unlocksAt?: Date | null } | null;
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
 * WHAT TRIGGERS SENDING (`settle`)
 *
 *   - the pipeline event that made the lecture playable;
 *   - Gumlet ending in failure (the app-only case below becomes decidable);
 *   - PUBLICATION: a lesson, a section or a course going from not-served to
 *     served settles its waiting lectures inside that request - bounded
 *     (ANNOUNCE_PUBLISH_BATCH lectures, ANNOUNCE_PUBLISH_BUDGET_MS), with the
 *     recipient checks of one course shared across its lectures;
 *   - the pipeline reconciler, as RECOVERY only: a failed attempt, a dead
 *     process's claim, whatever a bounded publish left over, and the one event
 *     nothing announces - a section's release date passing.
 *
 * WHEN IT GOES OUT - all of:
 *
 *   - the lesson and its section are PUBLISHED, the section has been released
 *     (`unlocksAt`), and the course is one enrolled students are served
 *     (PUBLISHED or HIDDEN) - otherwise it WAITS;
 *   - the lecture is playable where the student would open it:
 *       every platform  Gumlet is READY, and the app can play it (its own
 *                       ladder, or the Gumlet fallback)       -> everyone;
 *       app only        Gumlet has FAILED and the mobile ladder is READY and
 *                       served -> only students with a phone that is known to
 *                       play it (see `mobileAudience`), told that it is
 *                       available IN THE MOBILE APP. If Gumlet recovers, the
 *                       others are told then;
 *       Gumlet still working -> it WAITS for Gumlet to settle either way.
 *
 * WHO IS TOLD: ACTIVE enrolments of ACTIVE accounts on the course (the
 * original rule), narrowed by the gates the lesson endpoint applies to a
 * student: `assertContentAccess` (course state, access window, targeting) and
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
  /** The first native build of each platform that plays the mobile HLS stream; null = not configured. */
  private readonly hlsMinBuild: { android: number | null; ios: number | null };
  /** An attempt failed (or work was left over) in this process: the reconciler should look again soon. */
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
    // OFF unless it is switched on. A process that was not told (a missing
    // variable on one of the two hosts) sends nothing.
    this.enabled = video?.newVideoNotifications === true;
    this.mobileCfg = {
      delivery: video?.mobile?.delivery === 'gumlet' ? 'gumlet' : 'hls',
      gumletFallback: video?.mobile?.gumletFallback !== false,
    };
    this.hlsMinBuild = {
      android: positiveInt(video?.mobile?.hlsMinBuild?.android),
      ios: positiveInt(video?.mobile?.hlsMinBuild?.ios),
    };
  }

  /** True while this process knows of an attempt that failed, has not finished, or was left over. */
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
      return await this.settleOnce(videoId, new Pass(), true, owed.count > 0);
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
    return this.settleSafely(videoId, new Pass(), true);
  }

  /** The lesson was just published: send what its lecture has been waiting to say. */
  async settleForLesson(lessonId: string): Promise<void> {
    await this.settlePublished({ lessonId }, `lesson ${lessonId}`);
  }

  /** The section was just published: its lectures that were waiting only for that. */
  async settleForSection(sectionId: string): Promise<void> {
    await this.settlePublished({ lesson: { sectionId } }, `section ${sectionId}`);
  }

  /** The course is being served again (published, or unlisted): its waiting lectures. */
  async settleForCourse(courseId: string): Promise<void> {
    await this.settlePublished({ courseId }, `course ${courseId}`);
  }

  /**
   * The reconciler's pass: every owed announcement is looked at again. This is
   * recovery, not the trigger - it retries a failed attempt, takes over a dead
   * process's claim, finishes what a bounded publish left over, and notices a
   * section's release date passing. It also looks again at recent app-only
   * announcements, for students whose phone has become known-compatible since.
   */
  async settleDue(): Promise<{ examined: number; sent: number; waiting: number; failed: number }> {
    const owed = await this.prisma.video.findMany({
      where: { deletedAt: null, newVideoAnnounceState: { in: OWED_STATES } },
      select: { id: true, newVideoAnnounceState: true },
      orderBy: { newVideoAnnounceStateAt: 'desc' },
      take: ANNOUNCE_SETTLE_BATCH,
    });

    const pass = new Pass();
    const tally = { examined: owed.length, sent: 0, waiting: 0, failed: 0 };
    let unfinished = false;
    for (const video of owed) {
      const outcome = await this.settleSafely(video.id, pass, true);
      if (outcome === 'sent' || outcome === 'sent-mobile') tally.sent += 1;
      else if (outcome === 'failed') tally.failed += 1;
      else if (outcome === 'waiting') {
        tally.waiting += 1;
        // A claim another process (or a dead one) holds resolves within minutes.
        if (video.newVideoAnnounceState === ANNOUNCE_STATE.SENDING) unfinished = true;
      }
    }

    // App-only announcements of the last few days: has anyone they held back
    // become reachable? Costs a handful of queries per lecture when not.
    const appOnly = await this.prisma.video.findMany({
      where: {
        deletedAt: null,
        newVideoAnnounceState: ANNOUNCE_STATE.MOBILE,
        newVideoAnnounceStateAt: { gt: new Date(Date.now() - ANNOUNCE_MOBILE_RECHECK_MS) },
      },
      select: { id: true },
      take: ANNOUNCE_SETTLE_BATCH,
    });
    for (const video of appOnly) {
      const outcome = await this.settleSafely(video.id, pass, true);
      if (outcome === 'sent' || outcome === 'sent-mobile') tally.sent += 1;
      else if (outcome === 'failed') tally.failed += 1;
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

  /**
   * Something was published. Settles the lectures that were waiting for it -
   * at most ANNOUNCE_PUBLISH_BATCH of them and for at most
   * ANNOUNCE_PUBLISH_BUDGET_MS, newest first, so publishing a large course
   * cannot hold the request. What is left stays PENDING and the reconciler,
   * flagged here, takes it within its next wake.
   */
  private async settlePublished(scope: Record<string, unknown>, what: string): Promise<void> {
    try {
      const owed = await this.prisma.video.findMany({
        where: { deletedAt: null, newVideoAnnounceState: { in: OWED_STATES }, ...scope },
        select: { id: true },
        orderBy: { newVideoAnnounceStateAt: 'desc' },
        take: ANNOUNCE_PUBLISH_BATCH + 1,
      });
      if (owed.length === 0) return;

      const pass = new Pass();
      const deadline = Date.now() + ANNOUNCE_PUBLISH_BUDGET_MS;
      let settled = 0;
      for (const video of owed.slice(0, ANNOUNCE_PUBLISH_BATCH)) {
        if (Date.now() >= deadline) break;
        await this.settleSafely(video.id, pass, false);
        settled += 1;
      }
      if (settled < owed.length) {
        // `owed` was read one past the batch, so "more" is known, not how many.
        this.attention = true;
        this.logger.log(
          `${what} published: ${settled} waiting lecture(s) looked at now, ` +
            `${owed.length > ANNOUNCE_PUBLISH_BATCH ? 'at least ' : ''}${owed.length - settled} left to the reconciler`,
        );
      }
    } catch (error) {
      this.attention = true;
      this.logger.warn(`new-video announcements of ${what} not settled: ${(error as Error).message}`);
    }
  }

  private async settleSafely(videoId: string, pass: Pass, recheckAppOnly: boolean): Promise<AnnouncementOutcome> {
    try {
      return await this.settleOnce(videoId, pass, recheckAppOnly);
    } catch (error) {
      this.attention = true;
      this.logger.warn(`new-video announcement for ${videoId} failed: ${(error as Error).message}`);
      return 'failed';
    }
  }

  private async settleOnce(
    videoId: string,
    pass: Pass,
    recheckAppOnly: boolean,
    /** This very call recorded the debt (NULL -> PENDING). */
    recordedHere = false,
  ): Promise<AnnouncementOutcome> {
    const video = (await this.prisma.video.findFirst({
      where: { id: videoId, deletedAt: null },
      select: VIDEO_SELECT,
    })) as AnnounceableVideo | null;
    if (!video) return 'skipped';

    const state = video.newVideoAnnounceState;
    if (state === null) return 'already';
    if (state === ANNOUNCE_STATE.DONE) return 'already';

    const stateAge = Date.now() - (video.newVideoAnnounceStateAt?.getTime() ?? 0);
    if (state === ANNOUNCE_STATE.SENDING && stateAge < ANNOUNCE_STALE_CLAIM_MS) return 'waiting';

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
      // THIS PROCESS HAS NOTIFICATIONS OFF.
      //
      // A debt it recorded itself a moment ago is closed at once, so that
      // switching the notification back on does not announce every lecture
      // that became playable while it was off.
      //
      // A debt it did NOT record is left exactly as it is. The two hosts (API,
      // worker) are switched separately; while only one of them is on, the
      // other must not cancel what that one is holding - a draft waiting to be
      // published would be marked done by the first pass of the host that is
      // still off, and never announced.
      if (!recordedHere) return 'waiting';
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
    // A lecture already announced app-only. "Everyone" is still owed. The
    // app-only audience itself is looked at again only for a few days, and
    // only by the passes that are meant to (not by every publish).
    const appOnlyAgain = state === ANNOUNCE_STATE.MOBILE && audience === 'mobile';
    if (appOnlyAgain && (!recheckAppOnly || stateAge >= ANNOUNCE_MOBILE_RECHECK_MS)) return 'already';

    // Who would be told. Worked out BEFORE the claim, so that looking again at
    // an app-only lecture that has nobody new costs no write at all.
    const { recipients, report } = await this.audienceOf(video, audience, pass);
    if (appOnlyAgain && recipients.length === 0) return 'already';

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
      const written = await this.write(video, audience, recipients);

      await this.prisma.video.updateMany({
        where: { id: videoId, newVideoAnnounceState: ANNOUNCE_STATE.SENDING, newVideoAnnounceStateAt: claimedAt },
        data: {
          newVideoAnnounceState: audience === 'all' ? ANNOUNCE_STATE.DONE : ANNOUNCE_STATE.MOBILE,
          // Looking again does not restart the few days an app-only lecture is looked at.
          newVideoAnnounceStateAt: appOnlyAgain ? video.newVideoAnnounceStateAt : new Date(),
        },
      });
      this.logger.log(
        audience === 'all'
          ? `video ${videoId} announced (every platform): ${recipients.length} eligible, ` +
              `${written.created} notified, ${written.skipped} already had it`
          : `video ${videoId} announced (mobile app only): ${describeMobileAudience(report!, written.created)}`,
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
    // Drip release: the lesson endpoint refuses a student until the section's
    // date has passed (a free preview is exempt there, so it is here).
    if (!lesson.isPreview && lesson.section.unlocksAt && lesson.section.unlocksAt.getTime() > Date.now()) {
      return { wait: 'the section has not been released yet' };
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

  /** The students this announcement goes to now. `report` only for the app-only audience. */
  private async audienceOf(
    video: AnnounceableVideo,
    audience: Audience,
    pass: Pass,
  ): Promise<{ recipients: string[]; report?: MobileAudienceReport }> {
    const enrolled = await this.enrolledIn(video.courseId, pass);
    if (audience === 'all') return { recipients: await this.thoseWhoMayOpen(video, enrolled, pass) };

    const { compatible, report } = await this.mobileAudience(video, enrolled);
    // The access gate is the expensive part, so it is asked only about the
    // students who are compatible AND have not been told yet.
    return { recipients: await this.thoseWhoMayOpen(video, compatible, pass), report };
  }

  /** The original rule: an ACTIVE enrolment of an ACTIVE, undeleted account. */
  private enrolledIn(courseId: string, pass: Pass): Promise<string[]> {
    let known = pass.enrolled.get(courseId);
    if (!known) {
      known = this.prisma.enrollment
        .findMany({
          where: {
            courseId,
            state: EnrollmentState.ACTIVE,
            user: { status: AccountStatus.ACTIVE, deletedAt: null },
          },
          select: { userId: true },
        })
        .then((rows) => rows.map((row) => row.userId));
      pass.enrolled.set(courseId, known);
    }
    return known;
  }

  /**
   * Narrows to the students the lesson endpoint would let in, so nobody is told
   * about a lecture the same account would be refused: the access window and
   * course state, then section- and part-scoped enrolments (which a free
   * preview is exempt from there, so it is here). Verdicts are shared across
   * the lectures of one pass.
   */
  private async thoseWhoMayOpen(video: AnnounceableVideo, userIds: string[], pass: Pass): Promise<string[]> {
    const sectionId = video.lesson!.isPreview ? null : video.lesson!.sectionId;
    const allowed: string[] = [];
    for (let i = 0; i < userIds.length; i += ACCESS_CHECK_CONCURRENCY) {
      const batch = userIds.slice(i, i + ACCESS_CHECK_CONCURRENCY);
      const verdicts = await Promise.all(batch.map((userId) => this.mayOpen(userId, video.courseId, sectionId, pass)));
      batch.forEach((userId, index) => {
        if (verdicts[index]) allowed.push(userId);
      });
    }
    return allowed;
  }

  /** The lesson endpoint's student gates. A refusal is an answer; anything else is a failure. */
  private mayOpen(userId: string, courseId: string, sectionId: string | null, pass: Pass): Promise<boolean> {
    const key = `${userId}|${courseId}|${sectionId ?? '*'}`;
    let verdict = pass.mayOpen.get(key);
    if (!verdict) {
      verdict = (async () => {
        try {
          await this.access.assertContentAccess({ userId, role: UserRole.STUDENT, courseId });
          if (sectionId) await this.access.assertSectionAccessible({ userId, courseId, sectionId });
          return true;
        } catch (error) {
          if (error instanceof AppException) return false;
          throw error;
        }
      })();
      pass.mayOpen.set(key, verdict);
    }
    return verdict;
  }

  /**
   * WHO CAN PLAY A LECTURE THAT ONLY THE MOBILE APP CAN PLAY.
   *
   * Having an account, or even a bound phone, does not show that the app on
   * that phone plays the mobile HLS stream: builds older than the one that
   * introduced it are still installed, and every build reports the same app
   * VERSION. Two signals do show it, and neither needs the student to have
   * watched a mobile-HLS lecture before:
   *
   *   build       the native BUILD number the phone reported the last time it
   *               signed in (`devices.appBuild`) is at or above the first build
   *               of its platform that plays HLS (MOBILE_HLS_MIN_BUILD_ANDROID,
   *               MOBILE_HLS_MIN_BUILD_IOS);
   *   declared    the app on that phone has itself declared the capability to
   *               this server (it was issued an HLS ticket).
   *
   * A student whose only phones show neither is HELD BACK, not dismissed:
   * counted in the log line of the announcement, looked at again for
   * ANNOUNCE_MOBILE_RECHECK_MS (a sign-in on a newer build changes the answer),
   * and told with everyone else if Gumlet recovers.
   */
  private async mobileAudience(
    video: AnnounceableVideo,
    enrolled: string[],
  ): Promise<{ compatible: string[]; report: MobileAudienceReport }> {
    const report: MobileAudienceReport = {
      enrolled: enrolled.length,
      withPhone: 0,
      byBuild: 0,
      byDeclaration: 0,
      heldUnknown: 0,
      heldBelowMinimum: 0,
      alreadyTold: 0,
    };
    if (enrolled.length === 0) return { compatible: [], report };

    const devices = await this.prisma.device.findMany({
      where: { userId: { in: enrolled }, status: 'ACTIVE' },
      select: { id: true, userId: true, platform: true, appBuild: true },
    });
    const phones = devices
      .map((d) => ({ ...d, platform: d.platform.trim().toLowerCase() }))
      .filter((d) => MOBILE_DEVICE_PLATFORMS.has(d.platform));
    if (phones.length === 0) return { compatible: [], report };

    // Phones the build does not vouch for: has the app on them declared HLS itself?
    const undecided = phones.filter((d) => this.buildVerdict(d.platform, d.appBuild) !== 'build');
    const declared = new Set(
      undecided.length === 0
        ? []
        : (
            await this.prisma.playbackTicket.findMany({
              where: { deviceId: { in: undecided.map((d) => d.id) }, delivery: 'hls' },
              distinct: ['deviceId'],
              select: { deviceId: true },
            })
          ).map((t) => t.deviceId),
    );

    // A student is as good as their best phone.
    const rank: Record<PhoneVerdict, number> = { build: 3, declared: 2, unknown: 1, 'below-minimum': 0 };
    const best = new Map<string, PhoneVerdict>();
    for (const phone of phones) {
      const byBuild = this.buildVerdict(phone.platform, phone.appBuild);
      const verdict: PhoneVerdict = byBuild === 'build' ? 'build' : declared.has(phone.id) ? 'declared' : byBuild;
      const known = best.get(phone.userId);
      if (!known || rank[verdict] > rank[known]) best.set(phone.userId, verdict);
    }

    report.withPhone = best.size;
    const compatible: string[] = [];
    for (const userId of enrolled) {
      const verdict = best.get(userId);
      if (verdict === 'build') report.byBuild += 1;
      else if (verdict === 'declared') report.byDeclaration += 1;
      else if (verdict === 'unknown') report.heldUnknown += 1;
      else if (verdict === 'below-minimum') report.heldBelowMinimum += 1;
      if (verdict === 'build' || verdict === 'declared') compatible.push(userId);
    }
    if (compatible.length === 0) return { compatible, report };

    // Leave out anyone who already has this lecture's notification.
    const told = new Set(
      (
        await this.prisma.notification.findMany({
          where: { dedupeKey: { in: compatible.map((userId) => newVideoDedupeKey(video.id, userId)) } },
          select: { dedupeKey: true },
        })
      ).map((row) => row.dedupeKey),
    );
    report.alreadyTold = compatible.filter((userId) => told.has(newVideoDedupeKey(video.id, userId))).length;
    return { compatible: compatible.filter((userId) => !told.has(newVideoDedupeKey(video.id, userId))), report };
  }

  /** What a phone's recorded build says on its own. */
  private buildVerdict(platform: string, appBuild: string | null): Exclude<PhoneVerdict, 'declared'> {
    // The same reading of a build number the ticket endpoint uses, so "told it
    // is in the app" and "served the app's stream" cannot disagree.
    const standing = appBuildStanding(platform, appBuild, this.hlsMinBuild);
    if (standing === 'at-or-above') return 'build';
    return standing === 'below' ? 'below-minimum' : 'unknown';
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
        ? {
            title: 'New video available',
            titleAr: 'فيديو جديد متاح',
            body: `${title} is ready to watch.`,
            bodyAr: `${title} أصبح جاهزًا للمشاهدة.`,
          }
        : {
            // Gumlet (the web player) cannot play this lecture. The text says
            // where it CAN be watched, and claims nothing about anywhere else.
            title: 'New video available in the mobile app',
            titleAr: 'فيديو جديد متاح في تطبيق الهاتف',
            body: `${title} is now available to watch in the mobile app.`,
            bodyAr: `${title} أصبح متاحًا للمشاهدة في تطبيق الهاتف.`,
          };
    const rows = recipients.map((userId) => ({
      userId,
      kind: NotificationKind.NEW_VIDEO,
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

/** A native build number as a whole number, or null (see `parseAppBuild`). */
export const parseBuild = parseAppBuild;

function positiveInt(raw: unknown): number | null {
  return typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : null;
}

/** The log line of an app-only announcement: who was told, and who was deliberately not. */
function describeMobileAudience(report: MobileAudienceReport, notified: number): string {
  const held = report.heldUnknown + report.heldBelowMinimum;
  return (
    `${notified} notified ` +
    `(of ${report.enrolled} enrolled, ${report.withPhone} with an active phone: ` +
    `${report.byBuild} compatible by app build, ${report.byDeclaration} by declared HLS support` +
    (report.alreadyTold > 0 ? `, ${report.alreadyTold} already told` : '') +
    `); ${held} held back` +
    (held > 0
      ? ` (${report.heldUnknown} app build unknown or no minimum configured, ${report.heldBelowMinimum} below the minimum build)`
      : '') +
    `; everyone not notified is told if Gumlet recovers`
  );
}
