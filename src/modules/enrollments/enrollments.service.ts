import { Injectable, Logger, Optional } from '@nestjs/common';
import {
  AuditAction,
  EnrollmentMethod,
  EnrollmentState,
  NotificationKind,
  PartEntitlementSource,
  type Prisma,
  SectionGrantSource,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import {
  ACQUIRABLE_COURSE_STATUS,
  assertCourseAcquirable,
} from '../../common/publication';
import { paginated } from '../../common/types/api-response';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { withSerializableRetry } from '../../database/serializable-retry';
import { AuditService } from '../audit/audit.service';
import { CatalogService } from '../catalog/catalog.service';
import { CodesService } from '../codes/codes.service';
import { grantPartFromCode } from '../course-parts/grant-part-from-code';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';
import { NotificationsService } from '../notifications/notifications.service';
import { REFUND_TX_INCLUDE, refundStateOf } from '../payments/refund-state';
import { PaymentsService } from '../payments/payments.service';

import { revokeEnrollmentInTx } from './revoke-enrollment';

/**
 * Refuses anyone but an administrator (ADMIN or MASTER).
 *
 * Used for the operations owner decision D3 reserves for administration:
 * granting access without payment and extending an access window. Thrown as
 * INSUFFICIENT_ROLE (403), the same answer RolesGuard gives at the route.
 */
export function assertAdministrator(role: UserRole, action: string): void {
  if (role !== UserRole.ADMIN && role !== UserRole.MASTER) {
    throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
      message: `Only an administrator can ${action}.`,
    });
  }
}

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
    // Optional only so unit tests that build this service positionally keep
    // compiling; the application module always provides it (see
    // EnrollmentsModule's CatalogModule import). `transfer` refuses to run
    // without it, because "which ladder governs this department" must be
    // answered by the catalog, never re-derived here.
    @Optional() private readonly catalog?: CatalogService,
  ) {}

  // ---------------------------------------------------------------------------
  // Join
  // ---------------------------------------------------------------------------

  async join(params: {
    userId: string;
    role: UserRole;
    courseId: string;
    method: EnrollmentMethod;
    ip?: string | null;
    deviceKey?: string | null;
  }): Promise<EnrollmentResult> {
    const course = await this.courses.requirePublishedCourse(params.courseId);

    // Targeting is checked before the method, so a student outside the course's
    // academic group is told that rather than being sent down a payment or
    // approval path they can never complete. Staff are exempt inside the helper.
    await this.access.assertCourseTargeting(params.userId, params.role, params.courseId);

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

    const enrollment = await withSerializableRetry(this.prisma, (tx) =>
      this.grantAccess(tx, {
        userId,
        course,
        method: EnrollmentMethod.FREE,
      }),
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

    const result = await withSerializableRetry(this.prisma, async (tx) => {
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
    });

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
    role: UserRole;
    courseId: string;
    code: string;
    ip?: string | null;
    deviceKey?: string | null;
  }): Promise<EnrollmentResult> {
    const course = await this.courses.requirePublishedCourse(params.courseId);

    // A code must not become a way around targeting: the code authorises payment
    // for the course, it does not change who the course is offered to. Checked
    // before the code is even validated so a wrong-department student cannot
    // burn redemption attempts against it.
    await this.access.assertCourseTargeting(params.userId, params.role, params.courseId);

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
    //
    // Retried on a write conflict. Every redemption reads `redemptionCount` and
    // writes `redemptionCount + 1`, so two students redeeming the last
    // remaining use of a card collide by construction — the loser is aborted by
    // the database and, before this, that abort reached them as a 500 for a
    // request that was valid and would have succeeded a moment later. The retry
    // re-reads the count and takes the correct branch, so the code is still
    // oversold to nobody.
    const enrollment = await withSerializableRetry(this.prisma, async (tx) => {
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
            // Only a published course may be newly acquired. This used to be
            // `notIn: [ARCHIVED, SUSPENDED]`, which let a card grant a DRAFT or
            // HIDDEN course — content nobody had put up for sale, reached by
            // redeeming a card that had been frozen when those courses were
            // live. The primary course is held to this by
            // `requirePublishedCourse`; these extras were not.
            status: ACQUIRABLE_COURSE_STATUS,
          },
          select: {
            id: true,
            // Carried so `assertCourseAcquirable` below has a status to assert
            // on. Selecting it is not redundant: the guard is what makes the
            // rule hold, and a guard fed `undefined` denies everything.
            status: true,
            deletedAt: true,
            accessDurationType: true,
            accessDurationDays: true,
            accessEndsAt: true,
          },
        });

        for (const other of others) {
          // A multi-course card reaches courses the student was never checked
          // against. The targeting check on the primary course says nothing
          // about these, so each one is checked before it grants anything —
          // otherwise the extra scope is a way around targeting entirely.
          await this.access.assertCourseTargeting(params.userId, params.role, other.id);

          // The query above filters on status, so this cannot fail today. It is
          // here because "the filter is correct" is not a property that survives
          // the next edit to that query, and this is the last line before access
          // is granted.
          assertCourseAcquirable(other, other.id);

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
    });

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
      select: { id: true, coversAllSections: true, state: true, accessEndsAt: true },
    });

    // Access is only ever widened here, never narrowed: a student who already
    // holds the whole course keeps it even if the grant being applied is
    // section-scoped. The only way to reduce access is an explicit revoke.
    //
    // "Already holds the whole course" means a LIVE whole-course enrollment.
    // `coversAllSections` defaults to true on every row, including the
    // PENDING_APPROVAL / PENDING_PAYMENT rows written by a join request and
    // EXPIRED rows whose access has lapsed. Inheriting the flag from those let
    // a student request approval (or start a payment) and then redeem the
    // cheapest section card to unlock every section of the course.
    const holdsLiveWholeCourse =
      existing?.coversAllSections === true &&
      existing.state === EnrollmentState.ACTIVE &&
      (existing.accessEndsAt === null || existing.accessEndsAt > now);
    const coversAllSections = scope === null || holdsLiveWholeCourse;

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
    /**
     * The staff member asking. Enrollments carry student PII and are the
     * backbone of per-course revenue reporting, so the list is scoped to what
     * this actor is permitted to see rather than trusting the filters below.
     */
    actor: { id: string; role: UserRole };
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
    // `null` = master/admin, unrestricted. A teacher gets exactly the courses
    // whose assignment grants `students`; being assigned to nothing yields an
    // empty page rather than an unfiltered one.
    const readable = await this.access.readableCourseIds(
      params.actor.id,
      params.actor.role,
      'students',
    );

    if (readable !== null && readable.length === 0) {
      return paginated([], 0, params.page, params.pageSize);
    }

    // A single `courseId` condition, composed rather than spread twice — two
    // `courseId` keys in one object literal would silently overwrite, and the
    // scope is the one that must win.
    //
    // Intersecting (instead of rejecting) a teacher-supplied courseId keeps
    // asking about a course outside the assignment indistinguishable from
    // asking about one that does not exist.
    const courseCondition: Prisma.EnrollmentWhereInput['courseId'] =
      readable === null
        ? params.courseId
        : params.courseId
          ? { in: readable.filter((id) => id === params.courseId) }
          : { in: readable };

    // Only search phones when the query has digits: for a name query the
    // stripped string is '' and `contains: ''` matches every student.
    const phoneDigits = params.q?.replace(/\D/g, '') ?? '';

    const where: Prisma.EnrollmentWhereInput = {
      ...(courseCondition ? { courseId: courseCondition } : {}),
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
                ...(phoneDigits ? [{ phone: { contains: phoneDigits } }] : []),
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
          // Captured payments, including refunded ones: a partially refunded
          // payment still has a refundable balance, and a refunded one is part
          // of what this student paid. Newest first.
          payments: {
            where: { status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
            orderBy: { paidAt: 'desc' },
            select: {
              id: true,
              amount: true,
              currency: true,
              paidAt: true,
              status: true,
              provider: true,
              refundedAmount: true,
              // For the refund status shown beside the payment's own status.
              transactions: REFUND_TX_INCLUDE,
            },
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
            status: p.status,
            provider: p.provider,
            refundedAmount: Number(p.refundedAmount),
            // Beside `status`, never instead of it: see refund-state.ts.
            ...refundStateOf(p, p.transactions),
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
    // Defence in depth behind @AdminOnly() on the route: free access is an
    // administrative decision (owner decision D3), whatever capabilities a
    // teacher's course assignment carries.
    assertAdministrator(actor.role, 'grant access');
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

    const enrollment = await withSerializableRetry(
      this.prisma,
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
   * Removes a student from one course ("Remove from course" in the dashboard).
   *
   * This is an ACCESS decision, not a financial one. What it does, in one
   * Serializable transaction:
   *
   *  - the enrollment becomes REVOKED. Every access check (lesson gate,
   *    playback ticket and heartbeat, attachment ticket, my-courses, search,
   *    announcements, expiry reminders) reads that state live, so access ends
   *    at once; ACTIVE playback tickets are revoked as well;
   *  - the enrollment's section grants are removed and `coversAllSections` is
   *    cleared, so a later re-enrollment starts from what that later purchase
   *    buys. Grant-access only ever widens, so without this a student removed
   *    from a full-course enrollment who later redeemed a one-section card got
   *    the whole course back. The grants are snapshotted into the audit entry,
   *    and what was bought stays on the code redemptions and part purchases;
   *  - the student's live part entitlements on this course are revoked (the
   *    schema's additive revocation — the rows stay);
   *  - PENDING payments on this enrollment are CANCELLED. No money has moved on
   *    a pending payment, and `capture()` sets the enrollment ACTIVE, so leaving
   *    one open would let a late confirmation silently undo the removal;
   *  - the course's student count is recounted.
   *
   * What it deliberately does NOT do:
   *
   *  - refund. PAID payments and their revenue ledger lines are untouched, so
   *    reported revenue does not move. A refund is the separate, explicit
   *    `payments/:id/refund` action;
   *  - return a code. Course cards are sold for cash before they are redeemed;
   *    a redemption is the record that a sold card was used. There is no
   *    "returned" code state, and the redemption row stays;
   *  - touch watch progress, watch events, counted plays, the wallet, other
   *    courses' enrollments or the account.
   *
   * Refused while a payment on this enrollment is AUTHORIZED: that money is
   * held at a provider and has to be captured or voided there first.
   *
   * Idempotent: removing an already-removed student changes nothing and says
   * so. The state change is conditional, so two concurrent removals cannot both
   * apply their side effects.
   */
  async revoke(
    enrollmentId: string,
    actor: { id: string; role: UserRole },
    reason: string,
    expectedCourseId?: string,
  ) {
    // Removal also cancels payments and revokes purchased parts, so it is an
    // administrator's decision. It used to be open to any teacher holding the
    // course's `students` flag, which is a permission to *view* students.
    if (actor.role !== UserRole.MASTER && actor.role !== UserRole.ADMIN) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Only administrators can remove a student from a course',
      });
    }

    // The revocation itself is shared with refunds; see revoke-enrollment.ts.
    const result = await withSerializableRetry(this.prisma, (tx) =>
      revokeEnrollmentInTx(tx, this.audit, {
        enrollmentId,
        actor,
        reason,
        expectedCourseId,
      }),
    );

    return {
      ok: true,
      enrollmentId,
      userId: result.enrollment.userId,
      courseId: result.enrollment.courseId,
      state: EnrollmentState.REVOKED,
      alreadyRemoved: result.alreadyRevoked,
      cancelledPayments: result.cancelledPayments,
      revokedPartEntitlements: result.revokedPartEntitlements,
      removedSectionGrants: result.removedSectionGrants,
      revokedPlaybackTickets: result.revokedPlaybackTickets,
      retained: result.retained,
    };
  }

  /**
   * Moves a student's course entitlement to another course, together with the
   * academic profile that decides eligibility — the "student transferred to
   * another university/college" operation.
   *
   * Why a dedicated operation: academic targeting (`assertCourseTargeting`) is
   * enforced live on every access, so pointing a profile at a new university
   * immediately hides the old university's courses, while simply revoking and
   * re-granting as two admin actions cannot be atomic and leaves a window in
   * which the student holds access to neither course. And re-issuing a code
   * would record a second purchase for access already paid for.
   *
   * What it does, in ONE Serializable transaction (the student is never
   * visible between states):
   *  1. grants access to the destination course — whole-course when the source
   *     enrollment covered the whole course, otherwise scoped to the sections
   *     of one destination part, mirroring the section-scoped source. The grant
   *     uses `method: ADMIN_APPROVAL` and `SectionGrantSource.ADMIN`: an
   *     administrative move, not a code or a payment;
   *  2. revokes the source enrollment through the same `revokeEnrollmentInTx`
   *     that "Remove from course" and refunds use — payments, code
   *     redemptions, part purchases and watch history are preserved; live
   *     playback tickets for the source course die; source part entitlements
   *     are additively revoked (rows stay);
   *  3. points the student's profile at the destination course's university and
   *     faculty (and the chosen department), so targeting keeps passing for the
   *     destination course. The academic year/rung is re-validated against the
   *     destination department's ladder by the catalog service;
   *  4. records the destination part entitlement (when part-scoped) with
   *     `PartEntitlementSource.MIGRATION` and no purchase — an honest
   *     provenance the schema already provides for exactly this.
   *
   * What it deliberately does NOT do:
   *  - create a Payment, PaymentTransaction, RevenueLedger,
   *    AccessCodeRedemption or CoursePartPurchase row. A transfer is not a
   *    purchase and recognises no revenue;
   *  - issue, revoke or touch any access code;
   *  - touch watch progress, counted plays, the wallet, the library, the
   *    source course's content, or any other enrollment;
   *  - narrow an existing destination enrollment: a student who already holds
   *    the whole destination course is refused, not downgraded.
   *
   * Idempotent: a repeat of a completed transfer answers
   * `alreadyTransferred: true` from current state and changes nothing. A
   * source enrollment revoked by some other operation (e.g. "Remove from
   * course") is answered as INVALID_STATE rather than guessed at.
   */
  async transfer(
    params: {
      enrollmentId: string;
      destinationCourseId: string;
      /** Required iff the source enrollment is scoped to specific sections. */
      destinationPartId?: string;
      /** Required iff the destination course targets more than one department. */
      departmentId?: string;
      /** Defaults to the student's current rung, revalidated for the destination. */
      academicYearId?: string;
      reason: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    // Moving access AND an academic profile is administration only (owner
    // decision D3), checked before anything is read.
    assertAdministrator(actor.role, 'transfer course access');
    if (!this.catalog) {
      throw new Error('CatalogService is not wired into EnrollmentsService');
    }

    const source = await this.prisma.enrollment.findUnique({
      where: { id: params.enrollmentId },
      select: {
        id: true,
        userId: true,
        courseId: true,
        state: true,
        coversAllSections: true,
        course: { select: { id: true, title: true } },
      },
    });
    if (!source) throw AppException.notFound('Enrollment', params.enrollmentId);

    // The operation moves a student between two catalog units; the actor must
    // be allowed to manage students in BOTH.
    await Promise.all([
      this.access.assertCanManageCourse(actor.id, actor.role, source.courseId, 'students'),
      this.access.assertCanManageCourse(actor.id, actor.role, params.destinationCourseId, 'students'),
    ]);

    if (params.destinationCourseId === source.courseId) {
      throw AppException.validation({
        destinationCourseId: ['must differ from the enrollment’s current course'],
      });
    }

    // The destination course must be filed under a university and faculty:
    // the student's profile is about to be pointed at them, and a transfer
    // into a globally-open course has no academic home to point at.
    const destination = await this.prisma.course.findFirst({
      where: { id: params.destinationCourseId, ...notDeleted },
      select: {
        id: true,
        title: true,
        universityId: true,
        facultyId: true,
        accessDurationType: true,
        accessDurationDays: true,
        accessEndsAt: true,
        departments: { select: { departmentId: true } },
      },
    });
    if (!destination) throw AppException.notFound('Course', params.destinationCourseId);
    if (!destination.universityId || !destination.facultyId) {
      throw AppException.validation({
        destinationCourseId: [
          'a transfer needs a destination course filed under a university and faculty — the student’s academic profile follows the course',
        ],
      });
    }

    // A repeat of an already-completed transfer is answered from current
    // state instead of failing or applying anything twice. The response has
    // the same shape as a fresh transfer; its counters describe this call
    // (which changed nothing).
    const profile = await this.prisma.studentProfile.findUnique({
      where: { userId: source.userId },
    });
    if (!profile) throw AppException.notFound('StudentProfile', source.userId);

    if (source.state === EnrollmentState.REVOKED) {
      const destinationEnrollment = await this.prisma.enrollment.findUnique({
        where: {
          userId_courseId: { userId: source.userId, courseId: params.destinationCourseId },
        },
        select: { id: true, state: true, coversAllSections: true },
      });
      if (destinationEnrollment?.state === EnrollmentState.ACTIVE) {
        return {
          ok: true,
          alreadyTransferred: true,
          userId: source.userId,
          from: {
            enrollmentId: source.id,
            courseId: source.courseId,
            courseTitle: source.course.title,
            state: EnrollmentState.REVOKED,
            removedSectionGrants: 0,
            revokedPartEntitlements: 0,
            revokedPlaybackTickets: 0,
            retained: { paidPayments: 0, codeRedemptions: 0 },
          },
          to: {
            enrollmentId: destinationEnrollment.id,
            courseId: destination.id,
            courseTitle: destination.title,
            state: EnrollmentState.ACTIVE,
            coversAllSections: destinationEnrollment.coversAllSections,
            grantedSectionIds: [] as string[],
            partId: null,
            partEntitlementCreated: false,
            partEntitlementReinstated: false,
          },
          profile: {
            universityId: profile.universityId,
            facultyId: profile.facultyId,
            departmentId: profile.departmentId,
            academicYearId: profile.academicYearId,
          },
        };
      }
      throw new AppException(ErrorCode.INVALID_STATE, {
        message:
          'The source enrollment is revoked but the destination access is not active. Inspect the student’s history before retrying.',
        details: { enrollmentId: source.id, state: source.state },
      });
    }

    // --- destination department ---------------------------------------------
    const targetedDepartmentIds = destination.departments.map((d) => d.departmentId);
    let departmentId: string | null = params.departmentId ?? null;
    if (targetedDepartmentIds.length > 0) {
      if (!departmentId) {
        if (targetedDepartmentIds.length === 1) {
          [departmentId] = targetedDepartmentIds;
        } else {
          throw AppException.validation({
            departmentId: [
              'is required: the destination course targets several departments, so the student must be filed under exactly one of them',
            ],
          });
        }
      } else if (!targetedDepartmentIds.includes(departmentId)) {
        throw AppException.validation({
          departmentId: ['is not one of the destination course’s targeted departments'],
        });
      }
    } else if (departmentId) {
      throw AppException.validation({
        departmentId: ['was sent, but the destination course is not filed under any department'],
      });
    }

    // --- destination section scope ------------------------------------------
    let sectionScope: string[] | null = null;
    let destinationPartId: string | null = null;
    if (params.destinationPartId) {
      const part = await this.prisma.coursePart.findFirst({
        where: { id: params.destinationPartId, courseId: destination.id, deletedAt: null },
        select: {
          id: true,
          // The same freeze rule a PART code gets at generation: every
          // non-deleted section of the part, whatever its status.
          sections: {
            where: { deletedAt: null },
            orderBy: { sortOrder: 'asc' },
            select: { id: true },
          },
        },
      });
      if (!part) throw AppException.notFound('Course part', params.destinationPartId);
      if (part.sections.length === 0) {
        throw AppException.validation({
          destinationPartId: [
            'has no sections yet, so transferring into it would unlock nothing',
          ],
        });
      }
      destinationPartId = part.id;
      sectionScope = part.sections.map((s) => s.id);
    } else if (!source.coversAllSections) {
      throw AppException.validation({
        destinationPartId: [
          'is required: the source enrollment is scoped to specific sections, so the destination scope must be named too',
        ],
      });
    }

    // --- academic chain validation ------------------------------------------
    // Mirrors the integrity rule `UsersService.assertAcademicSelectionIsCoherent`
    // enforces on profile edits: a client never decides the chain, the database
    // does. Done here rather than through UsersService to keep this service
    // free of a dependency that would cycle.
    const academicYearId = params.academicYearId ?? profile.academicYearId;
    const academicFields: Record<string, string[]> = {};
    if (departmentId) {
      const [university, faculty, department] = await Promise.all([
        this.prisma.university.findFirst({
          where: { id: destination.universityId, isActive: true, ...notDeleted },
          select: { id: true },
        }),
        this.prisma.faculty.findFirst({
          where: { id: destination.facultyId, isActive: true, ...notDeleted },
          select: { id: true, universityId: true },
        }),
        this.prisma.department.findFirst({
          where: { id: departmentId, isActive: true, ...notDeleted },
          select: { id: true, facultyId: true },
        }),
      ]);
      if (!university) academicFields.universityId = ['unknown or inactive university'];
      if (!faculty) academicFields.facultyId = ['unknown or inactive faculty'];
      if (!department) academicFields.departmentId = ['unknown or inactive department'];
      if (faculty && university && faculty.universityId !== university.id) {
        academicFields.facultyId = ['does not belong to the destination university'];
      }
      if (department && faculty && department.facultyId !== faculty.id) {
        academicFields.departmentId = ['does not belong to the destination faculty'];
      }
    }
    if (academicYearId) {
      const structure = await this.catalog.resolveAcademicStructure(
        departmentId
          ? { departmentId }
          : { facultyId: destination.facultyId },
      );
      if (!structure) {
        academicFields.academicYearId = [
          'no academic structure covers the destination college',
        ];
      } else {
        const rung = await this.prisma.academicYear.findFirst({
          where: { id: academicYearId, structureId: structure.id, isActive: true },
          select: { id: true },
        });
        if (!rung) {
          academicFields.academicYearId = [
            'does not belong to the destination college’s ladder — send an explicit academicYearId',
          ];
        }
      }
    } else {
      academicFields.academicYearId = [
        'is required: the student has no rung and none was sent',
      ];
    }
    if (Object.keys(academicFields).length > 0) {
      throw AppException.validation(academicFields, 'Academic selection is not coherent');
    }

    // Refuse to make the destination narrower-then-wider: a student who
    // already holds the whole destination course keeps it (grantAccess only
    // widens), so proceeding would silently transfer a part-scoped source
    // into whole-course access. That decision belongs to a human, not here.
    if (sectionScope !== null) {
      const existingDestination = await this.prisma.enrollment.findUnique({
        where: {
          userId_courseId: { userId: source.userId, courseId: destination.id },
        },
        select: { id: true, state: true, coversAllSections: true, accessEndsAt: true },
      });
      const holdsLiveWholeCourse =
        existingDestination?.coversAllSections === true &&
        existingDestination.state === EnrollmentState.ACTIVE &&
        (existingDestination.accessEndsAt === null ||
          existingDestination.accessEndsAt > new Date());
      if (holdsLiveWholeCourse) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message:
            'The student already holds the whole destination course. A part-scoped transfer would not narrow it; revoke first if that is really wanted.',
          details: { enrollmentId: existingDestination?.id, courseId: destination.id },
        });
      }
    }

    // --- the transaction ------------------------------------------------------
    const result = await withSerializableRetry(this.prisma, async (tx) => {
      // Re-read inside the transaction: a grant or revocation that landed
      // while the checks above ran must abort this attempt, not be overwritten
      // by decisions made from a stale snapshot.
      const sourceNow = await tx.enrollment.findUnique({
        where: { id: source.id },
        select: { id: true, state: true },
      });
      if (!sourceNow || sourceNow.state !== EnrollmentState.ACTIVE) {
        throw new AppException(ErrorCode.CONFLICT, {
          message:
            'The source enrollment changed while the transfer was being prepared. Re-check the student and retry.',
          details: { enrollmentId: source.id, state: sourceNow?.state ?? 'MISSING' },
        });
      }

      // 1. Destination access first, so the student is never recorded as
      //    holding nothing — and if anything below throws, all of it rolls
      //    back together.
      const destinationEnrollment = await this.grantAccess(tx, {
        userId: source.userId,
        course: destination,
        method: EnrollmentMethod.ADMIN_APPROVAL,
        approvedById: actor.id,
        sectionScope,
        grantSource: SectionGrantSource.ADMIN,
        ...(destinationPartId ? { partId: destinationPartId } : {}),
      });

      // 1b. Part-ownership bookkeeping for the destination part, so the
      //     student app's "owned parts" view agrees with the section grants.
      //     `MIGRATION` is the schema's own provenance for this: no purchase
      //     row is created and no revenue is recognised.
      let partEntitlementCreated = false;
      let partEntitlementReinstated = false;
      if (destinationPartId) {
        const existing = await tx.coursePartEntitlement.findUnique({
          where: {
            userId_coursePartId: {
              userId: source.userId,
              coursePartId: destinationPartId,
            },
          },
        });
        if (!existing) {
          await tx.coursePartEntitlement.create({
            data: {
              userId: source.userId,
              courseId: destination.id,
              coursePartId: destinationPartId,
              source: PartEntitlementSource.MIGRATION,
              purchaseId: null,
              revokedAt: null,
            },
          });
          partEntitlementCreated = true;
        } else if (existing.revokedAt) {
          await tx.coursePartEntitlement.update({
            where: { id: existing.id },
            data: { revokedAt: null, revokedById: null, revokedReason: null },
          });
          partEntitlementReinstated = true;
        }
      }

      // 2. The source enrollment goes through the exact same revocation the
      //    dashboard's "Remove from course" uses, so history, redemptions,
      //    purchases and watch progress survive untouched.
      const revocation = await revokeEnrollmentInTx(tx, this.audit, {
        enrollmentId: source.id,
        actor,
        reason: params.reason,
        expectedCourseId: source.courseId,
        ticketReason: 'Course access transferred',
        auditContext: {
          transfer: {
            destinationCourseId: destination.id,
            destinationEnrollmentId: destinationEnrollment.id,
            destinationPartId,
          },
        },
      });
      if (revocation.alreadyRevoked) {
        // Only reachable if a concurrent operation revoked the source between
        // the re-read above and here. Abort so the grant and profile change
        // made from a stale premise roll back with it.
        throw new AppException(ErrorCode.CONFLICT, {
          message:
            'The source enrollment was revoked concurrently. Re-check the student and retry.',
          details: { enrollmentId: source.id },
        });
      }

      // 3. Profile follows the destination course, so the live targeting
      //    checks keep passing for it. Run inside the transaction: the
      //    eligibility change and the access change are one fact.
      await tx.studentProfile.update({
        where: { userId: source.userId },
        data: {
          universityId: destination.universityId,
          facultyId: destination.facultyId,
          departmentId,
          academicYearId,
        },
      });

      await this.audit.recordTx(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.ACCESS_GRANT,
        entity: 'enrollment',
        entityId: destinationEnrollment.id,
        after: {
          userId: source.userId,
          courseId: destination.id,
          method: EnrollmentMethod.ADMIN_APPROVAL,
          coversAllSections: sectionScope === null,
          grantedSectionIds: sectionScope ?? [],
          transferFromCourseId: source.courseId,
          transferFromEnrollmentId: source.id,
        },
        note: params.reason,
      });

      await this.audit.recordTx(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.UPDATE,
        entity: 'user',
        entityId: source.userId,
        before: {
          universityId: profile.universityId,
          facultyId: profile.facultyId,
          departmentId: profile.departmentId,
          academicYearId: profile.academicYearId,
        },
        after: {
          universityId: destination.universityId,
          facultyId: destination.facultyId,
          departmentId,
          academicYearId,
        },
        note: params.reason,
      });

      return {
        destinationEnrollment,
        revocation,
        partEntitlementCreated,
        partEntitlementReinstated,
      };
    });

    // Outside the transaction: a notification failing must not roll back a
    // completed transfer.
    await Promise.allSettled([
      this.notifications.createForUser({
        userId: source.userId,
        kind: NotificationKind.ENROLLMENT,
        title: 'Your course access was transferred',
        titleAr: 'تم نقل وصولك إلى كورس آخر',
        body: `Your access to ${source.course.title} was moved to ${destination.title}.`,
        bodyAr: `تم نقل وصولك من ${source.course.title} إلى ${destination.title}.`,
        route: `/course/${destination.id}`,
      }),
    ]);

    return {
      ok: true,
      alreadyTransferred: false,
      userId: source.userId,
      from: {
        enrollmentId: source.id,
        courseId: source.courseId,
        courseTitle: source.course.title,
        state: EnrollmentState.REVOKED,
        removedSectionGrants: result.revocation.removedSectionGrants,
        revokedPartEntitlements: result.revocation.revokedPartEntitlements,
        revokedPlaybackTickets: result.revocation.revokedPlaybackTickets,
        retained: result.revocation.retained,
      },
      to: {
        enrollmentId: result.destinationEnrollment.id,
        courseId: destination.id,
        courseTitle: destination.title,
        state: EnrollmentState.ACTIVE,
        coversAllSections: sectionScope === null,
        grantedSectionIds: sectionScope ?? [],
        partId: destinationPartId,
        partEntitlementCreated: result.partEntitlementCreated,
        partEntitlementReinstated: result.partEntitlementReinstated,
      },
      profile: {
        universityId: destination.universityId,
        facultyId: destination.facultyId,
        departmentId,
        academicYearId,
      },
    };
  }

  /** Extends an access window without creating a new payment. */
  async extend(
    enrollmentId: string,
    days: number,
    actor: { id: string; role: UserRole },
    note?: string,
  ) {
    // Administration only (owner decision D3), checked before anything is read
    // so a teacher learns nothing about the enrollment either.
    assertAdministrator(actor.role, 'extend access');

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
