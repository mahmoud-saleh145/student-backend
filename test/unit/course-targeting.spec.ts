import { CourseStatus, UserRole } from '@prisma/client';

import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { COURSE_TARGETING_ENABLED } from '../../src/modules/courses/course-targeting.config';

/**
 * Course targeting.
 *
 * A course is filed against an optional university, faculty, academic year and a
 * set of departments. Those columns were writable from the admin API and read
 * everywhere, but nothing compared them to the enrolling student — so a
 * Mechanical Engineering student could take a course offered only to Civil
 * Engineering, and the whole targeting feature was decoration.
 *
 * The tests below pin the three decisions that are easy to get wrong:
 *   - unconstrained dimensions are skipped, not failed
 *   - a course with no targeting at all is open, so pre-targeting courses keep
 *     working
 *   - an unset student profile is NOT a wildcard, because that would make every
 *     unconfigured account eligible for everything
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

function buildService(course: CourseTargeting | null, profile: StudentProfileRow | null) {
  const prisma = {
    course: { findFirst: jest.fn(async () => (course ? { ...course, id: 'crs_1', status: CourseStatus.PUBLISHED } : null)) },
    studentProfile: { findUnique: jest.fn(async () => profile) },
  };

  const service = new CourseAccessService(
    prisma as never,
    { get: jest.fn() } as never,
    { teacherMay: jest.fn(async () => true) } as never,
  );

  return { service, prisma };
}

const STUDENT = UserRole.STUDENT;
const OTHER = 'crs_2';

describe('isTargetedToStudent', () => {
  it('admits a student whose department matches', async () => {
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_mech' }] },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(true);
  });

  it('refuses a student from another department', async () => {
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_civil' }] },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(false);
  });

  it('admits a student in any of several offered departments', async () => {
    // A course is commonly shared across departments, which is why the relation
    // is many-to-many rather than a single FK.
    const { service } = buildService(
      {
        ...UNTARGETED,
        departments: [{ departmentId: 'dep_civil' }, { departmentId: 'dep_mech' }],
      },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(true);
  });

  it('requires every constrained dimension, not just one of them', async () => {
    // The conjunction is the point: matching the faculty does not excuse
    // failing the year.
    const { service } = buildService(
      { ...UNTARGETED, facultyId: 'fac_eng', academicYearId: 'yr_2' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: 'yr_3',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(false);
  });

  it('skips dimensions the course does not constrain', async () => {
    // The course names only a department, so a mismatched faculty must not
    // block a student who is in the right department.
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_mech' }] },
      {
        universityId: 'uni_1',
        facultyId: 'fac_medicine',
        departmentId: 'dep_mech',
        academicYearId: 'yr_9',
      },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(true);
  });

  it('leaves an untargeted course open to everyone', async () => {
    // Every column is nullable and plenty of courses are deliberately general.
    // Refusing these would break every course created before targeting existed.
    const { service } = buildService(UNTARGETED, {
      universityId: 'uni_9',
      facultyId: 'fac_arts',
      departmentId: 'dep_philosophy',
      academicYearId: 'yr_1',
    });

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(true);
  });

  it('does not read the profile at all for an untargeted course', async () => {
    // A pointless query on every enrollment of a general course.
    const { service, prisma } = buildService(UNTARGETED, null);

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(true);
    expect(prisma.studentProfile.findUnique).not.toHaveBeenCalled();
  });

  it('treats a missing student profile as ineligible, not as a wildcard', async () => {
    // The trap: treating unknown as "matches everything" reopens the original
    // hole for every account that has not filled in its profile.
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_mech' }] },
      null,
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(false);
  });

  it('treats an unset constrained dimension as ineligible', async () => {
    // The student profile has a department but no year, and the course targets
    // a specific year. Undetermined is not a match.
    const { service } = buildService(
      { ...UNTARGETED, academicYearId: 'yr_2' },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(false);
  });

  it('does not exempt staff', async () => {
    // An administrator enrolling a student by hand is a deliberate override;
    // the exemption lives in assertCourseTargeting, which is what the
    // enrollment paths call.
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_civil' }] },
      null,
    );

    await expect(service.isTargetedToStudent('adm_1', OTHER, UserRole.ADMIN)).resolves.toBe(true);
  });
});

describe('targeting enforcement switch (product decision 2026-10-06: off)', () => {
  it('ships with enforcement disabled', () => {
    expect(COURSE_TARGETING_ENABLED).toBe(false);
    const { service } = buildService(UNTARGETED, null);
    expect(service.targetingEnforced).toBe(false);
  });

  it('lets a student outside the group through while enforcement is off', async () => {
    const { service, prisma } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_civil' }], academicYearId: 'yr_1' },
      { universityId: 'uni_2', facultyId: 'fac_x', departmentId: 'dep_mech', academicYearId: 'yr_4' },
    );

    await expect(service.assertCourseTargeting('usr_1', STUDENT, OTHER)).resolves.toBeUndefined();
    // Disabled means not evaluated at all on the join path.
    expect(prisma.course.findFirst).not.toHaveBeenCalled();
  });

  it('keeps the rule itself intact while enforcement is off', async () => {
    const { service } = buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_civil' }] },
      { universityId: 'uni_1', facultyId: 'fac_eng', departmentId: 'dep_mech', academicYearId: null },
    );

    await expect(service.isTargetedToStudent('usr_1', OTHER, STUDENT)).resolves.toBe(false);
  });
});

/** With enforcement switched back on — what flipping the flag restores. */
describe('assertCourseTargeting (enforcement enabled)', () => {
  const enforced = (built: ReturnType<typeof buildService>) => {
    built.service.targetingEnforced = true;
    return built;
  };

  it('throws COURSE_NOT_TARGETED for a student outside the group', async () => {
    const { service } = enforced(buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_civil' }] },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    ));

    await expect(service.assertCourseTargeting('usr_1', STUDENT, OTHER)).rejects.toMatchObject({
      code: ErrorCode.COURSE_NOT_TARGETED,
    });
  });

  it('does not query anything for staff', async () => {
    // The override path must not depend on a student profile existing.
    const { service, prisma } = enforced(buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_civil' }] },
      null,
    ));

    await expect(service.assertCourseTargeting('adm_1', UserRole.ADMIN, OTHER)).resolves.toBeUndefined();
    expect(prisma.course.findFirst).not.toHaveBeenCalled();
    expect(prisma.studentProfile.findUnique).not.toHaveBeenCalled();
  });

  it('passes a student who matches', async () => {
    const { service } = enforced(buildService(
      { ...UNTARGETED, departments: [{ departmentId: 'dep_mech' }] },
      {
        universityId: 'uni_1',
        facultyId: 'fac_eng',
        departmentId: 'dep_mech',
        academicYearId: null,
      },
    ));

    await expect(service.assertCourseTargeting('usr_1', STUDENT, OTHER)).resolves.toBeUndefined();
  });
});