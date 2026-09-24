import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { ERROR_STATUS } from '../../src/common/errors/error-codes';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { CoursesAdminController } from '../../src/modules/courses/courses.admin.controller';
import { CoursePartsAdminController } from '../../src/modules/course-parts/course-parts.controller';
import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';

/**
 * Who may bring a course into existence.
 *
 * The rule is that an administrator creates a course and assigns it to the
 * teachers who will work on it; a teacher creates none. That has to hold at
 * three places, and this file exercises all three rather than assuming the
 * outermost one is enough:
 *
 *   1. the route — `@AdminOnly()` on `POST /admin/courses`, enforced by
 *      `RolesGuard`, which is what turns a teacher's direct API call into 403;
 *   2. the service — `CoursesAdminService.create` refuses a non-administrator
 *      whatever route reached it, because a decorator protects one route and
 *      not a method;
 *   3. the payload — none of the fields a teacher controls (their own id in
 *      `teacherIds`, someone else's id, a course id) changes the answer.
 *
 * The regression half matters as much: a teacher must keep everything they
 * had. Those cases are at the bottom.
 */

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const MASTER = { id: 'usr_master', role: UserRole.MASTER };
const TEACHER = { id: 'usr_teacher', role: UserRole.TEACHER };
const STUDENT = { id: 'usr_student', role: UserRole.STUDENT };

const COURSE_INPUT = {
  title: 'Organic Chemistry',
  teacherIds: ['usr_teacher'],
  enrollmentMethods: ['CODE'],
  price: 500,
};

/**
 * A prisma double that records what it was asked to do.
 *
 * `$transaction` runs the callback with this same object, so a `course.create`
 * inside the transaction is visible to the assertions — which is the point: a
 * refusal that still wrote a row would pass a test that only checked the
 * thrown error.
 */
function buildPrisma() {
  const courseCreate = jest.fn(async () => ({
    id: 'crs_new',
    title: COURSE_INPUT.title,
    status: 'DRAFT',
  }));

  const prisma = {
    course: {
      create: courseCreate,
      // No slug clash, so `uniqueSlug` settles on its first candidate.
      findUnique: jest.fn(async () => null),
      // `create` finishes by returning `detailForStaff`, which reads the row
      // back. Individual tests override this where the record matters.
      findFirst: jest.fn(async () => ({
        id: 'crs_new',
        thumbnailKey: null,
        prices: [],
        teachers: [],
        // `detailForStaff` reads these off the row; its own `include` always
        // selects them, so a double without them is unrealistic.
        _count: { enrollments: 0, attachments: 0 },
        sectionCount: 0,
        lessonCount: 0,
        departments: [],
      })),
      update: jest.fn(async () => ({ id: 'crs_new' })),
      findMany: jest.fn(async () => [] as unknown[]),
      count: jest.fn(async () => 0),
    },
    coursePrice: { create: jest.fn(async () => ({})) },
    courseSection: { createMany: jest.fn(async () => ({})) },
    courseTeacher: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async () => ({ id: 'ct_1', isLead: false })),
      updateMany: jest.fn(async () => ({})),
      count: jest.fn(async () => 2),
      delete: jest.fn(async () => ({})),
    },
    // `assertTeachersExist` compares this count with the number of distinct
    // ids it was given, so the double answers with however many were asked for.
    user: {
      count: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        new Set(args.where.id.in).size,
      ),
    },
    // Assigned below: the interactive form hands the callback this same
    // object, which it cannot reference from inside its own initializer.
    $transaction: jest.fn(async (arg: unknown) => arg),
  };

  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : arg,
  );

  return { prisma, courseCreate };
}

function buildService(over: { prisma?: unknown; access?: unknown } = {}) {
  const { prisma, courseCreate } = buildPrisma();

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
    staffMayViewCourse: jest.fn(async () => true),
    teacherCourseIds: jest.fn(async () => []),
  };

  const courses = { recountCourse: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const storage = { publicAssetUrl: jest.fn(async () => null) };

  const service = new CoursesAdminService(
    (over.prisma ?? prisma) as never,
    courses as never,
    (over.access ?? access) as never,
    audit as never,
    storage as never,
  );

  return { service, prisma, courseCreate, access, audit, courses };
}

type Controller = { prototype: Record<string, unknown> };

/** The role metadata a route carries, as `RolesGuard` reads it. */
function rolesOn(controller: Controller, method: string): UserRole[] | undefined {
  return new Reflector().getAllAndOverride<UserRole[]>(ROLES_KEY, [
    controller.prototype[method] as never,
    controller as never,
  ]);
}

/** Runs the real RolesGuard against a route, as an HTTP request would. */
function guardOn(
  controller: Controller,
  method: string,
  user: { id: string; role: UserRole } | null,
): boolean {
  const guard = new RolesGuard(new Reflector());

  const context = {
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user: user ?? undefined }) }),
  };

  return guard.canActivate(context as never);
}

const COURSES_CTRL = CoursesAdminController as unknown as Controller;

const rolesFor = (method: keyof CoursesAdminController) =>
  rolesOn(COURSES_CTRL, method as string);

const guardRoute = (
  method: keyof CoursesAdminController,
  user: { id: string; role: UserRole } | null,
) => guardOn(COURSES_CTRL, method as string, user);

// ---------------------------------------------------------------------------
// 1. The route
// ---------------------------------------------------------------------------

describe('POST /admin/courses — route authorization', () => {
  it('is declared for administrators only', () => {
    expect(rolesFor('create')).toEqual([UserRole.MASTER, UserRole.ADMIN]);
  });

  it.each([
    ['master', MASTER],
    ['admin', ADMIN],
  ])('lets %s through', (_label, user) => {
    expect(guardRoute('create', user)).toBe(true);
  });

  it.each([
    ['teacher', TEACHER],
    ['student', STUDENT],
  ])('refuses %s with 403', (_label, user) => {
    // The guard is what a direct API call meets, so this is the 403 a teacher
    // gets from curl as much as from the dashboard.
    let thrown: unknown;
    try {
      guardRoute('create', user);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).getStatus()).toBe(403);
    expect(ERROR_STATUS[ErrorCode.INSUFFICIENT_ROLE]).toBe(403);
  });

  it('still lets a teacher reach the routes they need', () => {
    // The point of the change is narrow. Listing, reading, editing content and
    // publishing stay @StaffOnly(); only creation moved.
    for (const route of ['list', 'detail', 'update', 'publish'] as const) {
      expect(rolesFor(route)).toContain(UserRole.TEACHER);
      expect(guardRoute(route, TEACHER)).toBe(true);
    }
  });

  it('keeps staffing administrative', () => {
    for (const route of ['assignTeacher', 'removeTeacher'] as const) {
      expect(rolesFor(route)).toEqual([UserRole.MASTER, UserRole.ADMIN]);
      expect(() => guardRoute(route, TEACHER)).toThrow(AppException);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The service
// ---------------------------------------------------------------------------

describe('CoursesAdminService.create — administrators', () => {
  it.each([
    ['an admin', ADMIN],
    ['the master', MASTER],
  ])('%s creates the course', async (_label, actor) => {
    const { service, courseCreate, audit } = buildService();

    await service.create({ ...COURSE_INPUT } as never, actor);

    expect(courseCreate).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: actor.id, entity: 'course' }),
    );
  });

  it('assigns the named teachers to the new course', async () => {
    const { service, courseCreate } = buildService();

    await service.create(
      { ...COURSE_INPUT, teacherIds: ['usr_teacher', 'usr_other'] } as never,
      ADMIN,
    );

    const args = (courseCreate.mock.calls[0] as unknown[] | undefined)?.[0] as {
      data: {
        teachers: { create: { teacherId: string; isLead: boolean }[] };
        createdById: string;
      };
    };
    const data = args.data;

    expect(data.teachers.create.map((row) => row.teacherId)).toEqual([
      'usr_teacher',
      'usr_other',
    ]);
    // Exactly one lead, and the creator is recorded as the creator.
    expect(data.teachers.create.filter((row) => row.isLead)).toHaveLength(1);
    expect(data.createdById).toBe(ADMIN.id);
  });
});

describe('CoursesAdminService.create — a teacher is refused', () => {
  /** The refusal, asserted the same way for every attempt below. */
  async function expectRefused(
    input: unknown,
    actor: { id: string; role: UserRole } = TEACHER,
  ) {
    const { service, courseCreate, prisma } = buildService();

    let thrown: unknown;
    try {
      await service.create(input as never, actor);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppException);
    expect((thrown as AppException).getStatus()).toBe(403);
    expect((thrown as AppException).code).toBe(ErrorCode.INSUFFICIENT_ROLE);

    // Nothing was written. A refusal that still created rows would be worse
    // than no refusal at all, because it would look like it worked.
    expect(courseCreate).not.toHaveBeenCalled();
    expect(prisma.coursePrice.create).not.toHaveBeenCalled();
    expect(prisma.courseTeacher.upsert).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();

    return thrown as AppException;
  }

  it('refuses even when the service is reached directly', async () => {
    // No controller, no guard — this is the second line of defence on its own.
    await expectRefused(COURSE_INPUT);
  });

  it('refuses a student too', async () => {
    await expectRefused(COURSE_INPUT, STUDENT);
  });

  it('refuses before validating anything else', async () => {
    // An empty `teacherIds` is a 422 for an admin. A teacher must still get
    // the 403: the role is decided first, so the error cannot be used to probe
    // which payloads would have been accepted.
    const error = await expectRefused({ ...COURSE_INPUT, teacherIds: [] });
    expect(error.code).toBe(ErrorCode.INSUFFICIENT_ROLE);
  });
});

describe('a teacher cannot arrange their own access by payload', () => {
  it('cannot self-assign by naming themselves', async () => {
    const { service, courseCreate } = buildService();

    await expect(
      service.create({ ...COURSE_INPUT, teacherIds: [TEACHER.id] } as never, TEACHER),
    ).rejects.toBeInstanceOf(AppException);

    expect(courseCreate).not.toHaveBeenCalled();
  });

  it('cannot self-assign by omitting themselves either', async () => {
    // The previous implementation appended the actor to `teacherIds` when a
    // teacher created a course, which is exactly the self-assignment that
    // `assignTeacher` reserves to administrators. Neither spelling works now.
    const { service, courseCreate } = buildService();

    await expect(
      service.create({ ...COURSE_INPUT, teacherIds: ['usr_other'] } as never, TEACHER),
    ).rejects.toBeInstanceOf(AppException);

    expect(courseCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['another teacher as lead', { leadTeacherId: 'usr_other' }],
    ['a forged creator id', { createdById: ADMIN.id }],
    ['a forged role in the body', { role: UserRole.ADMIN }],
    ['an existing course id', { id: 'crs_existing' }],
    ['a free course', { isFree: true, price: 0 }],
  ])('ignores %s in the payload', async (_label, extra) => {
    // The actor comes from the verified access token via @CurrentUser(); the
    // body is data. None of these fields is consulted before the role check.
    const { service, courseCreate } = buildService();

    await expect(
      service.create({ ...COURSE_INPUT, ...extra } as never, TEACHER),
    ).rejects.toBeInstanceOf(AppException);

    expect(courseCreate).not.toHaveBeenCalled();
  });

  it('cannot add themselves through assignTeacher', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.assignTeacher('crs_1', { teacherId: TEACHER.id }, TEACHER),
    ).rejects.toBeInstanceOf(AppException);

    expect(prisma.courseTeacher.upsert).not.toHaveBeenCalled();
  });

  it('cannot remove a colleague from a course', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.removeTeacher('crs_1', 'usr_other', TEACHER),
    ).rejects.toBeInstanceOf(AppException);

    expect(prisma.courseTeacher.delete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Assignment, and what a teacher keeps
// ---------------------------------------------------------------------------

describe('an admin assigns a course to a teacher', () => {
  it('writes the assignment and audits it', async () => {
    const { service, prisma, audit } = buildService();

    await service.assignTeacher('crs_1', { teacherId: 'usr_teacher' }, ADMIN);

    expect(prisma.courseTeacher.upsert).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entity: 'course_teacher', actorId: ADMIN.id }),
    );
  });

  it('gives a new assignment content access but not pricing or publishing', async () => {
    const { service, prisma } = buildService();

    await service.assignTeacher('crs_1', { teacherId: 'usr_teacher' }, ADMIN);

    const args = (prisma.courseTeacher.upsert.mock.calls[0] as unknown[] | undefined)?.[0] as {
      create: Record<string, unknown>;
    };

    expect(args.create).toMatchObject({
      canEditContent: true,
      canViewStudents: true,
      canEditPricing: false,
      canPublish: false,
      assignedById: ADMIN.id,
    });
  });
});

describe('a teacher keeps what they had', () => {
  /** A teacher assigned to `crs_mine` with the default content permissions. */
  function assignedTeacher() {
    const access = new CourseAccessService(
      {
        courseTeacher: {
          findUnique: jest.fn(async (args: { where: { courseId_teacherId: { courseId: string } } }) =>
            args.where.courseId_teacherId.courseId === 'crs_mine'
              ? {
                id: 'ct_1',
                canEditContent: true,
                canEditPricing: false,
                canPublish: false,
                canViewStudents: true,
                canViewRevenue: false,
              }
              : null,
          ),
          findMany: jest.fn(async () => [{ courseId: 'crs_mine' }]),
        },
      } as never,
      { teacherMay: jest.fn(async () => true) } as never,
    );

    return access;
  }

  it('can manage content on an assigned course', async () => {
    // Uploading and deleting videos, editing sections and lessons all go
    // through this one check, so it stands for all of them.
    await expect(
      assignedTeacher().assertCanManageCourse(TEACHER.id, TEACHER.role, 'crs_mine', 'content'),
    ).resolves.toBeUndefined();
  });

  it('cannot manage content on a course that is not theirs', async () => {
    await expect(
      assignedTeacher().assertCanManageCourse(TEACHER.id, TEACHER.role, 'crs_other', 'content'),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_COURSE_TEACHER });
  });

  it('still cannot reprice an assigned course without that permission', async () => {
    await expect(
      assignedTeacher().assertCanManageCourse(TEACHER.id, TEACHER.role, 'crs_mine', 'pricing'),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
  });

  it('sees their assigned courses in the management list', async () => {
    const teacherCourseIds = jest.fn(async () => ['crs_mine']);
    const { service, prisma } = buildService({
      access: { teacherCourseIds, assertCanManageCourse: jest.fn() },
    });

    // The list runs its two queries inside an array transaction.
    prisma.$transaction = jest.fn(async (ops: unknown) =>
      Array.isArray(ops) ? [[], 0] : ops,
    );

    await service.list({ actor: TEACHER, page: 1, pageSize: 20 });

    // The scope comes from their assignments, not from a filter in the query
    // string, so a teacher cannot widen it by asking for someone else's id.
    expect(teacherCourseIds).toHaveBeenCalledWith(TEACHER.id);
  });
});

describe('GET /admin/courses/:courseId — a teacher reads only assigned courses', () => {
  it('serves a course the teacher is assigned to', async () => {
    const { service, prisma } = buildService();
    prisma.course.findFirst = jest.fn(async () => ({
      id: 'crs_mine',
      thumbnailKey: null,
      prices: [],
      teachers: [],
      _count: { enrollments: 0, attachments: 0 },
      sectionCount: 0,
      lessonCount: 0,
      departments: [],
    }));

    await expect(service.detailForActor('crs_mine', TEACHER)).resolves.toMatchObject({
      id: 'crs_mine',
    });
  });

  it('refuses one they are not assigned to', async () => {
    // The record carries price history and every teacher's revenue share, so
    // knowing an id is not a reason to be shown it.
    const access = {
      staffMayViewCourse: jest.fn(async () => false),
      assertCanManageCourse: jest.fn(),
    };
    const { service, prisma } = buildService({ access });

    await expect(service.detailForActor('crs_other', TEACHER)).rejects.toMatchObject({
      code: ErrorCode.NOT_COURSE_TEACHER,
    });

    expect(prisma.course.findFirst).not.toHaveBeenCalled();
  });

  it('serves any course to an admin', async () => {
    const { service, prisma } = buildService();
    prisma.course.findFirst = jest.fn(async () => ({
      id: 'crs_other',
      thumbnailKey: null,
      prices: [],
      teachers: [],
      _count: { enrollments: 0, attachments: 0 },
      sectionCount: 0,
      lessonCount: 0,
      departments: [],
    }));

    await expect(service.detailForActor('crs_other', ADMIN)).resolves.toMatchObject({
      id: 'crs_other',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. What deliberately did NOT change
// ---------------------------------------------------------------------------

describe('course parts stay a staff-level content operation', () => {
  const PARTS = CoursePartsAdminController as unknown as Controller;

  /**
   * Adding a part to an existing course is content management, not course
   * creation: the course already exists and an administrator already decided
   * who teaches it. So these routes stay `@StaffOnly()`, and the service then
   * checks that this teacher is assigned to this course — the same per-course
   * check that governs sections, lessons and videos.
   *
   * This is pinned because the obvious over-correction to "teachers cannot
   * create courses" is to sweep every course-shaped `@Post()` into
   * `@AdminOnly()`, which would take content management away from teachers
   * without anyone deciding to.
   */
  it.each([
    ['create a part', 'create'],
    ['seed the default structure', 'createDefault'],
    ['list parts for staff', 'list'],
    ['reorder parts', 'reorder'],
  ])('a teacher may still %s', (_label, method) => {
    expect(rolesOn(PARTS, method)).toContain(UserRole.TEACHER);
    expect(guardOn(PARTS, method, TEACHER)).toBe(true);
  });

  it('the part purchase report stays administrative', () => {
    // Financial, so it is @AdminOnly() and must remain so.
    expect(rolesOn(PARTS, 'report')).toEqual([UserRole.MASTER, UserRole.ADMIN]);
    expect(() => guardOn(PARTS, 'report', TEACHER)).toThrow(AppException);
  });

  it('a teacher reaching parts is still checked against their assignment', async () => {
    // The route admits them; the service is what refuses an unassigned course.
    const assertCanManageCourse = jest.fn(async () => undefined);
    const { service } = buildService({ access: { assertCanManageCourse } });

    await service.update('crs_mine', { title: 'Renamed' } as never, TEACHER);

    expect(assertCanManageCourse).toHaveBeenCalledWith(
      TEACHER.id,
      TEACHER.role,
      'crs_mine',
      'content',
    );
  });
});
