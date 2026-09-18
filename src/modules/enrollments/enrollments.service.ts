import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  CourseStatus,
  EnrollmentMethod,
  EnrollmentState,
  NotificationKind,
  type Prisma,
  SectionGrantSource,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { MONEY_TX_OPTIONS, PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CodesService } from '../codes/codes.service';
import { grantPartFromCode } from '../course-parts/grant-part-from-code';
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

    // "Already enrolled" now has to be a question about *coverage*, not just
    // state. A student holding a section-scoped grant is ACTIVE on the course
    // yet must still be able to buy the next section; refusing them here would
    // make section codes unsellable to exactly the people most likely to want
    // one. Full-coverage holders are still refused, as before.
    if (current.state === 'ACTIVE') {
      const allowed = await this.access.allowedSectionIds(params.userId, params.courseId);
      if (allowed === null) {
        throw new AppException(ErrorCode.ALREADY_ENROLLED, {
          message: 'You already have access to this course',
        });
      }
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

      const durationOverride = {
        // A code may override the course's default access window.
        type: validation.code.accessDurationType,
        days: validation.code.accessDurationDays,
        endsAt: validation.code.accessEndsAt,
      };

      const granted = await this.grantAccess(tx, {
        userId: params.userId,
        course,
        method: EnrollmentMethod.CODE,
        durationOverride,
        sectionScope: validation.scope.sectionIds,
        codeId: validation.code.id,
        partId: validation.code.coursePartId ?? undefined,
      });

      // A part-scoped card additionally records the part entitlement, in this
      // same transaction — so a card can never be burned without the
      // entitlement it bought, nor an entitlement created without the card.
      // Course parts never touch the wallet; the money changed hands offline
      // when the card was sold, exactly as for course and section cards.
      if (validation.code.coursePartId) {
        await grantPartFromCode(tx, {
          userId: params.userId,
          coursePartId: validation.code.coursePartId,
          accessCodeId: validation.code.id,
          sectionIds: validation.scope.sectionIds ?? [],
        });
      }

      // A teacher-scoped card unlocks every course frozen into it, not only
      // the one the student happened to redeem from. Those extra courses are
      // granted with the same window and the same code id, so the audit trail
      // shows one redemption producing several enrollments.
      const extraCourseIds = validation.scope.courseIds.filter(
        (id) => id !== params.courseId,
      );

      if (extraCourseIds.length > 0) {
        const others = await tx.course.findMany({
          where: {
            id: { in: extraCourseIds },
            deletedAt: null,
            status: { notIn: [CourseStatus.ARCHIVED, CourseStatus.SUSPENDED] },
          },
          select: {
            id: true,
            accessDurationType: true,
            accessDurationDays: true,
            accessEndsAt: true,
          },
        });

        for (const other of others) {
          await this.grantAccess(tx, {
            userId: params.userId,
            course: other,
            method: EnrollmentMethod.CODE,
            durationOverride,
            sectionScope: null,
            codeId: validation.code.id,
          });
        }
      }

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
          after: {
            courseId: params.courseId,
            enrollmentId: granted.id,
            targetType: validation.scope.targetType,
            courseIds: validation.scope.courseIds,
            sectionIds: validation.scope.sectionIds,
          },
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
  /**
   * Creates or widens a student's access to a course.
   *
   * Public because course-part purchases grant access through exactly this
   * path rather than a parallel one: a part purchase writes the same
   * `enrollment_section_grants` rows a section-scoped code writes, so the
   * lesson gate, playback ticket and attachment ticket all keep working
   * unchanged. Everything this method already guaranteed — widen-never-narrow,
   * append-only grants, the student-count recount — applies to parts too.
   *
   * Must be called inside a transaction the caller controls, so the grant and
   * whatever paid for it commit or roll back together.
   */
  async grantAccess(
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
      /**
       * `null` (the default) means "the whole course" — every path that
       * existed before section codes passes nothing and therefore keeps its
       * exact previous behaviour. An array restricts the grant to those
       * sections.
       */
      sectionScope?: string[] | null;
      codeId?: string;
      /**
       * Why the sections are being granted. Defaults to CODE so every existing
       * caller keeps writing exactly the rows it wrote before.
       */
      grantSource?: SectionGrantSource;
      /** Set when a course-part purchase paid for these sections. */
      partId?: string;
    },
  ) {
    const now = new Date();
    const accessEndsAt = this.computeAccessEnd(params.course, params.durationOverride, now);
    const scope = params.sectionScope ?? null;

    const existing = await tx.enrollment.findUnique({
      where: { userId_courseId: { userId: params.userId, courseId: params.course.id } },
      select: { id: true, coversAllSections: true },
    });

    // Access is only ever widened here, never narrowed: a student who already
    // holds the whole course keeps it even if the grant being applied is
    // section-scoped. The only way to reduce access is an explicit revoke.
    const coversAllSections =
      scope === null || (existing?.coversAllSections ?? false) ? true : false;

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
        coversAllSections,
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
        coversAllSections,
      },
    });

    if (scope !== null && scope.length > 0) {
      // Append-only: buying a second section adds a row rather than replacing
      // the first, so what the student paid for stays reconstructible.
      await tx.enrollmentSectionGrant.createMany({
        data: scope.map((sectionId) => ({
          enrollmentId: enrollment.id,
          sectionId,
          source: params.grantSource ?? SectionGrantSource.CODE,
          codeId: params.codeId ?? null,
          partId: params.partId ?? null,
        })),
        skipDuplicates: true,
      });
    }

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
    /**
     * Restricts to students whose access covers this section — either because
     * they hold the whole course or because a section grant names it. This is
     * what backs the per-section purchaser exports.
     */
    sectionId?: string;
    q?: string;
  }) {
    const where: Prisma.EnrollmentWhereInput = {
      ...(params.courseId ? { courseId: params.courseId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.state ? { state: params.state } : {}),
      ...(params.sectionId
        ? {
            OR: [
              { coversAllSections: true },
              { sectionGrants: { some: { sectionId: params.sectionId } } },
            ],
          }
        : {}),
      ...(params.q
        ? {
            user: {
              OR: [
                { fullName: { contains: params.q, mode: 'insensitive' } },
                { phone: { contains: params.q.replace(/\D/g, '') } },
              ],
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.enrollment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              email: true,
              gender: true,
              status: true,
              studentProfile: {
                select: {
                  university: { select: { id: true, name: true, nameAr: true } },
                  faculty: { select: { id: true, name: true, nameAr: true } },
                  department: { select: { id: true, name: true, nameAr: true } },
                  academicYear: { select: { id: true, name: true, nameAr: true, order: true } },
                },
              },
            },
          },
          course: { select: { id: true, title: true } },
          payments: {
            where: { status: 'PAID' },
            select: { id: true, amount: true, currency: true, paidAt: true },
          },
          redemptions: {
            orderBy: { redeemedAt: 'desc' },
            take: 1,
            select: {
              redeemedAt: true,
              code: {
                select: {
                  id: true,
                  code: true,
                  targetType: true,
                  priceAmount: true,
                  currency: true,
                },
              },
            },
          },
          sectionGrants: { select: { sectionId: true } },
        },
      }),
      this.prisma.enrollment.count({ where }),
    ]);

    return paginated(
      rows.map((e) => {
        const redemption = e.redemptions[0];

        return {
          id: e.id,
          state: e.state,
          method: e.method,
          user: {
            id: e.user.id,
            fullName: e.user.fullName,
            phone: e.user.phone,
            email: e.user.email,
            gender: e.user.gender ?? 'MALE',
            status: e.user.status,
            university: e.user.studentProfile?.university ?? null,
            faculty: e.user.studentProfile?.faculty ?? null,
            department: e.user.studentProfile?.department ?? null,
            academicYear: e.user.studentProfile?.academicYear ?? null,
          },
          course: e.course,
          coversAllSections: e.coversAllSections,
          sectionIds: e.coversAllSections ? null : e.sectionGrants.map((g) => g.sectionId),
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
          redemption: redemption
            ? {
                codeId: redemption.code.id,
                code: redemption.code.code,
                targetType: redemption.code.targetType,
                amount:
                  redemption.code.priceAmount === null
                    ? null
                    : Number(redemption.code.priceAmount),
                currency: redemption.code.currency,
                redeemedAt: redemption.redeemedAt.toISOString(),
              }
            : null,
        };
      }),
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
