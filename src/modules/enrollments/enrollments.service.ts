import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  EnrollmentMethod,
  EnrollmentState,
  NotificationKind,
  type Prisma,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { MONEY_TX_OPTIONS, PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CodesService } from '../codes/codes.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PaymentsService } from '../payments/payments.service';

/** Matches the mobile app's `EnrollmentResult` exactly. */
export interface EnrollmentResult {
  state: string;
  courseId: string;
  payment: { provider: string; checkoutUrl: string; reference: string } | null;
  message: string | null;
}

/**
 * The Join Course flow.
 *
 * This is the orchestrator for spec §23/§66. The essential property: pressing
 * "Join" never grants access by itself. It asks the backend to evaluate the
 * course's configured requirements and returns the resulting state — which may
 * be ACTIVE (free / valid code), PENDING_PAYMENT (checkout required) or
 * PENDING_APPROVAL (an administrator must act). The client renders that state;
 * it does not decide it.
 *
 * Everything that touches money or a code runs at Serializable isolation, so
 * two taps on a slow connection cannot produce two enrollments, two payments,
 * or a double-redeemed code.
 */
@Injectable()
export class EnrollmentsService {
  private readonly logger = new Logger(EnrollmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly access: CourseAccessService,
    private readonly payments: PaymentsService,
    private readonly codes: CodesService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Join
  // ---------------------------------------------------------------------------

  async join(params: {
    userId: string;
    courseId: string;
    method: EnrollmentMethod;
    ip?: string | null;
    deviceKey?: string | null;
  }): Promise<EnrollmentResult> {
    const course = await this.courses.requirePublishedCourse(params.courseId);

    // The requested method must be one the course actually offers. A client
    // asking for FREE on a paid course is either stale or hostile; either way
    // the answer is the same.
    if (!course.enrollmentMethods.includes(params.method)) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: `This course does not offer '${params.method}' enrollment`,
        details: { available: course.enrollmentMethods },
      });
    }

    const current = await this.access.resolve({
      userId: params.userId,
      courseId: params.courseId,
    });

    if (current.state === 'ACTIVE') {
      throw new AppException(ErrorCode.ALREADY_ENROLLED, {
        message: 'You already have access to this course',
      });
    }
    if (current.state === 'PENDING_APPROVAL' && params.method === EnrollmentMethod.ADMIN_APPROVAL) {
      return {
        state: 'PENDING_APPROVAL',
        courseId: params.courseId,
        payment: null,
        message: 'Your request is already under review',
      };
    }

    switch (params.method) {
      case EnrollmentMethod.FREE:
        return this.joinFree(params.userId, course);
      case EnrollmentMethod.PAYMENT:
        return this.joinWithPayment(params.userId, course);
      case EnrollmentMethod.ADMIN_APPROVAL:
        return this.joinWithApproval(params.userId, course);
      case EnrollmentMethod.CODE:
        // Codes come through the dedicated redeem endpoint, which carries the
        // code itself. Reaching here means the client called the wrong route.
        throw new AppException(ErrorCode.VALIDATION_ERROR, {
          message: 'Use POST /courses/{id}/redeem with the access code',
        });
      default:
        throw new AppException(ErrorCode.VALIDATION_ERROR, {
          message: 'Unknown enrollment method',
        });
    }
  }

  private async joinFree(
    userId: string,
    course: Awaited<ReturnType<CoursesService['requirePublishedCourse']>>,
  ): Promise<EnrollmentResult> {
    if (!course.isFree) {
      // Guards the case where enrollmentMethods still lists FREE after the
      // course was given a price.
      throw new AppException(ErrorCode.PAYMENT_REQUIRED, {
        message: 'This course is not free',
      });
    }

    const enrollment = await this.prisma.$transaction(
      (tx) =>
        this.grantAccess(tx, {
          userId,
          course,
          method: EnrollmentMethod.FREE,
        }),
      MONEY_TX_OPTIONS,
    );

    await this.afterGrant(userId, course.id, course.title, EnrollmentMethod.FREE);

    return {
      state: enrollment.state,
      courseId: course.id,
      payment: null,
      message: null,
    };
  }

  private async joinWithPayment(
    userId: string,
    course: Awaited<ReturnType<CoursesService['requirePublishedCourse']>>,
  ): Promise<EnrollmentResult> {
    const price = await this.courses.currentPrice(course.id);

    if (!price || Number(price.amount) <= 0) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This course has no active price configured',
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const enrollment = await tx.enrollment.upsert({
        where: { userId_courseId: { userId, courseId: course.id } },
        create: {
          userId,
          courseId: course.id,
          state: EnrollmentState.PENDING_PAYMENT,
          method: EnrollmentMethod.PAYMENT,
        },
        update: {
          state: EnrollmentState.PENDING_PAYMENT,
          method: EnrollmentMethod.PAYMENT,
          revokedAt: null,
          revokedReason: null,
        },
      });

      const checkout = await this.payments.createPendingPayment(tx, {
        userId,
        courseId: course.id,
        enrollmentId: enrollment.id,
        price,
      });

      return { enrollment, checkout };
    }, MONEY_TX_OPTIONS);

    await this.audit.record({
      actorId: userId,
      actorRole: UserRole.STUDENT,
      action: AuditAction.ENROLLMENT_CREATE,
      entity: 'enrollment',
      entityId: result.enrollment.id,
      after: { courseId: course.id, state: EnrollmentState.PENDING_PAYMENT },
    });

    return {
      state: 'PENDING_PAYMENT',
      courseId: course.id,
      payment: result.checkout.checkoutUrl
        ? {
            provider: result.checkout.provider.toLowerCase(),
            checkoutUrl: result.checkout.checkoutUrl,
            reference: result.checkout.reference,
          }
        : null,
      message: result.checkout.checkoutUrl
        ? null
        : 'Payment is confirmed manually by the administration. Contact support to complete it.',
    };
  }

  private async joinWithApproval(
    userId: string,
    course: Awaited<ReturnType<CoursesService['requirePublishedCourse']>>,
  ): Promise<EnrollmentResult> {
    const enrollment = await this.prisma.enrollment.upsert({
      where: { userId_courseId: { userId, courseId: course.id } },
      create: {
        userId,
        courseId: course.id,
        state: EnrollmentState.PENDING_APPROVAL,
        method: EnrollmentMethod.ADMIN_APPROVAL,
      },
      update: {
        state: EnrollmentState.PENDING_APPROVAL,
        method: EnrollmentMethod.ADMIN_APPROVAL,
        revokedAt: null,
        revokedReason: null,
      },
    });

    await this.audit.record({
      actorId: userId,
      actorRole: UserRole.STUDENT,
      action: AuditAction.ENROLLMENT_CREATE,
      entity: 'enrollment',
      entityId: enrollment.id,
      after: { courseId: course.id, state: EnrollmentState.PENDING_APPROVAL },
    });

    return {
      state: 'PENDING_APPROVAL',
      courseId: course.id,
      payment: null,
      message: 'Your request has been sent to the administration',
    };
  }

  // ---------------------------------------------------------------------------
  // Redeem a code
  // ---------------------------------------------------------------------------

  async redeemCode(params: {
    userId: string;
    courseId: string;
    code: string;
    ip?: string | null;
    deviceKey?: string | null;
  }): Promise<EnrollmentResult> {
    const course = await this.courses.requirePublishedCourse(params.courseId);

    if (!course.enrollmentMethods.includes(EnrollmentMethod.CODE)) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'This course does not accept access codes',
      });
    }

    const current = await this.access.resolve({
      userId: params.userId,
      courseId: params.courseId,
    });
    if (current.state === 'ACTIVE') {
      throw new AppException(ErrorCode.ALREADY_ENROLLED, {
        message: 'You already have access to this course',
      });
    }

    // Code consumption and access grant share one Serializable transaction:
    // a crash between them would burn a code without granting anything.
    const enrollment = await this.prisma.$transaction(async (tx) => {
      const validation = await this.codes.redeemInTransaction(tx, {
        rawCode: params.code,
        userId: params.userId,
        courseId: params.courseId,
        ipAddress: params.ip,
        deviceKey: params.deviceKey,
      });

      const granted = await this.grantAccess(tx, {
        userId: params.userId,
        course,
        method: EnrollmentMethod.CODE,
        // A code may override the course's default access window.
        durationOverride: {
          type: validation.code.accessDurationType,
          days: validation.code.accessDurationDays,
          endsAt: validation.code.accessEndsAt,
        },
      });

      await tx.accessCodeRedemption.updateMany({
        where: { codeId: validation.code.id, userId: params.userId },
        data: { enrollmentId: granted.id },
      });

      await tx.auditLog.create({
        data: {
          actorId: params.userId,
          actorRole: UserRole.STUDENT,
          action: AuditAction.CODE_REDEEM,
          entity: 'access_code',
          entityId: validation.code.id,
          after: { courseId: params.courseId, enrollmentId: granted.id },
          ipAddress: params.ip ?? null,
        },
      });

      return granted;
    }, MONEY_TX_OPTIONS);

    await this.afterGrant(params.userId, course.id, course.title, EnrollmentMethod.CODE);

    return {
      state: enrollment.state,
      courseId: course.id,
      payment: null,
      message: null,
    };
  }

  // ---------------------------------------------------------------------------
  // Grant (shared by every path that produces access)
  // ---------------------------------------------------------------------------

  /**
   * The single place an enrollment becomes ACTIVE.
   *
   * Free joins, code redemptions, payment captures and administrative grants
   * all funnel through here, so the access-window calculation exists once.
   */
  private async grantAccess(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      course: {
        id: string;
        accessDurationType: string;
        accessDurationDays: number | null;
        accessEndsAt: Date | null;
      };
      method: EnrollmentMethod;
      durationOverride?: {
        type: string | null;
        days: number | null;
        endsAt: Date | null;
      };
      approvedById?: string;
    },
  ) {
    const now = new Date();
    const accessEndsAt = this.computeAccessEnd(params.course, params.durationOverride, now);

    const enrollment = await tx.enrollment.upsert({
      where: { userId_courseId: { userId: params.userId, courseId: params.course.id } },
      create: {
        userId: params.userId,
        courseId: params.course.id,
        state: EnrollmentState.ACTIVE,
        method: params.method,
        accessStartsAt: now,
        accessEndsAt,
        approvedById: params.approvedById,
        approvedAt: params.approvedById ? now : null,
      },
      update: {
        state: EnrollmentState.ACTIVE,
        method: params.method,
        accessStartsAt: now,
        accessEndsAt,
        approvedById: params.approvedById,
        approvedAt: params.approvedById ? now : undefined,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
    });

    const studentCount = await tx.enrollment.count({
      where: { courseId: params.course.id, state: EnrollmentState.ACTIVE },
    });
    await tx.course.update({
      where: { id: params.course.id },
      data: { studentCount },
    });

    return enrollment;
  }

  private computeAccessEnd(
    course: {
      accessDurationType: string;
      accessDurationDays: number | null;
      accessEndsAt: Date | null;
    },
    override: { type: string | null; days: number | null; endsAt: Date | null } | undefined,
    from: Date,
  ): Date | null {
    const type = override?.type ?? course.accessDurationType;
    const days = override?.days ?? course.accessDurationDays;
    const endsAt = override?.endsAt ?? course.accessEndsAt;

    switch (type) {
      case 'FIXED_DAYS':
        return days ? new Date(from.getTime() + days * 86_400_000) : null;
      case 'UNTIL_DATE':
        return endsAt;
      case 'LIFETIME':
      default:
        return null;
    }
  }

  /** Notification + audit after a successful grant. Never blocks the response. */
  private async afterGrant(
    userId: string,
    courseId: string,
    courseTitle: string,
    method: EnrollmentMethod,
  ): Promise<void> {
    await Promise.allSettled([
      this.notifications.createForUser({
        userId,
        kind: NotificationKind.ENROLLMENT,
        title: 'You joined a course',
        titleAr: 'تم انضمامك إلى كورس',
        body: `You now have access to ${courseTitle}.`,
        bodyAr: `أصبح لديك وصول إلى ${courseTitle}.`,
        route: `/course/${courseId}`,
      }),
      this.audit.record({
        actorId: userId,
        actorRole: UserRole.STUDENT,
        action: AuditAction.ENROLLMENT_CREATE,
        entity: 'enrollment',
        entityId: `${userId}:${courseId}`,
        after: { courseId, method, state: EnrollmentState.ACTIVE },
      }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Administrative
  // ---------------------------------------------------------------------------

  async list(params: {
    page: number;
    pageSize: number;
    courseId?: string;
    userId?: string;
    state?: EnrollmentState;
  }) {
    const where: Prisma.EnrollmentWhereInput = {
      ...(params.courseId ? { courseId: params.courseId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.state ? { state: params.state } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
          course: { select: { id: true, title: true } },
          payments: {
            where: { status: 'PAID' },
            select: { id: true, amount: true, currency: true, paidAt: true },
          },
        },
      }),
      this.prisma.enrollment.count({ where }),
    ]);

    return paginated(
      rows.map((e) => ({
        id: e.id,
        state: e.state,
        method: e.method,
        user: e.user,
        course: e.course,
        accessStartsAt: e.accessStartsAt.toISOString(),
        accessEndsAt: e.accessEndsAt?.toISOString() ?? null,
        completedLessons: e.completedLessons,
        lastAccessedAt: e.lastAccessedAt?.toISOString() ?? null,
        createdAt: e.createdAt.toISOString(),
        payments: e.payments.map((p) => ({
          id: p.id,
          amount: Number(p.amount),
          currency: p.currency,
          paidAt: p.paidAt?.toISOString() ?? null,
        })),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /** Approves a pending request, or grants access outright. */
  async grantByAdmin(
    params: {
      userId: string;
      courseId: string;
      accessDurationDays?: number;
      note?: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, params.courseId, 'students');

    const course = await this.prisma.course.findFirst({
      where: { id: params.courseId, ...notDeleted },
      select: {
        id: true,
        title: true,
        accessDurationType: true,
        accessDurationDays: true,
        accessEndsAt: true,
      },
    });
    if (!course) throw AppException.notFound('Course', params.courseId);

    const enrollment = await this.prisma.$transaction(
      (tx) =>
        this.grantAccess(tx, {
          userId: params.userId,
          course,
          method: EnrollmentMethod.ADMIN_APPROVAL,
          approvedById: actor.id,
          ...(params.accessDurationDays
            ? {
                durationOverride: {
                  type: 'FIXED_DAYS',
                  days: params.accessDurationDays,
                  endsAt: null,
                },
              }
            : {}),
        }),
      MONEY_TX_OPTIONS,
    );

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.ACCESS_GRANT,
      entity: 'enrollment',
      entityId: enrollment.id,
      after: { userId: params.userId, courseId: params.courseId },
      note: params.note,
    });

    await this.notifications
      .createForUser({
        userId: params.userId,
        kind: NotificationKind.ENROLLMENT,
        title: 'Your course access was approved',
        titleAr: 'تمت الموافقة على وصولك للكورس',
        body: `You now have access to ${course.title}.`,
        bodyAr: `أصبح لديك وصول إلى ${course.title}.`,
        route: `/course/${course.id}`,
      })
      .catch(() => undefined);

    return enrollment;
  }

  async rejectRequest(
    enrollmentId: string,
    actor: { id: string; role: UserRole },
    reason: string,
  ) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
      include: { course: { select: { id: true, title: true } } },
    });
    if (!enrollment) throw AppException.notFound('Enrollment', enrollmentId);

    await this.access.assertCanManageCourse(actor.id, actor.role, enrollment.courseId, 'students');

    if (enrollment.state !== EnrollmentState.PENDING_APPROVAL) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: `Enrollment is ${enrollment.state}, not pending approval`,
      });
    }

    const updated = await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        state: EnrollmentState.REVOKED,
        revokedAt: new Date(),
        revokedById: actor.id,
        revokedReason: reason,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.ACCESS_REVOKE,
      entity: 'enrollment',
      entityId: enrollmentId,
      note: reason,
    });

    return updated;
  }

  /**
   * Revokes access. The enrollment row, its payments and its watch history all
   * remain — only the state changes, plus any live playback is killed.
   */
  async revoke(
    enrollmentId: string,
    actor: { id: string; role: UserRole },
    reason: string,
  ) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment) throw AppException.notFound('Enrollment', enrollmentId);

    await this.access.assertCanManageCourse(actor.id, actor.role, enrollment.courseId, 'students');

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.enrollment.update({
        where: { id: enrollmentId },
        data: {
          state: EnrollmentState.REVOKED,
          revokedAt: now,
          revokedById: actor.id,
          revokedReason: reason,
        },
      });

      await tx.playbackTicket.updateMany({
        where: {
          userId: enrollment.userId,
          courseId: enrollment.courseId,
          status: 'ACTIVE',
        },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Enrollment revoked' },
      });

      const studentCount = await tx.enrollment.count({
        where: { courseId: enrollment.courseId, state: EnrollmentState.ACTIVE },
      });
      await tx.course.update({
        where: { id: enrollment.courseId },
        data: { studentCount },
      });
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.ACCESS_REVOKE,
      entity: 'enrollment',
      entityId: enrollmentId,
      note: reason,
    });

    return { ok: true };
  }

  /** Extends an access window without creating a new payment. */
  async extend(
    enrollmentId: string,
    days: number,
    actor: { id: string; role: UserRole },
    note?: string,
  ) {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { id: enrollmentId },
    });
    if (!enrollment) throw AppException.notFound('Enrollment', enrollmentId);

    await this.access.assertCanManageCourse(actor.id, actor.role, enrollment.courseId, 'students');

    // Extend from whichever is later: the current end date, or now. Extending
    // an already-lapsed enrollment from its old end date would grant nothing.
    const base =
      enrollment.accessEndsAt && enrollment.accessEndsAt.getTime() > Date.now()
        ? enrollment.accessEndsAt
        : new Date();

    const updated = await this.prisma.enrollment.update({
      where: { id: enrollmentId },
      data: {
        accessEndsAt: new Date(base.getTime() + days * 86_400_000),
        state: EnrollmentState.ACTIVE,
        revokedAt: null,
        revokedReason: null,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.ENROLLMENT_UPDATE,
      entity: 'enrollment',
      entityId: enrollmentId,
      before: { accessEndsAt: enrollment.accessEndsAt?.toISOString() ?? null },
      after: { accessEndsAt: updated.accessEndsAt?.toISOString() ?? null },
      note,
    });

    return updated;
  }

  /**
   * Nightly sweep marking lapsed enrollments EXPIRED.
   *
   * This is bookkeeping only — the access engine already evaluates the window
   * live on every request, so a student never keeps access because this job
   * was late. Its purpose is to make the stored state match reality for
   * reporting and list filters.
   */
  async expireLapsedEnrollments(): Promise<number> {
    const { count } = await this.prisma.enrollment.updateMany({
      where: {
        state: EnrollmentState.ACTIVE,
        accessEndsAt: { not: null, lte: new Date() },
      },
      data: { state: EnrollmentState.EXPIRED },
    });

    if (count > 0) this.logger.log(`marked ${count} enrollment(s) expired`);
    return count;
  }
}
