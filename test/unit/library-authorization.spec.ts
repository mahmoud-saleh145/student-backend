import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { ContentStatus, LibraryDepartmentScope, LibraryPurchaseKind, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { LibraryDocumentsService } from '../../src/modules/library/library-documents.service';
import { LibraryEligibilityService } from '../../src/modules/library/library-eligibility.service';
import { LibraryPurchaseService } from '../../src/modules/library/library-purchase.service';
import { LibraryService } from '../../src/modules/library/library.service';
import { PlaybackService } from '../../src/modules/playback/playback.service';

import { allowDrm } from './helpers/drm-doubles';

/**
 * The Library authorization matrix, end to end through the real services and
 * the REAL eligibility rules, over one in-memory world.
 *
 *   Visibility  university + faculty + department scope (+ publication, + storefront)
 *   Ownership   unrevoked entitlement — the read-only exception, per material
 *   Purchase    visibility, never ownership; refused before any debit
 *   Reading     owned (`lib_`) or eligible preview (`libp_`), per part
 *
 * Mansoura's "Faculty of Engineering (General)" stands in for the real case.
 */

const UNI = 'uni_mans';
const FAC = 'fac_gen';
const OTHER_FAC = 'fac_prog';

interface Entitlement {
  userId: string;
  libraryPartId: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

interface World {
  storefront: boolean;
  profile: { universityId: string | null; facultyId: string | null; departmentId: string | null } | null;
  material: Record<string, unknown> & {
    id: string;
    status: ContentStatus;
    isActive: boolean;
    deletedAt: Date | null;
    universityId: string | null;
    facultyId: string | null;
    departmentScope: LibraryDepartmentScope;
    departments: { departmentId: string }[];
  };
  parts: Array<Record<string, unknown> & { id: string; isPreview: boolean; price: number }>;
  packages: Array<Record<string, unknown> & { id: string; items: { libraryPartId: string }[] }>;
  entitlements: Entitlement[];
  existingPurchase: Record<string, unknown> | null;
}

const USER = 'usr_student';

function part(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    materialId: 'lm_1',
    title: `Title ${id}`,
    titleAr: null,
    description: `Secret description of ${id}`,
    sortOrder: Number(id.replace(/\D/g, '')) || 1,
    price: 50,
    currency: 'EGP',
    pageCount: 10,
    mimeType: 'application/pdf',
    isPreview: false,
    thumbnailKey: null,
    status: ContentStatus.PUBLISHED,
    isActive: true,
    deletedAt: null,
    objectKey: `library/${id}.pdf`,
    ...overrides,
  };
}

function world(overrides: Partial<World> = {}): World {
  return {
    storefront: true,
    profile: { universityId: UNI, facultyId: FAC, departmentId: 'dep_prep' },
    material: {
      id: 'lm_1',
      title: 'Mechanica',
      titleAr: 'ميكانيكا',
      description: null,
      coverKey: null,
      subject: null,
      academicYear: null,
      status: ContentStatus.PUBLISHED,
      isActive: true,
      deletedAt: null,
      universityId: UNI,
      facultyId: FAC,
      departmentScope: LibraryDepartmentScope.FACULTY,
      departments: [],
    },
    parts: [part('lp_1'), part('lp_2'), part('lp_3', { isPreview: true, price: 0 })],
    packages: [
      {
        id: 'pkg_1',
        materialId: 'lm_1',
        title: 'Bundle',
        titleAr: null,
        description: null,
        price: 80,
        currency: 'EGP',
        status: ContentStatus.PUBLISHED,
        isActive: true,
        deletedAt: null,
        items: [{ libraryPartId: 'lp_1' }, { libraryPartId: 'lp_2' }],
      },
    ],
    entitlements: [],
    existingPurchase: null,
    ...overrides,
  };
}

const isPub = (row: { status: unknown; isActive: unknown; deletedAt: unknown }) =>
  row.status === ContentStatus.PUBLISHED && row.isActive === true && row.deletedAt === null;

/** A Prisma stand-in answering exactly the queries the Library services make. */
function prismaFor(w: World) {
  const partWithMaterial = (p: World['parts'][number]) => ({ ...p, material: w.material });
  const findUniqueEnt = jest.fn(
    async (args: { where: { userId_libraryPartId: { userId: string; libraryPartId: string } } }) =>
      w.entitlements.find(
        (e) =>
          e.userId === args.where.userId_libraryPartId.userId &&
          e.libraryPartId === args.where.userId_libraryPartId.libraryPartId,
      ) ?? null,
  );
  const purchaseFindUnique = jest.fn(async (_args: unknown) => w.existingPurchase);
  const prisma: Record<string, unknown> = {
    studentProfile: { findUnique: jest.fn(async () => w.profile) },
    libraryMaterial: {
      findFirst: jest.fn(async (args: { where: Record<string, unknown> }) => {
        if (args.where.id !== w.material.id) return null;
        if ('status' in args.where && !isPub(w.material)) return null;
        return w.material;
      }),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
    },
    libraryPart: {
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const p = w.parts.find((x) => x.id === args.where.id && x.deletedAt === null);
        return p ? partWithMaterial(p) : null;
      }),
      findMany: jest.fn(async () => w.parts.filter((p) => isPub(p as never))),
    },
    libraryPackage: {
      findFirst: jest.fn(async (args: { where: { id: string } }) => {
        const pkg = w.packages.find((x) => x.id === args.where.id && x.deletedAt === null);
        if (!pkg) return null;
        return {
          ...pkg,
          material: w.material,
          items: pkg.items.map((i, n) => ({
            sortOrder: n,
            libraryPartId: i.libraryPartId,
            part: w.parts.find((p) => p.id === i.libraryPartId) ?? {
              id: i.libraryPartId,
              materialId: 'lm_other',
              status: ContentStatus.PUBLISHED,
              isActive: true,
              deletedAt: null,
            },
          })),
        };
      }),
      findMany: jest.fn(async () => w.packages.filter((p) => isPub(p as never))),
    },
    libraryEntitlement: {
      findUnique: findUniqueEnt,
      findFirst: jest.fn(async (args: { where: { userId: string; part: { materialId: string } } }) =>
        w.entitlements.find(
          (e) =>
            e.userId === args.where.userId &&
            e.revokedAt === null &&
            w.parts.some((p) => p.id === e.libraryPartId && p.deletedAt === null),
        ) ?? null,
      ),
      findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
        if ('part' in args.where) {
          // Owner view: the student's unrevoked entitlements on published parts.
          return w.entitlements
            .filter((e) => e.userId === args.where.userId && e.revokedAt === null)
            .map((e) => ({ grantedAt: e.grantedAt, part: w.parts.find((p) => p.id === e.libraryPartId)! }))
            .filter((row) => row.part && isPub(row.part as never));
        }
        const ids = (args.where.libraryPartId as { in: string[] }).in;
        return w.entitlements
          .filter((e) => e.userId === args.where.userId && ids.includes(e.libraryPartId))
          .filter((e) => (args.where.revokedAt === null ? e.revokedAt === null : true))
          .map((e) => ({ libraryPartId: e.libraryPartId, grantedAt: e.grantedAt, revokedAt: e.revokedAt }));
      }),
      count: jest.fn(async (args: { where: { userId: string; libraryPartId: { in: string[] } } }) =>
        w.entitlements.filter(
          (e) =>
            e.userId === args.where.userId &&
            args.where.libraryPartId.in.includes(e.libraryPartId) &&
            e.revokedAt !== null,
        ).length,
      ),
      createMany: jest.fn(async () => ({ count: 1 })),
    },
    libraryPurchase: {
      findUnique: purchaseFindUnique,
      create: jest.fn(async () => ({ id: 'lpu_1', purchasedAt: new Date() })),
    },
    user: {
      findFirst: jest.fn(async () => ({ id: USER, status: 'ACTIVE' })),
      findUniqueOrThrow: jest.fn(async () => ({ fullName: 'Student Name' })),
    },
    session: { findFirst: jest.fn(async () => ({ id: 'ses_1' })), count: jest.fn(async () => 1) },
    device: { findFirst: jest.fn(async () => ({ id: 'dev_1' })), count: jest.fn(async () => 1) },
  };
  prisma.$transaction = jest.fn(async (arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => Promise<unknown>)(prisma)
      : Promise.all(arg as readonly unknown[]),
  );
  return { prisma, findUniqueEnt, purchaseFindUnique };
}

function services(w: World) {
  const { prisma, findUniqueEnt, purchaseFindUnique } = prismaFor(w);
  const config = {
    get: (key: string) => (key === 'library' ? { storefrontEnabled: w.storefront } : undefined),
    getOrThrow: (key: string) =>
      key === 'playback' ? { ticketTtl: 300, heartbeatGrace: 90, heartbeatInterval: 30 } : {},
  };
  const eligibility = new LibraryEligibilityService(prisma as never, config as never);
  const audit = { record: jest.fn(async () => undefined) };
  const storage = {
    publicAssetUrl: jest.fn(async () => null),
    signMediaUrl: jest.fn(async (_p: { ticketId?: string | null }) => 'https://media.test/signed'),
  };
  const settings = { libraryDefaultThumbnailKey: jest.fn(async () => null) };
  const debit = jest.fn(async () => ({ id: 'wtx_1', balanceAfter: 100 }));
  const wallet = { debit, summary: jest.fn(async () => ({ balance: 500 })) };

  const library = new LibraryService(
    prisma as never, audit as never, storage as never, settings as never,
    eligibility, { resolveAcademicStructure: jest.fn() } as never,
  );
  const purchases = new LibraryPurchaseService(prisma as never, wallet as never, audit as never, eligibility);
  const documents = new LibraryDocumentsService(
    prisma as never,
    { assertAuthorizedForProtectedContent: jest.fn(async () => ({ deviceId: 'dev_1' })) } as never,
    storage as never,
    { record: jest.fn(async () => undefined) } as never,
    config as never,
    eligibility,
  );
  const playback = new PlaybackService(
    prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {} as never, allowDrm() as never, config as never,
  );
  return { library, purchases, documents, playback, prisma, debit, storage, findUniqueEnt, purchaseFindUnique };
}

const own = (libraryPartId: string, revoked = false): Entitlement => ({
  userId: USER,
  libraryPartId,
  grantedAt: new Date('2026-11-01T00:00:00Z'),
  revokedAt: revoked ? new Date('2026-11-02T00:00:00Z') : null,
});

const OUT_OF_SCOPE = { universityId: UNI, facultyId: OTHER_FAC, departmentId: 'dep_cce' };

async function caught(p: Promise<unknown>): Promise<AppException> {
  try {
    await p;
  } catch (e) {
    return e as AppException;
  }
  throw new Error('expected a rejection');
}

// ===========================================================================

describe('material detail: FULL / OWNER / 404', () => {
  it('in scope: FULL, with the access state and the ownership of every part', async () => {
    const w = world({ entitlements: [own('lp_1'), own('lp_2', true)] });
    const detail = (await services(w).library.materialForStudent('lm_1', USER)) as {
      view: string;
      parts: Array<{ id: string; access: string; ownership: string }>;
    };
    expect(detail.view).toBe('FULL');
    expect(Object.fromEntries(detail.parts.map((p) => [p.id, [p.access, p.ownership]]))).toEqual({
      lp_1: ['OWNED', 'OWNED'],
      lp_2: ['REVOKED', 'REVOKED'],
      lp_3: ['PREVIEW', 'NONE'],
    });
  });

  it('O1/C1: OWNER view carries only the allowed keys and only owned, unrevoked parts', async () => {
    const w = world({
      profile: OUT_OF_SCOPE,
      entitlements: [own('lp_1'), own('lp_2', true)],
    });
    const detail = (await services(w).library.materialForStudent('lm_1', USER)) as Record<string, unknown> & {
      parts: Array<Record<string, unknown>>;
    };

    expect(Object.keys(detail).sort()).toEqual(
      // `academicYears` (the list) sits beside the legacy single `academicYear`;
      // both are header fields, neither says anything about other parts.
      ['academicYear', 'academicYears', 'coverUrl', 'description', 'id', 'packages', 'parts', 'subject', 'title', 'titleAr', 'view'].sort(),
    );
    expect(detail.view).toBe('OWNER');
    expect(detail.packages).toEqual([]);
    expect(detail.parts.map((p) => p.id)).toEqual(['lp_1']);
    expect(Object.keys(detail.parts[0]).sort()).toEqual(
      [
        'access', 'description', 'id', 'mimeType', 'ownedSince', 'ownership', 'pageCount', 'sortOrder',
        'thumbnailUrl', 'title', 'titleAr',
        // C1: deprecated mirrors for the Student Web build that is live today.
        'isPreview', 'owned', 'purchasable',
      ].sort(),
    );
    // The mirrors say "owned, open it" and never "buy".
    expect(detail.parts[0]).toMatchObject({ owned: true, purchasable: false, isPreview: false });
    expect(detail.parts[0]).toMatchObject({ access: 'OWNED', ownership: 'OWNED' });
    const text = JSON.stringify(detail);
    for (const leak of ['lp_2', 'lp_3', 'pkg_1', 'price', 'partIds', 'partCount', 'ownsAllParts', 'Bundle']) {
      expect(text).not.toContain(leak);
    }
  });

  it('a revoked entitlement alone never establishes ownership', async () => {
    const w = world({ profile: OUT_OF_SCOPE, entitlements: [own('lp_1', true)] });
    const e = await caught(services(w).library.materialForStudent('lm_1', USER));
    expect(e.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('storefront off: an owner still gets the OWNER view; anyone else 404', async () => {
    const owner = world({ storefront: false, entitlements: [own('lp_1')] });
    expect(((await services(owner).library.materialForStudent('lm_1', USER)) as { view: string }).view).toBe('OWNER');

    const stranger = world({ storefront: false });
    expect((await caught(services(stranger).library.materialForStudent('lm_1', USER))).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('C4′: missing, unpublished, out of scope and storefront-off are the same 404', async () => {
    const answers = await Promise.all([
      caught(services(world()).library.materialForStudent('lm_missing', USER)),
      caught(services(world({ material: { ...world().material, status: ContentStatus.DRAFT } })).library.materialForStudent('lm_missing', USER)),
      caught(services(world({ profile: OUT_OF_SCOPE })).library.materialForStudent('lm_missing', USER)),
      caught(services(world({ storefront: false })).library.materialForStudent('lm_missing', USER)),
    ]);
    const shape = (e: AppException) => ({
      code: e.code,
      status: e.getStatus(),
      message: e.message,
      keys: Object.keys(e.getResponse() as object).sort(),
    });
    const first = shape(answers[0]);
    for (const e of answers) expect(shape(e)).toEqual(first);

    // And for the real id, hidden by each reason, the answer is that same shape.
    const hidden = await Promise.all([
      caught(services(world({ material: { ...world().material, status: ContentStatus.DRAFT } })).library.materialForStudent('lm_1', USER)),
      caught(services(world({ profile: OUT_OF_SCOPE })).library.materialForStudent('lm_1', USER)),
      caught(services(world({ storefront: false })).library.materialForStudent('lm_1', USER)),
    ]);
    const real = shape(hidden[0]);
    for (const e of hidden) expect(shape(e)).toEqual(real);
    expect(real.code).toBe(first.code);
    expect(real.status).toBe(first.status);
  });

  it('department scope: listed department FULL, unlisted 404, zero links 404', async () => {
    const scoped = (ids: string[]) =>
      world({
        material: {
          ...world().material,
          departmentScope: LibraryDepartmentScope.DEPARTMENTS,
          departments: ids.map((departmentId) => ({ departmentId })),
        },
      });
    expect(((await services(scoped(['dep_prep'])).library.materialForStudent('lm_1', USER)) as { view: string }).view).toBe('FULL');
    expect((await caught(services(scoped(['dep_civil'])).library.materialForStudent('lm_1', USER))).code).toBe(ErrorCode.NOT_FOUND);
    expect((await caught(services(scoped([])).library.materialForStudent('lm_1', USER))).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('a package with an item that is not visible is UNAVAILABLE and never names it', async () => {
    const w = world();
    w.packages[0].items.push({ libraryPartId: 'lp_foreign' });
    const detail = (await services(w).library.materialForStudent('lm_1', USER)) as {
      packages: Array<{ access: string; partIds: string[] }>;
    };
    expect(detail.packages[0].access).toBe('UNAVAILABLE');
    expect(detail.packages[0].partIds).not.toContain('lp_foreign');
  });
});

describe('browse', () => {
  it('storefront off: empty, without touching the catalogue', async () => {
    const s = services(world({ storefront: false }));
    const page = await s.library.browse({ page: 1, pageSize: 20, userId: USER });
    expect(page.items).toEqual([]);
    expect((s.prisma.libraryMaterial as { findMany: jest.Mock }).findMany).not.toHaveBeenCalled();
  });

  it('the eligibility branch comes from the student profile and sits beside search in an AND', async () => {
    const s = services(world());
    await s.library.browse({ page: 1, pageSize: 20, userId: USER, q: 'mech', academicYearId: 'y1' });
    const where = (s.prisma.libraryMaterial as { findMany: jest.Mock }).findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ universityId: UNI, facultyId: FAC }),
        // The year/level filter: filed under no rung ("all years"), or a
        // whole-college material filed under that rung, or THIS student's
        // department listed under that rung. Its own AND branch, so it can
        // only narrow the eligible list; the student's own year is not in it.
        {
          OR: [
            { academicYears: { none: {} } },
            { departmentScope: 'FACULTY', academicYears: { some: { academicYearId: 'y1' } } },
            {
              departmentScope: 'DEPARTMENTS',
              academicYears: {
                some: { academicYearId: 'y1', departments: { some: { departmentId: 'dep_prep' } } },
              },
            },
          ],
        },
        expect.objectContaining({ OR: expect.any(Array) }),
      ]),
    );
  });

  it('no profile: matches nothing', async () => {
    const s = services(world({ profile: null }));
    await s.library.browse({ page: 1, pageSize: 20, userId: USER });
    const where = (s.prisma.libraryMaterial as { findMany: jest.Mock }).findMany.mock.calls[0][0].where;
    expect(where.AND).toContainEqual({ id: { in: [] } });
  });
});

describe('quote and purchase: the gate runs first, the debit last', () => {
  const buy = (s: ReturnType<typeof services>, kind: LibraryPurchaseKind = LibraryPurchaseKind.PART, targetId = 'lp_1') =>
    s.purchases.purchase({ userId: USER, userRole: UserRole.STUDENT, kind, targetId });
  const quote = (s: ReturnType<typeof services>, kind: LibraryPurchaseKind = LibraryPurchaseKind.PART, targetId = 'lp_1') =>
    s.purchases.quote({ userId: USER, kind, targetId });

  const refusals: Array<[string, () => World, string]> = [
    ['storefront off', () => world({ storefront: false }), ErrorCode.NOT_FOUND],
    ['out of scope, owns nothing', () => world({ profile: OUT_OF_SCOPE }), ErrorCode.NOT_FOUND],
    ['out of scope, owns another part', () => world({ profile: OUT_OF_SCOPE, entitlements: [own('lp_2')] }), ErrorCode.LIBRARY_NOT_AVAILABLE],
    ['material unpublished', () => world({ material: { ...world().material, status: ContentStatus.HIDDEN } }), ErrorCode.NOT_FOUND],
    ['part revoked (bought via a package earlier)', () => world({ entitlements: [own('lp_1', true)] }), ErrorCode.LIBRARY_ENTITLEMENT_REVOKED],
  ];

  it.each(refusals)('purchase refused — %s — with no debit and no replay lookup', async (_n, mk, code) => {
    const w = mk();
    w.existingPurchase = { id: 'old', userId: USER, kind: 'PART', libraryPartId: 'lp_1', titleSnapshot: 't', priceAtPurchase: 50, currency: 'EGP', partIdsSnapshot: ['lp_1'], purchasedAt: new Date() };
    const s = services(w);
    expect((await caught(buy(s))).code).toBe(code);
    expect(s.debit).not.toHaveBeenCalled();
    // P2: the idempotent replay is never a way around the gate.
    expect(s.purchaseFindUnique).not.toHaveBeenCalled();
  });

  it.each(refusals)('G2: quote refuses the same way — %s', async (_n, mk, code) => {
    expect((await caught(quote(services(mk())))).code).toBe(code);
  });

  it('a free preview is not for sale', async () => {
    const s = services(world());
    expect((await caught(buy(s, LibraryPurchaseKind.PART, 'lp_3'))).code).toBe(ErrorCode.INVALID_STATE);
    expect(s.debit).not.toHaveBeenCalled();
  });

  it('P3: a package with a revoked item is refused whole, before any debit', async () => {
    const s = services(world({ entitlements: [own('lp_2', true)] }));
    expect((await caught(buy(s, LibraryPurchaseKind.PACKAGE, 'pkg_1'))).code).toBe(ErrorCode.LIBRARY_ENTITLEMENT_REVOKED);
    expect(s.debit).not.toHaveBeenCalled();
  });

  it('P3: a package with an item from another material is refused whole', async () => {
    const w = world();
    w.packages[0].items.push({ libraryPartId: 'lp_foreign' });
    const s = services(w);
    expect((await caught(buy(s, LibraryPurchaseKind.PACKAGE, 'pkg_1'))).code).toBe(ErrorCode.INVALID_STATE);
    expect(s.debit).not.toHaveBeenCalled();
  });

  it('P3: a package with an unpublished item is refused whole', async () => {
    const w = world();
    w.parts[1] = { ...w.parts[1], status: ContentStatus.DRAFT };
    const s = services(w);
    expect((await caught(buy(s, LibraryPurchaseKind.PACKAGE, 'pkg_1'))).code).toBe(ErrorCode.INVALID_STATE);
    expect(s.debit).not.toHaveBeenCalled();
  });

  it('in scope with the storefront on: the debit happens', async () => {
    const s = services(world());
    await buy(s);
    expect(s.debit).toHaveBeenCalledTimes(1);
  });
});

describe('opening documents (I1–I6)', () => {
  const open = (s: ReturnType<typeof services>, partId: string) =>
    s.documents.issueTicket({
      libraryPartId: partId,
      user: { id: USER, role: UserRole.STUDENT, sessionId: 'ses_1', deviceId: 'dev_1', deviceKey: 'k' } as never,
      integritySuspect: false,
    });
  const tid = (s: ReturnType<typeof services>) => s.storage.signMediaUrl.mock.calls[0][0].ticketId;

  it('I2: owned → lib_, whatever the scope or the storefront', async () => {
    for (const w of [
      world({ entitlements: [own('lp_1')] }),
      world({ profile: OUT_OF_SCOPE, entitlements: [own('lp_1')] }),
      world({ storefront: false, entitlements: [own('lp_1')] }),
    ]) {
      const s = services(w);
      await open(s, 'lp_1');
      expect(tid(s)).toBe('lib_lp_1');
    }
  });

  it('I3: eligible preview with the storefront on → libp_', async () => {
    const s = services(world());
    await open(s, 'lp_3');
    expect(tid(s)).toBe('libp_lp_3');
  });

  it.each([
    ['storefront off', world({ storefront: false })],
    ['out of scope', world({ profile: OUT_OF_SCOPE })],
    ['draft material', world({ material: { ...world().material, status: ContentStatus.DRAFT } })],
    ['inactive material', world({ material: { ...world().material, isActive: false } })],
  ])('I4: preview refused (404) — %s', async (_n, w) => {
    const s = services(w);
    expect((await caught(open(s, 'lp_3'))).code).toBe(ErrorCode.NOT_FOUND);
    expect(s.storage.signMediaUrl).not.toHaveBeenCalled();
  });

  it('I4: an inactive preview part is refused', async () => {
    const w = world();
    w.parts[2] = { ...w.parts[2], isActive: false };
    expect((await caught(open(services(w), 'lp_3'))).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('I5: an owned preview part opens as lib_', async () => {
    const s = services(world({ entitlements: [own('lp_3')] }));
    await open(s, 'lp_3');
    expect(tid(s)).toBe('lib_lp_3');
  });

  it('I1: in scope, not owned → 402; out of scope non-owner → 404 (C3); out of scope owner of another part → 402', async () => {
    expect((await caught(open(services(world()), 'lp_1'))).code).toBe(ErrorCode.PAYMENT_REQUIRED);
    expect((await caught(open(services(world({ profile: OUT_OF_SCOPE })), 'lp_1'))).code).toBe(ErrorCode.NOT_FOUND);
    expect((await caught(open(services(world({ profile: OUT_OF_SCOPE, entitlements: [own('lp_2')] })), 'lp_1'))).code).toBe(ErrorCode.PAYMENT_REQUIRED);
  });

  it('I6: revoked → LIBRARY_ENTITLEMENT_REVOKED, no URL', async () => {
    const s = services(world({ entitlements: [own('lp_1', true)] }));
    expect((await caught(open(s, 'lp_1'))).code).toBe(ErrorCode.LIBRARY_ENTITLEMENT_REVOKED);
    expect(s.storage.signMediaUrl).not.toHaveBeenCalled();
  });
});

describe('preview liveness (libp_)', () => {
  const live = (s: ReturnType<typeof services>, bound: { sid?: string | null; did?: string | null } = { sid: 'ses_1', did: 'dev_1' }) =>
    s.playback.ticketLiveness('libp_lp_3', USER, bound);

  it('live for an eligible, published preview on the bound session', async () => {
    await expect(live(services(world()))).resolves.toEqual({ live: true });
  });

  it.each([
    ['storefront off', world({ storefront: false })],
    ['out of scope', world({ profile: OUT_OF_SCOPE })],
    ['material unpublished', world({ material: { ...world().material, status: ContentStatus.HIDDEN } })],
  ])('dead — %s', async (_n, w) => {
    await expect(live(services(w))).resolves.toEqual({ live: false });
  });

  it('dead without a session id, or when the bound session is not active (K3)', async () => {
    await expect(live(services(world()), { sid: null })).resolves.toEqual({ live: false });
    const s = services(world());
    (s.prisma.session as { findFirst: jest.Mock }).findFirst.mockResolvedValueOnce(null);
    await expect(live(s)).resolves.toEqual({ live: false });
    const [args] = (s.prisma.session as { findFirst: jest.Mock }).findFirst.mock.calls[0];
    expect(args.where).toMatchObject({ id: 'ses_1', userId: USER, status: 'ACTIVE' });
  });

  it('needs no approved device: the device is not consulted', async () => {
    const s = services(world());
    (s.prisma.device as { findFirst: jest.Mock }).findFirst.mockResolvedValue(null);
    await expect(live(s)).resolves.toEqual({ live: true });
    await expect(live(s, { sid: 'ses_1' })).resolves.toEqual({ live: true });
    expect((s.prisma.device as { findFirst: jest.Mock }).findFirst).not.toHaveBeenCalled();
  });

  it('a libp_ ticket for a part that is not a preview is dead', async () => {
    await expect(services(world()).playback.ticketLiveness('libp_lp_1', USER, { sid: 'ses_1' })).resolves.toEqual({ live: false });
  });
});

/**
 * Decision B: revoked ownership vs free preview. Revocation and preview
 * eligibility are separate; neither silently overrides the other.
 *
 *   B1/B2  only an unrevoked entitlement grants owned access (`lib_`)
 *   B3     a revoked entitlement may coexist with preview eligibility
 *   B4–B6  preview needs storefront, publication, scope, session and device,
 *          and having owned the part never stands in for any of them
 *   B7     revocation never restores purchases, entitlements or packages
 *   B8     unrevoked owners keep access whatever their scope or the storefront
 */
describe('Decision B: revoked ownership vs free preview', () => {
  const REVOKED_PREVIEW = () => own('lp_3', true);
  const open = (s: ReturnType<typeof services>, partId: string) =>
    s.documents.issueTicket({
      libraryPartId: partId,
      user: { id: USER, role: UserRole.STUDENT, sessionId: 'ses_1', deviceId: 'dev_1', deviceKey: 'k' } as never,
      integritySuspect: false,
    });
  const tid = (s: ReturnType<typeof services>) => s.storage.signMediaUrl.mock.calls[0][0].ticketId;
  type FullPart = { id: string; access: string; ownership: string; owned: boolean; purchasable: boolean; isPreview: boolean };
  const fullParts = async (w: World) =>
    Object.fromEntries(
      ((await services(w).library.materialForStudent('lm_1', USER)) as { parts: FullPart[] }).parts.map((p) => [p.id, p]),
    );

  describe('material detail', () => {
    it('B3: a revoked preview part offers the preview and still says the ownership was revoked', async () => {
      const parts = await fullParts(world({ entitlements: [REVOKED_PREVIEW()] }));
      expect(parts.lp_3).toMatchObject({ access: 'PREVIEW', ownership: 'REVOKED', purchasable: false, isPreview: true });
    });

    it('B2: a revoked part that is not a preview offers nothing', async () => {
      const parts = await fullParts(world({ entitlements: [own('lp_1', true)] }));
      expect(parts.lp_1).toMatchObject({ access: 'REVOKED', ownership: 'REVOKED', owned: false, purchasable: false });
    });

    it('B7: a package holding a revoked preview part stays unavailable', async () => {
      const w = world({ entitlements: [REVOKED_PREVIEW()] });
      w.packages[0].items = [{ libraryPartId: 'lp_1' }, { libraryPartId: 'lp_3' }];
      const detail = (await services(w).library.materialForStudent('lm_1', USER)) as { packages: Array<{ access: string }> };
      expect(detail.packages[0].access).toBe('UNAVAILABLE');
    });

    it('B5: out of scope, a revoked preview part shows nothing at all (404)', async () => {
      const w = world({ profile: OUT_OF_SCOPE, entitlements: [REVOKED_PREVIEW()] });
      expect((await caught(services(w).library.materialForStudent('lm_1', USER))).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('B6: storefront off, a revoked preview part shows nothing at all (404)', async () => {
      const w = world({ storefront: false, entitlements: [REVOKED_PREVIEW()] });
      expect((await caught(services(w).library.materialForStudent('lm_1', USER))).code).toBe(ErrorCode.NOT_FOUND);
    });

    it('B8: storefront off and out of scope, an unrevoked owner keeps the owner view beside a revoked part', async () => {
      const w = world({ storefront: false, profile: OUT_OF_SCOPE, entitlements: [own('lp_1'), REVOKED_PREVIEW()] });
      const detail = (await services(w).library.materialForStudent('lm_1', USER)) as { view: string; parts: FullPart[] };
      expect(detail.view).toBe('OWNER');
      expect(detail.parts.map((p) => [p.id, p.access, p.ownership])).toEqual([['lp_1', 'OWNED', 'OWNED']]);
    });
  });

  describe('opening documents', () => {
    it('B3: a revoked owner of an eligible preview part gets a preview ticket, never an owned one', async () => {
      const s = services(world({ entitlements: [REVOKED_PREVIEW()] }));
      await open(s, 'lp_3');
      expect(tid(s)).toBe('libp_lp_3');
    });

    it.each([
      ['storefront off (B6)', () => world({ storefront: false, entitlements: [REVOKED_PREVIEW()] })],
      ['out of scope (B5)', () => world({ profile: OUT_OF_SCOPE, entitlements: [REVOKED_PREVIEW()] })],
      ['material unpublished', () => world({ material: { ...world().material, status: ContentStatus.HIDDEN }, entitlements: [REVOKED_PREVIEW()] })],
      ['material inactive', () => world({ material: { ...world().material, isActive: false }, entitlements: [REVOKED_PREVIEW()] })],
      [
        'part unpublished',
        () => {
          const w = world({ entitlements: [REVOKED_PREVIEW()] });
          w.parts[2] = { ...w.parts[2], status: ContentStatus.HIDDEN };
          return w;
        },
      ],
      [
        'part no longer a preview',
        () => {
          const w = world({ entitlements: [REVOKED_PREVIEW()] });
          w.parts[2] = { ...w.parts[2], isPreview: false, price: 50 };
          return w;
        },
      ],
    ])('B2/B4: a revoked owner is refused when the preview is not available — %s — with no URL', async (_n, mk) => {
      const s = services(mk());
      expect((await caught(open(s, 'lp_3'))).code).toBe(ErrorCode.LIBRARY_ENTITLEMENT_REVOKED);
      expect(s.storage.signMediaUrl).not.toHaveBeenCalled();
    });

    it('B8: an unrevoked owner reads whatever the storefront or the scope', async () => {
      const s = services(world({ storefront: false, profile: OUT_OF_SCOPE, entitlements: [own('lp_1'), REVOKED_PREVIEW()] }));
      await open(s, 'lp_1');
      expect(tid(s)).toBe('lib_lp_1');
    });
  });

  describe('liveness', () => {
    const bound = { sid: 'ses_1', did: 'dev_1' };

    it('B3: the preview grant stays live beside a revoked entitlement', async () => {
      await expect(
        services(world({ entitlements: [REVOKED_PREVIEW()] })).playback.ticketLiveness('libp_lp_3', USER, bound),
      ).resolves.toEqual({ live: true });
    });

    it('B2: an owned grant for the same part is dead once revoked', async () => {
      await expect(
        services(world({ entitlements: [REVOKED_PREVIEW()] })).playback.ticketLiveness('lib_lp_3', USER, bound),
      ).resolves.toEqual({ live: false });
    });

    it.each([
      ['storefront off (B6)', () => world({ storefront: false, entitlements: [REVOKED_PREVIEW()] })],
      ['out of scope (B5)', () => world({ profile: OUT_OF_SCOPE, entitlements: [REVOKED_PREVIEW()] })],
      ['material unpublished', () => world({ material: { ...world().material, status: ContentStatus.HIDDEN }, entitlements: [REVOKED_PREVIEW()] })],
    ])('B4: the preview grant of a revoked owner dies — %s', async (_n, mk) => {
      await expect(services(mk()).playback.ticketLiveness('libp_lp_3', USER, bound)).resolves.toEqual({ live: false });
    });

    it('B4: the preview grant of a revoked owner dies with its session', async () => {
      const noSession = services(world({ entitlements: [REVOKED_PREVIEW()] }));
      (noSession.prisma.session as { findFirst: jest.Mock }).findFirst.mockResolvedValueOnce(null);
      await expect(noSession.playback.ticketLiveness('libp_lp_3', USER, bound)).resolves.toEqual({ live: false });
    });
  });

  describe('B7: revocation restores nothing', () => {
    const buy = (s: ReturnType<typeof services>, kind: LibraryPurchaseKind, targetId: string) =>
      s.purchases.purchase({ userId: USER, userRole: UserRole.STUDENT, kind, targetId });

    it('a revoked preview part is refused as revoked, not quoted or bought, with no debit', async () => {
      const s = services(world({ entitlements: [REVOKED_PREVIEW()] }));
      expect((await caught(buy(s, LibraryPurchaseKind.PART, 'lp_3'))).code).toBe(ErrorCode.LIBRARY_ENTITLEMENT_REVOKED);
      expect((await caught(s.purchases.quote({ userId: USER, kind: LibraryPurchaseKind.PART, targetId: 'lp_3' }))).code).toBe(
        ErrorCode.LIBRARY_ENTITLEMENT_REVOKED,
      );
      expect(s.debit).not.toHaveBeenCalled();
    });

    it('a package holding a revoked preview part is refused whole, with no debit and no entitlement', async () => {
      const w = world({ entitlements: [REVOKED_PREVIEW()] });
      w.packages[0].items = [{ libraryPartId: 'lp_1' }, { libraryPartId: 'lp_3' }];
      const s = services(w);
      expect((await caught(buy(s, LibraryPurchaseKind.PACKAGE, 'pkg_1'))).code).toBe(ErrorCode.LIBRARY_ENTITLEMENT_REVOKED);
      expect(s.debit).not.toHaveBeenCalled();
      expect((s.prisma.libraryEntitlement as { createMany: jest.Mock }).createMany).not.toHaveBeenCalled();
    });

    it('opening a preview writes nothing: no entitlement, no purchase, no debit', async () => {
      const s = services(world({ entitlements: [REVOKED_PREVIEW()] }));
      await open(s, 'lp_3');
      expect((s.prisma.libraryEntitlement as { createMany: jest.Mock }).createMany).not.toHaveBeenCalled();
      expect((s.prisma.libraryPurchase as { create: jest.Mock }).create).not.toHaveBeenCalled();
      expect(s.debit).not.toHaveBeenCalled();
    });

    it('My Library lists unrevoked entitlements only, in the query itself', async () => {
      const w = world({ entitlements: [own('lp_1'), REVOKED_PREVIEW(), own('lp_2', true)] });
      const s = services(w);
      const ent = s.prisma.libraryEntitlement as { findMany: jest.Mock; count: jest.Mock };
      // Answers as the database would for the `where` it is given.
      const matching = (where: { userId: string; revokedAt?: null }) =>
        w.entitlements.filter((e) => e.userId === where.userId && (where.revokedAt === null ? e.revokedAt === null : true));
      ent.findMany.mockImplementation(async (args: { where: { userId: string; revokedAt?: null } }) =>
        matching(args.where).map((e) => ({
          id: `ent_${e.libraryPartId}`,
          source: 'PURCHASE',
          grantedAt: e.grantedAt,
          part: {
            ...w.parts.find((p) => p.id === e.libraryPartId)!,
            material: { id: 'lm_1', title: 'Mechanica', status: ContentStatus.PUBLISHED, deletedAt: null },
          },
        })),
      );
      ent.count.mockImplementation(async (args: { where: { userId: string; revokedAt?: null } }) => matching(args.where).length);

      const page = (await s.library.myLibrary(USER, 1, 20)) as unknown as {
        items: Array<{ partId: string }>;
        meta: { total: number };
      };
      expect(ent.findMany.mock.calls[0][0].where).toMatchObject({ userId: USER, revokedAt: null });
      expect(ent.count.mock.calls[0][0].where).toMatchObject({ userId: USER, revokedAt: null });
      expect(page.items.map((i) => i.partId)).toEqual(['lp_1']);
      expect(page.meta.total).toBe(1);
    });
  });
});

describe('I7: Library URLs are signed in exactly one place', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? sources(path) : path.endsWith('.ts') ? [path] : [];
    });
  }

  it('signMediaUrl has only its known callers, and only library-documents mints library tickets', () => {
    const root = join(process.cwd(), 'src');
    const callers = sources(root)
      .filter((file) => /\.signMediaUrl\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replace(/\\/g, '/'))
      .sort();
    expect(callers).toEqual([
      'modules/attachments/attachments.service.ts',
      'modules/library/library-documents.service.ts',
      'modules/playback/manifest.service.ts',
      'modules/playback/playback.service.ts',
    ]);
    // No other signer passes a Library ticket id. (playback.service.ts knows the
    // prefixes for its liveness check; it must never MINT one.)
    for (const file of callers.filter((f) => !f.startsWith('modules/library/'))) {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/ticketId:\s*[`'"]libp?_/);
    }
    // And the one place that does mints only through the two named prefixes.
    const documents = readFileSync(join(root, 'modules/library/library-documents.service.ts'), 'utf8');
    expect(documents).toMatch(/ticketId:\s*`\$\{prefix\}\$\{part\.id\}`/);
  });
});

describe('the URL for an owned, device-bound document names the authorized device', () => {
  it('uses the device the gate authorized, not the session device', async () => {
    const s = services(world({ entitlements: [own('lp_1')] }));
    await s.documents.issueTicket({
      libraryPartId: 'lp_1',
      // Signed in without a device header: the session has no device of its own.
      user: { id: USER, role: UserRole.STUDENT, sessionId: 'ses_1', deviceId: null, deviceKey: 'k', phone: '0', fullName: 'S', status: 'ACTIVE' } as never,
      integritySuspect: false,
    });
    expect(s.storage.signMediaUrl.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_1', deviceId: 'dev_1' });
  });

  it('a preview names only the session device, and needs none', async () => {
    const s = services(world());
    await s.documents.issueTicket({
      libraryPartId: 'lp_3',
      user: { id: USER, role: UserRole.STUDENT, sessionId: 'ses_1', deviceId: null, deviceKey: null, phone: '0', fullName: 'S', status: 'ACTIVE' } as never,
      integritySuspect: false,
    });
    expect(s.storage.signMediaUrl.mock.calls[0][0]).toMatchObject({ sessionId: 'ses_1', deviceId: null, ticketId: 'libp_lp_3' });
  });
});
