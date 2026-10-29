import { EnrollmentState, UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { EnrollmentsController } from '../../src/modules/enrollments/enrollments.controller';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';

/**
 * Owner decision D3: granting free access (including approving a pending
 * request) and extending an access window are ADMINISTRATION ONLY.
 *
 * Both are checked twice: the route is @AdminOnly(), and the service refuses a
 * non-admin before reading anything. A teacher whose course assignment carries
 * the student capability - which used to be enough - must still get 403.
 */

const TEACHER_WITH_STUDENT_CAPABILITY = { id: 'usr_t', role: UserRole.TEACHER };
const ADMIN = { id: 'usr_a', role: UserRole.ADMIN };
const MASTER = { id: 'usr_m', role: UserRole.MASTER };

function build() {
  const enrollmentRow = {
    id: 'enr_1',
    courseId: 'crs_1',
    userId: 'usr_s',
    state: EnrollmentState.PENDING_PAYMENT,
    accessEndsAt: null,
  };
  const prisma = {
    enrollment: {
      findUnique: jest.fn(async () => enrollmentRow),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => ({ ...enrollmentRow, ...a.data })),
    },
    course: { findFirst: jest.fn(async () => null) },
  };
  // The capability check a teacher with canViewStudents would PASS.
  const access = { assertCanManageCourse: jest.fn(async () => undefined) };
  const audit = { record: jest.fn(async () => undefined) };
  const service = new EnrollmentsService(
    prisma as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    {} as never,
    audit as never,
  );
  return { service, prisma, access, audit };
}

describe('extend access window', () => {
  it('refuses a teacher with 403 before reading or writing anything', async () => {
    const { service, prisma } = build();

    await expect(
      service.extend('enr_1', 30, TEACHER_WITH_STUDENT_CAPABILITY),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

    expect(prisma.enrollment.findUnique).not.toHaveBeenCalled();
    expect(prisma.enrollment.update).not.toHaveBeenCalled();
  });

  it.each([ADMIN, MASTER])('still works for %o', async (actor) => {
    const { service, prisma, audit } = build();

    const updated = await service.extend('enr_1', 30, actor);

    expect(prisma.enrollment.update).toHaveBeenCalledTimes(1);
    expect(updated.state).toBe(EnrollmentState.ACTIVE);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });
});

describe('grant access directly', () => {
  it('refuses a teacher with 403 before any course lookup or grant', async () => {
    const { service, prisma, access } = build();

    await expect(
      service.grantByAdmin({ userId: 'usr_s', courseId: 'crs_1' }, TEACHER_WITH_STUDENT_CAPABILITY),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });

    expect(access.assertCanManageCourse).not.toHaveBeenCalled();
    expect(prisma.course.findFirst).not.toHaveBeenCalled();
  });

  it('lets an administrator through to the course check', async () => {
    const { service, prisma } = build();

    // The course does not exist in this double, so an admin gets past the role
    // check and is answered NOT_FOUND by the real lookup.
    await expect(
      service.grantByAdmin({ userId: 'usr_s', courseId: 'crs_1' }, ADMIN),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma.course.findFirst).toHaveBeenCalledTimes(1);
  });
});

describe('route roles', () => {
  const roles = (handler: object) => (Reflect.getMetadata(ROLES_KEY, handler) as string[]).slice().sort();

  it('makes grant and extend admin-only', () => {
    expect(roles(EnrollmentsController.prototype.grant)).toEqual(['ADMIN', 'MASTER']);
    expect(roles(EnrollmentsController.prototype.extend)).toEqual(['ADMIN', 'MASTER']);
  });

  it('leaves listing and rejecting requests to staff, and revoke admin-only as before', () => {
    expect(roles(EnrollmentsController.prototype.list)).toContain('TEACHER');
    expect(roles(EnrollmentsController.prototype.reject)).toContain('TEACHER');
    expect(roles(EnrollmentsController.prototype.revoke)).toEqual(['ADMIN', 'MASTER']);
  });
});
