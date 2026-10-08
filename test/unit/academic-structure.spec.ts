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

/**
 * The exact field error a duplicate scoped structure produces. Asserted by
 * value rather than by regex because `AppException.validation` puts the text in
 * `fields` and leaves `message` as the generic "Request validation failed" —
 * matching on `message` would pass even if the wording regressed.
 */
const DUPLICATE_SCOPE_MESSAGE =
  'this unit already has an academic structure; edit that one instead';

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
  /**
   * The explicit faculty -> structure pin `academicStructureFaculty.findUnique`
   * answers with. Left `undefined` it means "no override stored", which is the
   * state every installation is in until an Admin creates one — so every
   * pre-existing test in this file still exercises the unchanged inheritance
   * path, which is the point.
   */
  facultyOverride?: {
    structure: {
      id: string;
      kind: AcademicStructureKind;
      scopeKey: string;
      isActive: boolean;
    };
  } | null;
  /** Live faculties `faculty.findMany` resolves, for override validation. */
  liveFaculties?: { id: string }[];
  /** The structure `setStructureFacultyOverrides` is editing. */
  structureWithOverrides?: {
    id: string;
    facultyOverrides: { facultyId: string }[];
  } | null;
}

function build(options: Options = {}) {
  // Named parameters throughout: a zero-arity `jest.fn(async () => …)` infers
  // an empty parameter tuple, which makes `mock.calls[0][0]` a type error
  // under `strict`.
  const structureFindMany = jest.fn(
    async (_args: { where: unknown; orderBy?: unknown; select: unknown }) =>
      options.structures ?? [],
  );
  // One mock, because the service reaches `academicStructure.findUnique` for
  // two different purposes: the duplicate-scope check (by scopeKey) and
  // loading the structure being edited (by id). Dispatching on the `where`
  // shape keeps both honest instead of having the second silently answer the
  // first's fixture.
  const structureFindUnique = jest.fn(
    async (args: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
      if ('scopeKey' in args.where) {
        return options.existingByScope === undefined ? null : options.existingByScope;
      }
      // Three callers now load a structure by id, and they want different
      // shapes. Dispatching on the requested `select` keeps each fixture
      // answering only its own question instead of one standing in for all.
      if (args.select && 'facultyOverrides' in args.select) {
        return options.structureWithOverrides === undefined
          ? null
          : options.structureWithOverrides;
      }
      return options.structureWithEntries === undefined ? null : options.structureWithEntries;
    },
  );
  // `scopeKey` is no longer a unique column — several platform-wide structures
  // may share the key — so the duplicate pre-check and the platform default
  // lookup both go through `findFirst`. Dispatching on the `where` shape keeps
  // this mock honest rather than letting it answer every question with the
  // same fixture.
  const structureFindFirst = jest.fn(
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
  const facultyFindMany = jest.fn(
    async (_args: { where: unknown; select: unknown }) => options.liveFaculties ?? [],
  );

  // The explicit faculty pin. `findUnique` is keyed on `facultyId`, which is
  // unique platform-wide precisely so this lookup has one answer.
  const overrideFindUnique = jest.fn(
    async (_args: { where: unknown; select: unknown }) =>
      options.facultyOverride === undefined ? null : options.facultyOverride,
  );
  const overrideDeleteMany = jest.fn(async (_args: { where: unknown }) => ({ count: 0 }));
  const overrideCreateMany = jest.fn(
    async (args: { data: readonly unknown[] }) => ({ count: args.data.length }),
  );

  // Only the array form is modelled: the callback form would have to hand the
  // callback a client, which means referencing `prisma` inside its own
  // initialiser — a circular type under `noImplicitAny`.
  const prisma = {
    academicStructure: {
      findMany: structureFindMany,
      findUnique: structureFindUnique,
      findFirst: structureFindFirst,
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
    faculty: { findUnique: facultyFindUnique, findMany: facultyFindMany },
    academicStructureFaculty: {
      findUnique: overrideFindUnique,
      deleteMany: overrideDeleteMany,
      createMany: overrideCreateMany,
    },
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
    structureFindFirst,
    facultyFindMany,
    overrideFindUnique,
    overrideDeleteMany,
    overrideCreateMany,
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

/**
 * The rule change: several platform-wide structures may coexist.
 *
 * This used to 422 with "this unit already has an academic structure; edit that
 * one instead". It was rejected twice over — by the service's duplicate
 * pre-check and by a blanket UNIQUE index on `scopeKey`, which every
 * platform-wide row shares. Only the platform scope changed: a university,
 * faculty or department still gets exactly one structure.
 *
 * The tests below drive the same mock the other cases use, with
 * `existingByScope` standing in for "a row with that key is already in the
 * table". For the platform cases that row is present and the create must still
 * succeed — which is the regression, since it previously threw.
 */
describe('several platform-wide structures may coexist', () => {
  const platformWide = { kind: AcademicStructureKind.YEAR };

  it('creates the first platform-wide structure', async () => {
    const { service, structureCreate } = build({ existingByScope: null });

    const created = await service.createAcademicStructure(platformWide, ACTOR);

    expect(created).toMatchObject({ scopeKey: PLATFORM_SCOPE_KEY });
    const call = structureCreate.mock.calls[0];
    if (!call) throw new Error('academicStructure.create was never called');
    expect(call[0].data).toMatchObject({
      scopeKey: PLATFORM_SCOPE_KEY,
      universityId: null,
      facultyId: null,
      departmentId: null,
    });
  });

  it('creates a second platform-wide structure even though one already exists', async () => {
    // The regression. `existingByScope` says the table already holds a platform
    // row; before the change this threw HTTP 422.
    const { service, structureCreate } = build({ existingByScope: { id: 'as_platform_1' } });

    const created = await service.createAcademicStructure(platformWide, ACTOR);

    expect(created).toMatchObject({ scopeKey: PLATFORM_SCOPE_KEY });
    expect(structureCreate).toHaveBeenCalledTimes(1);
  });

  it('creates a third platform-wide structure too', async () => {
    const { service, structureCreate } = build({ existingByScope: { id: 'as_platform_2' } });

    await expect(service.createAcademicStructure(platformWide, ACTOR)).resolves.toMatchObject({
      scopeKey: PLATFORM_SCOPE_KEY,
    });
    expect(structureCreate).toHaveBeenCalledTimes(1);
  });

  it('does not even ask the database whether a platform structure exists', async () => {
    // Proof that the fix is in the service and not a coincidence of the mock:
    // the duplicate pre-check is skipped outright for the platform scope, so a
    // row already holding that key cannot cause a rejection.
    const { service, structureFindFirst } = build({ existingByScope: { id: 'as_platform_1' } });

    await service.createAcademicStructure(platformWide, ACTOR);

    const platformLookups = structureFindFirst.mock.calls.filter((call) => {
      const where = (call[0] as { where: { scopeKey?: unknown } }).where;
      return where.scopeKey === PLATFORM_SCOPE_KEY;
    });
    expect(platformLookups).toHaveLength(0);
  });

  it('still refuses a second structure for a university', async () => {
    const { service, structureCreate } = build({ existingByScope: { id: 'as_uni' } });

    await expect(
      service.createAcademicStructure(
        { kind: AcademicStructureKind.YEAR, universityId: 'u1' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ fields: { scope: [DUPLICATE_SCOPE_MESSAGE] } });
    expect(structureCreate).not.toHaveBeenCalled();
  });

  it('still refuses a second structure for a faculty', async () => {
    const { service, structureCreate } = build({ existingByScope: { id: 'as_fac' } });

    await expect(
      service.createAcademicStructure({ kind: AcademicStructureKind.LEVEL, facultyId: 'f1' }, ACTOR),
    ).rejects.toMatchObject({ fields: { scope: [DUPLICATE_SCOPE_MESSAGE] } });
    expect(structureCreate).not.toHaveBeenCalled();
  });

  it('still refuses a second structure for a department', async () => {
    const { service, structureCreate } = build({ existingByScope: { id: 'as_dept' } });

    await expect(
      service.createAcademicStructure(
        { kind: AcademicStructureKind.YEAR, departmentId: 'd1' },
        ACTOR,
      ),
    ).rejects.toMatchObject({ fields: { scope: [DUPLICATE_SCOPE_MESSAGE] } });
    expect(structureCreate).not.toHaveBeenCalled();
  });

  it('still allows a first structure for each scoped unit', async () => {
    // The counterpart to the cases above: relaxing the platform scope must not
    // have relaxed anything else.
    for (const scope of [{ universityId: 'u1' }, { facultyId: 'f1' }, { departmentId: 'd1' }]) {
      const { service, structureCreate } = build({ existingByScope: null });
      await expect(
        service.createAcademicStructure({ kind: AcademicStructureKind.YEAR, ...scope }, ACTOR),
      ).resolves.toBeDefined();
      expect(structureCreate).toHaveBeenCalledTimes(1);
    }
  });

  it('still rejects a scope naming two owners', async () => {
    // Untouched by this change, and worth pinning: allowing multiple
    // platform-wide structures must not weaken the single-owner rule.
    const { service, structureCreate } = build({ existingByScope: null });
    await expect(
      service.createAcademicStructure(
        { kind: AcademicStructureKind.YEAR, universityId: 'u1', facultyId: 'f1' },
        ACTOR,
      ),
    ).rejects.toMatchObject({
      fields: {
        scope: ['an academic structure belongs to one unit: a university, a faculty or a department'],
      },
    });
    expect(structureCreate).not.toHaveBeenCalled();
  });

  it('resolves the oldest platform structure as the inherited fallback', async () => {
    // Several platform rows now match the fallback key, so resolution has to be
    // ordered or the inherited ladder could differ between two identical calls.
    const { service, structureFindMany } = build({
      structures: [{ id: 'as_plat', kind: AcademicStructureKind.YEAR, scopeKey: 'platform' }],
    });

    await service.resolveAcademicStructure({});

    const call = structureFindMany.mock.calls[0];
    if (!call) throw new Error('academicStructure.findMany was never called');
    expect(call[0].orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
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

/**
 * Explicit faculty overrides.
 *
 * The feature exists because inheritance alone cannot say "this faculty,
 * wherever it sits, uses THAT ladder". Four properties are worth pinning,
 * because each is a way the override could look finished and be wrong:
 *
 *   1. The override must BEAT the university ladder — otherwise it is a no-op
 *      for the only case anyone would use it for.
 *   2. It must work ACROSS universities. The whole request was to pin
 *      University A's college to University B's ladder, and a same-university
 *      guard would quietly forbid exactly that.
 *   3. It must not fire when nothing is pinned, or every installation's
 *      current behaviour changes the moment this code ships.
 *   4. A deactivated target must fall through, not strand the faculty with an
 *      empty year list.
 */
describe('resolveAcademicStructure — explicit faculty overrides', () => {
  const UNIVERSITY_LADDER = {
    id: 'as_univ_a',
    kind: AcademicStructureKind.YEAR,
    scopeKey: 'university:u_a',
  };
  const PLATFORM_LADDER = {
    id: 'as_platform',
    kind: AcademicStructureKind.YEAR,
    scopeKey: PLATFORM_SCOPE_KEY,
  };

  it('prefers the pinned structure over the faculty\'s own university ladder', async () => {
    const { service } = build({
      faculty: { universityId: 'u_a' },
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
      facultyOverride: {
        structure: {
          id: 'as_univ_b',
          kind: AcademicStructureKind.LEVEL,
          scopeKey: 'university:u_b',
          isActive: true,
        },
      },
    });

    const resolved = await service.resolveAcademicStructure({ facultyId: 'f_x' });

    // Without the override this would be `as_univ_a`: that is the assertion.
    expect(resolved?.id).toBe('as_univ_b');
    expect(resolved?.kind).toBe(AcademicStructureKind.LEVEL);
  });

  it('pins a faculty to a ladder owned by a DIFFERENT university', async () => {
    // Faculty X belongs to University A; the pinned ladder belongs to B. The
    // resolver must not care, and must not consult A at all.
    const { service } = build({
      faculty: { universityId: 'u_a' },
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
      facultyOverride: {
        structure: {
          id: 'as_univ_b',
          kind: AcademicStructureKind.YEAR,
          scopeKey: 'university:u_b',
          isActive: true,
        },
      },
    });

    const resolved = await service.resolveAcademicStructure({ facultyId: 'f_x' });
    expect(resolved?.scopeKey).toBe('university:u_b');
  });

  it('pins a faculty to a platform-wide ladder', async () => {
    const { service } = build({
      faculty: { universityId: 'u_a' },
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
      facultyOverride: {
        structure: {
          id: 'as_global',
          kind: AcademicStructureKind.LEVEL,
          scopeKey: PLATFORM_SCOPE_KEY,
          isActive: true,
        },
      },
    });

    // Note this is a *different* platform row from the one inheritance would
    // have reached, so the id is what proves the override was honoured.
    const resolved = await service.resolveAcademicStructure({ facultyId: 'f_x' });
    expect(resolved?.id).toBe('as_global');
  });

  it('leaves inheritance untouched when the faculty is not pinned', async () => {
    // The state of every existing installation. If this regresses, shipping the
    // feature changes answers for data nobody edited.
    const { service, overrideFindUnique } = build({
      faculty: { universityId: 'u_a' },
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
    });

    const resolved = await service.resolveAcademicStructure({ facultyId: 'f_x' });

    expect(resolved?.id).toBe('as_univ_a');
    expect(overrideFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { facultyId: 'f_x' } }),
    );
  });

  it('falls back to inheritance when the pinned structure is deactivated', async () => {
    const { service } = build({
      faculty: { universityId: 'u_a' },
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
      facultyOverride: {
        structure: {
          id: 'as_univ_b',
          kind: AcademicStructureKind.YEAR,
          scopeKey: 'university:u_b',
          isActive: false,
        },
      },
    });

    const resolved = await service.resolveAcademicStructure({ facultyId: 'f_x' });
    expect(resolved?.id).toBe('as_univ_a');
  });

  it('applies the faculty\'s override to that faculty\'s departments', async () => {
    const { service, overrideFindUnique } = build({
      department: { facultyId: 'f_x', faculty: { universityId: 'u_a' } },
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
      facultyOverride: {
        structure: {
          id: 'as_univ_b',
          kind: AcademicStructureKind.YEAR,
          scopeKey: 'university:u_b',
          isActive: true,
        },
      },
    });

    const resolved = await service.resolveAcademicStructure({ departmentId: 'd_1' });

    expect(resolved?.id).toBe('as_univ_b');
    expect(overrideFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { facultyId: 'f_x' } }),
    );
  });

  it("preserves the department ladder when its faculty has an override", async () => {
    // The override sits above every inherited level, including a department
    // that has its own structure. `assertAcademicYearBelongsToStructure`
    // resolves a course's ladder from its first department and relies on
    // departments under one college sharing a ladder; if the department's own
    // structure won here, a course targeted at the college and a course
    // targeted at one of its departments would land on different year lists.
    const { service } = build({
      department: { facultyId: 'f_x', faculty: { universityId: 'u_a' } },
      structures: [
        { id: 'as_dept', kind: AcademicStructureKind.YEAR, scopeKey: 'department:d_1' },
        UNIVERSITY_LADDER,
        PLATFORM_LADDER,
      ],
      facultyOverride: {
        structure: {
          id: 'as_univ_b',
          kind: AcademicStructureKind.YEAR,
          scopeKey: 'university:u_b',
          isActive: true,
        },
      },
    });

    const resolved = await service.resolveAcademicStructure({ departmentId: 'd_1' });
    expect(resolved?.id).toBe('as_dept');
  });

  it("still gives a department's own ladder priority when no override exists", async () => {
    // The demotion above must be caused by the pin and nothing else: with no
    // override stored, department -> faculty -> university -> platform is
    // untouched. This is the case every existing installation is in.
    const { service } = build({
      department: { facultyId: 'f_x', faculty: { universityId: 'u_a' } },
      structures: [
        { id: 'as_dept', kind: AcademicStructureKind.YEAR, scopeKey: 'department:d_1' },
        UNIVERSITY_LADDER,
        PLATFORM_LADDER,
      ],
    });

    const resolved = await service.resolveAcademicStructure({ departmentId: 'd_1' });
    expect(resolved?.id).toBe('as_dept');
  });

  it("falls back to the department's own ladder when the pinned one is inactive", async () => {
    const { service } = build({
      department: { facultyId: 'f_x', faculty: { universityId: 'u_a' } },
      structures: [
        { id: 'as_dept', kind: AcademicStructureKind.YEAR, scopeKey: 'department:d_1' },
        UNIVERSITY_LADDER,
        PLATFORM_LADDER,
      ],
      facultyOverride: {
        structure: {
          id: 'as_univ_b',
          kind: AcademicStructureKind.YEAR,
          scopeKey: 'university:u_b',
          isActive: false,
        },
      },
    });

    const resolved = await service.resolveAcademicStructure({ departmentId: 'd_1' });
    expect(resolved?.id).toBe('as_dept');
  });

  it('never consults the override table for a university-only scope', async () => {
    // A university is not a faculty; looking one up would be a wasted query and
    // a sign the scope handling had blurred.
    const { service, overrideFindUnique } = build({
      structures: [UNIVERSITY_LADDER, PLATFORM_LADDER],
    });

    await service.resolveAcademicStructure({ universityId: 'u_a' });
    expect(overrideFindUnique).not.toHaveBeenCalled();
  });
});

describe('setStructureFacultyOverrides', () => {
  const structure = { id: 'as_1', facultyOverrides: [{ facultyId: 'f_old' }] };

  it('replaces the whole set and releases faculties pinned elsewhere', async () => {
    const { service, overrideDeleteMany, overrideCreateMany } = build({
      structureWithOverrides: structure,
      liveFaculties: [{ id: 'f_a' }, { id: 'f_b' }],
    });

    await service.setStructureFacultyOverrides('as_1', ['f_a', 'f_b'], ACTOR);

    // Two deletes, in this order: drop this structure's unwanted rows, then
    // release the wanted ids from whichever structure holds them — so the
    // insert cannot collide with the unique index.
    expect(overrideDeleteMany).toHaveBeenCalledTimes(2);
    expect(overrideDeleteMany.mock.calls[0]?.[0].where).toEqual({
      structureId: 'as_1',
      facultyId: { notIn: ['f_a', 'f_b'] },
    });
    expect(overrideDeleteMany.mock.calls[1]?.[0].where).toEqual({
      facultyId: { in: ['f_a', 'f_b'] },
    });
    expect(overrideCreateMany.mock.calls[0]?.[0].data).toEqual([
      { structureId: 'as_1', facultyId: 'f_a' },
      { structureId: 'as_1', facultyId: 'f_b' },
    ]);
  });

  it('clears every override when given an empty list', async () => {
    const { service, overrideDeleteMany, overrideCreateMany } = build({
      structureWithOverrides: structure,
    });

    await service.setStructureFacultyOverrides('as_1', [], ACTOR);

    // An unqualified `structureId` delete, not `notIn: []` — whose meaning for
    // an empty array is a Prisma implementation detail rather than a contract.
    expect(overrideDeleteMany.mock.calls[0]?.[0].where).toEqual({ structureId: 'as_1' });
    expect(overrideCreateMany.mock.calls[0]?.[0].data).toEqual([]);
  });

  it('de-duplicates repeated ids rather than tripping the unique index', async () => {
    const { service, overrideCreateMany } = build({
      structureWithOverrides: structure,
      liveFaculties: [{ id: 'f_a' }],
    });

    await service.setStructureFacultyOverrides('as_1', ['f_a', 'f_a', ''], ACTOR);

    expect(overrideCreateMany.mock.calls[0]?.[0].data).toEqual([
      { structureId: 'as_1', facultyId: 'f_a' },
    ]);
  });

  it('rejects an unknown faculty with a field error, not a foreign-key 500', async () => {
    const { service, overrideCreateMany } = build({
      structureWithOverrides: structure,
      liveFaculties: [{ id: 'f_a' }],
    });

    await expect(
      service.setStructureFacultyOverrides('as_1', ['f_a', 'f_missing'], ACTOR),
    ).rejects.toThrow();
    expect(overrideCreateMany).not.toHaveBeenCalled();
  });

  it('404s for a structure that does not exist', async () => {
    const { service } = build({ structureWithOverrides: null });
    await expect(
      service.setStructureFacultyOverrides('as_nope', ['f_a'], ACTOR),
    ).rejects.toThrow();
  });

  it('busts the catalogue cache so the year picker reflects the new pin', async () => {
    const { service, redis } = build({
      structureWithOverrides: structure,
      liveFaculties: [{ id: 'f_a' }],
    });

    await service.setStructureFacultyOverrides('as_1', ['f_a'], ACTOR);
    expect(redis.delByPattern).toHaveBeenCalledWith('catalog:*');
  });

  it('records the before and after sets, so a move between ladders is traceable', async () => {
    const { service, audit } = build({
      structureWithOverrides: structure,
      liveFaculties: [{ id: 'f_a' }],
    });

    await service.setStructureFacultyOverrides('as_1', ['f_a'], ACTOR);

    const entry = audit.record.mock.calls[0]?.[0] as {
      before: { facultyOverrides: string[] };
      after: { facultyOverrides: string[] };
    };
    expect(entry.before.facultyOverrides).toEqual(['f_old']);
    expect(entry.after.facultyOverrides).toEqual(['f_a']);
  });
});
