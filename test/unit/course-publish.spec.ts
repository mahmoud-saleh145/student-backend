import { AcademicStructureKind, CourseStatus, UserRole } from '@prisma/client';

import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';

/**
 * Publishing a course.
 *
 * `publish()` used to refuse a course with no sections and no lessons, on the
 * reasoning that shipping an empty course to the catalogue is worse than a
 * rejected publish. That rule is gone: a course is routinely announced and made
 * joinable *before* its lectures are recorded, so requiring content made the
 * ordinary sequence impossible — you had to upload first and announce later.
 *
 * What this file pins is therefore two-sided, and the second half matters as
 * much as the first. Relaxing the content rule must not quietly relax the rest:
 * a course nobody teaches, a paid course with no price, and one with no way to
 * join all still make the listing unusable, and each is still refused.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

interface Overrides {
  status?: CourseStatus;
  isFree?: boolean;
  enrollmentMethods?: string[];
  teacherCount?: number;
  price?: number | null;
}

function buildService(overrides: Overrides = {}) {
  const course = {
    id: 'crs_1',
    title: 'Anatomy',
    status: overrides.status ?? CourseStatus.DRAFT,
    isFree: overrides.isFree ?? true,
    enrollmentMethods: overrides.enrollmentMethods ?? ['FREE'],
    prices: overrides.price === undefined || overrides.price === null ? [] : [{ amount: overrides.price, isCurrent: true }],
    _count: { teachers: overrides.teacherCount ?? 1 },
  };

  const courseUpdate = jest.fn(async () => ({
    ...course,
    status: CourseStatus.PUBLISHED,
    publishedAt: new Date('2026-10-08T00:00:00.000Z'),
  }));

  const assertCanManageCourse = jest.fn(async () => undefined);
  const record = jest.fn(async () => undefined);

  const prisma = {
    course: {
      findFirst: jest.fn(async () => course),
      update: courseUpdate,
    },
  } as Record<string, unknown>;

  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    { assertCanManageCourse } as never,
    { record } as never,
    { publicAssetUrl: jest.fn(async () => null) } as never,
    { resolveAcademicStructure: jest.fn(async () => ({ id: 'as_1', kind: AcademicStructureKind.YEAR })) } as never,
  );

  return { service, courseUpdate, record, assertCanManageCourse };
}

/** Asserts the field error text, which lives in `fields`, not `message`. */
const expectProblem = async (promise: Promise<unknown>, text: RegExp) => {
  await expect(promise).rejects.toMatchObject({
    details: { problems: expect.arrayContaining([expect.stringMatching(text)]) },
  });
};

describe('publishing an empty course', () => {
  it('succeeds with zero sections and zero lessons', async () => {
    // The whole point. The mock answers with no `sections` and no lesson count
    // at all, which is what an empty course looks like to this query.
    const { service, courseUpdate } = buildService();

    const result = await service.publish('crs_1', ADMIN);

    expect(result.status).toBe(CourseStatus.PUBLISHED);
    expect(courseUpdate).toHaveBeenCalledTimes(1);
  });

  it('does not ask about sections or lessons any more', async () => {
    // Not just permissive — the content is no longer part of the decision, so
    // the queries that fed it are gone too.
    const { service } = buildService();
    await service.publish('crs_1', ADMIN);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const args = (service as any).prisma.course.findFirst.mock.calls[0]?.[0];
    expect(args?.include?.sections).toBeUndefined();
    expect(args?.include?._count?.select?.lessons).toBeUndefined();
    // Still reads what it does gate on.
    expect(args?.include?._count?.select?.teachers).toBe(true);
  });

  it('publishes an existing empty draft without any data change', async () => {
    // The requirement's "existing empty courses": nothing about them needs
    // repairing, they were simply never allowed through this door.
    const { service } = buildService({ status: CourseStatus.DRAFT });
    await expect(service.publish('crs_1', ADMIN)).resolves.toMatchObject({
      status: CourseStatus.PUBLISHED,
    });
  });

  it('publishes an existing empty hidden course too', async () => {
    const { service } = buildService({ status: CourseStatus.HIDDEN });
    await expect(service.publish('crs_1', ADMIN)).resolves.toMatchObject({
      status: CourseStatus.PUBLISHED,
    });
  });
});

describe('the other publish rules are unchanged', () => {
  it('still refuses a course with no teacher', async () => {
    const { service, courseUpdate } = buildService({ teacherCount: 0 });

    await expectProblem(service.publish('crs_1', ADMIN), /no teacher is assigned/);
    expect(courseUpdate).not.toHaveBeenCalled();
  });

  it('still refuses a paid course with no price', async () => {
    const { service, courseUpdate } = buildService({ isFree: false, price: 0 });

    await expectProblem(service.publish('crs_1', ADMIN), /needs a price greater than zero/);
    expect(courseUpdate).not.toHaveBeenCalled();
  });

  it('still refuses a course with no way to join', async () => {
    const { service, courseUpdate } = buildService({ enrollmentMethods: [] });

    await expectProblem(service.publish('crs_1', ADMIN), /no enrollment method is configured/);
    expect(courseUpdate).not.toHaveBeenCalled();
  });

  it('still accepts a paid course with a price', async () => {
    const { service } = buildService({
      isFree: false,
      price: 250,
      enrollmentMethods: ['CODE', 'PAYMENT'],
    });

    await expect(service.publish('crs_1', ADMIN)).resolves.toBeDefined();
  });

  it('reports every problem at once, not just the first', async () => {
    // An administrator fixing a course should not discover one blocker per
    // attempt.
    const { service } = buildService({ teacherCount: 0, enrollmentMethods: [] });

    await expect(service.publish('crs_1', ADMIN)).rejects.toMatchObject({
      details: {
        problems: [
          expect.stringMatching(/no teacher is assigned/),
          expect.stringMatching(/no enrollment method is configured/),
        ],
      },
    });
  });

  it('no longer mentions sections or lessons in the refusal', async () => {
    const { service } = buildService({ teacherCount: 0 });

    await expect(service.publish('crs_1', ADMIN)).rejects.toMatchObject({
      details: { problems: ['no teacher is assigned'] },
    });
  });
});

describe('publishing side effects', () => {
  it('checks the permission before anything else', async () => {
    const { service, assertCanManageCourse } = buildService();

    await service.publish('crs_1', ADMIN);

    expect(assertCanManageCourse).toHaveBeenCalledWith('usr_admin', UserRole.ADMIN, 'crs_1', 'publish');
  });

  it('records the transition in the audit trail', async () => {
    const { service, record } = buildService();

    await service.publish('crs_1', ADMIN);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PUBLISH', entity: 'course', entityId: 'crs_1' }),
    );
  });

  it('404s a course that does not exist', async () => {
    const prisma = { course: { findFirst: jest.fn(async () => null), update: jest.fn() } };
    const service = new CoursesAdminService(
      prisma as never,
      {} as never,
      { assertCanManageCourse: jest.fn(async () => undefined) } as never,
      { record: jest.fn(async () => undefined) } as never,
      { publicAssetUrl: jest.fn(async () => null) } as never,
      { resolveAcademicStructure: jest.fn(async () => null) } as never,
    );

    await expect(service.publish('crs_missing', ADMIN)).rejects.toThrow();
  });
});
