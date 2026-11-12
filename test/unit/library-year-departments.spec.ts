import { LibraryDepartmentScope } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import {
  normalizeAudience,
  rungsForStudent,
  studentYearFilter,
  yearDepartmentRows,
  type RawAudience,
} from '../../src/modules/library/library-audience';

/**
 * Departments chosen per year/level.
 *
 *   * `audienceMappings` is the per-year form: each year names its own
 *     departments, independently of every other year;
 *   * the union of those departments is what eligibility reads, so who may
 *     see the material is decided by department alone;
 *   * the student browse filter matches a year only for the departments listed
 *     under THAT year; the student's own registered year is never an input;
 *   * the legacy form (one department list + years) still works and becomes
 *     "the same departments under every year";
 *   * every ambiguous shape is refused with a field error the dashboard can
 *     show beside the year group it concerns.
 */

const DEPTS = LibraryDepartmentScope.DEPARTMENTS;
const FACULTY = LibraryDepartmentScope.FACULTY;

function raw(overrides: Partial<RawAudience>): RawAudience {
  return { universityId: 'uni', facultyId: 'fac', departmentScope: DEPTS, ...overrides };
}

function refusal(run: () => unknown): Record<string, string[]> {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    return (error as AppException).fields ?? {};
  }
  throw new Error('expected a validation refusal');
}

describe('the per-year form', () => {
  it('keeps each year’s departments separate, and the union is what the material reaches', () => {
    const audience = normalizeAudience(
      raw({
        audienceMappings: [
          { academicYearId: 'level000', departmentIds: ['mte', 'mechatronics'] },
          { academicYearId: 'level200', departmentIds: ['electrical', 'mechanical'] },
        ],
      }),
    );
    expect(audience.yearDepartments).toEqual([
      { academicYearId: 'level000', departmentIds: ['mte', 'mechatronics'] },
      { academicYearId: 'level200', departmentIds: ['electrical', 'mechanical'] },
    ]);
    expect(audience.departmentIds).toEqual(['mte', 'mechatronics', 'electrical', 'mechanical']);
    expect(audience.academicYearIds).toEqual(['level000', 'level200']);
    expect(audience.perYear).toBe(true);
  });

  it('lets one department appear under several years', () => {
    const audience = normalizeAudience(
      raw({
        audienceMappings: [
          { academicYearId: 'y1', departmentIds: ['civil', 'electrical'] },
          { academicYearId: 'y3', departmentIds: ['civil', 'mechanical'] },
        ],
      }),
    );
    expect(audience.departmentIds).toEqual(['civil', 'electrical', 'mechanical']);
    expect(yearDepartmentRows('mat', audience)).toEqual([
      { materialId: 'mat', academicYearId: 'y1', departmentId: 'civil' },
      { materialId: 'mat', academicYearId: 'y1', departmentId: 'electrical' },
      { materialId: 'mat', academicYearId: 'y3', departmentId: 'civil' },
      { materialId: 'mat', academicYearId: 'y3', departmentId: 'mechanical' },
    ]);
  });

  it('drops a department ticked twice in one year', () => {
    const audience = normalizeAudience(
      raw({ audienceMappings: [{ academicYearId: 'y1', departmentIds: ['a', 'a', 'b'] }] }),
    );
    expect(audience.yearDepartments[0]?.departmentIds).toEqual(['a', 'b']);
  });

  it('refuses the same year twice, beside the second group', () => {
    const fields = refusal(() =>
      normalizeAudience(
        raw({
          audienceMappings: [
            { academicYearId: 'y1', departmentIds: ['a'] },
            { academicYearId: 'y1', departmentIds: ['b'] },
          ],
        }),
      ),
    );
    expect(Object.keys(fields)).toEqual(['audienceMappings.1.academicYearId']);
  });

  it('refuses a year with no department, beside that group, never as a wildcard', () => {
    const fields = refusal(() =>
      normalizeAudience(
        raw({
          audienceMappings: [
            { academicYearId: 'y1', departmentIds: ['a'] },
            { academicYearId: 'y2', departmentIds: [] },
          ],
        }),
      ),
    );
    expect(fields).toEqual({
      'audienceMappings.1.departmentIds': ['choose at least one department for this year/level'],
    });
  });

  it('refuses a group without a year', () => {
    const fields = refusal(() =>
      normalizeAudience(raw({ audienceMappings: [{ academicYearId: '', departmentIds: ['a'] }] })),
    );
    expect(Object.keys(fields)).toEqual(['audienceMappings.0.academicYearId']);
  });

  it('refuses per-year departments on a whole-college material', () => {
    const fields = refusal(() =>
      normalizeAudience(
        raw({
          departmentScope: FACULTY,
          audienceMappings: [{ academicYearId: 'y1', departmentIds: ['a'] }],
        }),
      ),
    );
    expect(Object.keys(fields)).toEqual(['audienceMappings']);
  });

  it('refuses per-year departments sent with yearScope ALL_YEARS', () => {
    const fields = refusal(() =>
      normalizeAudience(
        raw({
          yearScope: 'ALL_YEARS',
          audienceMappings: [{ academicYearId: 'y1', departmentIds: ['a'] }],
        }),
      ),
    );
    expect(Object.keys(fields)).toEqual(['yearScope']);
  });

  it('accepts departmentIds and academicYearIds beside the mapping when they agree', () => {
    const audience = normalizeAudience(
      raw({
        departmentIds: ['b', 'a'],
        academicYearIds: ['y2', 'y1'],
        yearScope: 'SELECTED_YEARS',
        audienceMappings: [
          { academicYearId: 'y1', departmentIds: ['a'] },
          { academicYearId: 'y2', departmentIds: ['b'] },
        ],
      }),
    );
    expect(audience.yearDepartments).toHaveLength(2);
  });

  it('refuses departmentIds or years that disagree with the mapping instead of guessing', () => {
    const fields = refusal(() =>
      normalizeAudience(
        raw({
          departmentIds: ['a', 'c'],
          academicYearIds: ['y1'],
          audienceMappings: [
            { academicYearId: 'y1', departmentIds: ['a'] },
            { academicYearId: 'y2', departmentIds: ['b'] },
          ],
        }),
      ),
    );
    expect(Object.keys(fields).sort()).toEqual(['academicYearIds', 'departmentIds']);
  });
});

describe('the legacy form and the broad scopes', () => {
  it('departments + years: the same departments under every year (what the migration wrote)', () => {
    const audience = normalizeAudience(
      raw({ departmentIds: ['mte', 'electrical'], academicYearIds: ['level000', 'level100'] }),
    );
    expect(audience.yearDepartments).toEqual([
      { academicYearId: 'level000', departmentIds: ['mte', 'electrical'] },
      { academicYearId: 'level100', departmentIds: ['mte', 'electrical'] },
    ]);
    expect(audience.perYear).toBe(false);
  });

  it('departments, all years: department links only, no per-year rows', () => {
    const audience = normalizeAudience(raw({ departmentIds: ['a'], academicYearIds: [] }));
    expect(audience.academicYearIds).toEqual([]);
    expect(audience.yearDepartments).toEqual([]);
  });

  it('entire college, selected years: year links only', () => {
    const audience = normalizeAudience(
      raw({ departmentScope: FACULTY, academicYearIds: ['y1', 'y2'], audienceMappings: [] }),
    );
    expect(audience.academicYearIds).toEqual(['y1', 'y2']);
    expect(audience.yearDepartments).toEqual([]);
  });

  it('entire college, all years: nothing linked', () => {
    const audience = normalizeAudience(raw({ departmentScope: FACULTY, yearScope: 'ALL_YEARS' }));
    expect(audience).toMatchObject({ departmentIds: [], academicYearIds: [], yearDepartments: [] });
  });

  it('the legacy single academicYearId still files one year', () => {
    const audience = normalizeAudience(raw({ departmentIds: ['a'], academicYearId: 'y1' }));
    expect(audience.yearDepartments).toEqual([{ academicYearId: 'y1', departmentIds: ['a'] }]);
  });

  it('yearScope ALL_YEARS refuses a year list rather than ignoring it', () => {
    const fields = refusal(() =>
      normalizeAudience(raw({ departmentIds: ['a'], yearScope: 'ALL_YEARS', academicYearIds: ['y1'] })),
    );
    expect(Object.keys(fields)).toEqual(['academicYearIds']);
  });

  it('yearScope SELECTED_YEARS with nothing selected is refused, never read as "no years"', () => {
    expect(
      Object.keys(
        refusal(() =>
          normalizeAudience(raw({ departmentIds: ['a'], yearScope: 'SELECTED_YEARS', audienceMappings: [] })),
        ),
      ),
    ).toEqual(['audienceMappings']);
    expect(
      Object.keys(
        refusal(() =>
          normalizeAudience(raw({ departmentScope: FACULTY, yearScope: 'SELECTED_YEARS' })),
        ),
      ),
    ).toEqual(['academicYearIds']);
  });
});

describe('the student year/level browse filter', () => {
  it('matches "all years", a whole-college material under that year, or this department under that year', () => {
    expect(studentYearFilter('level000', 'mte')).toEqual({
      OR: [
        { academicYears: { none: {} } },
        { departmentScope: FACULTY, academicYears: { some: { academicYearId: 'level000' } } },
        {
          departmentScope: DEPTS,
          academicYears: {
            some: { academicYearId: 'level000', departments: { some: { departmentId: 'mte' } } },
          },
        },
      ],
    });
  });

  it('a student without a department matches no per-year row', () => {
    const filter = studentYearFilter('y1', null);
    const branch = (filter.OR ?? [])[2] as {
      academicYears: { some: { departments: { some: { departmentId: string } } } };
    };
    expect(branch.academicYears.some.departments.some.departmentId).toBe('__no_department__');
  });

  it('never takes the student’s own registered year', () => {
    // The signature is the proof: a browsing rung and a department, nothing else.
    expect(studentYearFilter.length).toBe(2);
  });
});

describe('labelling the years for one student', () => {
  const links = [
    { id: 'level000', departments: [{ departmentId: 'mte' }] },
    { id: 'level200', departments: [] },
  ];

  it('shows a per-year material only under the years that list the student’s department', () => {
    expect(rungsForStudent(links, DEPTS).map((l) => l.id)).toEqual(['level000']);
  });

  it('falls back to every year when none lists them (an owner no longer in scope)', () => {
    const none = links.map((link) => ({ ...link, departments: [] }));
    expect(rungsForStudent(none, DEPTS).map((l) => l.id)).toEqual(['level000', 'level200']);
  });

  it('leaves a whole-college material’s years as they are', () => {
    expect(rungsForStudent(links, FACULTY)).toBe(links);
  });
});
