import { CourseStatus, UserRole } from '@prisma/client';

import { CourseAccessService } from '../../src/modules/courses/course-access.service';

/**
 * Cross-year eligibility.
 *
 * Academic year/level is a BROWSING and homepage-default preference, not an
 * eligibility rule. A student may enrol in, pay for and study a course from
 * ANY year or level inside their own university and faculty.
 *
 * What still refuses eligibility is unchanged and must stay that way:
 * university, faculty and department. The tests below pin both halves —
 * cross-year must be permitted, and cross-boundary must still be refused —
 * because relaxing the year term must not have taken anything else with it.
 */

interface CourseTargeting {
  universityId: string | null;
  facultyId: string | null;
  academicYearId: string | null;
  departments: Array<{ departmentId: string }>;
}

interface StudentProfileRow {
  universityId: string | null;
  facultyId: string | null;
  departmentId: string | null;
  academicYearId: string | null;
}

const UNTARGETED: CourseTargeting = {
  universityId: null,
  facultyId: null,
  academicYearId: null,
  departments: [],
};

const STUDENT = UserRole.STUDENT;
const COURSE = 'crs_1';

function buildService(course: CourseTargeting | null, profile: StudentProfileRow | null) {
  const prisma = {
    course: {
      findFirst: jest.fn(async () =>
        course ? { ...course, id: COURSE, status: CourseStatus.PUBLISHED } : null,
      ),
    },
    studentProfile: { findUnique: jest.fn(async () => profile) },
  };

  const service = new CourseAccessService(
    prisma as never,
    { get: jest.fn() } as never,
    { teacherMay: jest.fn(async () => true) } as never,
  );

  return { service, prisma };
}

describe('cross-year study is permitted', () => {
  it('admits a first-year student into a third-year course of their own faculty', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_eng', academicYearId: 'yr_3' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('admits a third-year student into a first-year course of their own faculty', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_eng', academicYearId: 'yr_1' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_3',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('admits a levels student into a level outside their own rung', async () => {
    // LEVEL and YEAR are the same rule: the rung is not compared at all.
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_med', academicYearId: 'lvl_400' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_med',
        departmentId: 'dep_ana',
        academicYearId: 'lvl_000',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('admits a student whose profile records no year at all', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_eng', academicYearId: 'yr_2' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('does not read the year when deciding, even for a year-targeted course', async () => {
    // The profile's academicYearId is irrelevant to eligibility now, so the
    // rule cannot depend on it.
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_eng', academicYearId: 'yr_3' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });
});

describe('university and faculty still refuse eligibility', () => {
  it('refuses a course assigned to another faculty of the same university', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_med', academicYearId: 'yr_1' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('refuses a course assigned to another university', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_2', academicYearId: 'yr_1' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('still refuses a course assigned to another department', async () => {
    const { service } = buildService(
      {
        ...UNTARGETED,
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        academicYearId: 'yr_1',
        departments: [{ departmentId: 'dep_civil' }],
      },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('still refuses a targeted course to a student with no profile', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_eng' },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('still exempts staff', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_2', facultyId: 'fac_x' },
      null,
    );

    await expect(service.isTargetedToStudent('adm_1', COURSE, UserRole.ADMIN)).resolves.toBe(true);
  });
});

describe('general and partially-targeted courses stay visible', () => {
  it('admits a student from any university into a course with no university and no faculty', async () => {
    const { service } = buildService(UNTARGETED, {
      universityId: 'uni_9',
      facultyId: 'fac_arts',
      departmentId: 'dep_phil',
      academicYearId: 'yr_4',
    });

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('admits any faculty of the university into a course with no faculty', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', academicYearId: 'yr_2' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_med',
        departmentId: 'dep_ana',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('refuses another university a course that names only this university', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1' },
      {
        universityId: 'uni_2',
        facultyId: 'fac_med',
        departmentId: 'dep_ana',
        academicYearId: 'yr_1',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });
});

describe('studentCourseWhere carries no academic-year term', () => {
  const whereOf = (w: Record<string, unknown>): string => JSON.stringify(w);

  it('keeps the university nullable-match branch', async () => {
    const { service } = buildService(null, {
      universityId: 'uni_1',
      facultyId: 'fac_eng',
      departmentId: 'dep_mech',
      academicYearId: 'yr_1',
    });

    const where = whereOf(await service.studentCourseWhere('usr_1'));
    expect(where).toContain('"universityId"');
    expect(where).toContain('uni_1');
  });

  it('keeps the faculty nullable-match branch', async () => {
    const { service } = buildService(null, {
      universityId: 'uni_1',
      facultyId: 'fac_eng',
      departmentId: 'dep_mech',
      academicYearId: 'yr_1',
    });

    const where = whereOf(await service.studentCourseWhere('usr_1'));
    expect(where).toContain('"facultyId"');
    expect(where).toContain('fac_eng');
  });

  it('keeps the department clause', async () => {
    const { service } = buildService(null, {
      universityId: 'uni_1',
      facultyId: 'fac_eng',
      departmentId: 'dep_mech',
      academicYearId: 'yr_1',
    });

    const where = whereOf(await service.studentCourseWhere('usr_1'));
    expect(where).toContain('departments');
    expect(where).toContain('dep_mech');
  });

  it('contains no academicYearId term at all', async () => {
    const { service } = buildService(null, {
      universityId: 'uni_1',
      facultyId: 'fac_eng',
      departmentId: 'dep_mech',
      academicYearId: 'yr_1',
    });

    // The listing spans every year, so the predicate must not mention one.
    expect(whereOf(await service.studentCourseWhere('usr_1'))).not.toContain('academicYearId');
  });

  it('returns an empty filter for an anonymous caller', async () => {
    const { service } = buildService(null, null);

    expect(await service.studentCourseWhere(null)).toEqual({});
  });
});

/**
 * The no-profile fallback.
 *
 * A missing profile and a profile whose year is unset must not disagree:
 * academic year is not an eligibility or visibility dimension, so it must not
 * appear in EITHER branch. This block exists because that equivalence was
 * briefly broken — the fallback kept an `academicYearId: null` term after the
 * main branch lost its year clause — and nothing else covered it.
 */
describe('studentCourseWhere without a student profile', () => {
  it('does not restrict the listing by academic year', async () => {
    const { service } = buildService(null, null);

    const where = await service.studentCourseWhere('usr_1');
    expect(where).not.toHaveProperty('academicYearId');
  });

  it('still fails closed on university, faculty and department', async () => {
    const { service } = buildService(null, null);

    // Removing the year term must not have widened these three: a caller with
    // no profile still sees only genuinely global courses.
    expect(await service.studentCourseWhere('usr_1')).toEqual({
      universityId: null,
      facultyId: null,
      departments: { none: {} },
    });
  });

  it('agrees with the profile-with-no-year state about academic year', async () => {
    const withProfile = buildService(null, {
      universityId: null,
      facultyId: null,
      departmentId: null,
      academicYearId: null,
    });
    const withoutProfile = buildService(null, null);

    // Both states must leave year unconstrained, so neither hides a course
    // merely because it sits on a rung.
    expect(await withProfile.service.studentCourseWhere('usr_1')).not.toHaveProperty(
      'academicYearId',
    );
    expect(await withoutProfile.service.studentCourseWhere('usr_1')).not.toHaveProperty(
      'academicYearId',
    );
  });

  it('leaves the anonymous path untouched', async () => {
    const { service } = buildService(null, null);

    expect(await service.studentCourseWhere(null)).toEqual({});
  });
});

/**
 * Listing and authorization are separate gates. Dropping the year term from the
 * listing predicate must not open the door to joining or reading a course the
 * caller was never eligible for — those go through `isTargetedToStudent`.
 */
describe('eligibility without a student profile is unchanged', () => {
  it('still refuses a course assigned to a university', async () => {
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1' },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('still refuses a course assigned to a faculty', async () => {
    const { service } = buildService(
      { ...UNTARGETED, facultyId: 'fac_eng' },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('still refuses a department-targeted course', async () => {
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_mech' }] },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });

  it('treats a course assigned ONLY to an academic year as untargeted', async () => {
    // A course with no university, no faculty and no departments is a GENERAL
    // course that merely carries a rung label. Year is not a targeting
    // dimension, so the untargeted short-circuit admits it before the
    // no-profile check is reached — for a profile-less caller and for everyone
    // else alike. Asserting `false` here would re-introduce exactly the year
    // restriction this change removes.
    const { service } = buildService(
      { ...UNTARGETED, academicYearId: 'yr_1' },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(true);
  });

  it('is consistent: a year-only course is open to a profiled student too', async () => {
    const yearOnly: CourseTargeting = { ...UNTARGETED, academicYearId: 'yr_1' };

    const withoutProfile = buildService(yearOnly, null);
    const withProfile = buildService(yearOnly, {
      universityId: 'uni_9',
      facultyId: 'fac_arts',
      departmentId: 'dep_phil',
      academicYearId: 'yr_4',
    });

    await expect(withoutProfile.service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(
      true,
    );
    await expect(withProfile.service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(
      true,
    );
  });

  it('still refuses a course that is targeted at all, without a profile', async () => {
    // The listing predicate and the eligibility gate must stay independent:
    // anything naming a real dimension remains refused.
    const { service } = buildService(
      { ...UNTARGETED, universityId: 'uni_1', facultyId: 'fac_eng', academicYearId: 'yr_4' },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', COURSE, STUDENT)).resolves.toBe(false);
  });
});