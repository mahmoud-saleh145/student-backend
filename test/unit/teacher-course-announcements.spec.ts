import { ValidationPipe } from '@nestjs/common';
import { AccountStatus, EnrollmentState, UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { compileAudience, ruleFromLegacyColumns } from '../../src/modules/notifications/audience';
import {
  CourseAnnouncementDto,
  NotificationsController,
} from '../../src/modules/notifications/notifications.controller';

/**
 * Owner decision D2: teachers may notify the ACTIVE students of their OWN
 * assigned courses, and nothing wider. Broadcasts and direct messages stay
 * admin-only.
 */

const TEACHER = { id: 'usr_t', role: UserRole.TEACHER } as never;
const ADMIN = { id: 'usr_a', role: UserRole.ADMIN } as never;

function build(opts: { allowed: boolean }) {
  const createLegacy = jest.fn(async () => ({ id: 'ann_1', status: 'SENT' }));
  const assertCourseExistsAndManageable = jest.fn(async () => {
    if (!opts.allowed) {
      throw Object.assign(new Error('NOT_COURSE_TEACHER'), { code: 'NOT_COURSE_TEACHER' });
    }
  });
  const controller = new NotificationsController(
    {} as never,
    { createLegacy } as never,
    { assertCourseExistsAndManageable } as never,
  );
  return { controller, createLegacy, assertCourseExistsAndManageable };
}

const body = { title: 'Lecture moved', body: 'Tomorrow at 10:00 instead of 12:00.' };

describe('POST /notifications/courses/:courseId/announcements', () => {
  it('lets an assigned teacher notify their own course, checked with the student capability', async () => {
    const { controller, createLegacy, assertCourseExistsAndManageable } = build({ allowed: true });

    await controller.announceToCourse('crs_1', body as CourseAnnouncementDto, TEACHER);

    expect(assertCourseExistsAndManageable).toHaveBeenCalledWith('usr_t', UserRole.TEACHER, 'crs_1', 'students');
    expect(createLegacy).toHaveBeenCalledWith(
      expect.objectContaining({
        courseId: 'crs_1',
        route: '/course/crs_1',
        publishNow: true,
        title: body.title,
        body: body.body,
      }),
      TEACHER,
    );
    // Nothing that widens the audience reaches the send.
    const sent = (createLegacy.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(sent).not.toHaveProperty('universityId');
    expect(sent).not.toHaveProperty('academicYearId');
    expect(sent).not.toHaveProperty('userId');
  });

  it("refuses a teacher who is not assigned to the course (another teacher's course)", async () => {
    const { controller, createLegacy } = build({ allowed: false });

    await expect(
      controller.announceToCourse('crs_other', body as CourseAnnouncementDto, TEACHER),
    ).rejects.toMatchObject({ code: 'NOT_COURSE_TEACHER' });
    expect(createLegacy).not.toHaveBeenCalled();
  });

  it('lets an admin notify any existing course through the same route', async () => {
    const { controller, createLegacy } = build({ allowed: true });
    await controller.announceToCourse('crs_1', body as CourseAnnouncementDto, ADMIN);
    expect(createLegacy).toHaveBeenCalledTimes(1);
  });
});

describe('the course announcement body cannot carry an audience', () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const validate = (value: Record<string, unknown>) =>
    pipe.transform(value, { type: 'body', metatype: CourseAnnouncementDto });

  it.each([
    ['userId', { userId: 'usr_someone' }],
    ['universityId', { universityId: 'uni_1' }],
    ['academicYearId', { academicYearId: 'yr_1' }],
    ['courseId', { courseId: 'crs_other' }],
    ['route', { route: '/wallet' }],
    ['audience', { audience: { roles: ['TEACHER'] } }],
  ])('rejects an extra %s field', async (_name, extra) => {
    await expect(validate({ ...body, ...extra })).rejects.toBeDefined();
  });

  it('accepts the plain message', async () => {
    await expect(validate({ ...body, titleAr: 'تم نقل المحاضرة', sendPush: true })).resolves.toMatchObject(body);
  });
});

describe('the audience is the course\'s ACTIVE students only', () => {
  it('compiles to active student accounts with an ACTIVE enrollment in that course', () => {
    const where = compileAudience(ruleFromLegacyColumns({ courseId: 'crs_1', universityId: null, academicYearId: null }));

    expect(where).toMatchObject({
      deletedAt: null,
      role: { in: [UserRole.STUDENT] },
      status: AccountStatus.ACTIVE,
      enrollments: { some: { courseId: { in: ['crs_1'] }, state: { in: [EnrollmentState.ACTIVE] } } },
    });
  });
});

describe('route roles', () => {
  const roles = (handler: object) => Reflect.getMetadata(ROLES_KEY, handler) as string[];

  it('keeps broadcasts and direct messages admin-only', () => {
    expect(roles(NotificationsController.prototype.announce).sort()).toEqual(['ADMIN', 'MASTER']);
  });

  it('opens the course route to staff, with the course check doing the scoping', () => {
    expect(roles(NotificationsController.prototype.announceToCourse)).toEqual(
      expect.arrayContaining(['TEACHER', 'ADMIN', 'MASTER']),
    );
    expect(roles(NotificationsController.prototype.announceToCourse)).not.toContain('STUDENT');
  });
});
