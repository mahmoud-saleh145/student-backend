import { AcademicStructureKind, AuditAction, UserRole } from '@prisma/client';

import { CatalogService } from '../../src/modules/catalog/catalog.service';

/**
 * What happens to a college's LADDER when its university's DEFAULT changes.
 *
 * The product rule is that nothing is renamed, renumbered or deleted. These
 * tests pin that from both directions, because the failure mode is quiet:
 *
 *   1. A change that quietly renames "First Year" to "Level 100" would rewrite
 *      the academic year every existing student is filed under.
 *   2. A change that quietly HIDES the disagreement makes the screen look done
 *      while students are offered years under a levels question.
 *
 * The second is what an earlier implementation did: `academicSelection`
 * rewrote the reported system to match the ladder, which made the picker
 * self-consistent and the misconfiguration invisible.
 */

const ACTOR = { id: 'usr_admin', role: UserRole.ADMIN };

/**
 * A service with one university, one college and one ladder.
 *
 * `entries` and the structure's `kind` are set independently so a test can
 * create the mismatch the second failure mode describes.
 */
function build(options: {
  universityDefault?: AcademicStructureKind;
  facultyOverride?: AcademicStructureKind | null;
  structureKind?: AcademicStructureKind;
  entries?: { id: string; order: number; name: string; nameAr: string }[];
  structureId?: string;
}) {
  const structureId = options.structureId ?? 'as_1';
  const structureKind = options.structureKind ?? AcademicStructureKind.YEAR;
  const entries = options.entries ?? [
    { id: 'ay1', order: 1, name: 'First Year', nameAr: 'الفرقة الأولى' },
    { id: 'ay2', order: 2, name: 'Second Year', nameAr: 'الفرقة الثانية' },
  ];

  const prisma = {
    university: {
      findUnique: jest.fn(async (args: { where: { id: string } }) =>
        args.where.id === 'u1'
          ? {
              id: 'u1',
              name: 'Cairo University',
              defaultAcademicSystem:
                options.universityDefault ?? AcademicStructureKind.YEAR,
            }
          : null,
      ),
      findFirst: jest.fn(async () => ({
        id: 'u1',
        name: 'Cairo University',
        defaultAcademicSystem: options.universityDefault ?? AcademicStructureKind.YEAR,
      })),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'u_new',
        ...args.data,
      })),
      // The admin overview lists every university, not one by id.
      findMany: jest.fn(async () => [
        {
          id: 'u1',
          name: 'Cairo University',
          nameAr: 'جامعة القاهرة',
          isActive: true,
          defaultAcademicSystem: options.universityDefault ?? AcademicStructureKind.YEAR,
          _count: { faculties: 1 },
        },
      ]),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: args.where.id,
          name: 'Cairo University',
          defaultAcademicSystem:
            (args.data.defaultAcademicSystem as AcademicStructureKind) ??
            options.universityDefault ??
            AcademicStructureKind.YEAR,
        }),
      ),
    },
    faculty: {
      findUnique: jest.fn(
        async (args: { where: { id: string }; select?: Record<string, unknown> }) => {
          if (args.where.id !== 'f1') return null;
          if (args.select && 'academicSystemOverride' in args.select) {
            return {
              id: 'f1',
              academicSystemOverride:
                options.facultyOverride === undefined ? null : options.facultyOverride,
              university: {
                id: 'u1',
                defaultAcademicSystem:
                  options.universityDefault ?? AcademicStructureKind.YEAR,
              },
            };
          }
          // The ladder resolver's shape.
          return { id: 'f1', universityId: 'u1' };
        },
      ),
      findFirst: jest.fn(async () => ({
        id: 'f1',
        universityId: 'u1',
        academicSystemOverride:
          options.facultyOverride === undefined ? null : options.facultyOverride,
        university: {
          id: 'u1',
          defaultAcademicSystem: options.universityDefault ?? AcademicStructureKind.YEAR,
        },
      })),
      // Two different list queries. Dispatched on the requested `select` so each
      // fixture answers only its own question: override validation wants bare
      // ids, the admin overview wants full rows with the parent university.
      findMany: jest.fn(async (args: { select?: Record<string, unknown> }) =>
        args.select && 'university' in args.select
          ? [
              {
                id: 'f1',
                name: 'Engineering',
                nameAr: 'الهندسة',
                isActive: true,
                universityId: 'u1',
                academicSystemOverride:
                  options.facultyOverride === undefined ? null : options.facultyOverride,
                university: {
                  id: 'u1',
                  name: 'Cairo University',
                  defaultAcademicSystem:
                    options.universityDefault ?? AcademicStructureKind.YEAR,
                },
              },
            ]
          : [{ id: 'f1' }],
      ),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: args.where.id,
          ...args.data,
        }),
      ),
    },
    department: { findUnique: jest.fn(async () => null) },
    academicStructure: {
      findMany: jest.fn(async () => [
        { id: structureId, kind: structureKind, scopeKey: `faculty:f1` },
      ]),
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: structureId,
        ...args.data,
      })),
      update: jest.fn(
        async (args: { where: { id: string }; data: Record<string, unknown> }) => ({
          id: args.where.id,
          ...args.data,
        }),
      ),
    },
    academicStructureFaculty: {
      findUnique: jest.fn(async () => null),
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    academicYear: {
      findMany: jest.fn(async () => entries.map((e) => ({ ...e, isActive: true }))),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'ay_new',
        ...args.data,
      })),
      upsert: jest.fn(async () => ({ id: 'ay' })),
      updateMany: jest.fn(async () => ({ count: 0 })),
      update: jest.fn(async () => ({ id: 'ay' })),
    },
    $transaction: jest.fn(async (ops: readonly unknown[]) => Promise.all(ops)),
  };

  const redis = {
    remember: jest.fn(
      async (_key: string, _ttl: number, producer: () => Promise<unknown>) => producer(),
    ),
    delByPattern: jest.fn(async () => 0),
  };
  const audit = {
    // Named parameter: a zero-arity `jest.fn` infers an empty parameter tuple,
    // which makes reading `mock.calls[0][0]` a type error under `strict`.
    record: jest.fn(async (_entry: Record<string, unknown>) => undefined),
  };

  const service = new CatalogService(prisma as never, redis as never, audit as never);
  return { service, prisma, redis, audit };
}

describe('changing a university default does not touch existing entries', () => {
  it('writes only the university column', async () => {
    const { service, prisma } = build({ universityDefault: AcademicStructureKind.YEAR });

    await service.updateUniversity(
      'u1',
      { defaultAcademicSystem: AcademicStructureKind.LEVEL },
      ACTOR,
    );

    // Exactly one table is written. A change that also touched academic_structures
    // or academic_years would be renaming or re-labelling students' academic
    // years behind their backs.
    expect(prisma.university.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { defaultAcademicSystem: AcademicStructureKind.LEVEL },
    });
    expect(prisma.academicStructure.update).not.toHaveBeenCalled();
    expect(prisma.academicYear.updateMany).not.toHaveBeenCalled();
    expect(prisma.academicYear.upsert).not.toHaveBeenCalled();
  });

  it('leaves the entries the college offers exactly as they were', async () => {
    // Before: a year-based university whose college shows years.
    const before = build({ universityDefault: AcademicStructureKind.YEAR });
    expect(
      (await before.service.academicYears({ facultyId: 'f1' })).map((y) => y.name),
    ).toEqual(['First Year', 'Second Year']);

    // After the default flips, the SAME ladder still answers with the SAME names.
    // They are renamed only if an administrator edits them deliberately.
    const after = build({ universityDefault: AcademicStructureKind.LEVEL });
    const entries = await after.service.academicYears({ facultyId: 'f1' });
    expect(entries.map((y) => y.name)).toEqual(['First Year', 'Second Year']);
    expect(entries.map((y) => y.id)).toEqual(['ay1', 'ay2']);
  });

  it('reports the disagreement instead of hiding it', async () => {
    // The default says LEVEL; the ladder the college actually resolves to says
    // YEAR. An earlier version rewrote the reported system to YEAR and returned
    // `ladderMatchesSystem` implicitly, which made a misconfiguration look like a
    // working screen.
    const { service } = build({ universityDefault: AcademicStructureKind.LEVEL });

    const selection = await service.academicSelection({ facultyId: 'f1' });

    // The CONFIGURED value is reported honestly...
    expect(selection.academicSystem?.system).toBe(AcademicStructureKind.LEVEL);
    // ...the ladder's real vocabulary is reported alongside it...
    expect(selection.ladderKind).toBe(AcademicStructureKind.YEAR);
    // ...and the disagreement is explicit rather than resolved behind the scenes.
    expect(selection.ladderMatchesSystem).toBe(false);
  });

  it('reports agreement when the ladder matches the configuration', async () => {
    const { service } = build({ universityDefault: AcademicStructureKind.YEAR });

    const selection = await service.academicSelection({ facultyId: 'f1' });

    expect(selection.academicSystem?.system).toBe(AcademicStructureKind.YEAR);
    expect(selection.ladderKind).toBe(AcademicStructureKind.YEAR);
    expect(selection.ladderMatchesSystem).toBe(true);
  });

  it('treats "no ladder yet" as agreement rather than a mismatch', async () => {
    // A college with a configuration but no structure is mid-setup, not broken.
    // Reporting MISMATCH there would train an administrator to ignore the flag.
    const { service } = build({
      universityDefault: AcademicStructureKind.LEVEL,
      entries: [],
    });

    const selection = await service.academicSelection({ facultyId: 'f1' });

    expect(selection.academicYears).toEqual([]);
    expect(selection.ladderKind).toBeNull();
    expect(selection.ladderMatchesSystem).toBe(true);
  });

  it('audits the change with both the old and new value', async () => {
    // Without the before/after pair there is no way to answer "who switched this
    // university, and what was it before?" after the fact.
    const { service, audit } = build({ universityDefault: AcademicStructureKind.YEAR });

    await service.updateUniversity(
      'u1',
      { defaultAcademicSystem: AcademicStructureKind.LEVEL },
      ACTOR,
    );

    const entry = audit.record.mock.calls[0]?.[0] as unknown as {
      action: AuditAction;
      entity: string;
      before: { defaultAcademicSystem: AcademicStructureKind };
      after: { defaultAcademicSystem: AcademicStructureKind };
    };
    expect(entry.action).toBe(AuditAction.UPDATE);
    expect(entry.entity).toBe('university');
    expect(entry.before.defaultAcademicSystem).toBe(AcademicStructureKind.YEAR);
    expect(entry.after.defaultAcademicSystem).toBe(AcademicStructureKind.LEVEL);
  });
});

describe('the admin overview surfaces the ladder, not just the configuration', () => {
  it("reports each college's governing ladder kind and whether it disagrees", async () => {
    const { service } = build({ universityDefault: AcademicStructureKind.LEVEL });

    const overview = await service.academicSystemOverview();

    const college = overview.faculties[0];
    expect(college?.effectiveAcademicSystem).toBe(AcademicStructureKind.LEVEL);
    expect(college?.ladderKind).toBe(AcademicStructureKind.YEAR);
    expect(college?.ladderMismatch).toBe(true);
    expect(college?.inherited).toBe(true);
  });

  it('reports no mismatch when everything agrees', async () => {
    const { service } = build({ universityDefault: AcademicStructureKind.YEAR });

    const overview = await service.academicSystemOverview();

    expect(overview.faculties[0]?.ladderMismatch).toBe(false);
  });
});
