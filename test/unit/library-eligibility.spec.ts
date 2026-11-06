import { LibraryDepartmentScope } from '@prisma/client';

import {
  academicMaterialWhere,
  isAcademicallyVisible,
  toAudience,
} from '../../src/modules/library/library-eligibility.service';

/**
 * The academic visibility rule itself (F2/F5/F3), with no service around it.
 * University, faculty and department from the student's own profile; year is
 * never part of it; every null fails closed.
 */
const STUDENT = { universityId: 'uni_mans', facultyId: 'fac_gen', departmentId: 'dep_prep' };

const facultyWide = {
  universityId: 'uni_mans',
  facultyId: 'fac_gen',
  departmentScope: LibraryDepartmentScope.FACULTY,
  departmentIds: [],
};
const deptScoped = (ids: string[]) => ({
  ...facultyWide,
  departmentScope: LibraryDepartmentScope.DEPARTMENTS,
  departmentIds: ids,
});

describe('isAcademicallyVisible', () => {
  it.each([
    ['faculty-wide, same university and faculty', STUDENT, facultyWide, true],
    ['faculty-wide, any department of the faculty', { ...STUDENT, departmentId: 'dep_civil' }, facultyWide, true],
    ['faculty-wide, student with no department', { ...STUDENT, departmentId: null }, facultyWide, true],
    ['other faculty', { ...STUDENT, facultyId: 'fac_prog' }, facultyWide, false],
    ['other university', { ...STUDENT, universityId: 'uni_delta' }, facultyWide, false],
    ['department-scoped, listed department', STUDENT, deptScoped(['dep_prep']), true],
    ['department-scoped, one of several', STUDENT, deptScoped(['dep_civil', 'dep_prep']), true],
    ['department-scoped, unlisted department', STUDENT, deptScoped(['dep_civil']), false],
    ['department-scoped, student with no department', { ...STUDENT, departmentId: null }, deptScoped(['dep_prep']), false],
    ['department-scoped with ZERO links (fail closed)', STUDENT, deptScoped([]), false],
    ['material without a university', STUDENT, { ...facultyWide, universityId: null }, false],
    ['material without a faculty', STUDENT, { ...facultyWide, facultyId: null }, false],
    ['student without a university', { ...STUDENT, universityId: null }, facultyWide, false],
    ['student without a faculty', { ...STUDENT, facultyId: null }, facultyWide, false],
  ] as const)('%s', (_name, scope, material, expected) => {
    expect(isAcademicallyVisible(scope as never, material as never)).toBe(expected);
  });

  it('no profile at all sees nothing', () => {
    expect(isAcademicallyVisible(null, facultyWide)).toBe(false);
  });
});

describe('academicMaterialWhere', () => {
  it('matches no row for a missing or incomplete profile — never `{}`', () => {
    expect(academicMaterialWhere(null)).toEqual({ id: { in: [] } });
    expect(academicMaterialWhere({ ...STUDENT, facultyId: null })).toEqual({ id: { in: [] } });
    expect(academicMaterialWhere({ ...STUDENT, universityId: null })).toEqual({ id: { in: [] } });
  });

  it('pins university and faculty exactly, never to null', () => {
    const where = academicMaterialWhere(STUDENT) as Record<string, unknown>;
    expect(where.universityId).toBe('uni_mans');
    expect(where.facultyId).toBe('fac_gen');
  });

  it('offers faculty-wide material or department links to the student’s department', () => {
    expect(academicMaterialWhere(STUDENT)).toMatchObject({
      OR: [
        { departmentScope: LibraryDepartmentScope.FACULTY },
        {
          departmentScope: LibraryDepartmentScope.DEPARTMENTS,
          departments: { some: { departmentId: 'dep_prep' } },
        },
      ],
    });
  });

  it('never matches a department link for a student with no department', () => {
    const where = academicMaterialWhere({ ...STUDENT, departmentId: null }) as {
      OR: Array<{ departments?: { some: { departmentId: string } } }>;
    };
    expect(where.OR[1].departments?.some.departmentId).not.toBeNull();
    expect(where.OR[1].departments?.some.departmentId).toMatch(/^__/);
  });

  it('carries no year/level term: year is a browsing filter only', () => {
    expect(JSON.stringify(academicMaterialWhere(STUDENT))).not.toContain('academicYear');
  });
});

describe('toAudience', () => {
  it('reads a missing departments relation as no links', () => {
    expect(
      toAudience({
        universityId: 'u',
        facultyId: 'f',
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        departments: undefined as never,
      }).departmentIds,
    ).toEqual([]);
  });
});
