import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  EnrollmentState,
  NotificationKind,
  type Prisma,
  UserRole,
} from '@prisma/client';
import { Queue } from 'bullmq';

import { AppException } from '../../common/errors/app.exception';
import { ConfigService } from '@nestjs/config';
import { paginated } from '../../common/types/api-response';
import { PrismaService } from '../../database/prisma.service';
import { QUEUE_NAMES, type PushJobData } from '../../jobs/queue.constants';

export interface CreateNotificationInput {
  userId: string;
  kind: NotificationKind;
  title: string;
  titleAr?: string;
  body: string;
  bodyAr?: string;
  route?: string | null;
  imageUrl?: string | null;
  data?: Record<string, unknown>;
  announcementId?: string;
  /** Set false for low-value notifications that shouldn't buzz a phone. */
  sendPush?: boolean;
}

/**
 * Notifications.
 *
 * Two layers, deliberately separate:
 *  - the **inbox** (Notification rows), which is the source of truth and what
 *    the app's notifications tab reads;
 *  - **push delivery**, which is best-effort and queued.
 *
 * A push that fails must never mean the student loses the message; they will
 * still see it in the inbox. That is why the row is written synchronously and
 * the push is enqueued afterwards.
 *
 * Routes are validated against an allow-list before storage, because a route
 * ends up driving client-side navigation and an arbitrary URL there would be a
 * redirect vector.
 */
/**
 * Page order for an inbox, newest first.
 *
 * `createdAt` alone is not an order, it is a partial one. `createdAt` defaults
 * to `now()`, which in Postgres is *transaction* time — so every row written by
 * a single `createMany` shares one identical timestamp. Ordering on it alone
 * leaves those rows in whatever order the planner happens to produce, which is
 * not stable between the `SELECT` for page 2 and the one for page 1. The visible
 * symptom is a notification shown twice while another never appears, and it
 * shows up under exactly the load the inbox is built for: a busy week.
 *
 * `id` is unique, so adding it as a tiebreaker makes the order total and the
 * pages partition the set rather than sampling it. Both list methods have to use
 * the same order for that to hold, which is why it is a constant rather than
 * written out twice.
 */
const NOTIFICATION_PAGE_ORDER: Prisma.NotificationOrderByWithRelationInput[] = [
  { createdAt: 'desc' },
  { id: 'desc' },
];

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private static readonly SAFE_ROUTE =
    /^\/(?:course|lesson|player|viewer|settings|profile|search|notifications)(?:\/[A-Za-z0-9._~-]+)*\/?$/;

  /**
   * Active push tokens one account may hold. See PUSH_MAX_ACTIVE_TOKENS_PER_USER.
   *
   * Falls back to the validated default so a unit test that builds this service
   * without a ConfigService still enforces the same ceiling instead of quietly
   * allowing an unbounded set.
   */
  private readonly pushTokenCap: number;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.push) private readonly pushQueue: Queue<PushJobData>,
    config: ConfigService,
  ) {
    this.pushTokenCap = config.get<number>('PUSH_MAX_ACTIVE_TOKENS_PER_USER') ?? 8;
  }

  // ---------------------------------------------------------------------------
  // Creation
  // ---------------------------------------------------------------------------

  async createForUser(input: CreateNotificationInput) {
    const route = this.sanitizeRoute(input.route);

    const notification = await this.prisma.notification.create({
      data: {
        userId: input.userId,
        kind: input.kind,
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        route,
        imageUrl: input.imageUrl,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        announcementId: input.announcementId,
      },
    });

    if (input.sendPush !== false) {
      await this.enqueuePush(input.userId, notification.id, input.kind);
    }

    return notification;
  }

  /**
   * Fan-out to many students.
   *
   * Uses createMany plus one bulk queue job rather than N individual calls:
   * announcing a new lesson on a 2 000-student course must not become 2 000
   * round trips.
   */
  async createForMany(userIds: string[], input: Omit<CreateNotificationInput, 'userId'>) {
    if (userIds.length === 0) return { created: 0 };

    const route = this.sanitizeRoute(input.route);

    const created = await this.prisma.notification.createMany({
      data: userIds.map((userId) => ({
        userId,
        kind: input.kind,
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        route,
        imageUrl: input.imageUrl,
        data: (input.data ?? undefined) as Prisma.InputJsonValue | undefined,
        announcementId: input.announcementId,
      })),
    });

    if (input.sendPush !== false) {
      await this.pushQueue
        .add(
          'bulk',
          {
            type: 'bulk',
            userIds,
            kind: input.kind,
            title: input.title,
            titleAr: input.titleAr,
            body: input.body,
            bodyAr: input.bodyAr,
            route,
          },
          { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        .catch((e) => this.logger.warn(`push enqueue failed: ${e.message}`));
    }

    return { created: created.count };
  }

  /**
   * Creates notifications that are each allowed to exist once, ever.
   *
   * `createForMany` is deliberately unguarded, because a broadcast is supposed
   * to reach everyone and re-running it should be a no-op by virtue of the
   * caller not asking twice. This is the variant for jobs that *will* re-run —
   * a cron that fires again, a retry, a duplicate delivery — where "won't happen
   * again today" is not a guarantee, it is an assumption.
   *
   * Each row carries a `dedupeKey`, and the uniqueness constraint does the work:
   * a repeat run inserts the rows it has not seen and skips the rest, in one
   * statement, atomically. Nothing has to read first and then write, so two
   * overlapping runs cannot both decide a row is missing.
   *
   * `createMany` does not report *which* rows it skipped, so push targets are
   * resolved separately against the same indexed column. That lookup is only an
   * optimisation for the push: correctness of the notification itself does not
   * depend on it.
   */
  async createOnce(
    rows: Array<CreateNotificationInput & { dedupeKey: string }>,
  ): Promise<{ created: number; skipped: number }> {
    if (rows.length === 0) return { created: 0, skipped: 0 };

    const keys = rows.map((r) => r.dedupeKey);

    const alreadyPresent = await this.prisma.notification.findMany({
      where: { dedupeKey: { in: keys } },
      select: { dedupeKey: true },
    });
    const present = new Set(alreadyPresent.map((r) => r.dedupeKey));

    const fresh = rows.filter((r) => !present.has(r.dedupeKey));

    const inserted = await this.prisma.notification.createMany({
      data: fresh.map((r) => ({
        userId: r.userId,
        kind: r.kind,
        title: r.title,
        titleAr: r.titleAr,
        body: r.body,
        bodyAr: r.bodyAr,
        route: this.sanitizeRoute(r.route),
        imageUrl: r.imageUrl,
        data: (r.data ?? undefined) as Prisma.InputJsonValue | undefined,
        announcementId: r.announcementId,
        dedupeKey: r.dedupeKey,
      })),
      // The safety net for two runs overlapping between the read above and this
      // insert. Without it the second run would raise P2002 on the whole batch
      // and lose the rows that were genuinely new.
      skipDuplicates: true,
    });

    const pushable = fresh.filter((r) => r.sendPush !== false);
    if (pushable.length > 0) {
      await this.pushQueue
        .add(
          'bulk',
          {
            type: 'bulk',
            userIds: pushable.map((r) => r.userId),
            kind: pushable[0].kind,
            title: pushable[0].title,
            titleAr: pushable[0].titleAr,
            body: pushable[0].body,
            bodyAr: pushable[0].bodyAr,
            route: this.sanitizeRoute(pushable[0].route),
          },
          { removeOnComplete: 100, removeOnFail: 500, attempts: 3, backoff: { type: 'exponential', delay: 5000 } },
        )
        .catch((e) => this.logger.warn(`push enqueue failed: ${e.message}`));
    }

    return { created: inserted.count, skipped: rows.length - inserted.count };
  }

  /** Everyone with active access to a course. Used for new-lesson alerts. */
  async notifyCourseStudents(
    courseId: string,
    input: Omit<CreateNotificationInput, 'userId'>,
  ) {
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        courseId,
        state: EnrollmentState.ACTIVE,
        user: { status: AccountStatus.ACTIVE, deletedAt: null },
      },
      select: { userId: true },
    });

    return this.createForMany(
      enrollments.map((e) => e.userId),
      input,
    );
  }

  private async enqueuePush(userId: string, notificationId: string, kind: NotificationKind) {
    try {
      await this.pushQueue.add(
        'single',
        { type: 'single', userId, notificationId, kind },
        {
          removeOnComplete: 200,
          removeOnFail: 500,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
    } catch (e) {
      // A Redis outage must not fail the business operation that triggered
      // this. The inbox row is already written.
      this.logger.warn(`push enqueue failed for ${userId}: ${(e as Error).message}`);
    }
  }

  private sanitizeRoute(route?: string | null): string | null {
    if (!route) return null;
    if (route.includes('..')) return null;
    return NotificationsService.SAFE_ROUTE.test(route) ? route : null;
  }

  // ---------------------------------------------------------------------------
  // Inbox
  // ---------------------------------------------------------------------------

  async list(params: {
    userId: string;
    page: number;
    pageSize: number;
    unreadOnly?: boolean;
  }) {
    const where: Prisma.NotificationWhereInput = {
      userId: params.userId,
      ...(params.unreadOnly ? { read: false } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: NOTIFICATION_PAGE_ORDER,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginated(
      rows.map((n) => this.serialize(n, 'en')),
      total,
      params.page,
      params.pageSize,
    );
  }

  /**
   * Localised at read time.
   *
   * Both languages are stored on the row, and the request's Accept-Language
   * picks one. Storing both is what lets a student switch the app to Arabic
   * and see their existing notifications in Arabic — translating at send time
   * would freeze them in whatever language was active then.
   */
  private serialize(
    n: {
      id: string;
      kind: NotificationKind;
      title: string;
      titleAr: string | null;
      body: string;
      bodyAr: string | null;
      read: boolean;
      createdAt: Date;
      route: string | null;
      imageUrl: string | null;
    },
    locale: 'en' | 'ar',
  ) {
    return {
      id: n.id,
      kind: n.kind,
      title: locale === 'ar' && n.titleAr ? n.titleAr : n.title,
      body: locale === 'ar' && n.bodyAr ? n.bodyAr : n.body,
      read: n.read,
      createdAt: n.createdAt.toISOString(),
      route: n.route,
      imageUrl: n.imageUrl,
    };
  }

  async listLocalized(params: {
    userId: string;
    page: number;
    pageSize: number;
    unreadOnly?: boolean;
    locale: 'en' | 'ar';
  }) {
    const where: Prisma.NotificationWhereInput = {
      userId: params.userId,
      ...(params.unreadOnly ? { read: false } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: NOTIFICATION_PAGE_ORDER,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.notification.count({ where }),
    ]);

    return paginated(
      rows.map((n) => this.serialize(n, params.locale)),
      total,
      params.page,
      params.pageSize,
    );
  }

  async unreadCount(userId: string): Promise<{ count: number }> {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    });
    return { count };
  }

  async markRead(userId: string, notificationId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { id: notificationId, userId, read: false },
      data: { read: true, readAt: new Date() },
    });
    return { ok: true, updated: count };
  }

  async markAllRead(userId: string) {
    const { count } = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
    return { ok: true, updated: count };
  }

  // ---------------------------------------------------------------------------
  // Push tokens
  // ---------------------------------------------------------------------------

  async registerPushToken(params: {
    userId: string;
    token: string;
    platform: string;
    provider?: string;
    deviceKey?: string | null;
  }) {
    // A token is globally unique. If it moves to another account (shared
    // handset, account switch) it must be re-pointed, not duplicated —
    // otherwise the previous owner keeps receiving this student's pushes.
    //
    // Both halves run in one transaction so two devices registering at the same
    // moment cannot each count the other's row and both keep an over-cap set.
    await this.prisma.$transaction(async (tx) => {
      await tx.pushToken.upsert({
        where: { token: params.token },
        create: {
          userId: params.userId,
          token: params.token,
          platform: params.platform,
          provider: params.provider ?? 'expo',
          deviceKey: params.deviceKey ?? null,
          lastUsedAt: new Date(),
        },
        update: {
          userId: params.userId,
          platform: params.platform,
          deviceKey: params.deviceKey ?? null,
          isActive: true,
          failureCount: 0,
          lastUsedAt: new Date(),
        },
      });

      // Keep the most recently seen `cap` tokens and retire the rest.
      //
      // Ordered by updatedAt rather than lastUsedAt: lastUsedAt is nullable, and
      // on Postgres a DESC sort puts NULLs first — which would rank a token that
      // has never been used above the ones that have. updatedAt is bumped by
      // this very upsert, so "newest" means "most recently registered".
      const keepers = await tx.pushToken.findMany({
        where: { userId: params.userId, isActive: true },
        orderBy: { updatedAt: 'desc' },
        take: this.pushTokenCap,
        select: { id: true },
      });

      // Anything not in the kept set goes inactive. A user who registered
      // thousands of tokens while this was unbounded is repaired by their next
      // registration, and only `cap` rows are ever read to do it.
      await tx.pushToken.updateMany({
        where: {
          userId: params.userId,
          isActive: true,
          id: { notIn: keepers.map((k) => k.id) },
        },
        data: { isActive: false },
      });
    });

    return { ok: true };
  }

  async unregisterPushToken(userId: string, token: string) {
    await this.prisma.pushToken.updateMany({
      where: { token, userId },
      data: { isActive: false },
    });
    return { ok: true };
  }

  async activeTokensFor(userIds: string[]) {
    return this.prisma.pushToken.findMany({
      where: { userId: { in: userIds }, isActive: true },
      select: { id: true, token: true, userId: true, provider: true },
    });
  }

  async markTokenFailed(tokenId: string) {
    const token = await this.prisma.pushToken.update({
      where: { id: tokenId },
      data: { failureCount: { increment: 1 } },
      select: { failureCount: true },
    });

    // Three consecutive rejections means the token is dead (app uninstalled).
    if (token.failureCount >= 3) {
      await this.prisma.pushToken.update({
        where: { id: tokenId },
        data: { isActive: false },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Preferences
  // ---------------------------------------------------------------------------

  async getPreferences(userId: string) {
    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });

    return {
      newCourse: prefs.newCourse,
      newLesson: prefs.newLesson,
      announcements: prefs.announcements,
      payments: prefs.payments,
    };
  }

  async updatePreferences(
    userId: string,
    input: Partial<{
      newCourse: boolean;
      newLesson: boolean;
      announcements: boolean;
      payments: boolean;
    }>,
  ) {
    const prefs = await this.prisma.notificationPreference.upsert({
      where: { userId },
      create: { userId, ...input },
      update: input,
    });

    return {
      newCourse: prefs.newCourse,
      newLesson: prefs.newLesson,
      announcements: prefs.announcements,
      payments: prefs.payments,
    };
  }

  /** Maps a notification kind to the preference that gates its push. */
  static preferenceKeyFor(kind: NotificationKind):
    | 'newCourse'
    | 'newLesson'
    | 'announcements'
    | 'payments'
    | null {
    switch (kind) {
      case NotificationKind.NEW_COURSE:
        return 'newCourse';
      case NotificationKind.NEW_LESSON:
      case NotificationKind.NEW_VIDEO:
      case NotificationKind.NEW_SECTION:
      case NotificationKind.COURSE_UPDATE:
        return 'newLesson';
      case NotificationKind.ANNOUNCEMENT:
        return 'announcements';
      case NotificationKind.PAYMENT:
      case NotificationKind.ENROLLMENT:
        return 'payments';
      // Security and direct administrative messages are never suppressed by a
      // preference — a student must always be told their device changed.
      case NotificationKind.SECURITY:
      case NotificationKind.ADMIN:
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Direct message to one student
  //
  // The broadcast routes used to live here too. They now go through
  // `AnnouncementsService` — see `createLegacy`/`publishLegacy` for what that
  // fixed — which leaves only the single-recipient case, which is genuinely a
  // notification rather than an audience dispatch and so needs no claim.
  // ---------------------------------------------------------------------------

  async messageStudent(
    input: {
      title: string;
      titleAr?: string;
      body: string;
      bodyAr?: string;
      route?: string;
      userId?: string;
      sendPush?: boolean;
    },
    actor: { id: string },
  ) {
    if (!input.userId) throw AppException.validation({ userId: ['Required.'] }, 'Who to message?');

    // Scoped to an active, undeleted student. A teacher id, a suspended account
    // or a deleted one is a not-found here rather than a silently dropped
    // message: the caller asked to reach a student and no student was reached.
    //
    // `status` is load-bearing, not decoration. Without it the guard accepted
    // PENDING, SUSPENDED and DISABLED accounts, so a direct message could reach
    // a student the rest of the platform refuses to deliver to — broadcast
    // audiences already filter on `AccountStatus.ACTIVE`, and this route was
    // the one way around that.
    const student = await this.prisma.user.findFirst({
      where: {
        id: input.userId,
        role: UserRole.STUDENT,
        status: AccountStatus.ACTIVE,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!student) throw AppException.notFound('Student', input.userId);

    const result = await this.createForMany([student.id], {
      kind: NotificationKind.ANNOUNCEMENT,
      title: input.title,
      titleAr: input.titleAr,
      body: input.body,
      bodyAr: input.bodyAr,
      route: input.route,
      sendPush: input.sendPush ?? true,
    });

    return { userId: student.id, recipients: result.created, sentById: actor.id };
  }
}
