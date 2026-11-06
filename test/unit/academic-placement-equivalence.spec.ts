import { AcademicStructureKind } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { notDeleted } from '../../src/database/prisma.service';
import {
  COURSE_PLACEMENT,
  LIBRARY_PLACEMENT,
  checkAcademicStructure,
  checkYearInLadder,
} from '../../src/modules/catalog/academic-placement';

/**
 * E1 — moving the course validators must not change course behaviour (#13).
 *
 * `reference*` below are the two methods exactly as they stood in
 * `CoursesAdminService` on origin/main 8e4d550 (lines 1509-1630), with `this.`
 * replaced by explicit parameters and nothing else. Every scenario runs through
 * the reference and through the shared function with COURSE_PLACEMENT, against
 * the same fake database, and both the outcome (thrown fields/messages) and
 * every database call (method + arguments, in order) must be identical.
 */

// ---- reference: verbatim from origin/main ---------------------------------

async function referenceAssertAcademicStructure(
  prisma: FakePrisma,
  input: { universityId?: string | null; facultyId?: string | null; departmentIds?: string[] | null },
): Promise<void> {
  const fields: Record<string, string[]> = {};

  const facultyId = input.facultyId ?? null;
  const universityId = input.universityId ?? null;
  const departmentIds = [...new Set(input.departmentIds ?? [])];

  const faculty = facultyId
    ? await prisma.faculty.findFirst({
        where: { id: facultyId, ...notDeleted },
        select: { id: true, universityId: true },
      })
    : null;

  if (facultyId && !faculty) {
    fields.facultyId = ['college not found'];
  } else if (faculty && universityId && faculty.universityId !== universityId) {
    fields.facultyId = ['does not belong to the selected university'];
  }

  if (departmentIds.length > 0) {
    if (!facultyId) {
      fields.departmentIds = ['choose a college before choosing departments'];
    } else {
      const found = await prisma.department.findMany({
        where: { id: { in: departmentIds }, ...notDeleted },
        select: { id: true, facultyId: true, studyType: true },
      });

      if (new Set(found.map((d) => d.studyType)).size > 1) {
        fields.departmentIds = ['General and Programs departments cannot be combined'];
      }

      const missing = departmentIds.filter((id) => !found.some((d) => d.id === id));
      const foreign = found.filter((d) => d.facultyId !== facultyId);

      if (missing.length > 0) {
        fields.departmentIds = ['one or more departments do not exist'];
      } else if (foreign.length > 0) {
        fields.departmentIds = [
          'one or more departments do not belong to the selected college',
        ];
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    throw AppException.validation(fields);
  }
}

async function referenceAssertYear(
  prisma: FakePrisma,
  catalog: FakeCatalog,
  input: {
    universityId?: string | null;
    facultyId?: string | null;
    departmentIds?: string[] | null;
    academicYearId?: string | null;
  },
): Promise<void> {
  const academicYearId = input.academicYearId;
  if (!academicYearId) return;

  const departmentIds = [...new Set(input.departmentIds ?? [])].sort();
  const departmentId = departmentIds[0];
  for (const additionalDepartment of departmentIds.slice(1)) {
    await referenceAssertYear(prisma, catalog, { ...input, departmentIds: [additionalDepartment] });
  }

  const structure = await catalog.resolveAcademicStructure({
    departmentId: departmentId ?? null,
    facultyId: departmentId ? null : (input.facultyId ?? null),
    universityId: departmentId || input.facultyId ? null : (input.universityId ?? null),
  });

  if (!structure) {
    throw AppException.validation({
      academicYearId: ['no academic structure covers this course; create one first'],
    });
  }

  const rung = await prisma.academicYear.findFirst({
    where: { id: academicYearId, structureId: structure.id },
    select: { id: true },
  });

  if (!rung) {
    throw AppException.validation({
      academicYearId: [
        structure.kind === AcademicStructureKind.LEVEL
          ? 'that level is not part of this course academic structure'
          : 'that year is not part of this course academic structure',
      ],
    });
  }
}

// ---- a fake database that records every call -------------------------------

type Call = [string, unknown];

function fakes() {
  const calls: Call[] = [];
  const faculties = [
    { id: 'fac_a', universityId: 'uni_a', isActive: true },
    { id: 'fac_b', universityId: 'uni_b', isActive: true },
    { id: 'fac_off', universityId: 'uni_a', isActive: false },
  ];
  const departments = [
    { id: 'dep_g1', facultyId: 'fac_a', studyType: 'GENERAL', isActive: true },
    { id: 'dep_g2', facultyId: 'fac_a', studyType: 'GENERAL', isActive: true },
    { id: 'dep_p1', facultyId: 'fac_a', studyType: 'PROGRAMS', isActive: true },
    { id: 'dep_x', facultyId: 'fac_b', studyType: 'GENERAL', isActive: true },
    { id: 'dep_off', facultyId: 'fac_a', studyType: 'GENERAL', isActive: false },
  ];
  const structures: Record<string, { id: string; kind: AcademicStructureKind } | null> = {
    'department:dep_g1': { id: 'st_year', kind: AcademicStructureKind.YEAR },
    'department:dep_g2': { id: 'st_year', kind: AcademicStructureKind.YEAR },
    'department:dep_p1': { id: 'st_level', kind: AcademicStructureKind.LEVEL },
    'faculty:fac_a': { id: 'st_year', kind: AcademicStructureKind.YEAR },
    'faculty:fac_b': null,
    'university:uni_a': { id: 'st_year', kind: AcademicStructureKind.YEAR },
  };
  const years = [
    { id: 'y1', structureId: 'st_year', isActive: true },
    { id: 'l1', structureId: 'st_level', isActive: true },
    { id: 'y_off', structureId: 'st_year', isActive: false },
  ];

  const prisma = {
    faculty: {
      findFirst: async (args: { where: { id: string }; select?: unknown }) => {
        calls.push(['faculty.findFirst', args]);
        const row = faculties.find((f) => f.id === args.where.id);
        return row ? { id: row.id, universityId: row.universityId } : null;
      },
    },
    department: {
      findMany: async (args: { where: { id: { in: string[] } }; select?: unknown }) => {
        calls.push(['department.findMany', args]);
        return departments
          .filter((d) => args.where.id.in.includes(d.id))
          .map((d) => ({ id: d.id, facultyId: d.facultyId, studyType: d.studyType }));
      },
    },
    academicYear: {
      findFirst: async (args: { where: { id: string; structureId: string }; select?: unknown }) => {
        calls.push(['academicYear.findFirst', args]);
        const row = years.find(
          (y) => y.id === args.where.id && y.structureId === args.where.structureId,
        );
        return row ? { id: row.id } : null;
      },
    },
    university: {
      findFirst: async () => {
        calls.push(['university.findFirst', null]);
        return { id: 'uni_a', isActive: true };
      },
    },
  };
  const catalog = {
    resolveAcademicStructure: async (scope: {
      departmentId: string | null;
      facultyId: string | null;
      universityId: string | null;
    }) => {
      calls.push(['catalog.resolveAcademicStructure', scope]);
      const key = scope.departmentId
        ? `department:${scope.departmentId}`
        : scope.facultyId
          ? `faculty:${scope.facultyId}`
          : `university:${scope.universityId}`;
      return structures[key] ?? null;
    },
  };
  return { prisma, catalog, calls };
}

type FakePrisma = ReturnType<typeof fakes>['prisma'];
type FakeCatalog = ReturnType<typeof fakes>['catalog'];

async function outcome(run: () => Promise<void>) {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    const e = error as AppException;
    return { ok: false, code: e.code, details: (e as unknown as { fields?: unknown }).fields ?? e.message };
  }
}

const structureCases: Array<[string, Parameters<typeof referenceAssertAcademicStructure>[1]]> = [
  ['empty placement', {}],
  ['valid faculty', { universityId: 'uni_a', facultyId: 'fac_a' }],
  ['faculty only (no university)', { facultyId: 'fac_a' }],
  ['faculty not found', { universityId: 'uni_a', facultyId: 'nope' }],
  ['faculty of another university', { universityId: 'uni_a', facultyId: 'fac_b' }],
  ['departments without a faculty', { departmentIds: ['dep_g1'] }],
  ['valid departments', { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_g1', 'dep_g2'] }],
  ['duplicate department ids', { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_g1', 'dep_g1'] }],
  ['mixed General and Programs', { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_g1', 'dep_p1'] }],
  ['missing department', { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_g1', 'ghost'] }],
  ['department of another faculty', { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_x'] }],
  ['inactive department (courses never checked activity)', { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_off'] }],
  ['inactive faculty (courses never checked activity)', { universityId: 'uni_a', facultyId: 'fac_off' }],
];

const yearCases: Array<[string, Parameters<typeof referenceAssertYear>[2]]> = [
  ['no year', { facultyId: 'fac_a' }],
  ['year on the faculty ladder', { facultyId: 'fac_a', academicYearId: 'y1' }],
  ['level on a YEAR ladder', { facultyId: 'fac_a', academicYearId: 'l1' }],
  ['no ladder covers the faculty', { facultyId: 'fac_b', academicYearId: 'y1' }],
  ['year by university only', { universityId: 'uni_a', academicYearId: 'y1' }],
  ['department ladder (LEVEL)', { facultyId: 'fac_a', departmentIds: ['dep_p1'], academicYearId: 'l1' }],
  ['wrong rung for a LEVEL department', { facultyId: 'fac_a', departmentIds: ['dep_p1'], academicYearId: 'y1' }],
  ['several departments, same ladder', { facultyId: 'fac_a', departmentIds: ['dep_g2', 'dep_g1'], academicYearId: 'y1' }],
  ['several departments, different ladders', { facultyId: 'fac_a', departmentIds: ['dep_g1', 'dep_p1'], academicYearId: 'y1' }],
  ['inactive rung (courses never checked activity)', { facultyId: 'fac_a', academicYearId: 'y_off' }],
];

describe('course placement: shared validator == original course code (E1)', () => {
  it.each(structureCases)('structure — %s', async (_name, input) => {
    const ref = fakes();
    const neu = fakes();
    const expected = await outcome(() => referenceAssertAcademicStructure(ref.prisma, input));
    const actual = await outcome(() => checkAcademicStructure(neu.prisma as never, input, COURSE_PLACEMENT));
    expect(actual).toEqual(expected);
    expect(neu.calls).toEqual(ref.calls);
  });

  it.each(yearCases)('year/level — %s', async (_name, input) => {
    const ref = fakes();
    const neu = fakes();
    const expected = await outcome(() => referenceAssertYear(ref.prisma, ref.catalog, input));
    const actual = await outcome(() =>
      checkYearInLadder(neu.prisma as never, neu.catalog as never, input, COURSE_PLACEMENT),
    );
    expect(actual).toEqual(expected);
    expect(neu.calls).toEqual(ref.calls);
  });

  it('COURSE_PLACEMENT is the default, so omitting options cannot change behaviour', async () => {
    const a = fakes();
    const b = fakes();
    const input = { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_g1', 'dep_p1'] };
    expect(await outcome(() => checkAcademicStructure(a.prisma as never, input))).toEqual(
      await outcome(() => checkAcademicStructure(b.prisma as never, input, COURSE_PLACEMENT)),
    );
    expect(a.calls).toEqual(b.calls);
  });
});

describe('Library placement adds its own rules and nothing leaks back to courses', () => {
  it('requires a university and a faculty', async () => {
    const { prisma } = fakes();
    const result = await outcome(() => checkAcademicStructure(prisma as never, {}, LIBRARY_PLACEMENT));
    expect(result).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });

  it('refuses an inactive department and an inactive rung', async () => {
    const f = fakes();
    // The Library path selects isActive; the fake answers from the full rows.
    (f.prisma.department.findMany as unknown) = async () => [
      { id: 'dep_off', facultyId: 'fac_a', studyType: 'GENERAL', isActive: false },
    ];
    const dept = await outcome(() =>
      checkAcademicStructure(
        f.prisma as never,
        { universityId: 'uni_a', facultyId: 'fac_a', departmentIds: ['dep_off'] },
        LIBRARY_PLACEMENT,
      ),
    );
    expect(dept).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });

    const g = fakes();
    (g.prisma.academicYear.findFirst as unknown) = async (args: { where: { isActive?: boolean } }) =>
      args.where.isActive === true ? null : { id: 'y_off' };
    const rung = await outcome(() =>
      checkYearInLadder(g.prisma as never, g.catalog as never, { facultyId: 'fac_a', academicYearId: 'y_off' }, LIBRARY_PLACEMENT),
    );
    expect(rung).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' });
  });

  it('names the material, not the course, in its messages', async () => {
    const { prisma, catalog } = fakes();
    const result = await outcome(() =>
      checkYearInLadder(prisma as never, catalog as never, { facultyId: 'fac_b', academicYearId: 'y1' }, LIBRARY_PLACEMENT),
    );
    expect(JSON.stringify(result)).toContain('this material');
  });
});
