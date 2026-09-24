import { UserRole } from '@prisma/client';

import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';

/**
 * University → College → Department, enforced where it counts.
 *
 * The dashboard filters each select by its parent, but a filtered dropdown is
 * a convenience, not a constraint — the API accepts whatever is posted, and
 * `users.service.ts` has checked this for student profiles since the beginning
 * while courses never did. A course could be saved with a college from one
 * university and a university from another, and nothing complained.
 *
 * The other half of these cases is about *preservation*: an edit that says
 * nothing about departments must leave them alone. Wiping a course's structure
 * on an unrelated rename is the kind of data loss nobody reports until much
 * later.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

const UNI = 'uni_1';
const OTHER_UNI = 'uni_2';
const FACULTY = 'fac_1';          // belongs to UNI
const FOREIGN_FACULTY = 'fac_9';  // belongs to OTHER_UNI
const DEPT_A = 'dep_a';           // belongs to FACULTY
const DEPT_B = 'dep_b';           // belongs to FACULTY
const FOREIGN_DEPT = 'dep_z';     // belongs to FOREIGN_FACULTY

const FACULTIES: Record<string, { id: string; universityId: string }> = {
  [FACULTY]: { id: FACULTY, universityId: UNI },
  [FOREIGN_FACULTY]: { id: FOREIGN_FACULTY, universityId: OTHER_UNI },
};

const DEPARTMENTS: Record<string, { id: string; facultyId: string }> = {
  [DEPT_A]: { id: DEPT_A, facultyId: FACULTY },
  [DEPT_B]: { id: DEPT_B, facultyId: FACULTY },
  [FOREIGN_DEPT]: { id: FOREIGN_DEPT, facultyId: FOREIGN_FACULTY },
};

const BASE_INPUT = {
  title: 'Organic Chemistry',
  teacherIds: ['usr_teacher'],
  enrollmentMethods: ['CODE'],
  price: 500,
};

/** The department ids a `course.create` was asked to link, in order. */
function createdDepartmentIds(courseCreate: jest.Mock): string[] {
  const args = (courseCreate.mock.calls[0] as unknown[] | undefined)?.[0] as {
    data: { departments: { create: { department: { connect: { id: string } } }[] } };
  };

  return args.data.departments.create.map((entry) => entry.department.connect.id);
}

function buildService(storedDepartmentIds: string[] = []) {
  const courseCreate = jest.fn(async () => ({ id: 'crs_new', title: 'x', status: 'DRAFT' }));
  const courseDepartment = {
    deleteMany: jest.fn(async () => ({ count: 0 })),
    createMany: jest.fn(async () => ({ count: 0 })),
  };

  const prisma = {
    course: {
      create: courseCreate,
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => ({
        id: 'crs_1',
        status: 'DRAFT',
        universityId: UNI,
        facultyId: FACULTY,
        thumbnailKey: null,
        prices: [],
        teachers: [],
        sectionCount: 0,
        lessonCount: 0,
        _count: { enrollments: 0, attachments: 0 },
        departments: storedDepartmentIds.map((departmentId) => ({
          departmentId,
          department: { id: departmentId, name: departmentId, facultyId: FACULTY },
        })),
      })),
      update: jest.fn(async () => ({ id: 'crs_1', title: 'x', shortDescription: '' })),
    },
    faculty: {
      findFirst: jest.fn(async (args: { where: { id: string } }) =>
        FACULTIES[args.where.id] ?? null,
      ),
    },
    department: {
      findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in.map((id) => DEPARTMENTS[id]).filter(Boolean),
      ),
    },
    courseDepartment,
    coursePrice: { create: jest.fn(async () => ({})) },
    courseSection: { createMany: jest.fn(async () => ({})) },
    courseTeacher: { upsert: jest.fn(async () => ({})), count: jest.fn(async () => 2) },
    user: {
      count: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        new Set(args.where.id.in).size,
      ),
    },
    $transaction: jest.fn(async (arg: unknown) => arg),
  };

  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
  );

  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn() } as never,
    { assertCanManageCourse: jest.fn(), staffMayViewCourse: jest.fn(async () => true) } as never,
    { record: jest.fn() } as never,
    { publicAssetUrl: jest.fn(async () => null) } as never,
  );

  return { service, prisma, courseCreate, courseDepartment };
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

describe('creating a course with an academic structure', () => {
  it('accepts a coherent university → college → departments', async () => {
    const { service, courseCreate } = buildService();

    await service.create(
      {
        ...BASE_INPUT,
        universityId: UNI,
        facultyId: FACULTY,
        departmentIds: [DEPT_A, DEPT_B],
      } as never,
      ADMIN,
    );

    // A checked nested create, so each entry connects the relation rather than
    // carrying a raw foreign key.
    expect(createdDepartmentIds(courseCreate)).toEqual([DEPT_A, DEPT_B]);
  });

  it('rejects a college from a different university', async () => {
    const { service, courseCreate } = buildService();

    await expect(
      service.create(
        { ...BASE_INPUT, universityId: UNI, facultyId: FOREIGN_FACULTY } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      fields: { facultyId: ['does not belong to the selected university'] },
    });

    expect(courseCreate).not.toHaveBeenCalled();
  });

  it('rejects a department from a different college', async () => {
    const { service, courseCreate } = buildService();

    await expect(
      service.create(
        {
          ...BASE_INPUT,
          universityId: UNI,
          facultyId: FACULTY,
          departmentIds: [DEPT_A, FOREIGN_DEPT],
        } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      fields: {
        departmentIds: ['one or more departments do not belong to the selected college'],
      },
    });

    expect(courseCreate).not.toHaveBeenCalled();
  });

  it('rejects departments with no college chosen', async () => {
    const { service } = buildService();

    await expect(
      service.create({ ...BASE_INPUT, departmentIds: [DEPT_A] } as never, ADMIN),
    ).rejects.toMatchObject({
      fields: { departmentIds: ['choose a college before choosing departments'] },
    });
  });

  it('rejects a department id that does not exist', async () => {
    const { service } = buildService();

    await expect(
      service.create(
        {
          ...BASE_INPUT,
          universityId: UNI,
          facultyId: FACULTY,
          departmentIds: ['dep_nope'],
        } as never,
        ADMIN,
      ),
    ).rejects.toMatchObject({
      fields: { departmentIds: ['one or more departments do not exist'] },
    });
  });

  it('de-duplicates repeated department ids', async () => {
    const { service, courseCreate } = buildService();

    await service.create(
      {
        ...BASE_INPUT,
        universityId: UNI,
        facultyId: FACULTY,
        departmentIds: [DEPT_A, DEPT_A, DEPT_B],
      } as never,
      ADMIN,
    );

    // The join table's composite key would reject the duplicate anyway; doing
    // it here means a clean error never has to reach the client.
    expect(createdDepartmentIds(courseCreate)).toHaveLength(2);
  });

  it('still allows a course with no academic structure at all', async () => {
    // Every existing course predates these fields. They must stay valid.
    const { service, courseCreate } = buildService();

    await service.create({ ...BASE_INPUT } as never, ADMIN);

    expect(courseCreate).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Update — the preservation half
// ---------------------------------------------------------------------------

describe('editing a course does not disturb what it did not mention', () => {
  it('leaves department links untouched when the edit omits them', async () => {
    const { service, courseDepartment } = buildService([DEPT_A, DEPT_B]);

    await service.update('crs_1', { title: 'Renamed' } as never, ADMIN);

    // The whole point: a rename must not wipe the structure.
    expect(courseDepartment.deleteMany).not.toHaveBeenCalled();
    expect(courseDepartment.createMany).not.toHaveBeenCalled();
  });

  it('clears the links when the edit explicitly passes an empty list', async () => {
    const { service, courseDepartment } = buildService([DEPT_A, DEPT_B]);

    await service.update('crs_1', { departmentIds: [] } as never, ADMIN);

    expect(courseDepartment.deleteMany).toHaveBeenCalledTimes(1);
    const where = ((courseDepartment.deleteMany.mock.calls[0] as unknown[])[0] as {
      where: { departmentId: { in: string[] } };
    }).where;
    expect(where.departmentId.in.sort()).toEqual([DEPT_A, DEPT_B].sort());
  });

  it('writes only the difference, not a delete-and-reinsert', async () => {
    const { service, courseDepartment } = buildService([DEPT_A]);

    await service.update('crs_1', { departmentIds: [DEPT_A, DEPT_B] } as never, ADMIN);

    // DEPT_A was already linked and must keep its row — and its createdAt.
    expect(courseDepartment.deleteMany).not.toHaveBeenCalled();
    const created = ((courseDepartment.createMany.mock.calls[0] as unknown[])[0] as {
      data: { departmentId: string }[];
    }).data;
    expect(created).toEqual([{ courseId: 'crs_1', departmentId: DEPT_B }]);
  });

  it('writes nothing at all when the same set is resubmitted', async () => {
    const { service, courseDepartment } = buildService([DEPT_A, DEPT_B]);

    await service.update('crs_1', { departmentIds: [DEPT_B, DEPT_A] } as never, ADMIN);

    expect(courseDepartment.deleteMany).not.toHaveBeenCalled();
    expect(courseDepartment.createMany).not.toHaveBeenCalled();
  });
});

describe('editing validates the course as it will be', () => {
  it('rejects moving the college to another university', async () => {
    const { service, prisma } = buildService();

    await expect(
      service.update('crs_1', { facultyId: FOREIGN_FACULTY } as never, ADMIN),
    ).rejects.toMatchObject({
      fields: { facultyId: ['does not belong to the selected university'] },
    });

    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('rejects a college change that strands the stored departments', async () => {
    // The stored departments belong to FACULTY. Moving the course to another
    // college without saying what happens to them would leave a hierarchy
    // that cannot be rendered — so it is refused rather than silently fixed.
    const { service, prisma } = buildService([DEPT_A]);
    prisma.faculty.findFirst = jest.fn(async () => ({
      id: FOREIGN_FACULTY,
      universityId: UNI,
    })) as never;

    await expect(
      service.update('crs_1', { facultyId: FOREIGN_FACULTY } as never, ADMIN),
    ).rejects.toMatchObject({
      fields: {
        departmentIds: ['one or more departments do not belong to the selected college'],
      },
    });

    expect(prisma.course.update).not.toHaveBeenCalled();
  });

  it('allows a college change that comes with matching departments', async () => {
    const { service, prisma } = buildService([DEPT_A]);

    await service.update(
      'crs_1',
      { facultyId: FACULTY, departmentIds: [DEPT_B] } as never,
      ADMIN,
    );

    expect(prisma.course.update).toHaveBeenCalledTimes(1);
  });
});
