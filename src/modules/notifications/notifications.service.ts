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
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  private static readonly SAFE_ROUTE =
    /^\/(?:course|lesson|player|viewer|settings|profile|search|notifications)(?:\/[A-Za-z0-9._~-]+)*\/?$/;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUE_NAMES.push) private readonly pushQueue: Queue<PushJobData>,
  ) {}

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
        orderBy: { createdAt: 'desc' },
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
        orderBy: { createdAt: 'desc' },
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
    await this.prisma.pushToken.upsert({
      where: { token: params.token },
      create: {
        userId: params.userId,
        token: params.token,
        platform: params.platform,
        provider: params.provider ?? 'expo',
        deviceKey: params.deviceKey ?? null,
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
  // Announcements (admin broadcast)
  // ---------------------------------------------------------------------------

  async createAnnouncement(
    input: {
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
    },
    actor: { id: string },
  ) {
    const announcement = await this.prisma.announcement.create({
      data: {
        title: input.title,
        titleAr: input.titleAr,
        body: input.body,
        bodyAr: input.bodyAr,
        route: this.sanitizeRoute(input.route),
        courseId: input.courseId,
        universityId: input.universityId,
        academicYearId: input.academicYearId,
        sendPush: input.sendPush ?? true,
        createdById: actor.id,
        publishedAt: input.publishNow === false ? null : new Date(),
      },
    });

    if (announcement.publishedAt) {
      await this.publishAnnouncement(announcement.id);
    }

    return announcement;
  }

  async publishAnnouncement(announcementId: string) {
    const announcement = await this.prisma.announcement.findUnique({
      where: { id: announcementId },
    });
    if (!announcement) throw AppException.notFound('Announcement', announcementId);

    const recipients = await this.prisma.user.findMany({
      where: {
        role: UserRole.STUDENT,
        status: AccountStatus.ACTIVE,
        deletedAt: null,
        ...(announcement.courseId
          ? {
              enrollments: {
                some: { courseId: announcement.courseId, state: EnrollmentState.ACTIVE },
              },
            }
          : {}),
        ...(announcement.universityId || announcement.academicYearId
          ? {
              studentProfile: {
                ...(announcement.universityId
                  ? { universityId: announcement.universityId }
                  : {}),
                ...(announcement.academicYearId
                  ? { academicYearId: announcement.academicYearId }
                  : {}),
              },
            }
          : {}),
      },
      select: { id: true },
    });

    const result = await this.createForMany(
      recipients.map((r) => r.id),
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

    await this.prisma.announcement.update({
      where: { id: announcementId },
      data: { publishedAt: announcement.publishedAt ?? new Date() },
    });

    return { announcementId, recipients: result.created };
  }
}
