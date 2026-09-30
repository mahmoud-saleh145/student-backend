import { AcademicStructureKind, UserRole } from '@prisma/client';

import {
  academicScopeKey,
  assertSingleAcademicOwner,
  CatalogService,
  PLATFORM_SCOPE_KEY,
} from '../../src/modules/catalog/catalog.service';

/**
 * Academic structures: Years vs Levels, owned per catalogue unit.
 *
 * `academic_years` used to be one flat platform-wide list with a globally
 * unique `order`, so two colleges could not both have a rung numbered 1 and
 * there was nowhere to record whether a list meant "First Year" or "Level 1".
 *
 * Three properties are worth pinning, because each of them is a way the
 * feature could look finished and be wrong:
 *
 *   1. `scopeKey` is what carries uniqueness. Postgres treats NULLs as
 *      distinct, so a UNIQUE over the three nullable owner columns would have
 *      accepted two platform-wide structures.
 *   2. Resolution inherits upwards. A department with no structure of its own
 *      must fall through to its faculty, then its university, then the
 *      platform — otherwise an Admin has to redefine the same four years for
 *      every department.
 *   3. Editing the rungs must not strip students of their placement. Rows
 *      point at these ids, so a removed rung is deactivated, never deleted,
 *      and a renamed rung keeps its id.
 */

const ACTOR = { id: 'usr_admin', role: UserRole.ADMIN };

interface Options {
  /** Structures the database would return for the candidate scopeKeys. */
  structures?: { id: string; kind: AcademicStructureKind; scopeKey: string }[];
  /** The row `academicStructure.findUnique` answers with. */
  existingByScope?: { id: string } | null;
  department?: { facultyId: string; faculty: { universityId: string } } | null;
  faculty?: { universityId: string } | null;
  /** The structure `replaceStructureEntries` is editing. */
  structureWithEntries?: {
    id: string;
    entries: { id: string; order: number }[];
  } | null;
  entries?: { id: string; order: number; name: string; nameAr: string; isActive: boolean }[];
}

function build(options: Options = {}) {
  // Named parameters throughout: a zero-arity `jest.fn(async () => …)` infers
  // an empty parameter tuple, which makes `mock.calls[0][0]` a type error
  // under `strict`.
  const structureFindMany = jest.fn(
    async (_args: { where: unknown; select: unknown }) => options.structures ?? [],
  );
  // One mock, because the service reaches `academicStructure.findUnique` for
  // two different purposes: the duplicate-scope check (by scopeKey) and
  // loading the structure being edited (by id). Dispatching on the `where`
  // shape keeps both honest instead of having the second silently answer the
  // first's fixture.
  const structureFindUnique = jest.fn(
    async (args: { where: Record<string, unknown>; select?: unknown }) => {
      if ('scopeKey' in args.where) {
        return options.existingByScope === undefined ? null : options.existingByScope;
      }
      return options.structureWithEntries === undefined ? null : options.structureWithEntries;
    },
  );
  const structureCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'as_new',
    ...args.data,
  }));
  const structureUpdate = jest.fn(async (args: { where: unknown; data: unknown }) => ({
    id: 'as_1',
    ...(args.data as Record<string, unknown>),
  }));

  const yearUpsert = jest.fn(
    async (_args: { where: unknown; update: unknown; create: unknown }) => ({ id: 'ay' }),
  );
  const yearUpdateMany = jest.fn(async (_args: { where: unknown; data: unknown }) => ({
    count: 1,
  }));
  const yearFindMany = jest.fn(
    async (_args: { where: unknown; orderBy?: unknown; select: unknown }) =>
      options.entries ?? [],
  );
  const yearCreate = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    id: 'ay_new',
    ...args.data,
  }));

  const departmentFindUnique = jest.fn(
    async (_args: { where: unknown; select: unknown }) =>
      options.department === undefined ? null : options.department,
  );
  const facultyFindUnique = jest.fn(
    async (_args: { where: unknown; select: unknown }) =>
      options.faculty === undefined ? null : options.faculty,
  );

  // Only the array form is modelled: the callback form would have to hand the
  // callback a client, which means referencing `prisma` inside its own
  // initialiser — a circular type under `noImplicitAny`.
  const prisma = {
    academicStructure: {
      findMany: structureFindMany,
      findUnique: structureFindUnique,
      create: structureCreate,
      update: structureUpdate,
    },
    academicYear: {
      upsert: yearUpsert,
      updateMany: yearUpdateMany,
      findMany: yearFindMany,
      create: yearCreate,
    },
    department: { findUnique: departmentFindUnique },
    faculty: { findUnique: facultyFindUnique },
    $transaction: jest.fn(async (operations: readonly unknown[]) => Promise.all(operations)),
  };

  // `remember` must actually invoke the producer, or every read test would
  // assert against an empty cache rather than the query.
  const redis = {
    remember: jest.fn(async (_key: string, _ttl: number, producer: () => Promise<unknown>) =>
      producer(),
    ),
    delByPattern: jest.fn(async (_pattern: string) => 0),
  };
  const audit = { record: jest.fn(async (_entry: Record<string, unknown>) => undefined) };

  const service = new CatalogService(prisma as never, redis as never, audit as never);

  return {
    service,
    prisma,
    audit,
    redis,
    structureFindMany,
    structureCreate,
    yearUpsert,
    yearUpdateMany,
    yearFindMany,
    structureFindUnique,
  };
}

describe('academicScopeKey', () => {
  it('names the most specific owner', () => {
    expect(academicScopeKey({ departmentId: 'd1', facultyId: null })).toBe('department:d1');
    expect(academicScopeKey({ facultyId: 'f1' })).toBe('faculty:f1');
    expect(academicScopeKey({ universityId: 'u1' })).toBe('university:u1');
  });

  it('falls back to the platform key when nothing is named', () => {
    // This is the string the unique index relies on. Were it derived as an
    // empty value, or omitted, two platform structures could coexist.
    expect(academicScopeKey({})).toBe(PLATFORM_SCOPE_KEY);
    expect(academicScopeKey({ universityId: null, facultyId: null, departmentId: null })).toBe(
      'platform',
    );
  });
});

describe('assertSingleAcademicOwner', () => {
  it('accepts one owner, or none', () => {
    expect(() => assertSingleAcademicOwner({})).not.toThrow();
    expect(() => assertSingleAcademicOwner({ facultyId: 'f1' })).not.toThrow();
    // Empty strings are not owners — a form that submits blanks must not be
    // read as naming three units.
    expect(() =>
      assertSingleAcademicOwner({ universityId: '', facultyId: 'f1', departmentId: '' }),
    ).not.toThrow();
  });

  it('rejects two owners', () => {
    expect(() => assertSingleAcademicOwner({ universityId: 'u1', facultyId: 'f1' })).toThrow();
  });
});

describe('resolving which structure governs a unit', () => {
  it('prefers the department’s own structure', async () => {
    const { service } = build({
      department: { facultyId: 'f1', faculty: { universityId: 'u1' } },
      structures: [
        { id: 'as_dept', kind: AcademicStructureKind.LEVEL, scopeKey: 'department:d1' },
        { id: 'as_fac', kind: AcademicStructureKind.YEAR, scopeKey: 'faculty:f1' },
        { id: 'as_plat', kind: AcademicStructureKind.YEAR, scopeKey: 'platform' },
      ],
    });

    await expect(service.resolveAcademicStructure({ departmentId: 'd1' })).resolves.toMatchObject({
      id: 'as_dept',
    });
  });

  it('inherits the faculty structure when the department has none', async () => {
    const { service } = build({
      department: { facultyId: 'f1', faculty: { universityId: 'u1' } },
      structures: [
        { id: 'as_fac', kind: AcademicStructureKind.LEVEL, scopeKey: 'faculty:f1' },
        { id: 'as_plat', kind: AcademicStructureKind.YEAR, scopeKey: 'platform' },
      ],
    });

    const resolved = await service.resolveAcademicStructure({ departmentId: 'd1' });
    expect(resolved).toMatchObject({ id: 'as_fac', kind: AcademicStructureKind.LEVEL });
  });

  it('falls all the way through to the platform structure', async () => {
    const { service } = build({
      department: { facultyId: 'f1', faculty: { universityId: 'u1' } },
      structures: [{ id: 'as_plat', kind: AcademicStructureKind.YEAR, scopeKey: 'platform' }],
    });

    await expect(service.resolveAcademicStructure({ departmentId: 'd1' })).resolves.toMatchObject({
      id: 'as_plat',
    });
  });

  it('resolves in one query rather than walking the hierarchy', async () => {
    // Four sequential round trips per registration-screen load would be a
    // real cost on a list this small; the candidates go in one `in` clause.
    const { service, structureFindMany } = build({
      department: { facultyId: 'f1', faculty: { universityId: 'u1' } },
      structures: [{ id: 'as_plat', kind: AcademicStructureKind.YEAR, scopeKey: 'platform' }],
    });

    await service.resolveAcademicStructure({ departmentId: 'd1' });

    expect(structureFindMany).toHaveBeenCalledTimes(1);
    const call = structureFindMany.mock.calls[0];
    if (!call) throw new Error('academicStructure.findMany was never called');
    const where = call[0].where as { scopeKey: { in: string[] } };
    expect(where.scopeKey.in).toEqual([
      'department:d1',
      'faculty:f1',
      'university:u1',
      'platform',
    ]);
  });

  it('answers null when no structure exists at all', async () => {
    const { service } = build({ structures: [] });
    await expect(service.resolveAcademicStructure({})).resolves.toBeNull();
  });
});

describe('the list a student picks from', () => {
  it('carries the structure’s kind so the UI can label it', async () => {
    // Without this the app has to infer "Year" or "Level" from the names,
    // which breaks the moment an Admin writes them in Arabic only.
    const { service } = build({
      structures: [{ id: 'as_fac', kind: AcademicStructureKind.LEVEL, scopeKey: 'faculty:f1' }],
      faculty: { universityId: 'u1' },
      entries: [
        { id: 'ay1', order: 1, name: 'Level 1', nameAr: 'المستوى الأول', isActive: true },
      ],
    });

    const list = await service.academicYears({ facultyId: 'f1' });
    expect(list).toEqual([
      expect.objectContaining({ order: 1, name: 'Level 1', kind: AcademicStructureKind.LEVEL }),
    ]);
  });

  it('is empty rather than throwing when a unit has no structure', async () => {
    const { service } = build({ structures: [] });
    await expect(service.academicYears({})).resolves.toEqual([]);
  });

  it('refuses a scope naming two units', async () => {
    const { service } = build();
    await expect(service.academicYears({ universityId: 'u1', facultyId: 'f1' })).rejects.toThrow();
  });
});

describe('creating a structure', () => {
  it('stores the derived scopeKey and the single owner', async () => {
    const { service, structureCreate } = build({ existingByScope: null });

    await service.createAcademicStructure(
      { kind: AcademicStructureKind.LEVEL, facultyId: 'f1' },
      ACTOR,
    );

    const call = structureCreate.mock.calls[0];
    if (!call) throw new Error('academicStructure.create was never called');
    expect(call[0].data).toMatchObject({
      kind: AcademicStructureKind.LEVEL,
      scopeKey: 'faculty:f1',
      facultyId: 'f1',
      universityId: null,
      departmentId: null,
    });
  });

  it('refuses a second structure for the same unit', async () => {
    // The unique index has the last word, but an Admin should get a field
    // error rather than a unique violation surfaced as a 500.
    const { service } = build({ existingByScope: { id: 'as_existing' } });
    await expect(
      service.createAcademicStructure({ kind: AcademicStructureKind.YEAR, facultyId: 'f1' }, ACTOR),
    ).rejects.toThrow();
  });

  it('records the creation in the audit trail', async () => {
    const { service, audit } = build({ existingByScope: null });
    await service.createAcademicStructure({ kind: AcademicStructureKind.YEAR }, ACTOR);
    expect(audit.record).toHaveBeenCalled();
  });
});

describe('defining the rungs', () => {
  const structure = {
    id: 'as_1',
    entries: [
      { id: 'ay1', order: 1 },
      { id: 'ay2', order: 2 },
      { id: 'ay3', order: 3 },
    ],
  };

  it('is not limited to four', async () => {
    // The count is the Admin's choice; nothing in the stack assumes four.
    const { service, yearUpsert } = build({ structureWithEntries: structure });
    const seven = Array.from({ length: 7 }, (_, i) => ({
      order: i + 1,
      name: `Level ${i + 1}`,
      nameAr: `المستوى ${i + 1}`,
    }));

    await service.replaceStructureEntries('as_1', seven, ACTOR);

    expect(yearUpsert).toHaveBeenCalledTimes(7);
  });

  it('upserts by (structureId, order) so a rename keeps the row', async () => {
    // Students and courses point at these ids. Renaming "Third Year" must not
    // replace the row, or every student filed under it loses their placement.
    const { service, yearUpsert } = build({ structureWithEntries: structure });

    await service.replaceStructureEntries(
      'as_1',
      [{ order: 3, name: 'Year Three', nameAr: 'الفرقة الثالثة' }],
      ACTOR,
    );

    const call = yearUpsert.mock.calls[0];
    if (!call) throw new Error('academicYear.upsert was never called');
    expect(call[0].where).toEqual({ structureId_order: { structureId: 'as_1', order: 3 } });
    expect(call[0].update).toMatchObject({ name: 'Year Three', isActive: true });
  });

  it('deactivates a removed rung instead of deleting it', async () => {
    // A delete would either fail on the foreign key or strip rows that point
    // at it. Deactivating keeps the history and hides it from the picker.
    const { service, yearUpdateMany } = build({ structureWithEntries: structure });

    await service.replaceStructureEntries(
      'as_1',
      [
        { order: 1, name: 'First', nameAr: 'الأولى' },
        { order: 2, name: 'Second', nameAr: 'الثانية' },
      ],
      ACTOR,
    );

    const call = yearUpdateMany.mock.calls[0];
    if (!call) throw new Error('academicYear.updateMany was never called');
    expect(call[0].where).toEqual({ id: { in: ['ay3'] } });
    expect(call[0].data).toEqual({ isActive: false });
  });

  it('reactivates a rung that comes back at the same order', async () => {
    const { service, yearUpsert } = build({ structureWithEntries: structure });

    await service.replaceStructureEntries(
      'as_1',
      [{ order: 2, name: 'Second Year', nameAr: 'الثانية' }],
      ACTOR,
    );

    const call = yearUpsert.mock.calls[0];
    if (!call) throw new Error('academicYear.upsert was never called');
    expect((call[0].update as { isActive: boolean }).isActive).toBe(true);
  });

  it('rejects two rungs sharing an order', async () => {
    const { service } = build({ structureWithEntries: structure });
    await expect(
      service.replaceStructureEntries(
        'as_1',
        [
          { order: 1, name: 'A', nameAr: 'أ' },
          { order: 1, name: 'B', nameAr: 'ب' },
        ],
        ACTOR,
      ),
    ).rejects.toThrow();
  });

  it('rejects a non-positive or fractional order', async () => {
    const { service } = build({ structureWithEntries: structure });
    await expect(
      service.replaceStructureEntries('as_1', [{ order: 0, name: 'A', nameAr: 'أ' }], ACTOR),
    ).rejects.toThrow();
    await expect(
      service.replaceStructureEntries('as_1', [{ order: 1.5, name: 'A', nameAr: 'أ' }], ACTOR),
    ).rejects.toThrow();
  });

  it('busts the catalogue cache, so the picker does not serve a stale list', async () => {
    const { service, redis } = build({ structureWithEntries: structure });
    await service.replaceStructureEntries('as_1', [{ order: 1, name: 'A', nameAr: 'أ' }], ACTOR);
    expect(redis.delByPattern).toHaveBeenCalledWith('catalog:*');
  });
});
