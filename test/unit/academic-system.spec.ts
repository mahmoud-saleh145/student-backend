import { AcademicStructureKind } from '@prisma/client';

import {
  AcademicSystemConfigurationError,
  academicSystemLabel,
  academicSystemNoun,
  resolveAcademicSystem,
} from '../../src/modules/catalog/academic-system';
import { CatalogService } from '../../src/modules/catalog/catalog.service';
import { UsersService } from '../../src/modules/users/users.service';

/**
 * University default + college override, resolved as one rule.
 *
 * These are the twelve scenarios from the product brief, written against the
 * business rule rather than against the implementation:
 *
 *     effectiveSystem = college.academicSystemOverride ?? university.default
 *
 * The thing worth protecting is that the override is NULLABLE and that null
 * really does mean "follow the university". A version of this that copies the
 * university's value onto its colleges at write time looks identical and behaves
 * completely differently: no university-wide change would ever be possible
 * again. Scenarios 5, 6 and 7 are the tests that catch it.
 */

/** A university defaulting to YEARS, with a college that has no override. */
const GOVERNMENT_YEAR_UNIVERSITY = {
  id: 'u_gov',
  name: 'Cairo University',
  defaultAcademicSystem: AcademicStructureKind.YEAR,
};

/** The same shape, defaulting to LEVELS instead. */
const PRIVATE_LEVEL_UNIVERSITY = {
  id: 'u_priv',
  name: 'Private University',
  defaultAcademicSystem: AcademicStructureKind.LEVEL,
};

/**
 * Builds a `CatalogService` over the two configuration columns and nothing else.
 *
 * The prisma mock exposes only `university.findUnique`, `faculty.findUnique` and
 * `department.findUnique`, because the resolution is a three-row read and
 * nothing else. A mock that grew the whole client would let a test pass for the
 * wrong reason.
 */
function buildSystem(
  options: {
    university?: {
      id: string;
      defaultAcademicSystem: AcademicStructureKind | null;
    } | null;
    faculty?: {
      id: string;
      academicSystemOverride: AcademicStructureKind | null;
      university: { id: string; defaultAcademicSystem: AcademicStructureKind | null };
    } | null;
    department?: {
      facultyId: string;
      faculty: {
        id: string;
        academicSystemOverride: AcademicStructureKind | null;
        university: { id: string; defaultAcademicSystem: AcademicStructureKind | null };
      };
    } | null;
  } = {},
) {
  const universityFindUnique = jest.fn(async (args: { where: { id: string } }) => {
    const wanted = args.where.id;
    if (options.university && options.university.id === wanted) return options.university;
    if (options.faculty && options.faculty.university.id === wanted) {
      return {
        id: options.faculty.university.id,
        defaultAcademicSystem: options.faculty.university.defaultAcademicSystem,
      };
    }
    if (options.department && options.department.faculty.university.id === wanted) {
      return {
        id: options.department.faculty.university.id,
        defaultAcademicSystem:
          options.department.faculty.university.defaultAcademicSystem,
      };
    }
    return null;
  });

  const facultyFindUnique = jest.fn(async (args: { where: { id: string } }) => {
    const wanted = args.where.id;
    if (options.faculty && options.faculty.id === wanted) return options.faculty;
    if (options.department && options.department.faculty.id === wanted) {
      return options.department.faculty;
    }
    return null;
  });

  const departmentFindUnique = jest.fn(async (args: { where: { id: string } }) =>
    options.department && args.where.id === 'd_1' ? options.department : null,
  );

  const prisma = {
    university: { findUnique: universityFindUnique },
    faculty: { findUnique: facultyFindUnique },
    department: { findUnique: departmentFindUnique },
    // Never reached by these tests; present so an unexpected write is a loud
    // failure rather than an undefined-property error.
    academicStructure: {},
  };

  const service = new CatalogService(prisma as never, {} as never, {} as never);

  return { service, prisma, universityFindUnique, facultyFindUnique };
}

// ---------------------------------------------------------------------------
// The pure rule
// ---------------------------------------------------------------------------

describe('resolveAcademicSystem', () => {
  it('inherits the university default when the college has no override', () => {
    const result = resolveAcademicSystem({
      facultyId: 'f_eng',
      facultyOverride: null,
      universityId: 'u_gov',
      universityDefault: AcademicStructureKind.YEAR,
    });

    expect(result.system).toBe(AcademicStructureKind.YEAR);
    // The source is not decoration: the admin screen has to be able to say
    // "Inherited" rather than just naming the value.
    expect(result.source).toBe('UNIVERSITY_DEFAULT');
    expect(result.facultyOverride).toBeNull();
  });

  it('uses the college override when one is configured', () => {
    const result = resolveAcademicSystem({
      facultyId: 'f_cs',
      facultyOverride: AcademicStructureKind.LEVEL,
      universityId: 'u_gov',
      universityDefault: AcademicStructureKind.YEAR,
    });

    expect(result.system).toBe(AcademicStructureKind.LEVEL);
    expect(result.source).toBe('COLLEGE_OVERRIDE');
  });

  it('refuses to guess when neither configuration point has an answer', () => {
    // Scenario 11. Defaulting to YEAR here would silently mislabel a level-based
    // college's list, and nothing downstream would ever notice.
    expect(() =>
      resolveAcademicSystem({
        facultyId: 'f_eng',
        facultyOverride: null,
        universityId: 'u_gov',
        universityDefault: null,
      }),
    ).toThrow(AcademicSystemConfigurationError);
  });

  it('never lets university ownership influence the result', () => {
    // The brief is explicit: government/private must not decide this. The rule
    // takes no ownership input at all, so there is nothing for it to consult.
    const result = resolveAcademicSystem({
      facultyId: 'f_eng',
      facultyOverride: null,
      universityId: 'u_gov',
      universityDefault: AcademicStructureKind.YEAR,
    });
    expect(Object.keys(result).sort()).toEqual([
      'facultyId',
      'facultyOverride',
      'source',
      'system',
      'universityDefault',
      'universityId',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Scenario 1: year-based university, college with no override
// ---------------------------------------------------------------------------

describe('scenario 1 — a year-based university with a college that has no override', () => {
  it('resolves to years', async () => {
    const { service } = buildSystem({
      faculty: {
        id: 'f_eng',
        academicSystemOverride: null,
        university: {
          id: 'u_gov',
          defaultAcademicSystem: AcademicStructureKind.YEAR,
        },
      },
    });

    const resolved = await service.resolveAcademicSystem({ facultyId: 'f_eng' });

    expect(resolved.system).toBe(AcademicStructureKind.YEAR);
    expect(resolved.source).toBe('UNIVERSITY_DEFAULT');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: year-based university, college overridden to levels
// ---------------------------------------------------------------------------

describe('scenario 2 — a level-based college inside a year-based university', () => {
  it('resolves to levels', async () => {
    // The exact motivating case: a Computer Science college inside a
    // year-based university. Ownership is irrelevant and is never consulted.
    const { service } = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: AcademicStructureKind.LEVEL,
        university: {
          id: 'u_gov',
          defaultAcademicSystem: AcademicStructureKind.YEAR,
        },
      },
    });

    const resolved = await service.resolveAcademicSystem({ facultyId: 'f_cs' });

    expect(resolved.system).toBe(AcademicStructureKind.LEVEL);
    expect(resolved.source).toBe('COLLEGE_OVERRIDE');
    // Both values are reported so the admin screen can show what was overridden.
    expect(resolved.universityDefault).toBe(AcademicStructureKind.YEAR);
    expect(resolved.facultyOverride).toBe(AcademicStructureKind.LEVEL);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: level-based university, college with no override
// ---------------------------------------------------------------------------

describe('scenario 3 — a level-based university with a college that has no override', () => {
  it('resolves to levels', async () => {
    const { service } = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: null,
        university: {
          id: 'u_priv',
          defaultAcademicSystem: AcademicStructureKind.LEVEL,
        },
      },
    });

    const resolved = await service.resolveAcademicSystem({ facultyId: 'f_cs' });

    expect(resolved.system).toBe(AcademicStructureKind.LEVEL);
    expect(resolved.source).toBe('UNIVERSITY_DEFAULT');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: level-based university, college overridden to years
// ---------------------------------------------------------------------------

describe('scenario 4 — a year-based college inside a level-based university', () => {
  it('resolves to years', async () => {
    // The mirror of scenario 2, and the case that proves the rule is not
    // "government means years, private means levels" wearing a disguise.
    const { service } = buildSystem({
      faculty: {
        id: 'f_law',
        academicSystemOverride: AcademicStructureKind.YEAR,
        university: {
          id: 'u_priv',
          defaultAcademicSystem: AcademicStructureKind.LEVEL,
        },
      },
    });

    const resolved = await service.resolveAcademicSystem({ facultyId: 'f_law' });

    expect(resolved.system).toBe(AcademicStructureKind.YEAR);
    expect(resolved.source).toBe('COLLEGE_OVERRIDE');
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: changing the university default moves an inheriting college
// ---------------------------------------------------------------------------

describe('scenario 5 — changing the university default', () => {
  it('changes an inheriting college', async () => {
    // Two calls against two different stored values for the university, with the
    // college's own row untouched. This is inheritance: nothing was copied
    // anywhere, so the change reaches the college for free.
    const before = buildSystem({
      faculty: {
        id: 'f_eng',
        academicSystemOverride: null,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.YEAR },
      },
    });
    const after = buildSystem({
      faculty: {
        id: 'f_eng',
        academicSystemOverride: null,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.LEVEL },
      },
    });

    expect(
      (await before.service.resolveAcademicSystem({ facultyId: 'f_eng' })).system,
    ).toBe(AcademicStructureKind.YEAR);
    expect(
      (await after.service.resolveAcademicSystem({ facultyId: 'f_eng' })).system,
    ).toBe(AcademicStructureKind.LEVEL);
  });

  it('reports the college as inheriting, not overridden, both times', async () => {
    // If the college were storing its own value this would come back as
    // COLLEGE_OVERRIDE after the change, which is the bug this test rules out.
    const { service } = buildSystem({
      faculty: {
        id: 'f_eng',
        academicSystemOverride: null,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.LEVEL },
      },
    });

    const resolved = await service.resolveAcademicSystem({ facultyId: 'f_eng' });
    expect(resolved.source).toBe('UNIVERSITY_DEFAULT');
    expect(resolved.facultyOverride).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: changing the university default does not move an overridden college
// ---------------------------------------------------------------------------

describe('scenario 6 — a college with an explicit override', () => {
  it('keeps its system when the university default changes', async () => {
    const before = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: AcademicStructureKind.LEVEL,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.YEAR },
      },
    });
    const after = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: AcademicStructureKind.LEVEL,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.LEVEL },
      },
    });

    // Both reads answer LEVEL. The second one is the interesting half: the
    // university now defaults to LEVEL too, but the college is still an explicit
    // decision rather than a follower, so a later flip away from LEVEL moves it.
    expect(
      (await before.service.resolveAcademicSystem({ facultyId: 'f_cs' })).system,
    ).toBe(AcademicStructureKind.LEVEL);
    const afterResult = await after.service.resolveAcademicSystem({ facultyId: 'f_cs' });
    expect(afterResult.system).toBe(AcademicStructureKind.LEVEL);
    expect(afterResult.source).toBe('COLLEGE_OVERRIDE');
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: removing an override returns the college to inheritance
// ---------------------------------------------------------------------------

describe('scenario 7 — clearing an override', () => {
  it('follows the university again immediately', async () => {
    const withOverride = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: AcademicStructureKind.LEVEL,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.YEAR },
      },
    });
    const afterClear = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: null,
        university: { id: 'u_gov', defaultAcademicSystem: AcademicStructureKind.YEAR },
      },
    });

    expect(
      (await withOverride.service.resolveAcademicSystem({ facultyId: 'f_cs' })).system,
    ).toBe(AcademicStructureKind.LEVEL);
    const cleared = await afterClear.service.resolveAcademicSystem({ facultyId: 'f_cs' });
    expect(cleared.system).toBe(AcademicStructureKind.YEAR);
    expect(cleared.source).toBe('UNIVERSITY_DEFAULT');
  });
});

/**
 * Builds a `UsersService` for the registration-validation tests.
 *
 * Only the academic-coherence path is exercised, so the collaborators it does
 * not touch are passed as empty objects cast through `never` — the same
 * convention the rest of this repository's unit tests use.
 */
function buildUsersService(prisma: unknown, catalog: unknown): UsersService {
  // Constructor order is (prisma, passwords, audit, settings, catalog).
  return new UsersService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    catalog as never,
  );
}

// ---------------------------------------------------------------------------
// Scenario 8: a rung from the wrong structure
// ---------------------------------------------------------------------------

describe('scenario 8 — an invalid student selection', () => {
  it("reports a rung that is not in the college's ladder as a field error", async () => {
    // The backend half of the rule. A student posting an academicYearId belonging
    // to another college's ladder is rejected by structure membership, which is
    // checked against the database rather than trusted from the client.
    const prisma = {
      university: { findFirst: jest.fn(async () => ({ id: 'u_gov' })) },
      faculty: {
        findFirst: jest.fn(async () => ({ id: 'f_cs', universityId: 'u_gov' })),
      },
      department: {
        findFirst: jest.fn(async () => ({
          id: 'd_1',
          facultyId: 'f_cs',
          studyType: 'PROGRAMS',
        })),
      },
      // Two different questions, answered from one mock: "does this rung id
      // exist at all?" (no `structureId` in the where clause) and "does it
      // belong to the governing ladder?" (scoped to one structure). The rung
      // exists but belongs to a different college's ladder, so the second
      // answer must be null.
      academicYear: {
        findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
          'structureId' in args.where ? null : { id: 'ay_foreign' },
        ),
      },
    };

    const catalog = {
      resolveAcademicStructure: jest.fn(async () => ({ id: 'as_cs' })),
    };

    const users = buildUsersService(prisma, catalog);

    await expect(
      users.assertAcademicSelectionIsCoherent({
        universityId: 'u_gov',
        facultyId: 'f_cs',
        departmentId: 'd_1',
        academicYearId: 'ay_foreign',
      }),
    ).rejects.toMatchObject({
      fields: { academicYearId: ['does not belong to the selected department'] },
    });

    // The lookup is scoped to the resolved structure, so a rung from any other
    // college's ladder cannot match.
    expect(prisma.academicYear.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ay_foreign', structureId: 'as_cs', isActive: true },
      }),
    );
  });

  it('rejects a department belonging to a different college', async () => {
    const prisma = {
      university: { findFirst: jest.fn(async () => ({ id: 'u_gov' })) },
      faculty: {
        findFirst: jest.fn(async () => ({ id: 'f_cs', universityId: 'u_gov' })),
      },
      department: {
        findFirst: jest.fn(async () => ({ id: 'd_1', facultyId: 'f_other' })),
      },
      academicYear: { findFirst: jest.fn(async () => ({ id: 'ay_1' })) },
    };
    const catalog = { resolveAcademicStructure: jest.fn(async () => ({ id: 'as_cs' })) };

    const users = buildUsersService(prisma, catalog);

    await expect(
      users.assertAcademicSelectionIsCoherent({
        universityId: 'u_gov',
        facultyId: 'f_cs',
        departmentId: 'd_1',
        academicYearId: 'ay_1',
      }),
    ).rejects.toMatchObject({
      fields: { departmentId: ['does not belong to the selected faculty'] },
    });
  });
});

// ---------------------------------------------------------------------------
// Scenario 10: registration without any study-type selection
// ---------------------------------------------------------------------------

describe('scenario 10 — registration without a study type', () => {
  it('succeeds when only the college configuration is supplied', async () => {
    // The payload a student now sends: university, college, department and the
    // rung. No government/private flag, no study type, no academic system.
    const prisma = {
      university: { findFirst: jest.fn(async () => ({ id: 'u_gov' })) },
      faculty: {
        findFirst: jest.fn(async () => ({ id: 'f_cs', universityId: 'u_gov' })),
      },
      department: { findFirst: jest.fn(async () => ({ id: 'd_1', facultyId: 'f_cs' })) },
      // The rung exists (no `structureId` in the where clause) AND belongs to the
      // governing ladder (scoped to `as_cs`), so both checks pass.
      academicYear: {
        findFirst: jest.fn(async (args: { where: Record<string, unknown> }) =>
          !('structureId' in args.where) || args.where.structureId === 'as_cs'
            ? { id: 'ay_1' }
            : null,
        ),
      },
    };
    const catalog = { resolveAcademicStructure: jest.fn(async () => ({ id: 'as_cs' })) };

    const users = buildUsersService(prisma, catalog);

    await expect(
      users.assertAcademicSelectionIsCoherent({
        universityId: 'u_gov',
        facultyId: 'f_cs',
        departmentId: 'd_1',
        academicYearId: 'ay_1',
      }),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: a misconfigured hierarchy
// ---------------------------------------------------------------------------

describe('scenario 11 — missing or invalid configuration', () => {
  it('raises a configuration error rather than selecting a system', async () => {
    const { service } = buildSystem({
      faculty: {
        id: 'f_eng',
        academicSystemOverride: null,
        university: { id: 'u_gov', defaultAcademicSystem: null },
      },
    });

    await expect(service.resolveAcademicSystem({ facultyId: 'f_eng' })).rejects.toThrow();
  });

  it('reports a missing college rather than falling back to a university', async () => {
    // Falling back would answer for a college that does not exist, which is how
    // an unrelated ladder ends up being offered to a student.
    const { service } = buildSystem({ faculty: null });

    await expect(
      service.resolveAcademicSystem({ facultyId: 'f_gone' }),
    ).rejects.toThrow();
  });

  it('still answers when only the override is configured', async () => {
    // A college whose override exists but whose university default does not is
    // fully determined: the override is the answer.
    const { service } = buildSystem({
      faculty: {
        id: 'f_cs',
        academicSystemOverride: AcademicStructureKind.LEVEL,
        university: { id: 'u_gov', defaultAcademicSystem: null },
      },
    });

    const resolved = await service.resolveAcademicSystem({ facultyId: 'f_cs' });
    expect(resolved.system).toBe(AcademicStructureKind.LEVEL);
    expect(resolved.source).toBe('COLLEGE_OVERRIDE');
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: a department follows its college
// ---------------------------------------------------------------------------

describe('scenario 12 — departments and their college', () => {
  it("resolves a department through its college's override", async () => {
    // A PROGRAMS department in a year-based university whose college is
    // overridden to LEVEL must resolve to LEVEL. Under the old rule
    // (`studyType === 'PROGRAMS' ? LEVEL : YEAR`) this was impossible.
    const { service } = buildSystem({
      department: {
        facultyId: 'f_cs',
        faculty: {
          id: 'f_cs',
          academicSystemOverride: AcademicStructureKind.LEVEL,
          university: {
            id: 'u_gov',
            defaultAcademicSystem: AcademicStructureKind.YEAR,
          },
        },
      },
    });

    const resolved = await service.resolveAcademicSystem({ departmentId: 'd_1' });

    expect(resolved.system).toBe(AcademicStructureKind.LEVEL);
    expect(resolved.facultyId).toBe('f_cs');
  });

  it('resolves a GENERAL department to years when its college inherits years', async () => {
    const { service } = buildSystem({
      department: {
        facultyId: 'f_eng',
        faculty: {
          id: 'f_eng',
          academicSystemOverride: null,
          university: {
            id: 'u_priv',
            defaultAcademicSystem: AcademicStructureKind.LEVEL,
          },
        },
      },
    });

    // A general department inside a level-based university shows levels. The
    // study type is not consulted at any point.
    const resolved = await service.resolveAcademicSystem({ departmentId: 'd_1' });
    expect(resolved.system).toBe(AcademicStructureKind.LEVEL);
  });
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

describe('academic system labels', () => {
  it('names both systems unambiguously in both languages', () => {
    // "Type" is the label that caused the original confusion; these say what the
    // system is and carry the Arabic term the dashboard shows.
    expect(academicSystemLabel(AcademicStructureKind.YEAR)).toEqual({
      en: 'Year-based (نظام الفرق)',
      ar: 'نظام الفرق',
    });
    expect(academicSystemLabel(AcademicStructureKind.LEVEL)).toEqual({
      en: 'Level-based (نظام الليفلز)',
      ar: 'نظام الليفلز',
    });
  });

  it('uses the singular noun for a field label', () => {
    expect(academicSystemNoun(AcademicStructureKind.YEAR)).toEqual({
      en: 'Year',
      ar: 'الفرقة',
    });
    expect(academicSystemNoun(AcademicStructureKind.LEVEL)).toEqual({
      en: 'Level',
      ar: 'المستوى',
    });
  });
});

// ---------------------------------------------------------------------------
// The fixture guard
// ---------------------------------------------------------------------------

describe("the scenarios' fixtures", () => {
  it('describes a year-based university and a level-based one', () => {
    // Guards the fixtures above against being quietly swapped, which would make
    // scenarios 2 and 4 assert the wrong thing while still passing.
    expect(GOVERNMENT_YEAR_UNIVERSITY.defaultAcademicSystem).toBe(
      AcademicStructureKind.YEAR,
    );
    expect(PRIVATE_LEVEL_UNIVERSITY.defaultAcademicSystem).toBe(
      AcademicStructureKind.LEVEL,
    );
  });
});
