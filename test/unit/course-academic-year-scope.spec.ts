import { AcademicStructureKind, UserRole } from '@prisma/client';

import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';

/**
 * A course's rung must belong to the ladder that governs its unit.
 *
 * `academicYearId` used to be stored unchecked. A faculty whose structure counts
 * in levels could hold a course filed under a platform "First Year": both rows
 * existed, the course was internally consistent, and nothing ever compared them.
 * The dashboard hid the mismatch by always listing the platform ladder, so the
 * levels a college actually offered were never on screen to pick from.
 *
 * These tests pin the server half. The dashboard half is that the year list is
 * fetched with the unit's scope — see `useAcademicYears`, whose doc comment
 * records why the unscoped call was wrong.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

/** The platform ladder: five years. */
const PLATFORM_STRUCTURE = { id: 'as_platform', kind: AcademicStructureKind.YEAR };
/** A medicine-style faculty ladder: six levels. */
const FACULTY_STRUCTURE = { id: 'as_medicine', kind: AcademicStructureKind.LEVEL };

function buildService(options: {
  structure?: { id: string; kind: AcademicStructureKind } | null;
  /** Rungs that belong to the resolved structure. */
  rungs?: { id: string }[];
  /** Colleges that exist, so the pre-existing structure check passes first. */
  faculties?: { id: string; universityId: string }[];
  departments?: { id: string; facultyId: string }[];
}) {
  const resolveAcademicStructure = jest.fn(async () => options.structure ?? null);

  const yearFindFirst = jest.fn(
    async (args: { where: { id: string; structureId: string } }) =>
      (options.rungs ?? []).some((r) => r.id === args.where.id) ? { id: args.where.id } : null,
  );

  const prisma = {
    course: {
      findFirst: jest.fn(async () => ({
        id: 'crs_1',
        title: 'Anatomy',
        shortDescription: '',
        description: '',
        status: 'DRAFT',
        thumbnailKey: null,
        universityId: null,
        facultyId: null,
        academicYearId: null,
        departments: [],
        prices: [],
        teachers: [],
        sections: [],
        university: null,
        faculty: null,
        academicYear: null,
        subject: null,
        _count: { enrollments: 0, attachments: 0 },
        sectionCount: 0,
        lessonCount: 0,
      })),
      findUnique: jest.fn(async () => null),
      update: jest.fn(async () => ({ id: 'crs_1' })),
      findMany: jest.fn(async () => []),
    },
    academicYear: { findFirst: yearFindFirst },
    // Passing departmentIds writes the join rows, which is a different code
    // path from reading them — included so these tests do not have to.
    courseDepartment: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    // Coherent by default: a college exists and any department asked for sits
    // under it, so these tests exercise the rung check rather than tripping the
    // hierarchy check that runs before it.
    faculty: {
      findFirst: jest.fn(async (args: { where: { id: string } }) =>
        (options.faculties ?? [{ id: args.where.id, universityId: 'u_1' }]).find(
          (f) => f.id === args.where.id,
        ) ?? null,
      ),
    },
    department: {
      findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        (options.departments ?? args.where.id.in.map((id) => ({ id, facultyId: 'f_med' }))),
      ),
    },
  } as Record<string, unknown>;

  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
  );

  const service = new CoursesAdminService(
    prisma as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    { assertCanManageCourse: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
    { publicAssetUrl: jest.fn(async () => null) } as never,
    { resolveAcademicStructure } as never,
  );

  return { service, resolveAcademicStructure, yearFindFirst };
}

/**
 * `AppException.validation` leaves `message` as the generic "Request validation
 * failed" and puts the wording in `fields`, so the field is what has to be
 * asserted — matching on `message` would pass even if the wording regressed.
 */
const expectFieldError = async (promise: Promise<unknown>, field: string, text: RegExp) => {
  await expect(promise).rejects.toMatchObject({
    fields: { [field]: [expect.stringMatching(text)] },
  });
};

describe('a rung must belong to the course own ladder', () => {
  it('accepts a year from the platform ladder', async () => {
    const { service } = buildService({
      structure: PLATFORM_STRUCTURE,
      rungs: [{ id: 'ay_1' }],
    });

    await expect(
      service.update('crs_1', { academicYearId: 'ay_1' }, ADMIN),
    ).resolves.toBeDefined();
  });

  it('accepts a level from a faculty ladder', async () => {
    const { service } = buildService({
      structure: FACULTY_STRUCTURE,
      rungs: [{ id: 'ay_lvl1' }],
    });

    await expect(
      service.update('crs_1', { facultyId: 'f_med', academicYearId: 'ay_lvl1' }, ADMIN),
    ).resolves.toBeDefined();
  });

  it('refuses a platform year on a course governed by a levels ladder', async () => {
    // The reported bug, from the server's side: Medicine counts in levels, and
    // "First Year" is not one of them.
    const { service } = buildService({
      structure: FACULTY_STRUCTURE,
      rungs: [{ id: 'ay_lvl1' }],
    });

    await expectFieldError(
      service.update('crs_1', { facultyId: 'f_med', academicYearId: 'ay_1' }, ADMIN),
      'academicYearId',
      /level is not part of/i,
    );
  });

  it('names the right noun, so the message matches the control it sits under', async () => {
    const yearCase = buildService({ structure: PLATFORM_STRUCTURE, rungs: [] });
    await expectFieldError(
      yearCase.service.update('crs_1', { academicYearId: 'ay_zz' }, ADMIN),
      'academicYearId',
      /year is not part of/i,
    );

    const levelCase = buildService({ structure: FACULTY_STRUCTURE, rungs: [] });
    await expectFieldError(
      levelCase.service.update('crs_1', { facultyId: 'f_med', academicYearId: 'ay_zz' }, ADMIN),
      'academicYearId',
      /level is not part of/i,
    );
  });

  it('refuses a rung when the unit has no ladder at all', async () => {
    // Nothing anywhere up the chain, so there is nothing for the rung to belong
    // to — better said plainly than stored and rendered by nothing.
    const { service } = buildService({ structure: null });

    await expectFieldError(
      service.update('crs_1', { academicYearId: 'ay_1' }, ADMIN),
      'academicYearId',
      /no academic structure covers this course/i,
    );
  });

  it('leaves an untouched course alone — no ladder needed when nothing is set', async () => {
    const { service, resolveAcademicStructure } = buildService({ structure: null });

    await expect(
      service.update('crs_1', { title: 'Anatomy and Physiology' }, ADMIN),
    ).resolves.toBeDefined();

    // Not even asked: a course with no rung cannot be misfiled.
    expect(resolveAcademicStructure).not.toHaveBeenCalled();
  });

  it('resolves from the department when one is chosen', async () => {
    // Most specific wins, matching how the list itself was fetched.
    const { service, resolveAcademicStructure } = buildService({
      structure: FACULTY_STRUCTURE,
      rungs: [{ id: 'ay_lvl2' }],
    });

    await service.update(
      'crs_1',
      { facultyId: 'f_med', departmentIds: ['d_anat'], academicYearId: 'ay_lvl2' },
      ADMIN,
    );

    expect(resolveAcademicStructure).toHaveBeenCalledWith({
      departmentId: 'd_anat',
      facultyId: null,
      universityId: null,
    });
  });

  it('resolves from the faculty when no department is chosen', async () => {
    const { service, resolveAcademicStructure } = buildService({
      structure: FACULTY_STRUCTURE,
      rungs: [{ id: 'ay_lvl2' }],
    });

    await service.update('crs_1', { facultyId: 'f_med', academicYearId: 'ay_lvl2' }, ADMIN);

    expect(resolveAcademicStructure).toHaveBeenCalledWith({
      departmentId: null,
      facultyId: 'f_med',
      universityId: null,
    });
  });

  it('checks the stored rung too, so an unrelated edit cannot keep a bad one', async () => {
    // Moving a course into a levels college has to re-file its year even if the
    // administrator never touched the year field — the merge is what makes that
    // visible.
    const prismaCourseFindFirst = jest.fn(async () => ({
      id: 'crs_1',
      title: 'Anatomy',
      shortDescription: '',
      description: '',
      status: 'DRAFT',
      thumbnailKey: null,
      universityId: null,
      facultyId: null,
      academicYearId: 'ay_platform_1',
      departments: [],
      prices: [],
      teachers: [],
      sections: [],
      university: null,
      faculty: null,
      academicYear: null,
      subject: null,
      _count: { enrollments: 0, attachments: 0 },
      sectionCount: 0,
      lessonCount: 0,
    }));

    const resolveAcademicStructure = jest.fn(async () => FACULTY_STRUCTURE);
    const prisma = {
      course: {
        findFirst: prismaCourseFindFirst,
        findUnique: jest.fn(async () => null),
        update: jest.fn(async () => ({ id: 'crs_1' })),
        findMany: jest.fn(async () => []),
      },
      academicYear: { findFirst: jest.fn(async () => null) },
      faculty: { findFirst: jest.fn(async () => ({ id: 'f_med', universityId: 'u_1' })) },
      department: {
        findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
          args.where.id.in.map((id) => ({ id, facultyId: 'f_med' })),
        ),
      },
    } as Record<string, unknown>;
    prisma.$transaction = jest.fn(async (arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : arg,
    );

    const service = new CoursesAdminService(
      prisma as never,
      { recountCourse: jest.fn(async () => undefined) } as never,
      { assertCanManageCourse: jest.fn(async () => undefined) } as never,
      { record: jest.fn(async () => undefined) } as never,
      { publicAssetUrl: jest.fn(async () => null) } as never,
      { resolveAcademicStructure } as never,
    );

    await expectFieldError(
      service.update('crs_1', { facultyId: 'f_med', departmentIds: ['d_anat'] }, ADMIN),
      'academicYearId',
      /level is not part of/i,
    );
  });
});
