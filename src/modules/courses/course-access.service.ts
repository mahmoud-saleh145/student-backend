import { Injectable, Logger } from '@nestjs/common';
import {
  CourseStatus,
  type Enrollment,
  EnrollmentMethod,
  EnrollmentState,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import {
  PlatformSettingsService,
  type TeacherCapability,
} from '../settings/platform-settings.service';

/** Mirrors the mobile app's `AccessState` union exactly. */
export type AccessState =
  | 'NOT_ENROLLED'
  | 'PENDING_APPROVAL'
  | 'PENDING_PAYMENT'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REVOKED'
  | 'ARCHIVED';

export interface CourseAccess {
  state: AccessState;
  expiresAt: string | null;
  enrolledAt: string | null;
  availableMethods: EnrollmentMethod[];
}

export interface AccessDecision {
  state: AccessState;
  /** True only when protected content may be served right now. */
  canAccessContent: boolean;
  enrollment: Enrollment | null;
  expiresAt: Date | null;
  /** The error to raise if the caller demanded access. */
  denialCode?: ErrorCode;
}

/**
 * The access engine.
 *
 * Every gate in the system — course detail, lesson detail, playback ticket,
 * attachment ticket, progress writes — resolves access through this one
 * service. That is the whole point: access rules stated once, in one place,
 * so a new endpoint cannot accidentally implement a laxer version of them.
 *
 * The precedence order below is deliberate and worth stating, because the
 * naive ordering produces user-visible bugs:
 *
 *   1. Course archived      → ARCHIVED   (beats everything; content is gone)
 *   2. Enrollment revoked   → REVOKED    (an administrative decision)
 *   3. Access window lapsed → EXPIRED    (beats ACTIVE even if state says ACTIVE)
 *   4. Stored state         → as recorded
 *   5. No enrollment row    → NOT_ENROLLED
 *
 * Note step 3: `Enrollment.state` can legitimately still read ACTIVE while
 * `accessEndsAt` is in the past, because the nightly expiry sweep has not run
 * yet. Trusting the stored column alone would keep serving video for up to a
 * day after access lapsed, so the window is always evaluated live.
 */
@Injectable()
export class CourseAccessService {
  private readonly logger = new Logger(CourseAccessService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Resolution
  // ---------------------------------------------------------------------------

  async resolve(params: {
    userId: string | null;
    role?: UserRole;
    courseId: string;
  }): Promise<AccessDecision> {
    const course = await this.prisma.course.findFirst({
      where: { id: params.courseId, ...notDeleted },
      select: { id: true, status: true, enrollmentMethods: true, isFree: true },
    });

    if (!course) {
      return {
        state: 'NOT_ENROLLED',
        canAccessContent: false,
        enrollment: null,
        expiresAt: null,
        denialCode: ErrorCode.NOT_FOUND,
      };
    }

    // Staff bypass enrollment, but not the archive: an archived course is
    // archived for everyone, which is what makes the state meaningful.
    if (params.role && params.role !== UserRole.STUDENT) {
      const staffAllowed = await this.staffMayViewCourse(params.userId!, params.role, course.id);
      if (staffAllowed) {
        return {
          state: course.status === CourseStatus.ARCHIVED ? 'ARCHIVED' : 'ACTIVE',
          canAccessContent: course.status !== CourseStatus.ARCHIVED,
          enrollment: null,
          expiresAt: null,
          denialCode:
            course.status === CourseStatus.ARCHIVED ? ErrorCode.COURSE_ARCHIVED : undefined,
        };
      }
    }

    if (!params.userId) {
      return {
        state: 'NOT_ENROLLED',
        canAccessContent: false,
        enrollment: null,
        expiresAt: null,
        denialCode: ErrorCode.UNAUTHORIZED,
      };
    }

    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId: params.userId, courseId: params.courseId } },
    });

    return this.decide(course.status, enrollment);
  }

  /** Pure decision function — unit-testable without a database. */
  decide(courseStatus: CourseStatus, enrollment: Enrollment | null): AccessDecision {
    // 1. Archive beats everything.
    if (courseStatus === CourseStatus.ARCHIVED) {
      return {
        state: 'ARCHIVED',
        canAccessContent: false,
        enrollment,
        expiresAt: enrollment?.accessEndsAt ?? null,
        denialCode: ErrorCode.COURSE_ARCHIVED,
      };
    }

    if (!enrollment) {
      return {
        state: 'NOT_ENROLLED',
        canAccessContent: false,
        enrollment: null,
        expiresAt: null,
        denialCode: ErrorCode.NOT_ENROLLED,
      };
    }

    // 2. Revocation is an explicit administrative decision.
    if (enrollment.state === EnrollmentState.REVOKED) {
      return {
        state: 'REVOKED',
        canAccessContent: false,
        enrollment,
        expiresAt: enrollment.accessEndsAt,
        denialCode: ErrorCode.NOT_ENROLLED,
      };
    }

    // 3. Live window evaluation — do not trust the stored state alone.
    const now = Date.now();
    const lapsed =
      enrollment.accessEndsAt !== null && enrollment.accessEndsAt.getTime() <= now;

    if (lapsed) {
      return {
        state: 'EXPIRED',
        canAccessContent: false,
        enrollment,
        expiresAt: enrollment.accessEndsAt,
        denialCode: ErrorCode.ACCESS_EXPIRED,
      };
    }

    const notStarted = enrollment.accessStartsAt.getTime() > now;
    if (notStarted && enrollment.state === EnrollmentState.ACTIVE) {
      return {
        state: 'PENDING_APPROVAL',
        canAccessContent: false,
        enrollment,
        expiresAt: enrollment.accessEndsAt,
        denialCode: ErrorCode.ENROLLMENT_PENDING,
      };
    }

    // 4. Stored state.
    switch (enrollment.state) {
      case EnrollmentState.ACTIVE: {
        // Two lifecycle states keep the enrollment intact but pause delivery:
        //
        //   SUSPENDED — deliberately paused for everyone.
        //   DRAFT     — pulled back into authoring via unpublish(). The course
        //               is explicitly not fit for consumption, so continuing
        //               to stream it to already-enrolled students would defeat
        //               the point of withdrawing it.
        //
        // HIDDEN is deliberately NOT in this list. It means "unlisted": off
        // the catalogue for new students, unchanged for those already in.
        //
        // The reported state stays ACTIVE in both cases, because the student's
        // enrollment really is active — only delivery is withheld. That is what
        // makes re-publishing a no-op rather than a data repair.
        if (
          courseStatus === CourseStatus.SUSPENDED ||
          courseStatus === CourseStatus.DRAFT
        ) {
          return {
            state: 'ACTIVE',
            canAccessContent: false,
            enrollment,
            expiresAt: enrollment.accessEndsAt,
            denialCode: ErrorCode.COURSE_NOT_AVAILABLE,
          };
        }
        return {
          state: 'ACTIVE',
          canAccessContent: true,
          enrollment,
          expiresAt: enrollment.accessEndsAt,
        };
      }
      case EnrollmentState.PENDING_APPROVAL:
        return {
          state: 'PENDING_APPROVAL',
          canAccessContent: false,
          enrollment,
          expiresAt: enrollment.accessEndsAt,
          denialCode: ErrorCode.ENROLLMENT_PENDING,
        };
      case EnrollmentState.PENDING_PAYMENT:
        return {
          state: 'PENDING_PAYMENT',
          canAccessContent: false,
          enrollment,
          expiresAt: enrollment.accessEndsAt,
          denialCode: ErrorCode.PAYMENT_REQUIRED,
        };
      case EnrollmentState.EXPIRED:
        return {
          state: 'EXPIRED',
          canAccessContent: false,
          enrollment,
          expiresAt: enrollment.accessEndsAt,
          denialCode: ErrorCode.ACCESS_EXPIRED,
        };
      case EnrollmentState.ARCHIVED:
        return {
          state: 'ARCHIVED',
          canAccessContent: false,
          enrollment,
          expiresAt: enrollment.accessEndsAt,
          denialCode: ErrorCode.COURSE_ARCHIVED,
        };
      default:
        return {
          state: 'NOT_ENROLLED',
          canAccessContent: false,
          enrollment,
          expiresAt: null,
          denialCode: ErrorCode.NOT_ENROLLED,
        };
    }
  }

  /**
   * Throws unless protected content may be served. This is the function the
   * playback and attachment paths call — there is no other way in.
   */
  async assertContentAccess(params: {
    userId: string;
    role: UserRole;
    courseId: string;
    /** Preview lessons are watchable without enrollment. */
    allowPreview?: boolean;
    isPreviewContent?: boolean;
  }): Promise<AccessDecision> {
    const decision = await this.resolve({
      userId: params.userId,
      role: params.role,
      courseId: params.courseId,
    });

    if (decision.canAccessContent) return decision;

    // Preview content is the one documented exception, and only when the
    // course itself is still available.
    if (
      params.allowPreview &&
      params.isPreviewContent &&
      decision.state !== 'ARCHIVED' &&
      decision.denialCode !== ErrorCode.COURSE_NOT_AVAILABLE
    ) {
      return { ...decision, canAccessContent: true };
    }

    throw new AppException(decision.denialCode ?? ErrorCode.NOT_ENROLLED, {
      details: { accessState: decision.state, courseId: params.courseId },
    });
  }

  // ---------------------------------------------------------------------------
  // Batch resolution (list endpoints)
  // ---------------------------------------------------------------------------

  /**
   * Resolves access for many courses in two queries instead of 2N. Used by the
   * catalogue, my-courses and home feed, all of which render an access badge
   * per card.
   */
  async resolveMany(
    userId: string | null,
    courses: { id: string; status: CourseStatus; enrollmentMethods: EnrollmentMethod[] }[],
  ): Promise<Map<string, { decision: AccessDecision; access: CourseAccess }>> {
    const result = new Map<string, { decision: AccessDecision; access: CourseAccess }>();

    const enrollments = userId
      ? await this.prisma.enrollment.findMany({
          where: { userId, courseId: { in: courses.map((c) => c.id) } },
        })
      : [];

    const byCourse = new Map(enrollments.map((e) => [e.courseId, e]));

    for (const course of courses) {
      const decision = this.decide(course.status, byCourse.get(course.id) ?? null);
      result.set(course.id, {
        decision,
        access: this.toCourseAccess(decision, course.enrollmentMethods, course.status),
      });
    }

    return result;
  }

  /** Serialises a decision into the `CourseAccess` object the app expects. */
  toCourseAccess(
    decision: AccessDecision,
    enrollmentMethods: EnrollmentMethod[],
    courseStatus: CourseStatus,
  ): CourseAccess {
    return {
      state: decision.state,
      expiresAt: decision.expiresAt ? decision.expiresAt.toISOString() : null,
      enrolledAt: decision.enrollment?.createdAt.toISOString() ?? null,
      // Only offer join methods when joining is actually possible. An archived
      // or already-active course returns an empty array, which is what makes
      // the app hide the join button without needing its own rules.
      availableMethods: this.availableMethods(decision.state, enrollmentMethods, courseStatus),
    };
  }

  private availableMethods(
    state: AccessState,
    configured: EnrollmentMethod[],
    courseStatus: CourseStatus,
  ): EnrollmentMethod[] {
    if (courseStatus !== CourseStatus.PUBLISHED) return [];

    switch (state) {
      case 'NOT_ENROLLED':
      case 'EXPIRED':
        // Renewal uses the same methods as a first join.
        return configured;
      case 'PENDING_PAYMENT':
        // Let the student retry payment or fall back to a code.
        return configured.filter(
          (m) => m === EnrollmentMethod.PAYMENT || m === EnrollmentMethod.CODE,
        );
      case 'REVOKED':
      case 'PENDING_APPROVAL':
      case 'ACTIVE':
      case 'ARCHIVED':
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Staff authorization
  // ---------------------------------------------------------------------------

  /** Master and admin see everything; a teacher sees only assigned courses. */
  async staffMayViewCourse(
    userId: string,
    role: UserRole,
    courseId: string,
  ): Promise<boolean> {
    if (role === UserRole.MASTER || role === UserRole.ADMIN) return true;
    if (role !== UserRole.TEACHER) return false;

    const assignment = await this.prisma.courseTeacher.findUnique({
      where: { courseId_teacherId: { courseId, teacherId: userId } },
      select: { id: true },
    });
    return !!assignment;
  }

  /**
   * Resource-level authorization for teachers, with per-capability checks.
   * Throws NOT_COURSE_TEACHER rather than a generic 403 so the dashboard can
   * explain the difference between "not yours" and "not permitted".
   */
  /**
   * Platform-wide teacher switches, set by an administrator in Settings.
   *
   * These are separate from the per-course `CourseTeacher` flags and are
   * checked *in addition* to them: a teacher assigned with `canEditContent`
   * still cannot delete a lecture while the platform switch is off. Both must
   * allow it.
   *
   * Admin and master are never subject to these — the switches exist to
   * constrain delegation to teachers, not to constrain the platform owner.
   */
  async assertTeacherCapability(
    role: UserRole,
    capability: TeacherCapability,
  ): Promise<void> {
    if (role !== UserRole.TEACHER) return;

    if (!(await this.settings.teacherMay(capability))) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: `Teachers are not permitted to perform '${capability}' on this platform`,
        details: { capability, setting: `teacher.${capability}` },
      });
    }
  }

  async assertCanManageCourse(
    userId: string,
    role: UserRole,
    courseId: string,
    capability: 'content' | 'pricing' | 'publish' | 'students' | 'revenue' = 'content',
  ): Promise<void> {
    if (role === UserRole.MASTER || role === UserRole.ADMIN) return;

    if (role !== UserRole.TEACHER) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE);
    }

    const assignment = await this.prisma.courseTeacher.findUnique({
      where: { courseId_teacherId: { courseId, teacherId: userId } },
    });

    if (!assignment) {
      throw new AppException(ErrorCode.NOT_COURSE_TEACHER, {
        message: 'You are not assigned to this course',
      });
    }

    const permitted: Record<typeof capability, boolean> = {
      content: assignment.canEditContent,
      pricing: assignment.canEditPricing,
      publish: assignment.canPublish,
      students: assignment.canViewStudents,
      revenue: assignment.canViewRevenue,
    };

    if (!permitted[capability]) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: `Your assignment on this course does not grant '${capability}'`,
        details: { capability },
      });
    }
  }

  /** Course ids a teacher is assigned to — used to scope list queries. */
  async teacherCourseIds(teacherId: string): Promise<string[]> {
    const rows = await this.prisma.courseTeacher.findMany({
      where: { teacherId },
      select: { courseId: true },
    });
    return rows.map((r) => r.courseId);
  }

  /**
   * Which sections of a course a student is entitled to.
   *
   * Returns `null` for "all of them", which is what every enrollment created
   * before section-scoped codes existed means and what every course-scoped
   * grant still means. Only a SECTION code produces a restricted enrollment,
   * and only then does this return an explicit list.
   *
   * Callers must treat `null` and "restricted" differently rather than
   * flattening one into the other: an empty array is a real answer (a
   * restricted enrollment whose sections were all archived) and must not be
   * confused with unrestricted access.
   */
  async allowedSectionIds(userId: string, courseId: string): Promise<string[] | null> {
    const enrollment = await this.prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: {
        id: true,
        coversAllSections: true,
        sectionGrants: { select: { sectionId: true } },
      },
    });

    if (!enrollment || enrollment.coversAllSections) return null;
    return enrollment.sectionGrants.map((grant) => grant.sectionId);
  }

  /**
   * Section-level gate for a single lesson. Course-level access is assumed to
   * have been decided already by `decide()`/`resolve()`; this only narrows it.
   */
  async assertSectionAccessible(params: {
    userId: string;
    courseId: string;
    sectionId: string;
  }): Promise<void> {
    const allowed = await this.allowedSectionIds(params.userId, params.courseId);
    if (allowed === null) return;

    if (!allowed.includes(params.sectionId)) {
      throw new AppException(ErrorCode.NOT_ENROLLED, {
        message: 'Your access to this course does not include this section',
        details: { sectionId: params.sectionId },
      });
    }
  }
}
