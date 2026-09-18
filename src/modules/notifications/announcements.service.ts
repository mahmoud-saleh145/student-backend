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

    return { considered: due.length, results };
  }

  async dispatch(announcementId: string, now: Date) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id: announcementId },
    });
    if (!announcement) throw AppException.notFound('Announcement', announcementId);

    const occurrenceAt = announcement.nextOccurrenceAt ?? now;

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
        // Another worker owns this occurrence. Not an error.
        return { announcementId, occurrenceAt, skipped: 'already-claimed' as const };
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
