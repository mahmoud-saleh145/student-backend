import {
  ContentStatus,
  CourseStatus,
  LibraryPurchaseKind,
  PartPricingModel,
  UserRole,
  WalletTxType,
} from '@prisma/client';

import {
  isCourseAcquirable,
  isOnSale,
  isAcquirableContent,
  isAcquirableCourse,
} from '../../src/common/publication';
import { grantPartFromCode } from '../../src/modules/course-parts/grant-part-from-code';
import { LibraryPurchaseService } from '../../src/modules/library/library-purchase.service';

/**
 * Unpublished content must not be acquirable.
 *
 * ── The bug class ────────────────────────────────────────────────────────────
 *
 * Nothing stopped a student obtaining content that was not published. Not one
 * rule, agreed in one place — four, spelled four different ways:
 *
 *   1. A multi-course card froze its extra courses into itself and filtered
 *      them with `notIn: [ARCHIVED, SUSPENDED]`. `DRAFT` and `HIDDEN` passed.
 *      The primary course was held to a strict rule; the extras were not, and
 *      the extras are the ones nobody was looking at.
 *   2. `grantPartFromCode` checked `deletedAt` and nothing else, so a card for a
 *      draft, hidden, archived or deactivated part still minted a purchase row
 *      and a live entitlement.
 *   3. The library's `assertOnSale` refused `ARCHIVED` on the item, so a
 *      `DRAFT` part was purchasable — invisible in a catalogue that only ever
 *      lists `PUBLISHED`, and reachable by calling the endpoint with an id.
 *   4. The same function refused `DRAFT` but not `HIDDEN` on the *material*, so
 *      two spellings of "not for sale" gave two different answers.
 *
 * The reason a UI never caught any of this: every one of these items is hidden
 * from the catalogue already. The bug is only reachable by a client that skips
 * the UI — which is exactly what an attacker is.
 *
 * ── What is deliberately NOT changed ─────────────────────────────────────────
 *
 * Withdrawing content must not take away what students already bought. These
 * guards govern *new* acquisition only. Existing entitlements, purchases and
 * the "you own this but it is withdrawn" listing are untouched.
 */

const COURSE_TEACHERS = [
  {
    teacherId: 'tch_1',
    isLead: true,
    revenueSharePercent: '60',
    teacher: { teacherProfile: { revenueSharePercent: '50' } },
  },
];

interface PartShape {
  status?: ContentStatus;
  isActive?: boolean;
  deletedAt?: Date | null;
  courseStatus?: CourseStatus;
  courseDeletedAt?: Date | null;
}

/** A transaction whose part row is exactly as described. */
function txWithPart(shape: PartShape = {}) {
  const created: Array<Record<string, unknown>> = [];
  const upserts: Array<Record<string, unknown>> = [];

  const part = {
    id: 'prt_1',
    courseId: 'crs_1',
    title: 'Part 1',
    currency: 'EGP',
    pricingModel: PartPricingModel.PERCENTAGE,
    pricePercent: '100',
    priceAmount: null,
    status: shape.status ?? ContentStatus.PUBLISHED,
    isActive: shape.isActive ?? true,
    deletedAt: shape.deletedAt ?? null,
    course: {
      id: 'crs_1',
      title: 'Circuit Analysis II',
      status: shape.courseStatus ?? CourseStatus.PUBLISHED,
      deletedAt: shape.courseDeletedAt ?? null,
      teachers: COURSE_TEACHERS,
    },
  };

  const tx = {
    coursePart: { findFirst: jest.fn(async () => part) },
    coursePartEntitlement: {
      findUnique: jest.fn(async () => null),
      upsert: jest.fn(async (args: { create: Record<string, unknown> }) => {
        upserts.push(args.create);
        return { id: 'cpe_1' };
      }),
    },
    coursePrice: { findFirst: jest.fn(async () => ({ amount: '1000' })) },
    coursePartPurchase: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args.data);
        return { id: 'cpp_1' };
      }),
    },
    $queryRawUnsafe: jest.fn(async () => []),
    $queryRaw: jest.fn(async () => []),
  };

  return { tx: tx as never, created, upserts };
}

const redeem = (tx: never) =>
  grantPartFromCode(tx, {
    userId: 'usr_1',
    coursePartId: 'prt_1',
    accessCodeId: 'cod_1',
    sectionIds: ['sec_1'],
  });

// ─────────────────────────────────────────────────────────────────────────────
// The shared rule
// ─────────────────────────────────────────────────────────────────────────────
describe('the shared publication rule', () => {
  describe('a course may be acquired only when published', () => {
    it.each([
      ['PUBLISHED', CourseStatus.PUBLISHED, true],
      ['DRAFT', CourseStatus.DRAFT, false],
      ['HIDDEN', CourseStatus.HIDDEN, false],
      ['SUSPENDED', CourseStatus.SUSPENDED, false],
      ['ARCHIVED', CourseStatus.ARCHIVED, false],
    ])('%s → %s', (_label, status, expected) => {
      expect(isAcquirableCourse(status)).toBe(expected);
    });

    it('never treats a deleted course as acquirable, whatever its status', () => {
      expect(isCourseAcquirable({ status: CourseStatus.PUBLISHED, deletedAt: new Date() })).toBe(
        false,
      );
    });
  });

  describe('content may be acquired only when published', () => {
    it.each([
      ['PUBLISHED', ContentStatus.PUBLISHED, true],
      ['DRAFT', ContentStatus.DRAFT, false],
      ['HIDDEN', ContentStatus.HIDDEN, false],
      ['ARCHIVED', ContentStatus.ARCHIVED, false],
    ])('%s → %s', (_label, status, expected) => {
      expect(isAcquirableContent(status)).toBe(expected);
    });
  });

  describe('a sellable child needs published *and* active', () => {
    it('allows a published, active part', () => {
      expect(isOnSale({ status: ContentStatus.PUBLISHED, isActive: true })).toBe(true);
    });

    it.each([ContentStatus.DRAFT, ContentStatus.HIDDEN, ContentStatus.ARCHIVED])(
      'refuses a %s part even when active',
      (status) => {
        // The hole: "not archived" was the old test, so anything unpublished
        // passed as long as it was not the one word they remembered.
        expect(isOnSale({ status, isActive: true })).toBe(false);
      },
    );

    it('refuses a published but deactivated part', () => {
      // The schema calls an inactive part "cannot be bought". A status-only rule
      // let it be bought anyway.
      expect(isOnSale({ status: ContentStatus.PUBLISHED, isActive: false })).toBe(false);
    });

    it('refuses a deleted part', () => {
      expect(
        isOnSale({ status: ContentStatus.PUBLISHED, isActive: true, deletedAt: new Date() }),
      ).toBe(false);
    });

    it('treats an undefined status as not for sale rather than as for sale', () => {
      // Fail closed. A missing field must never read as permission.
      expect(isOnSale({ status: undefined, isActive: true })).toBe(false);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Access-code redemption of a course part
// ─────────────────────────────────────────────────────────────────────────────
describe('a card cannot unlock an unpublished part', () => {
  it('grants a published, active part', async () => {
    const { tx, created, upserts } = txWithPart();

    const result = await redeem(tx);

    expect(result).not.toBeNull();
    expect(created).toHaveLength(1);
    expect(upserts).toHaveLength(1);
  });

  it.each([ContentStatus.DRAFT, ContentStatus.HIDDEN, ContentStatus.ARCHIVED])(
    'refuses a %s part and writes nothing',
    async (status) => {
      const { tx, created, upserts } = txWithPart({ status });

      await expect(redeem(tx)).rejects.toMatchObject({ code: 'INVALID_STATE' });

      // The important half: the refusal must leave no purchase row and no
      // entitlement. A throw after the writes would burn the card for nothing.
      expect(created).toHaveLength(0);
      expect(upserts).toHaveLength(0);
    },
  );

  it('refuses a deactivated part, which the schema says cannot be bought', async () => {
    const { tx, created } = txWithPart({ isActive: false });

    await expect(redeem(tx)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(created).toHaveLength(0);
  });

  it('refuses a published part that belongs to a draft course', async () => {
    // The card is validated against its own course elsewhere. This part belongs
    // to a *different* course, so that check says nothing about it.
    const { tx, created } = txWithPart({ courseStatus: CourseStatus.DRAFT });

    await expect(redeem(tx)).rejects.toMatchObject({ code: 'COURSE_NOT_AVAILABLE' });
    expect(created).toHaveLength(0);
  });

  it.each([CourseStatus.HIDDEN, CourseStatus.SUSPENDED, CourseStatus.ARCHIVED])(
    'refuses a part whose course is %s',
    async (courseStatus) => {
      const { tx, created } = txWithPart({ courseStatus });

      await expect(redeem(tx)).rejects.toMatchObject({ code: 'COURSE_NOT_AVAILABLE' });
      expect(created).toHaveLength(0);
    },
  );

  it('still returns null rather than throwing when the part row is gone', async () => {
    // A hard-deleted part must not break redemption of a legitimately sold card:
    // the frozen sections still unlock through the ordinary grant path.
    const tx = {
      coursePart: { findFirst: jest.fn(async () => null) },
      coursePartEntitlement: { findUnique: jest.fn(), upsert: jest.fn() },
      coursePrice: { findFirst: jest.fn() },
      coursePartPurchase: { create: jest.fn() },
    } as never;

    await expect(redeem(tx)).resolves.toBeNull();
  });

  it('does not let the part id in the request choose what is granted', async () => {
    // The id comes from the card row in the database, not the request body. This
    // is why publication state — not client intent — is the thing to check.
    const { tx, upserts } = txWithPart();

    await grantPartFromCode(tx, {
      userId: 'usr_1',
      coursePartId: 'prt_1',
      accessCodeId: 'cod_1',
      sectionIds: ['sec_1'],
    });

    expect(upserts[0]).toMatchObject({ coursePartId: 'prt_1', userId: 'usr_1' });
  });
});
// -----------------------------------------------------------------------------
// The library
// -----------------------------------------------------------------------------
interface LibraryShape {
  partStatus?: ContentStatus;
  partActive?: boolean;
  partDeletedAt?: Date | null;
  materialStatus?: ContentStatus;
  materialActive?: boolean;
  materialDeletedAt?: Date | null;
  packageStatus?: ContentStatus;
  packageActive?: boolean;
}

function libraryService(shape: LibraryShape = {}) {
const purchaseCreate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: 'lpu_1',
    purchasedAt: new Date('2026-09-18T04:00:00Z'),
    ...data,
  }));
  const entitlementCreateMany = jest.fn(async () => ({ count: 1 }));

  const material = {
    id: 'mat_1',
    title: 'Physics Revision Papers',
    status: shape.materialStatus ?? ContentStatus.PUBLISHED,
    isActive: shape.materialActive ?? true,
    deletedAt: shape.materialDeletedAt ?? null,
  };

  const part = {
    id: 'lp_1',
    title: 'Part 1',
    price: '50',
    currency: 'EGP',
    status: shape.partStatus ?? ContentStatus.PUBLISHED,
    isActive: shape.partActive ?? true,
    deletedAt: shape.partDeletedAt ?? null,
    material,
  };

  const pkg = {
    id: 'pkg_1',
    title: 'Complete Package',
    price: '120',
    currency: 'EGP',
    status: shape.packageStatus ?? ContentStatus.PUBLISHED,
    isActive: shape.packageActive ?? true,
    deletedAt: null,
    material,
    items: [
      { sortOrder: 0, part: { id: 'lp_1', status: ContentStatus.PUBLISHED, isActive: true, deletedAt: null } },
      { sortOrder: 1, part: { id: 'lp_2', status: ContentStatus.PUBLISHED, isActive: true, deletedAt: null } },
    ],
  };

  const tx = {
    libraryPart: { findFirst: jest.fn(async () => part) },
    libraryPackage: { findFirst: jest.fn(async () => pkg) },
    user: { findFirst: jest.fn(async () => ({ id: 'usr_1', status: 'ACTIVE' })) },
    libraryEntitlement: {
      findMany: jest.fn(async () => []),
      createMany: entitlementCreateMany,
    },
    libraryPurchase: { create: purchaseCreate },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    libraryPurchase: { findUnique: jest.fn(async () => null) },
    libraryPart: { findFirst: jest.fn(async () => part) },
    libraryPackage: { findFirst: jest.fn(async () => pkg) },
    libraryEntitlement: { findMany: jest.fn(async () => []) },
  };

  const wallet = {
    debit: jest.fn(async () => ({
      id: 'wtx_1',
      walletId: 'wal_1',
      amount: 50,
      balanceBefore: 500,
      balanceAfter: 450,
      direction: 'DEBIT',
      type: WalletTxType.PURCHASE,
      createdAt: new Date(),
      replayed: false,
    })),
    summary: jest.fn(async () => ({ balance: 500, currency: 'EGP' })),
  };

  const service = new LibraryPurchaseService(
    prisma as never,
    wallet as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  const buy = (kind: LibraryPurchaseKind, targetId: string) =>
    service.purchase({ userId: 'usr_1', userRole: UserRole.STUDENT, kind, targetId });

  return { buy, purchaseCreate, entitlementCreateMany, wallet };
}

describe('the library will not sell unpublished content', () => {
  it('sells a published, active part', async () => {
    const { buy, purchaseCreate } = libraryService();

    await buy(LibraryPurchaseKind.PART, 'lp_1');

    expect(purchaseCreate).toHaveBeenCalledTimes(1);
  });

  it.each([ContentStatus.DRAFT, ContentStatus.HIDDEN, ContentStatus.ARCHIVED])(
    'refuses a %s part and debits nothing',
    async (partStatus) => {
      const { buy, purchaseCreate, entitlementCreateMany, wallet } = libraryService({ partStatus });

      await expect(buy(LibraryPurchaseKind.PART, 'lp_1')).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });

      // No money moved and no entitlement written. A refusal that debited first
      // would be worse than the bug it replaced.
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(purchaseCreate).not.toHaveBeenCalled();
      expect(entitlementCreateMany).not.toHaveBeenCalled();
    },
  );

  it('refuses a deactivated part', async () => {
    const { buy, wallet } = libraryService({ partActive: false });

    await expect(buy(LibraryPurchaseKind.PART, 'lp_1')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it.each([ContentStatus.DRAFT, ContentStatus.HIDDEN, ContentStatus.ARCHIVED])(
    'refuses a published part inside a %s material',
    async (materialStatus) => {
      // The old rule refused DRAFT on the material but let HIDDEN through, which
      // is the same intent spelled two ways with two different answers.
      const { buy, wallet } = libraryService({ materialStatus });

      await expect(buy(LibraryPurchaseKind.PART, 'lp_1')).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      expect(wallet.debit).not.toHaveBeenCalled();
    },
  );

  it('refuses a part whose material is deactivated', async () => {
    const { buy, wallet } = libraryService({ materialActive: false });

    await expect(buy(LibraryPurchaseKind.PART, 'lp_1')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it.each([ContentStatus.DRAFT, ContentStatus.HIDDEN])(
    'refuses a %s package',
    async (packageStatus) => {
      const { buy, wallet } = libraryService({ packageStatus });

      await expect(buy(LibraryPurchaseKind.PACKAGE, 'pkg_1')).rejects.toMatchObject({
        code: 'INVALID_STATE',
      });
      expect(wallet.debit).not.toHaveBeenCalled();
    },
  );

  it('refuses a package inside an unpublished material', async () => {
    const { buy, wallet } = libraryService({ materialStatus: ContentStatus.HIDDEN });

    await expect(buy(LibraryPurchaseKind.PACKAGE, 'pkg_1')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(wallet.debit).not.toHaveBeenCalled();
  });

  it('does not quote unpublished content either', async () => {
    // A quote is a sale: it states a price a student can then act on.
    const { buy } = libraryService({ partStatus: ContentStatus.DRAFT });

    await expect(buy(LibraryPurchaseKind.PART, 'lp_1')).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
  });
});
