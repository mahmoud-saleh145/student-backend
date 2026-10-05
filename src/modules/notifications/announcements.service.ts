import { Injectable, Logger } from '@nestjs/common';
import {
  AnnouncementFrequency,
  AnnouncementStatus,
  NotificationKind,
  Prisma,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { PrismaService } from '../../database/prisma.service';

import {
  MAX_AUDIENCE_SIZE,
  compileAudience,
  parseStoredRule,
  ruleFromLegacyColumns,
  targetsEveryone,
  type AudienceRule,
} from './audience';
import { NotificationsService } from './notifications.service';
import { assertValidRecurrence, nextOccurrence, type RecurrenceSpec } from './recurrence';

/** Users loaded per page when fanning out. Bounds memory on a large audience. */
const FANOUT_PAGE_SIZE = 2_000;

/** Names returned by a preview, so an admin can sanity-check the rule. */
const PREVIEW_SAMPLE_SIZE = 10;

export interface AnnouncementInput {
  title: string;
  titleAr?: string;
  body: string;
  bodyAr?: string;
  route?: string;
  sendPush?: boolean;

  audience?: AudienceRule;

  frequency?: AnnouncementFrequency;
  sendAtLocal?: string;
  timezone?: string;
  weekdays?: number[];
  dayOfMonth?: number;
  startsOn?: Date;
  endsOn?: Date;
  maxOccurrences?: number;

  /** Send immediately instead of scheduling. */
  sendNow?: boolean;
}

/**
 * Scheduled, targeted announcements.
 *
 * Three things this service is careful about, in order of how much they would
 * cost to get wrong:
 *
 *  1. **A send happens at most once.** An occurrence is claimed by inserting a
 *     row with a unique `(announcementId, occurrenceAt)` before any message is
 *     written. A push cannot be recalled, so the claim precedes the work and a
 *     losing racer gets a `P2002` instead of a second broadcast.
 *
 *  2. **A missed occurrence is skipped, not replayed.** If the worker is down
 *     for three days, a daily announcement sends once when it comes back, not
 *     three times. Three days of stale reminders arriving together is worse
 *     than the gap that caused them.
 *
 *  3. **The audience is re-read every time.** The rule is stored; the recipient
 *     list never is. See `audience.ts` for why.
 */
@Injectable()
export class AnnouncementsService {
  private readonly logger = new Logger(AnnouncementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Authoring
  // ---------------------------------------------------------------------------

  async create(input: AnnouncementInput, actor: { id: string }) {
    const schedule = this.buildSchedule(input);

    const announcement = await this.prisma.announcement.create({
      data: {
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        route: input.route,
        sendPush: input.sendPush ?? true,
        audienceRule: (input.audience ?? {}) as Prisma.InputJsonValue,
        createdById: actor.id,
        ...schedule,
      },
    });

    if (input.sendNow) {
      // Dispatched inline so the admin sees the recipient count in the
      // response rather than discovering it a minute later.
      const result = await this.dispatch(announcement.id, new Date());
      return { ...announcement, dispatch: result };
    }

    return announcement;
  }

  async update(id: string, input: Partial<AnnouncementInput>, actor: { id: string }) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw AppException.notFound('Announcement', id);

    // A sent announcement is a record of what people received. Editing the text
    // afterwards would make the record disagree with every inbox holding it.
    if (
      existing.status === AnnouncementStatus.SENT ||
      existing.status === AnnouncementStatus.SENDING ||
      existing.occurrenceCount > 0
    ) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_EDITABLE, {
        message:
          existing.occurrenceCount > 0
            ? `Already sent ${existing.occurrenceCount} time(s). Cancel it and create a new one.`
            : 'Currently sending.',
        details: { status: existing.status, occurrenceCount: existing.occurrenceCount },
      });
    }

    const merged: AnnouncementInput = {
      title: input.title ?? existing.title,
      body: input.body ?? existing.body,
      frequency: input.frequency ?? existing.frequency,
      sendAtLocal: input.sendAtLocal ?? existing.sendAtLocal ?? undefined,
      timezone: input.timezone ?? existing.timezone,
      weekdays: input.weekdays ?? existing.weekdays,
      dayOfMonth: input.dayOfMonth ?? existing.dayOfMonth ?? undefined,
      startsOn: input.startsOn ?? existing.startsOn ?? undefined,
      endsOn: input.endsOn ?? existing.endsOn ?? undefined,
      maxOccurrences: input.maxOccurrences ?? existing.maxOccurrences ?? undefined,
    };

    return this.prisma.announcement.update({
      where: { id },
      data: {
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        route: input.route,
        sendPush: input.sendPush,
        ...(input.audience
          ? { audienceRule: input.audience as Prisma.InputJsonValue }
          : {}),
        ...this.buildSchedule(merged),
        updatedAt: new Date(),
      },
    });
  }

  async cancel(id: string) {
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (!existing) throw AppException.notFound('Announcement', id);

    // Only something still to come can be called off. Cancelling a SENT
    // announcement overwrote its status and made the history read as though it
    // had never gone out, when in fact students had already received it —
    // and cancelling mid-SENDING raced `advance()`, which then wrote the
    // status back and revived the schedule.
    if (
      existing.status !== AnnouncementStatus.SCHEDULED &&
      existing.status !== AnnouncementStatus.DRAFT
    ) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_EDITABLE, {
        message: `This announcement is ${existing.status.toLowerCase()} and can no longer be cancelled.`,
        details: { announcementId: id, status: existing.status },
      });
    }

    // Cancelling stops future occurrences. It never touches notifications
    // already delivered — those belong to the students who received them.
    return this.prisma.announcement.update({
      where: { id },
      data: { status: AnnouncementStatus.CANCELLED, nextOccurrenceAt: null },
    });
  }

  /**
   * Turns input into the stored schedule.
   *
   * Validating here rather than at dispatch time is deliberate: a schedule is
   * configured once and then not looked at again until it fires, possibly weeks
   * later, and a rejection at 03:00 in a worker log reaches nobody.
   */
  private buildSchedule(input: AnnouncementInput) {
    if (input.audience) {
      // Throws on an empty dimension, which would match nobody silently.
      compileAudience(input.audience);
    }

    if (input.sendNow || !input.sendAtLocal) {
      return {
        status: input.sendNow ? AnnouncementStatus.SCHEDULED : AnnouncementStatus.DRAFT,
        frequency: AnnouncementFrequency.ONCE,
        nextOccurrenceAt: input.sendNow ? new Date() : null,
        weekdays: [],
      };
    }

    const spec: RecurrenceSpec = {
      frequency: input.frequency ?? AnnouncementFrequency.ONCE,
      sendAtLocal: input.sendAtLocal,
      timezone: input.timezone ?? 'Africa/Cairo',
      weekdays: input.weekdays ?? [],
      dayOfMonth: input.dayOfMonth ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      maxOccurrences: input.maxOccurrences ?? null,
      occurrenceCount: 0,
    };

    assertValidRecurrence(spec);

    const next = nextOccurrence(spec, new Date());
    if (!next) {
      throw AppException.validation(
        { schedule: ['This schedule has no future occurrence.'] },
        'Schedule would never fire',
      );
    }

    return {
      status: AnnouncementStatus.SCHEDULED,
      frequency: spec.frequency,
      sendAtLocal: spec.sendAtLocal,
      timezone: spec.timezone,
      weekdays: spec.weekdays ?? [],
      dayOfMonth: spec.dayOfMonth,
      startsOn: spec.startsOn,
      endsOn: spec.endsOn,
      maxOccurrences: spec.maxOccurrences,
      nextOccurrenceAt: next,
    };
  }

  // ---------------------------------------------------------------------------
  // Preview
  // ---------------------------------------------------------------------------

  /**
   * What a rule would reach, without sending anything.
   *
   * An audience builder without a dry run is how someone sends the wrong
   * message to eight thousand people at two in the morning. This writes
   * nothing and enqueues nothing.
   */
  async preview(rule: AudienceRule) {
    const where = compileAudience(rule);

    const [total, sample] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: { id: true, fullName: true, phone: true },
        take: PREVIEW_SAMPLE_SIZE,
        orderBy: { fullName: 'asc' },
      }),
    ]);

    return {
      total,
      sample,
      targetsEveryone: targetsEveryone(rule),
      /** The send will refuse above this; surfaced so the UI can warn first. */
      limit: MAX_AUDIENCE_SIZE,
      exceedsLimit: total > MAX_AUDIENCE_SIZE,
    };
  }

  // ---------------------------------------------------------------------------
  // Dispatch
  // ---------------------------------------------------------------------------

  /**
   * Everything due, dispatched once each.
   *
   * `SENDING` is included in the selection on purpose: a worker killed
   * mid-fan-out leaves the row in that state, and excluding it would strand the
   * announcement forever. The dispatch row, not the status, is what prevents a
   * double send.
   */
  async dispatchDue(now: Date = new Date(), limit = 50) {
    // Before anything else, deal with claims whose owner never came back. This
    // has to run first and independently of the due query below: an occurrence
    // abandoned by a dead worker is not necessarily *due* any more (a `DRAFT`
    // reached through the legacy publish route never was), so selecting only
    // rows matching the schedule would leave it stranded with nobody noticing.
    const abandoned = await this.recoverAbandonedClaims(now, limit);

    const due = await this.prisma.announcement.findMany({
      where: {
        status: { in: [AnnouncementStatus.SCHEDULED, AnnouncementStatus.SENDING] },
        nextOccurrenceAt: { not: null, lte: now },
      },
      select: { id: true, nextOccurrenceAt: true },
      orderBy: { nextOccurrenceAt: 'asc' },
      take: limit,
    });

    const results = [];
    for (const row of due) {
      try {
        results.push(await this.dispatch(row.id, now));
      } catch (e) {
        // One bad announcement must not stop the rest of the minute's work.
        this.logger.error(`announcement ${row.id} failed: ${(e as Error).message}`);
        results.push({ announcementId: row.id, error: (e as Error).message });
      }
    }

    return { considered: due.length, abandoned, results };
  }

  /**
   * Finalises claims whose owner died, wherever the announcement happens to be.
   *
   * `dispatchDue`'s own selection recovers the easy case: a `SCHEDULED` or
   * `SENDING` row whose occurrence is still due gets re-selected, collides with
   * its claim, and is repaired. The awkward case is everything else — chiefly a
   * legacy "publish now" announcement, which sits in `DRAFT` and is therefore
   * never selected at all. Its occurrence is spent, its claim is unfinished, and
   * without this sweep it is simply never sent, with nothing in any log to say
   * why.
   *
   * The action is always the same and always the conservative one: mark the
   * occurrence spent and move the schedule on, never send. A crashed fan-out may
   * have reached some students already, and there is no unique constraint on
   * `(userId, announcementId)` to make a resend idempotent — so the dispatch row
   * is treated as the record of what was attempted, and recipients who did get
   * it are not asked to receive it twice.
   */
  private async recoverAbandonedClaims(now: Date, limit: number) {
    const cutoff = new Date(now.getTime() - AnnouncementsService.CLAIM_LEASE_MS);

    const stale = await this.prisma.announcementDispatch.findMany({
      where: { finishedAt: null, startedAt: { lt: cutoff } },
      select: { id: true, announcementId: true, occurrenceAt: true, startedAt: true },
      orderBy: { startedAt: 'asc' },
      take: limit,
    });

    const recovered = [];
    for (const claim of stale) {
      try {
        const announcement = await this.prisma.announcement.findUnique({
          where: { id: claim.announcementId },
          select: {
            id: true,
            status: true,
            occurrenceCount: true,
            lastOccurrenceAt: true,
            frequency: true,
            sendAtLocal: true,
            timezone: true,
            weekdays: true,
            dayOfMonth: true,
            startsOn: true,
            endsOn: true,
            maxOccurrences: true,
          },
        });
        if (!announcement) continue;

        const outcome = await this.recoverClaimedOccurrence(
          announcement as Parameters<AnnouncementsService['recoverClaimedOccurrence']>[0],
          claim.occurrenceAt,
          now,
        );
        recovered.push(outcome);
      } catch (e) {
        // A single unrecoverable row must not stop the sweep; the next tick
        // will see it again.
        this.logger.error(
          `failed to recover abandoned claim ${claim.id}: ${(e as Error).message}`,
        );
      }
    }

    return recovered;
  }

  async dispatch(announcementId: string, now: Date, claimedAt?: Date) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id: announcementId },
    });
    if (!announcement) throw AppException.notFound('Announcement', announcementId);

    // A cancelled announcement must stay cancelled. "Send now" on one would
    // otherwise deliver it and then `advance()` would stamp SCHEDULED or SENT
    // over the cancellation — reviving something an administrator had
    // deliberately called off, and pushing it to students.
    if (announcement.status === AnnouncementStatus.CANCELLED) {
      return { announcementId, occurrenceAt: now, skipped: 'cancelled' as const };
    }

    // Which instant is being claimed. `claimedAt` pins it for a retry that must
    // collide with a claim a dead process left behind; it deliberately does not
    // become `now`, because `advance()` schedules the *following* occurrence from
    // `now` and a reclaimed instant is in the past — passing it through would
    // schedule the next send in the past too.
    const occurrenceAt = claimedAt ?? announcement.nextOccurrenceAt ?? now;

    // --- claim, before any message exists ------------------------------------
    let dispatchId: string;
    try {
      const claim = await this.prisma.announcementDispatch.create({
        data: { announcementId, occurrenceAt },
        select: { id: true },
      });
      dispatchId = claim.id;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        // Another worker owns this occurrence — either it is mid-fan-out right
        // now, or it died after claiming and never advanced.
        //
        // Distinguishing those two matters: returning here without advancing is
        // correct for a live owner, and a permanent stall for a dead one. A dead
        // owner leaves the row in SENDING with `nextOccurrenceAt` unchanged, so
        // `dispatchDue` re-selects it every minute, re-hits this same claim, and
        // a recurring announcement never fires again and never reaches SENT.
        // The row then spins in the due list forever, one row per crash.
        return this.recoverClaimedOccurrence(announcement, occurrenceAt, now);
      }
      throw e;
    }

    await this.prisma.announcement.update({
      where: { id: announcementId },
      data: { status: AnnouncementStatus.SENDING },
    });

    try {
      const { recipients, created } = await this.fanOut(announcement);

      await this.prisma.$transaction([
        this.prisma.announcementDispatch.update({
          where: { id: dispatchId },
          data: { recipientCount: recipients, createdCount: created, finishedAt: new Date() },
        }),
        this.prisma.announcement.update({
          where: { id: announcementId },
          data: this.advance(announcement, occurrenceAt, now),
        }),
      ]);

      this.logger.log(
        `announcement ${announcementId} sent to ${created} of ${recipients}`,
      );

      return { announcementId, occurrenceAt, recipients, created };
    } catch (e) {
      // The claim stays. A failure that silently released it would be retried
      // next minute, and a partial fan-out would then send twice to everyone
      // reached the first time.
      await this.prisma.announcementDispatch.update({
        where: { id: dispatchId },
        data: { error: (e as Error).message.slice(0, 500), finishedAt: new Date() },
      });
      await this.prisma.announcement.update({
        where: { id: announcementId },
        data: this.advance(announcement, occurrenceAt, now),
      });
      throw e;
    }
  }

  /**
   * How long an unfinished claim is assumed to belong to a live worker.
   *
   * The fan-out is a bounded number of inserts, so anything still unfinished
   * after this is treated as abandoned. Five minutes is comfortably longer than
   * a healthy dispatch and short enough that a crashed occurrence recovers on
   * the next few ticks rather than waiting for someone to notice.
   */
  private static readonly CLAIM_LEASE_MS = 5 * 60 * 1000;

  /**
   * Handles an occurrence whose claim already exists.
   *
   * Three outcomes, and getting them wrong is how the wedge happens:
   *
   *   - **Owner still working** — leave everything alone and try again later.
   *     Advancing here would double-schedule: the live worker will advance too.
   *   - **Owner finished, or is gone** — advance the schedule *without* sending.
   *     This occurrence is spent; its dispatch row is the proof, and re-sending
   *     would duplicate every notification the dead worker already delivered.
   *     Advancing is what un-wedges the announcement.
   *   - **Owner gone mid-fan-out** — same as above. Some recipients may already
   *     have a notification row; `notifications` has no unique constraint on
   *     `(userId, announcementId)`, so a *resend* would duplicate for exactly
   *     those students. Not resending is therefore the only safe answer, and the
   *     dispatch row records the error so the partial send is visible.
   */
  private async recoverClaimedOccurrence(
    announcement: {
      id: string;
      occurrenceCount: number;
      lastOccurrenceAt: Date | null;
      frequency: AnnouncementFrequency;
      sendAtLocal: string | null;
      timezone: string;
      weekdays: number[];
      dayOfMonth: number | null;
      startsOn: Date | null;
      endsOn: Date | null;
      maxOccurrences: number | null;
    },
    occurrenceAt: Date,
    now: Date,
  ) {
    const existing = await this.prisma.announcementDispatch.findUnique({
      where: { announcementId_occurrenceAt: { announcementId: announcement.id, occurrenceAt } },
      select: { id: true, startedAt: true, finishedAt: true, error: true },
    });

    // The claim vanished between our failed insert and this read — another
    // worker released it. Treat the occurrence as still pending.
    if (!existing) {
      return { announcementId: announcement.id, occurrenceAt, skipped: 'already-claimed' as const };
    }

    const ageMs = now.getTime() - existing.startedAt.getTime();
    const live = existing.finishedAt === null && ageMs < AnnouncementsService.CLAIM_LEASE_MS;

    if (live) {
      return { announcementId: announcement.id, occurrenceAt, skipped: 'already-claimed' as const };
    }

    const advanced = this.advance(announcement, occurrenceAt, now);

    await this.prisma.announcement.update({
      where: { id: announcement.id },
      data: advanced,
    });

    this.logger.warn(
      `announcement ${announcement.id} occurrence ${occurrenceAt.toISOString()} was claimed by a ` +
        `worker that did not finish (${existing.error ? `error: ${existing.error}` : 'abandoned'}); ` +
        `advanced to ${advanced.nextOccurrenceAt?.toISOString() ?? 'no further occurrence'} without resending`,
    );

    return {
      announcementId: announcement.id,
      occurrenceAt,
      skipped: 'recovered-stale-claim' as const,
      error: existing.error ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Legacy endpoints
  //
  // `POST /notifications/announcements` and
  // `POST /notifications/announcements/:id/publish` are the original admin
  // broadcast routes, kept because the dashboard still calls them. They used to
  // have their own publication code, and that was three bugs at once:
  //
  //   - **No claim.** They never inserted an `AnnouncementDispatch` row, so
  //     nothing stopped a second publish from broadcasting the same message
  //     again. `notifications` has no unique constraint on
  //     `(userId, announcementId)`, so the duplicates were real rows, not a
  //     no-op — every student in the audience got the message twice.
  //   - **No paging.** `user.findMany` with no `take` loaded every recipient id
  //     into memory in one unbounded result set.
  //   - **Its own audience query.** A hand-rolled `where` over the three legacy
  //     columns, which ignored `audienceRule`, departments, faculty and
  //     subjects, and applied no `MAX_AUDIENCE_SIZE` ceiling.
  //
  // Both now go through `dispatch`, so there is exactly one publication path:
  // claim first, audience resolved by `audience.ts`, paged fan-out.
  // ---------------------------------------------------------------------------

  async createLegacy(input: {
    title: string;
    titleAr?: string;
    body: string;
    bodyAr?: string;
    route?: string;
    courseId?: string;
    universityId?: string;
    academicYearId?: string;
    sendPush?: boolean;
    publishNow?: boolean;
  }, actor: { id: string }) {
    // Untargeted is "every active student", and the rule is stored rather than
    // left as null columns: `audienceRule: {}` and three null columns compile to
    // the same filter, but only the first is re-evaluated on later sends.
    const audience = ruleFromLegacyColumns({
      courseId: input.courseId ?? null,
      universityId: input.universityId ?? null,
      academicYearId: input.academicYearId ?? null,
    });

    return this.create(
      {
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        route: input.route,
        sendPush: input.sendPush,
        audience,
        // Omitting `sendAtLocal` is what marks this as a draft in `create`.
        sendNow: input.publishNow !== false,
      },
      actor,
    );
  }

  /**
   * Publishing a draft. Idempotent, which is the whole point of it existing.
   *
   * `dispatch` alone is not enough here. After a successful send the row is
   * `SENT` with `nextOccurrenceAt: null`, so a second press would fall back to
   * `occurrenceAt = now`, miss the claim that exists for the *first* instant,
   * and broadcast again. The button would send the message twice for a reason no
   * dashboard user could see.
   *
   * So publication is refused once it has happened. One occurrence is the
   * semantic of this route — an admin publishing a draft — and the draft is now
   * `SENT`, so it has had it.
   */
  async publishLegacy(id: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        occurrenceCount: true,
        frequency: true,
        nextOccurrenceAt: true,
      },
    });
    if (!announcement) throw AppException.notFound('Announcement', id);

    if (announcement.status === AnnouncementStatus.CANCELLED) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_EDITABLE, {
        message: 'This announcement was cancelled and will not be published.',
        details: { announcementId: id, status: announcement.status },
      });
    }

    if (announcement.status === AnnouncementStatus.SENDING) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_EDITABLE, {
        message: 'This announcement is already being sent.',
        details: { announcementId: id, status: announcement.status },
      });
    }

    if (announcement.status === AnnouncementStatus.SENT || announcement.occurrenceCount > 0) {
      throw new AppException(ErrorCode.ANNOUNCEMENT_NOT_EDITABLE, {
        message: 'This announcement has already been published.',
        details: {
          announcementId: id,
          status: announcement.status,
          occurrenceCount: announcement.occurrenceCount,
        },
      });
    }

    // A recurring announcement scheduled through this route can be in DRAFT
    // with a future `nextOccurrenceAt`. Publishing now consumes that occurrence
    // rather than adding a second one, so the schedule keeps its shape.
    //
    // The claim instant has to be *stable* across retries, and for a legacy
    // announcement it has nowhere natural to come from: `frequency` is ONCE and
    // `nextOccurrenceAt` is null, so the only candidate is `new Date()` — a
    // different instant on every press. That defeats the entire duplicate-send
    // defence, because the uniqueness guarantee is
    // `(announcementId, occurrenceAt)`:
    //
    //   press 1 → claim (a, T1) → process dies before the status update
    //   press 2 → occurrenceAt is now T2 → no conflict → a *second* claim row
    //            → the fan-out runs again → every student gets it twice
    //
    // Nothing above catches that, because the guards read the announcement and
    // the crash left it looking untouched: still DRAFT, still occurrenceCount 0.
    //
    // So an existing unfinished claim wins. A retry then collides with it on the
    // unique index and lands in `recoverClaimedOccurrence`, which is the code
    // that already knows how to tell a live owner from a dead one.
    const unfinished = await this.prisma.announcementDispatch.findFirst({
      where: { announcementId: id, finishedAt: null },
      orderBy: { startedAt: 'desc' },
      select: { occurrenceAt: true },
    });

    const occurrenceAt =
      unfinished?.occurrenceAt ??
      (announcement.frequency === AnnouncementFrequency.ONCE
        ? new Date()
        : announcement.nextOccurrenceAt ?? new Date());

    return this.dispatch(id, new Date(), occurrenceAt);
  }

  /**
   * Where the row goes after an occurrence.
   *
   * The next time is computed from `now`, not from the occurrence that just
   * fired, so a worker that was down does not wake up owing a backlog.
   */
  private advance(
    announcement: {
      frequency: AnnouncementFrequency;
      sendAtLocal: string | null;
      timezone: string;
      weekdays: number[];
      dayOfMonth: number | null;
      startsOn: Date | null;
      endsOn: Date | null;
      maxOccurrences: number | null;
      occurrenceCount: number;
    },
    occurrenceAt: Date,
    now: Date,
  ) {
    const count = announcement.occurrenceCount + 1;

    const next = announcement.sendAtLocal
      ? nextOccurrence(
          {
            frequency: announcement.frequency,
            sendAtLocal: announcement.sendAtLocal,
            timezone: announcement.timezone,
            weekdays: announcement.weekdays,
            dayOfMonth: announcement.dayOfMonth,
            startsOn: announcement.startsOn,
            endsOn: announcement.endsOn,
            maxOccurrences: announcement.maxOccurrences,
            occurrenceCount: count,
          },
          now,
        )
      : null;

    return {
      occurrenceCount: count,
      lastOccurrenceAt: occurrenceAt,
      nextOccurrenceAt: next,
      status: next ? AnnouncementStatus.SCHEDULED : AnnouncementStatus.SENT,
      publishedAt: occurrenceAt,
    };
  }

  /**
   * Resolves the audience and writes the notifications.
   *
   * Paged: a 50 000-recipient announcement must not build a single array of
   * 50 000 ids in memory, nor hand one to the queue as a single job payload.
   */
  private async fanOut(announcement: {
    id: string;
    title: string;
    titleAr: string | null;
    body: string;
    bodyAr: string | null;
    route: string | null;
    sendPush: boolean;
    audienceRule: Prisma.JsonValue;
    courseId: string | null;
    universityId: string | null;
    academicYearId: string | null;
  }) {
    const rule = this.resolveRule(announcement);
    const where = compileAudience(rule);

    const recipients = await this.prisma.user.count({ where });

    if (recipients > MAX_AUDIENCE_SIZE) {
      throw new AppException(ErrorCode.AUDIENCE_TOO_LARGE, {
        message: `Audience of ${recipients} exceeds the limit of ${MAX_AUDIENCE_SIZE}.`,
        details: { recipients, limit: MAX_AUDIENCE_SIZE },
      });
    }

    let created = 0;
    let cursor: string | undefined;

    for (;;) {
      const page = await this.prisma.user.findMany({
        where,
        select: { id: true },
        take: FANOUT_PAGE_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (page.length === 0) break;

      const result = await this.notifications.createForMany(
        page.map((u) => u.id),
        {
          kind: NotificationKind.ANNOUNCEMENT,
          title: announcement.title,
          titleAr: announcement.titleAr ?? undefined,
          body: announcement.body,
          bodyAr: announcement.bodyAr ?? undefined,
          route: announcement.route,
          announcementId: announcement.id,
          sendPush: announcement.sendPush,
        },
      );

      created += result.created;
      cursor = page[page.length - 1]?.id;

      if (page.length < FANOUT_PAGE_SIZE) break;
    }

    return { recipients, created };
  }

  /** The stored rule, or the legacy columns read as one. */
  private resolveRule(announcement: {
    audienceRule: Prisma.JsonValue;
    courseId: string | null;
    universityId: string | null;
    academicYearId: string | null;
  }): AudienceRule {
    const stored = parseStoredRule(announcement.audienceRule);
    if (Object.keys(stored).length > 0) return stored;
    return ruleFromLegacyColumns(announcement);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  async list(params: { page: number; pageSize: number; status?: AnnouncementStatus }) {
    const where: Prisma.AnnouncementWhereInput = params.status
      ? { status: params.status }
      : {};

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.announcement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { _count: { select: { notifications: true, dispatches: true } } },
      }),
      this.prisma.announcement.count({ where }),
    ]);

    return paginated(rows, total, params.page, params.pageSize);
  }

  async detail(id: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id },
      include: {
        dispatches: { orderBy: { occurrenceAt: 'desc' }, take: 20 },
        _count: { select: { notifications: true } },
      },
    });

    if (!announcement) throw AppException.notFound('Announcement', id);
    return announcement;
  }
}
