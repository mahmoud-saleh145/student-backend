import { CourseStatus, type Enrollment, EnrollmentState, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';

/**
 * The preview exception of `assertContentAccess`.
 *
 * Every route that serves a lecture or its material to a student - lesson
 * detail, lesson-by-video, the playback ticket and the attachment ticket -
 * passes `allowPreview: true` and the content's own `isPreview` flag. The
 * exception exists so a prospective student can sample a course that is ON
 * OFFER. It must never turn a lesson or attachment id into access to a course
 * that is not: an unlisted (HIDDEN), withdrawn (DRAFT), paused (SUSPENDED),
 * archived or deleted course previews nothing to a student it does not
 * already serve.
 *
 * Before this was pinned down, a student with no enrolment, or with a revoked,
 * expired or pending one, was handed preview content of a HIDDEN, DRAFT or
 * SUSPENDED course by id alone (and of a deleted course whose lesson row was
 * left behind): `decide()` does not look at the course status for a student
 * without an active enrolment, so the denial code never said "not available".
 *
 * Everything that must NOT change is pinned here too: previews of a PUBLISHED
 * course for everyone who is not yet entitled, enrolled students of a HIDDEN
 * course, and staff.
 */

const DAY = 86_400_000;
const COURSE_ID = 'crs_1';
const USER_ID = 'usr_1';

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    id: 'enr_1',
    userId: USER_ID,
    courseId: COURSE_ID,
    state: EnrollmentState.ACTIVE,
    method: 'PAYMENT',
    accessStartsAt: new Date(Date.now() - DAY),
    accessEndsAt: null,
    approvedById: null,
    approvedAt: null,
    revokedById: null,
    revokedAt: null,
    revokedReason: null,
    completedLessons: 0,
    lastLessonId: null,
    lastAccessedAt: null,
    createdAt: new Date(Date.now() - DAY),
    updatedAt: new Date(),
    ...overrides,
  } as Enrollment;
}

/** `null` = the course does not exist or is soft-deleted (`resolve()` filters `deletedAt`). */
type Status = CourseStatus | null;

function service(params: { status: Status; enrollment?: Enrollment | null; teacherAssigned?: boolean }) {
  const prisma = {
    course: {
      findFirst: jest.fn().mockResolvedValue(
        params.status === null
          ? null
          : { id: COURSE_ID, status: params.status, enrollmentMethods: [], isFree: false },
      ),
    },
    enrollment: { findUnique: jest.fn().mockResolvedValue(params.enrollment ?? null) },
    courseTeacher: {
      findUnique: jest.fn().mockResolvedValue(params.teacherAssigned ? { id: 'ct_1' } : null),
    },
  };
  const svc = new CourseAccessService(prisma as never, null as never, null as never);
  // Department/year targeting is a separate gate with its own tests; it runs
  // before any of this and is not what is under test.
  svc.targetingEnforced = false;
  return svc;
}

async function attempt(
  svc: CourseAccessService,
  opts: { role?: UserRole; preview: boolean },
): Promise<{ allowed: true } | { allowed: false; code: string; details: Record<string, unknown> | undefined }> {
  try {
    await svc.assertContentAccess({
      userId: USER_ID,
      role: opts.role ?? UserRole.STUDENT,
      courseId: COURSE_ID,
      allowPreview: true,
      isPreviewContent: opts.preview,
    });
    return { allowed: true };
  } catch (error) {
    if (!(error instanceof AppException)) throw error;
    return { allowed: false, code: error.code, details: error.details };
  }
}

const NOT_ON_OFFER: Status[] = [CourseStatus.HIDDEN, CourseStatus.DRAFT, CourseStatus.SUSPENDED, null];

const NOT_ENTITLED: Array<[string, Enrollment | null]> = [
  ['no enrolment', null],
  ['a REVOKED enrolment', enrollment({ state: EnrollmentState.REVOKED })],
  ['an EXPIRED enrolment', enrollment({ state: EnrollmentState.EXPIRED })],
  ['an ACTIVE enrolment whose window has closed', enrollment({ accessEndsAt: new Date(Date.now() - DAY) })],
  ['a PENDING_APPROVAL enrolment', enrollment({ state: EnrollmentState.PENDING_APPROVAL })],
  ['a PENDING_PAYMENT enrolment', enrollment({ state: EnrollmentState.PENDING_PAYMENT })],
];

describe('assertContentAccess - the preview exception', () => {
  describe('refuses preview content of a course that is not on offer', () => {
    for (const status of NOT_ON_OFFER) {
      for (const [who, row] of NOT_ENTITLED) {
        it(`${status ?? 'deleted/missing'} course, student with ${who}`, async () => {
          const result = await attempt(service({ status, enrollment: row }), { preview: true });
          expect(result.allowed).toBe(false);
        });
      }
    }
  });

  describe('keeps previews of a PUBLISHED course open to students who are not entitled yet', () => {
    for (const [who, row] of NOT_ENTITLED) {
      it(`student with ${who}`, async () => {
        const result = await attempt(service({ status: CourseStatus.PUBLISHED, enrollment: row }), { preview: true });
        expect(result).toEqual({ allowed: true });
      });
    }

    it('but still not non-preview content', async () => {
      const result = await attempt(service({ status: CourseStatus.PUBLISHED, enrollment: null }), { preview: false });
      expect(result).toMatchObject({ allowed: false, code: ErrorCode.NOT_ENROLLED });
    });
  });

  describe('an ARCHIVED course previews nothing (unchanged)', () => {
    for (const [who, row] of [['no enrolment', null], ['an ACTIVE enrolment', enrollment()]] as const) {
      it(`student with ${who}`, async () => {
        const result = await attempt(service({ status: CourseStatus.ARCHIVED, enrollment: row }), { preview: true });
        expect(result).toMatchObject({ allowed: false, code: ErrorCode.COURSE_ARCHIVED });
      });
    }
  });

  describe('enrolled students keep exactly the access they had', () => {
    it.each([CourseStatus.PUBLISHED, CourseStatus.HIDDEN])(
      'an ACTIVE enrolment in a %s course opens preview and non-preview content',
      async (status) => {
        for (const preview of [true, false]) {
          const result = await attempt(service({ status, enrollment: enrollment() }), { preview });
          expect(result).toEqual({ allowed: true });
        }
      },
    );

    it.each([CourseStatus.DRAFT, CourseStatus.SUSPENDED])(
      'an ACTIVE enrolment in a %s course is refused with COURSE_NOT_AVAILABLE, preview or not',
      async (status) => {
        for (const preview of [true, false]) {
          const result = await attempt(service({ status, enrollment: enrollment() }), { preview });
          expect(result).toMatchObject({ allowed: false, code: ErrorCode.COURSE_NOT_AVAILABLE });
        }
      },
    );
  });

  describe('staff authorization is unchanged', () => {
    const OPEN: CourseStatus[] = [CourseStatus.PUBLISHED, CourseStatus.HIDDEN, CourseStatus.DRAFT, CourseStatus.SUSPENDED];

    for (const role of [UserRole.ADMIN, UserRole.MASTER]) {
      it(`${role} reads preview and non-preview content of any non-archived course`, async () => {
        for (const status of OPEN) {
          for (const preview of [true, false]) {
            expect(await attempt(service({ status }), { role, preview })).toEqual({ allowed: true });
          }
        }
      });
    }

    it('an assigned TEACHER reads any non-archived course', async () => {
      for (const status of OPEN) {
        for (const preview of [true, false]) {
          const result = await attempt(service({ status, teacherAssigned: true }), { role: UserRole.TEACHER, preview });
          expect(result).toEqual({ allowed: true });
        }
      }
    });

    it('no staff role reads an ARCHIVED course', async () => {
      for (const role of [UserRole.ADMIN, UserRole.MASTER]) {
        const result = await attempt(service({ status: CourseStatus.ARCHIVED }), { role, preview: true });
        expect(result).toMatchObject({ allowed: false, code: ErrorCode.COURSE_ARCHIVED });
      }
    });

    it('an unassigned TEACHER is treated like any other non-entitled user', async () => {
      const published = await attempt(service({ status: CourseStatus.PUBLISHED }), { role: UserRole.TEACHER, preview: true });
      expect(published).toEqual({ allowed: true });
      const hidden = await attempt(service({ status: CourseStatus.HIDDEN }), { role: UserRole.TEACHER, preview: true });
      expect(hidden.allowed).toBe(false);
    });
  });

  describe('a refusal says nothing about a course that is not on offer', () => {
    it.each(NOT_ON_OFFER)('%s course, student with no enrolment: NOT_ENROLLED / NOT_FOUND, no course id', async (status) => {
      const result = await attempt(service({ status, enrollment: null }), { preview: true });
      expect(result.allowed).toBe(false);
      if (result.allowed) return;
      // The same answer as any locked lesson (or a missing course): nothing
      // that tells an outsider the course exists or what state it is in.
      expect(result.code).toBe(status === null ? ErrorCode.NOT_FOUND : ErrorCode.NOT_ENROLLED);
      expect(result.details ?? {}).not.toHaveProperty('courseId');
    });

    it('a PUBLISHED course still reports its id, which the app needs to offer enrolment', async () => {
      const result = await attempt(service({ status: CourseStatus.PUBLISHED, enrollment: null }), { preview: false });
      expect(result).toMatchObject({ allowed: false, details: { courseId: COURSE_ID } });
    });

    it('a student who holds an enrolment row still gets the course id back', async () => {
      const result = await attempt(
        service({ status: CourseStatus.HIDDEN, enrollment: enrollment({ state: EnrollmentState.EXPIRED }) }),
        { preview: false },
      );
      expect(result).toMatchObject({ allowed: false, code: ErrorCode.ACCESS_EXPIRED, details: { courseId: COURSE_ID } });
    });
  });
});
