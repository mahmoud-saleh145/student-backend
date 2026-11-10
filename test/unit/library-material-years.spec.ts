import { ContentStatus, LibraryDepartmentScope, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { LibraryService, academicYearFilter } from '../../src/modules/library/library.service';
import { openEligibility, catalogDouble } from './helpers/library-eligibility-double';

/**
 * A material filed under several years/levels, and its cover image.
 *
 * Years:
 *   * `academicYearIds` is the audience; the legacy `academicYearId` column is
 *     kept equal to the FIRST rung in ladder order so every reader deployed
 *     today still sees a year;
 *   * a client that still sends the single `academicYearId` gets a one-year
 *     material, and `null` clears the years;
 *   * every rung is checked against the ladder, and a refusal names
 *     `academicYearIds`, the field the client sent;
 *   * the whole-audience rule treats the years as sent in either spelling;
 *   * the browse filter matches the rung OR "all years", in its own AND branch.
 *
 * Cover:
 *   * the key must come from the library image namespace (creation) or this
 *     material's own namespace (edit) — it feeds a public URL;
 *   * the object must exist and be within the image limit before the row
 *     points at it;
 *   * a replaced or cleared cover is deleted from storage, best-effort, and
 *     only when it sits in this material's own cover namespace.
 */

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

/** The YEAR ladder, in order: y1 is the first rung, y3 the last. */
const LADDER: Record<string, number> = { y1: 1, y2: 2, y3: 3 };

function build(
  before: Partial<{
    academicYears: { academicYearId: string }[];
    coverKey: string | null;
    status: ContentStatus;
  }> = {},
) {
  const material = {
    id: 'mat_1',
    title: 'Physics Revision Papers',
    status: before.status ?? ContentStatus.DRAFT,
    isActive: true,
    publishedAt: null as Date | null,
    deletedAt: null,
    universityId: 'uni_1',
    facultyId: 'fac_1',
    departmentScope: LibraryDepartmentScope.FACULTY,
    academicYearId: before.academicYears?.[0]?.academicYearId ?? null,
    coverKey: before.coverKey ?? null,
    departments: [] as { departmentId: string }[],
    academicYears: before.academicYears ?? [],
  };

  const create = jest.fn(async (args: { data: Record<string, unknown> }) => ({
    ...material,
    ...args.data,
    id: 'mat_new',
  }));
  const update = jest.fn(async (_args: { where: unknown; data: Record<string, unknown> }) => ({
    ...material,
  }));
  const findFirst = jest.fn(async (_args: { where: Record<string, unknown> }) => material);
  const findMany = jest.fn(async (_args: { where: Record<string, unknown> }) => [] as never[]);
  const count = jest.fn(async (_args: { where: Record<string, unknown> }) => 0);

  const yearLinks = {
    deleteMany: jest.fn(async (_args: { where: Record<string, unknown> }) => ({ count: 0 })),
    createMany: jest.fn(async (_args: { data: unknown[]; skipDuplicates?: boolean }) => ({
      count: 0,
    })),
  };

  const prisma: Record<string, unknown> = {
    libraryMaterial: { findFirst, create, update, findMany, count },
    libraryEntitlement: { findMany: jest.fn(async () => []) },
    libraryMaterialDepartment: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      createMany: jest.fn(async () => ({ count: 0 })),
    },
    libraryMaterialAcademicYear: yearLinks,
    university: { findFirst: jest.fn(async () => ({ id: 'uni_1', isActive: true })) },
    faculty: {
      findFirst: jest.fn(async () => ({ id: 'fac_1', universityId: 'uni_1', isActive: true })),
    },
    department: { findMany: jest.fn(async () => []) },
    academicYear: {
      // The ladder check: a rung exists only if it is on the YEAR ladder.
      findFirst: jest.fn(async (args: { where: { id: string } }) =>
        LADDER[args.where.id] ? { id: args.where.id } : null,
      ),
      // Ladder order, for the legacy column.
      findMany: jest.fn(async (args: { where: { id: { in: string[] } } }) =>
        args.where.id.in
          .filter((id) => LADDER[id])
          .map((id) => ({ id, order: LADDER[id] }))
          .sort((a, b) => a.order - b.order),
      ),
    },
  };
  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as readonly unknown[]),
  );

  const audit = { record: jest.fn(async (_entry: Record<string, unknown>) => undefined) };
  const storage = {
    publicAssetUrl: jest.fn(async () => null),
    signMediaUrl: jest.fn(),
    assertUploadWithinLimit: jest.fn(
      async (_p: { bucket: string; objectKey: string; maxBytes: number; field?: string }) => 1024,
    ),
    deleteObject: jest.fn(async (_bucket: string, _key: string) => undefined),
  };
  const settings = { libraryDefaultThumbnailKey: jest.fn(async () => null) };

  const service = new LibraryService(
    prisma as never,
    audit as never,
    storage as never,
    settings as never,
    openEligibility() as never,
    catalogDouble() as never,
  );
  jest.spyOn(service, 'materialForAdmin').mockImplementation(async () => material as never);

  return { service, prisma, storage, material, create, update, findMany, yearLinks };
}

const written = (fn: jest.Mock): Record<string, unknown> => {
  const call = fn.mock.calls[0];
  if (!call) throw new Error('never called');
  return (call[0] as { data: Record<string, unknown> }).data;
};

const WHOLE_FACULTY = {
  universityId: 'uni_1',
  facultyId: 'fac_1',
  departmentScope: LibraryDepartmentScope.FACULTY,
  departmentIds: [] as string[],
};

async function refusal(promise: Promise<unknown>): Promise<AppException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

describe('creating a material with several years', () => {
  it('links every rung and mirrors the first one, in ladder order, into the legacy column', async () => {
    const { service, create, yearLinks } = build();

    await service.createMaterial(
      { title: 'Statics', ...WHOLE_FACULTY, academicYearIds: ['y3', 'y1', 'y3'] },
      ADMIN,
    );

    // y3 was sent first; the legacy column still names the lowest rung.
    expect(written(create).academicYearId).toBe('y1');
    expect(yearLinks.createMany).toHaveBeenCalledTimes(1);
    expect(yearLinks.createMany.mock.calls[0]?.[0].data).toEqual([
      { materialId: 'mat_new', academicYearId: 'y3' },
      { materialId: 'mat_new', academicYearId: 'y1' },
    ]);
  });

  it('still accepts the single legacy academicYearId as a one-year material', async () => {
    const { service, create, yearLinks } = build();

    await service.createMaterial({ title: 'Statics', ...WHOLE_FACULTY, academicYearId: 'y2' }, ADMIN);

    expect(written(create).academicYearId).toBe('y2');
    expect(yearLinks.createMany.mock.calls[0]?.[0].data).toEqual([
      { materialId: 'mat_new', academicYearId: 'y2' },
    ]);
  });

  it('the list wins over the legacy id when both are sent', async () => {
    const { service, create, yearLinks } = build();

    await service.createMaterial(
      { title: 'Statics', ...WHOLE_FACULTY, academicYearId: 'y3', academicYearIds: ['y1', 'y2'] },
      ADMIN,
    );

    expect(written(create).academicYearId).toBe('y1');
    expect(yearLinks.createMany.mock.calls[0]?.[0].data).toHaveLength(2);
  });

  it('no years at all means "all years": no links, a null legacy column', async () => {
    const { service, create, yearLinks, prisma } = build();

    await service.createMaterial({ title: 'Statics', ...WHOLE_FACULTY }, ADMIN);

    expect(written(create).academicYearId).toBeNull();
    expect(yearLinks.createMany).not.toHaveBeenCalled();
    // Nothing to order, so the ladder is not even read.
    expect((prisma.academicYear as { findMany: jest.Mock }).findMany).not.toHaveBeenCalled();
  });

  it('refuses a rung that is not on the ladder, naming academicYearIds', async () => {
    const { service, create } = build();

    const error = await refusal(
      service.createMaterial(
        { title: 'Statics', ...WHOLE_FACULTY, academicYearIds: ['y1', 'level_0'] },
        ADMIN,
      ),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(error.fields).toHaveProperty('academicYearIds');
    expect(error.fields).not.toHaveProperty('academicYearId');
    expect(create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe('editing the years of a material', () => {
  it('years alone are a partial audience, and the refusal names the four missing keys', async () => {
    const { service, update } = build({ academicYears: [{ academicYearId: 'y1' }] });

    const error = await refusal(
      service.updateMaterial('mat_1', { academicYearIds: ['y1', 'y2'] }, ADMIN),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(Object.keys(error.fields ?? {}).sort()).toEqual([
      'departmentIds',
      'departmentScope',
      'facultyId',
      'universityId',
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('the legacy single id also counts as the years being sent', async () => {
    const { service } = build();

    const error = await refusal(service.updateMaterial('mat_1', { academicYearId: 'y1' }, ADMIN));

    expect(Object.keys(error.fields ?? {})).not.toContain('academicYearIds');
    expect(Object.keys(error.fields ?? {})).toContain('universityId');
  });

  it('a whole audience replaces the links: stale ones leave, new ones arrive, the legacy column follows', async () => {
    const { service, update, yearLinks } = build({ academicYears: [{ academicYearId: 'y1' }] });

    await service.updateMaterial(
      'mat_1',
      { ...WHOLE_FACULTY, academicYearIds: ['y3', 'y2'] },
      ADMIN,
    );

    expect(yearLinks.deleteMany).toHaveBeenCalledWith({
      where: { materialId: 'mat_1', academicYearId: { notIn: ['y3', 'y2'] } },
    });
    expect(yearLinks.createMany).toHaveBeenCalledWith({
      data: [
        { materialId: 'mat_1', academicYearId: 'y3' },
        { materialId: 'mat_1', academicYearId: 'y2' },
      ],
      skipDuplicates: true,
    });
    expect(written(update).academicYearId).toBe('y2');
  });

  it('a null legacy id with the rest of the audience clears every year', async () => {
    const { service, update, yearLinks } = build({
      academicYears: [{ academicYearId: 'y1' }, { academicYearId: 'y2' }],
    });

    await service.updateMaterial('mat_1', { ...WHOLE_FACULTY, academicYearId: null }, ADMIN);

    expect(yearLinks.deleteMany).toHaveBeenCalledWith({
      where: { materialId: 'mat_1', academicYearId: { notIn: [] } },
    });
    expect(yearLinks.createMany).not.toHaveBeenCalled();
    expect(written(update).academicYearId).toBeNull();
  });

  it('a title-only edit leaves the links and the legacy column alone', async () => {
    const { service, update, yearLinks } = build({ academicYears: [{ academicYearId: 'y1' }] });

    await service.updateMaterial('mat_1', { title: 'Renamed' }, ADMIN);

    expect(yearLinks.deleteMany).not.toHaveBeenCalled();
    expect(yearLinks.createMany).not.toHaveBeenCalled();
    expect(Object.keys(written(update))).toEqual(['title']);
  });

  it('publishing re-validates every stored year, not just the first', async () => {
    const { service, update } = build({
      academicYears: [{ academicYearId: 'y1' }, { academicYearId: 'gone' }],
    });

    const error = await refusal(
      service.updateMaterial('mat_1', { status: ContentStatus.PUBLISHED }, ADMIN),
    );

    expect(error.fields).toHaveProperty('academicYearIds');
    expect(update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe('the year/level filter', () => {
  it('matches a material filed under the rung, or under no rung at all', () => {
    expect(academicYearFilter('y1')).toEqual({
      OR: [
        { academicYears: { some: { academicYearId: 'y1' } } },
        { academicYears: { none: {} } },
      ],
    });
  });

  it('is its own AND branch of the admin list, beside the search', async () => {
    const { service, findMany } = build();

    await service.listForAdmin({ page: 1, pageSize: 20, q: 'stat', academicYearId: 'y2' });

    const where = findMany.mock.calls[0]?.[0].where as { AND: unknown[] };
    expect(where.AND).toEqual(
      expect.arrayContaining([
        academicYearFilter('y2'),
        expect.objectContaining({ OR: expect.any(Array) }),
      ]),
    );
  });

  it('is absent from the admin list when no rung is asked for', async () => {
    const { service, findMany } = build();

    await service.listForAdmin({ page: 1, pageSize: 20 });

    const where = findMany.mock.calls[0]?.[0].where as { AND: unknown[] };
    expect(JSON.stringify(where)).not.toContain('academicYears');
  });
});

// ---------------------------------------------------------------------------
// Cover image
// ---------------------------------------------------------------------------

describe('the material cover', () => {
  it('on creation, accepts a key from the library image namespace once the object is verified', async () => {
    const { service, create, storage } = build();

    await service.createMaterial(
      { title: 'Statics', ...WHOLE_FACULTY, coverKey: 'thumbnails/library/mat_new/cover/9f2c.png' },
      ADMIN,
    );

    expect(storage.assertUploadWithinLimit).toHaveBeenCalledWith({
      bucket: 'media',
      objectKey: 'thumbnails/library/mat_new/cover/9f2c.png',
      maxBytes: 10 * 1024 * 1024,
      field: 'coverKey',
    });
    expect(written(create).coverKey).toBe('thumbnails/library/mat_new/cover/9f2c.png');
  });

  it.each([
    'hls/vid_1/360p/index.m3u8',
    'library/9f2c.pdf',
    'thumbnails/courses/crs_1/9f2c.png',
    'avatars/usr_1/9f2c.png',
    'https://example.com/cover.png',
  ])('refuses %s as a cover and writes nothing', async (coverKey) => {
    const { service, create, storage } = build();

    const error = await refusal(
      service.createMaterial({ title: 'Statics', ...WHOLE_FACULTY, coverKey }, ADMIN),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(create).not.toHaveBeenCalled();
    expect(storage.assertUploadWithinLimit).not.toHaveBeenCalled();
  });

  it('on edit, the key must belong to THIS material', async () => {
    const { service, update } = build();

    const error = await refusal(
      service.updateMaterial(
        'mat_1',
        { coverKey: 'thumbnails/library/mat_other/cover/9f2c.png' },
        ADMIN,
      ),
    );

    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(update).not.toHaveBeenCalled();
  });

  it('an upload that never landed is refused before the row points at it', async () => {
    const { service, update, storage } = build();
    storage.assertUploadWithinLimit.mockRejectedValueOnce(
      new AppException(ErrorCode.UPLOAD_FAILED, { fields: { coverKey: ['not found in storage'] } }),
    );

    const error = await refusal(
      service.updateMaterial('mat_1', { coverKey: 'thumbnails/library/mat_1/cover/9f2c.png' }, ADMIN),
    );

    expect(error.code).toBe(ErrorCode.UPLOAD_FAILED);
    expect(update).not.toHaveBeenCalled();
  });

  it('replacing the cover deletes the previous object from this material’s cover namespace', async () => {
    const { service, storage } = build({ coverKey: 'thumbnails/library/mat_1/cover/old.png' });

    await service.updateMaterial(
      'mat_1',
      { coverKey: 'thumbnails/library/mat_1/cover/new.png' },
      ADMIN,
    );

    expect(storage.deleteObject).toHaveBeenCalledWith('media', 'thumbnails/library/mat_1/cover/old.png');
  });

  it('clearing the cover (null) deletes it too, and is persisted as null', async () => {
    const { service, storage, update } = build({ coverKey: 'thumbnails/library/mat_1/cover/old.png' });

    await service.updateMaterial('mat_1', { coverKey: null }, ADMIN);

    expect(written(update).coverKey).toBeNull();
    expect(storage.deleteObject).toHaveBeenCalledWith('media', 'thumbnails/library/mat_1/cover/old.png');
    expect(storage.assertUploadWithinLimit).not.toHaveBeenCalled();
  });

  it('writing the same key back neither re-verifies nor deletes anything', async () => {
    const { service, storage } = build({ coverKey: 'thumbnails/library/mat_1/cover/old.png' });

    await service.updateMaterial(
      'mat_1',
      { coverKey: 'thumbnails/library/mat_1/cover/old.png' },
      ADMIN,
    );

    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(storage.assertUploadWithinLimit).not.toHaveBeenCalled();
  });

  it('an edit that does not mention the cover leaves the object alone', async () => {
    const { service, storage } = build({ coverKey: 'thumbnails/library/mat_1/cover/old.png' });

    await service.updateMaterial('mat_1', { title: 'Renamed' }, ADMIN);

    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('never deletes a previous key outside this material’s cover namespace', async () => {
    // A part thumbnail re-used as the cover is a valid key, but it is the
    // part's object: clearing the cover must not take the part's image away.
    const { service, storage } = build({ coverKey: 'thumbnails/library/mat_1/parts/lp_1/x.png' });

    await service.updateMaterial('mat_1', { coverKey: null }, ADMIN);

    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it('a storage failure while discarding never fails the edit', async () => {
    const { service, storage, update } = build({ coverKey: 'thumbnails/library/mat_1/cover/old.png' });
    storage.deleteObject.mockRejectedValueOnce(new Error('R2 down'));

    await expect(service.updateMaterial('mat_1', { coverKey: null }, ADMIN)).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });
});
