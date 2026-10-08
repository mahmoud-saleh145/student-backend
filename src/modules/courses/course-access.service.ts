import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CourseStatus,
  type Prisma,
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

import { COURSE_TARGETING_ENABLED } from './course-targeting.config';

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

  /**
   * Whether `assertCourseTargeting` refuses students outside a course's
   * academic group. Read from the single switch in course-targeting.config.ts;
   * an instance field only so tests can exercise both states.
   */
  targetingEnforced: boolean = COURSE_TARGETING_ENABLED;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: PlatformSettingsService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether online payment is live.
   *
   * `payment.provider` ships as 'none'. Nothing about the payment
   * implementation is removed — the module, the Payment rows, the webhook
   * handlers and the provider clients are all intact and untouched — it is
   * simply not offered while no provider is configured. Turning it back on is
   * setting PAYMENT_PROVIDER, not restoring code.
   *
   * Filtering HERE rather than in the app is deliberate: the client renders
   * exactly the methods this list contains, so a single server-side answer
   * keeps the mobile app, any future client and the enrolment endpoint from
   * disagreeing about whether a checkout exists.
   */
  private get onlinePaymentEnabled(): boolean {
    return (this.config.get<string>('payment.provider') ?? 'none') !== 'none';
  }

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
      const staffAllowed = await this.staffMayViewCourse(
        params.userId!,
        params.role,
        course.id,
      );
      if (staffAllowed) {
        return {
          state: course.status === CourseStatus.ARCHIVED ? 'ARCHIVED' : 'ACTIVE',
          canAccessContent: course.status !== CourseStatus.ARCHIVED,
          enrollment: null,
          expiresAt: null,
          denialCode:
            course.status === CourseStatus.ARCHIVED
              ? ErrorCode.COURSE_ARCHIVED
              : undefined,
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

    await this.assertCourseTargeting(
      params.userId,
      params.role ?? UserRole.STUDENT,
      course.id,
    );

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
    courses: {
      id: string;
      status: CourseStatus;
      enrollmentMethods: EnrollmentMethod[];
    }[],
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
      availableMethods: this.availableMethods(
        decision.state,
        enrollmentMethods,
        courseStatus,
      ),
    };
  }

  private availableMethods(
    state: AccessState,
    configured: EnrollmentMethod[],
    courseStatus: CourseStatus,
  ): EnrollmentMethod[] {
    if (courseStatus !== CourseStatus.PUBLISHED) return [];

    // Offering a checkout that cannot complete is worse than offering
    // nothing: the student picks it, reaches a dead end, and opens a support
    // ticket. Applied to every branch below rather than to one of them.
    const offerable = this.onlinePaymentEnabled
      ? configured
      : configured.filter((m) => m !== EnrollmentMethod.PAYMENT);

    switch (state) {
      case 'NOT_ENROLLED':
      case 'EXPIRED':
        // Renewal uses the same methods as a first join.
        return offerable;
      case 'PENDING_PAYMENT':
        // Let the student retry payment or fall back to a code. With no
        // provider configured this leaves CODE, which is the only way a
        // part-paid enrolment can now be completed.
        return offerable.filter(
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

  /**
   * `assertCanManageCourse`, plus the existence check it deliberately omits.
   *
   * `assertCanManageCourse` answers only "may this actor manage course X", and
   * for an admin or master it answers without touching the database — so on its
   * own it says nothing about whether X exists. Every mutation in
   * `CoursesAdminService` loads the course first and so never needs more.
   *
   * A route that uses a `courseId` to *derive a storage path* does need more.
   * Without an existence check an admin could mint objects under an arbitrary
   * id, and a teacher's refusal would read "you are not assigned to this
   * course" when the truth is that no such course exists. Pairing the two here
   * keeps the authority in one place instead of repeating `findFirst` + assert
   * at each such call site, and leaves the capability vocabulary unchanged.
   *
   * Soft-deleted courses are treated as absent, matching every other admin
   * path (`notDeleted`).
   */
  async assertCourseExistsAndManageable(
    userId: string,
    role: UserRole,
    courseId: string,
    capability: 'content' | 'pricing' | 'publish' | 'students' | 'revenue' = 'content',
  ): Promise<void> {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: { id: true },
    });
    if (!course) throw AppException.notFound('Course', courseId);

    await this.assertCanManageCourse(userId, role, courseId, capability);
  }

  /**
   * Whether a course is offered to a given academic group.
   *
   * A course is filed against an optional `universityId`, `facultyId`,
   * `academicYearId` and a set of `departments`. Those columns were writable
   * from the admin API and readable everywhere, but nothing ever compared them
   * to the enrolling student — so a Mechanical Engineering student could take a
   * course offered only to the Civil Engineering department, and targeting was
   * decoration. This method is the missing comparison.
   *
   * ## The rule is a conjunction, not a disjunction
   *
   * A dimension the course sets must be one the student matches. A dimension the
   * course leaves null is unconstrained and is skipped. A student whose own
   * profile has no value for a constrained dimension does *not* match: an unset
   * profile is missing information, and treating it as a wildcard would make
   * every unconfigured account eligible for everything — which is the same hole
   * in a new shape.
   *
   * ## Why a course with no targeting at all is open
   *
   * Every column is nullable, and plenty of courses are deliberately general.
   * Refusing those would break every course created before targeting existed,
   * so "no targeting" means "open". Only a course that actually names a
   * dimension is restricted by it.
   *
   * Staff are not subject to this: an administrator enrolling a student by hand
   * is a deliberate override, which is why callers pass the role through.
   */
  /** Shared SQL eligibility filter keeps pagination, search and recommendations consistent. */
  async studentCourseWhere(userId: string | null): Promise<Prisma.CourseWhereInput> {
    if (!userId) return {};
    const profile = await this.prisma.studentProfile.findUnique({ where: { userId } });
    if (!profile)
      return {
        universityId: null,
        facultyId: null,
        academicYearId: null,
        departments: { none: {} },
      };
    return {
      AND: [
        { OR: [{ universityId: null }, { universityId: profile.universityId }] },
        { OR: [{ facultyId: null }, { facultyId: profile.facultyId }] },
        { OR: [{ academicYearId: null }, { academicYearId: profile.academicYearId }] },
        {
          OR: [
            { departments: { none: {} } },
            {
              departments: {
                some: { departmentId: profile.departmentId ?? '__unclassified__' },
              },
            },
          ],
        },
      ],
    };
  }

  async isTargetedToStudent(
    userId: string,
    courseId: string,
    role: UserRole,
  ): Promise<boolean> {
    if (role !== UserRole.STUDENT) return true;

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: {
        universityId: true,
        facultyId: true,
        academicYearId: true,
        departments: { select: { departmentId: true } },
      },
    });

    if (!course) return true;

    const constrainsDepartment = course.departments.length > 0;
    const constrainsUniversity = course.universityId !== null;
    const constrainsFaculty = course.facultyId !== null;
    const constrainsYear = course.academicYearId !== null;

    // Untargeted: open to everyone.
    if (
      !constrainsDepartment &&
      !constrainsUniversity &&
      !constrainsFaculty &&
      !constrainsYear
    ) {
      return true;
    }

    const profile = await this.prisma.studentProfile.findUnique({
      where: { userId },
      select: {
        universityId: true,
        facultyId: true,
        departmentId: true,
        academicYearId: true,
      },
    });

    // No profile, or a dimension the course constrains that the student has not
    // filled in. Undetermined, and undetermined is not a match.
    if (!profile) return false;

    if (
      constrainsDepartment &&
      !course.departments.some((d) => d.departmentId === profile.departmentId)
    ) {
      return false;
    }
    if (constrainsUniversity && course.universityId !== profile.universityId)
      return false;
    if (constrainsFaculty && course.facultyId !== profile.facultyId) return false;
    if (constrainsYear && course.academicYearId !== profile.academicYearId) return false;

    return true;
  }

  /**
   * Throws `COURSE_NOT_TARGETED` when the student is outside the course's
   * academic group.
   *
   * `details.mismatch` names the dimensions that failed, so the client can tell
   * the student which field of their profile to correct rather than saying only
   * "not permitted".
   */
  async assertCourseTargeting(
    userId: string,
    role: UserRole,
    courseId: string,
  ): Promise<void> {
    // Enforcement is switched off by product decision — see
    // course-targeting.config.ts. The rule itself (isTargetedToStudent) is
    // unchanged and still evaluates correctly when this is turned back on.
    if (!this.targetingEnforced) return;
    if (role !== UserRole.STUDENT) return;
    if (await this.isTargetedToStudent(userId, courseId, role)) return;

    throw new AppException(ErrorCode.COURSE_NOT_TARGETED, {
      message: 'This course is not offered to your department or year',
    });
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
   * The course ids a staff actor may read student- or revenue-bearing rows for.
   *
   * This is the single place list-endpoint scoping is derived, so
   * `GET /admin/enrollments` and `GET /admin/payments` cannot each invent
   * their own weaker version of `assertCanManageCourse`.
   *
   * Returns `null` for "unrestricted" (master and admin) rather than a list of
   * every course, so callers can tell *may see everything* apart from *may see
   * nothing*. That distinction is load-bearing: a teacher assigned to nothing
   * must yield an empty page, never an unfiltered one.
   *
   * Callers intersect a client-supplied `courseId` with the result rather than
   * rejecting it, so probing for a course the teacher cannot see is
   * indistinguishable from probing for one that does not exist.
   */
  async readableCourseIds(
    userId: string,
    role: UserRole,
    capability: 'students' | 'revenue',
  ): Promise<string[] | null> {
    if (role === UserRole.MASTER || role === UserRole.ADMIN) return null;
    if (role !== UserRole.TEACHER) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE);
    }

    const rows = await this.prisma.courseTeacher.findMany({
      where: {
        teacherId: userId,
        ...(capability === 'students'
          ? { canViewStudents: true }
          : { canViewRevenue: true }),
      },
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
    await this.assertCourseTargeting(userId, UserRole.STUDENT, courseId);

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
