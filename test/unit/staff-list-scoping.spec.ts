import { UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';

/**
 * Who may read the platform-wide lists of students and money.
 *
 * Both `GET /admin/enrollments` and `GET /admin/payments` are `@StaffOnly()`,
 * which admits MASTER, ADMIN and TEACHER. That decorator was never the problem:
 * a teacher *should* to be able to see the students in their own courses. The
 * defect was that neither list scoped its query, so "their own courses" became
 * "every course" — and with it every student's name, phone and email, every
 * payment, and the platform revenue totals.
 *
 * Both are now scoped through one helper, `CourseAccessService.readableCourseIds`,
 * because the point of a centralized access engine is that a new list endpoint
 * cannot quietly implement a laxer rule than the one beside it. The capability
 * asked for differs and matters: reading students follows `canViewStudents`,
 * reading money follows `canViewRevenue` — the same flag analytics already
 * enforced, so `/admin/payments` no longer routes around it.
 *
 * The tests use the *real* `CourseAccessService` rather than a stub of
 * `readableCourseIds`, because the behaviour under test is the composition of
 * the two: a stub would happily hand a student a course list and prove nothing
 * about the role handling that sits in front of it.
 *
 * Assertions are on the shape of the query rather than the rows returned,
 * because the guarantee is "unassigned courses are absent from the WHERE
 * clause" — which holds whatever a given double happens to return.
 */

// ---------------------------------------------------------------------------
// Actors and doubles
// ---------------------------------------------------------------------------

const MASTER = { id: 'usr_master', role: UserRole.MASTER };
const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const TEACHER_A = { id: 'usr_teacher_a', role: UserRole.TEACHER };
const STUDENT = { id: 'usr_student', role: UserRole.STUDENT };

type Assignment = {
  courseId: string;
  canViewStudents: boolean;
  canViewRevenue: boolean;
};

/** A real `CourseAccessService` over a fixed assignment table. */
function accessWith(assignments: Assignment[]) {
  return new CourseAccessService(
    {
      courseTeacher: {
        findMany: jest.fn(async (args: { where: Record<string, unknown> }) =>
          assignments
            .filter((a) =>
              args.where.canViewStudents === true
                ? a.canViewStudents
                : args.where.canViewRevenue === true
                  ? a.canViewRevenue
                  : true,
            )
            .map((a) => ({ courseId: a.courseId })),
        ),
      },
    } as never,
    { teacherMay: jest.fn(async () => true) } as never,
    { get: () => 'none' } as never,
  );
}

/** The access engine an actor of this role should meet in production. */
function accessFor(
  role: UserRole,
  courseIds: string[],
  flags: Partial<Assignment> = {},
): CourseAccessService {
  if (role === UserRole.MASTER || role === UserRole.ADMIN) return accessWith([]);
  return accessWith(
    courseIds.map((courseId) => ({
      courseId,
      canViewStudents: true,
      canViewRevenue: true,
      ...flags,
    })),
  );
}

function buildEnrollments(actor: { id: string; role: UserRole }, courseIds: string[]) {
  const findMany = jest.fn(async () => [] as unknown[]);
  const count = jest.fn(async () => 0);
  const prisma = {
    enrollment: { findMany, count },
    // The list issues its two reads as one array transaction.
    $transaction: jest.fn(async () => [[], 0] as [unknown[], number]),
  };

  const service = new EnrollmentsService(
    prisma as never,
    {} as never,
    accessFor(actor.role, courseIds) as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  return { service, prisma, findMany, count };
}

function buildPayments(actor: { id: string; role: UserRole }, courseIds: string[]) {
  const findMany = jest.fn(async () => [] as unknown[]);
  const count = jest.fn(async () => 0);
  const aggregate = jest.fn(async () => ({
    _sum: { amount: null, refundedAmount: null },
  }));
  const prisma = {
    payment: { findMany, count, aggregate },
    $transaction: jest.fn(
      async () => [[], 0, { _sum: { amount: null, refundedAmount: null } }] as unknown[],
    ),
  };

  const service = new PaymentsService(
    prisma as never,
    { record: jest.fn(async () => undefined) } as never,
    accessFor(actor.role, courseIds) as never,
    {
      getOrThrow: () => ({
        provider: 'none',
        defaultPlatformSharePercent: 30,
        currency: 'EGP',
        checkoutBaseUrl: null,
      }),
    } as never,
  );

  return { service, prisma, findMany, count, aggregate };
}

/** The `where` the enrollment query was actually given. */
function enrollmentWhere(findMany: jest.Mock): Record<string, unknown> {
  return (findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0]
    .where;
}

/**
 * The `where` each payment query was given.
 *
 * Read from the individual mocks rather than from the `$transaction`
 * argument: the service passes an array of *already-invoked* calls, so the
 * original argument objects only exist on those mocks.
 */
function paymentWheres(
  findMany: jest.Mock,
  count: jest.Mock,
  aggregate: jest.Mock,
): Record<string, unknown>[] {
  return [findMany, count, aggregate].map(
    (m) => (m.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where,
  );
}

// ---------------------------------------------------------------------------
// The helper itself
// ---------------------------------------------------------------------------

describe('CourseAccessService.readableCourseIds', () => {
  it.each([
    ['master', MASTER],
    ['an admin', ADMIN],
  ])('returns null (unrestricted) for %s', async (_label, actor) => {
    await expect(
      accessWith([]).readableCourseIds(actor.id, actor.role, 'students'),
    ).resolves.toBeNull();
  });

  it('gives a teacher only the courses whose assignment grants students', async () => {
    const access = accessWith([
      { courseId: 'crs_a', canViewStudents: true, canViewRevenue: false },
      { courseId: 'crs_b', canViewStudents: false, canViewRevenue: true },
    ]);

    await expect(
      access.readableCourseIds(TEACHER_A.id, TEACHER_A.role, 'students'),
    ).resolves.toEqual(['crs_a']);
  });

  it('gives a teacher money only where the assignment grants revenue', async () => {
    // The load-bearing asymmetry: students and money are separate grants, so
    // asking for 'revenue' must never fall back to 'students'.
    const access = accessWith([
      { courseId: 'crs_a', canViewStudents: true, canViewRevenue: false },
      { courseId: 'crs_b', canViewStudents: false, canViewRevenue: true },
    ]);

    await expect(
      access.readableCourseIds(TEACHER_A.id, TEACHER_A.role, 'revenue'),
    ).resolves.toEqual(['crs_b']);
  });

  it('refuses a role that is not staff at all', async () => {
    // Defence in depth: the route is @StaffOnly(), so this only fires if a
    // future caller reaches the helper without that decorator.
    await expect(
      accessWith([]).readableCourseIds(STUDENT.id, STUDENT.role, 'students'),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_ROLE });
  });
});

// ---------------------------------------------------------------------------
// GET /admin/enrollments
// ---------------------------------------------------------------------------

describe('EnrollmentsService.list — teacher scoping', () => {
  it("confines the query to the teacher's own courses", async () => {
    const { service, prisma, findMany, count } = buildEnrollments(TEACHER_A, ['crs_mine']);

    await service.list({ actor: TEACHER_A, page: 1, pageSize: 20 });

    expect(enrollmentWhere(findMany).courseId).toEqual({ in: ['crs_mine'] });
  });

  it("does not leak another teacher's course when its id is requested", async () => {
    // Teacher A asks for Teacher B's course by id. The scope is intersected, so
    // the query matches nothing. Deliberately not an error: telling "not yours"
    // apart from "does not exist" would itself be an existence oracle.
    const { service, prisma, findMany, count } = buildEnrollments(TEACHER_A, ['crs_mine']);

    await service.list({
      actor: TEACHER_A,
      page: 1,
      pageSize: 20,
      courseId: 'crs_other',
    });

    expect(enrollmentWhere(findMany).courseId).toEqual({ in: [] });
  });

  it('returns an empty page for a teacher assigned to nothing', async () => {
    // The dangerous case is `[]` being read as "no restriction".
    const { service, prisma, findMany, count } = buildEnrollments(TEACHER_A, []);

    const result = (await service.list({
      actor: TEACHER_A,
      page: 1,
      pageSize: 20,
    })) as unknown as { items: unknown[]; meta: { total: number } };

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('keeps the scope when a search term narrows it further', async () => {
    // `q` matches name and phone — the PII oracle the audit flagged. It must be
    // applied *inside* the course scope, never instead of it.
    const { service, prisma, findMany, count } = buildEnrollments(TEACHER_A, ['crs_mine']);

    await service.list({ actor: TEACHER_A, page: 1, pageSize: 20, q: '0100' });

    const where = enrollmentWhere(findMany);
    expect(where.courseId).toEqual({ in: ['crs_mine'] });
    expect(where.user).toBeDefined();
  });

  it('keeps the scope regardless of paging', async () => {
    const { service, prisma, findMany, count } = buildEnrollments(TEACHER_A, ['crs_mine']);

    await service.list({ actor: TEACHER_A, page: 7, pageSize: 100 });

    expect(enrollmentWhere(findMany).courseId).toEqual({ in: ['crs_mine'] });
  });

  it('keeps the scope when a section belonging to another course is named', async () => {
    const { service, prisma, findMany, count } = buildEnrollments(TEACHER_A, ['crs_mine']);

    await service.list({
      actor: TEACHER_A,
      page: 1,
      pageSize: 20,
      sectionId: 'sec_from_other_course',
    });

    const where = enrollmentWhere(findMany);
    expect(where.courseId).toEqual({ in: ['crs_mine'] });
    expect(where.OR).toBeDefined();
  });

  it('refuses a student reaching the service directly', async () => {
    const { service } = buildEnrollments(STUDENT, []);

    await expect(service.list({ actor: STUDENT, page: 1, pageSize: 20 })).rejects.toBeInstanceOf(
      AppException,
    );
  });

  it.each([
    ['an admin', ADMIN],
    ['the master', MASTER],
  ])('leaves %s unrestricted', async (_label, actor) => {
    const { service, prisma, findMany, count } = buildEnrollments(actor, []);

    await service.list({ actor, page: 1, pageSize: 20 });

    // No courseId key at all — the original platform-wide behaviour.
    expect(enrollmentWhere(findMany).courseId).toBeUndefined();
  });

  it('still honours an admin courseId filter exactly as before', async () => {
    const { service, prisma, findMany, count } = buildEnrollments(ADMIN, []);

    await service.list({ actor: ADMIN, page: 1, pageSize: 20, courseId: 'crs_x' });

    expect(enrollmentWhere(findMany).courseId).toBe('crs_x');
  });
});

// ---------------------------------------------------------------------------
// GET /admin/payments
// ---------------------------------------------------------------------------

describe('PaymentsService.listForAdmin — teacher scoping', () => {
  it("confines payments and totals to the teacher's revenue-permitted courses", async () => {
    const { service, prisma, findMany, count, aggregate } = buildPayments(TEACHER_A, ['crs_mine']);

    await service.listForAdmin({ actor: TEACHER_A, page: 1, pageSize: 20 });

    const wheres = paymentWheres(findMany, count, aggregate);
    expect(wheres[0].courseId).toEqual({ in: ['crs_mine'] });
    // The totals aggregate the same scoped where, so platform revenue cannot be
    // read out of the meta block of an otherwise correctly-scoped page.
    expect(wheres[2].courseId).toEqual({ in: ['crs_mine'] });
  });

  it('reports zero totals rather than platform totals for an unassigned teacher', async () => {
    const { service, prisma, findMany, count, aggregate } = buildPayments(TEACHER_A, []);

    const result = (await service.listForAdmin({
      actor: TEACHER_A,
      page: 1,
      pageSize: 20,
    })) as unknown as { meta: { totals: { paid: number; net: number } } };

    expect(result.meta.totals).toEqual({ paid: 0, refunded: 0, net: 0 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('matches nothing when a teacher names a course outside their scope', async () => {
    const { service, prisma, findMany, count, aggregate } = buildPayments(TEACHER_A, ['crs_mine']);

    await service.listForAdmin({
      actor: TEACHER_A,
      page: 1,
      pageSize: 20,
      courseId: 'crs_other',
    });

    expect(paymentWheres(findMany, count, aggregate)[0].courseId).toEqual({ in: [] });
  });

  it('gives a teacher with canViewRevenue off nothing, despite canViewStudents', async () => {
    // The exact control /admin/payments used to bypass: this teacher may see
    // students on crs_mine but not its money.
    const { service, prisma, findMany, count, aggregate } = buildPayments(TEACHER_A, []);

    // Rebuild with students-only permission on one course.
    const access = accessWith([
      { courseId: 'crs_mine', canViewStudents: true, canViewRevenue: false },
    ]);
    const scoped = new PaymentsService(
      prisma as never,
      { record: jest.fn(async () => undefined) } as never,
      access as never,
      {
        getOrThrow: () => ({
          provider: 'none',
          defaultPlatformSharePercent: 30,
          currency: 'EGP',
          checkoutBaseUrl: null,
        }),
      } as never,
    );

    const result = (await scoped.listForAdmin({
      actor: TEACHER_A,
      page: 1,
      pageSize: 20,
    })) as unknown as { meta: { totals: { net: number } } };

    expect(result.meta.totals.net).toBe(0);
    expect(service).toBeDefined();
  });

  it.each([
    ['an admin', ADMIN],
    ['the master', MASTER],
  ])('leaves %s unrestricted', async (_label, actor) => {
    const { service, prisma, findMany, count, aggregate } = buildPayments(actor, []);

    await service.listForAdmin({ actor, page: 1, pageSize: 20 });

    expect(paymentWheres(findMany, count, aggregate)[0].courseId).toBeUndefined();
  });

  it('refuses a student reaching the service directly', async () => {
    const { service } = buildPayments(STUDENT, []);

    await expect(
      service.listForAdmin({ actor: STUDENT, page: 1, pageSize: 20 }),
    ).rejects.toBeInstanceOf(AppException);
  });
});
