import {
  ContentStatus,
  LibraryEntitlementSource,
  LibraryPurchaseKind,
  WalletTxSource,
  WalletTxType,
} from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { LibraryPurchaseService } from '../../src/modules/library/library-purchase.service';

/**
 * Buying library documents with wallet credits.
 *
 * Two themes, and the tests are grouped by them:
 *
 *  1. **The debit and the entitlements are one unit.** A refused purchase must
 *     leave nothing behind — no entitlement, no purchase row. Most of these
 *     tests therefore assert on what was NOT written.
 *
 *  2. **A package's membership is frozen by construction.** Buying a package
 *     writes one entitlement per part, so editing the package next month cannot
 *     reach backwards into what somebody already owns. The snapshot column
 *     records the same thing a second time, explicitly.
 */

const MATERIAL = {
  title: 'Physics Revision Papers',
  status: ContentStatus.PUBLISHED,
  isActive: true,
  deletedAt: null,
};

/** Three parts at 50 / 40 / 50, and a package of all three at 120. */
const PARTS = [
  { id: 'lp_1', title: 'Part 1 — Before Mid', price: '50', currency: 'EGP' },
  { id: 'lp_2', title: 'Part 2 — Mid', price: '40', currency: 'EGP' },
  { id: 'lp_3', title: 'Part 3 — After Mid', price: '50', currency: 'EGP' },
];

interface Options {
  /** Part ids the student already holds. */
  owns?: string[];
  existingPurchase?: Record<string, unknown> | null;
  insufficientCredit?: boolean;
  partOverrides?: Record<string, unknown>;
  packageOverrides?: Record<string, unknown>;
  /** Parts inside the package that are withdrawn and must be excluded. */
  withdrawnPartIds?: string[];
}

function build(options: Options = {}) {
  const owns = new Set(options.owns ?? []);
  const withdrawn = new Set(options.withdrawnPartIds ?? []);

  const part = {
    ...PARTS[0],
    isActive: true,
    status: ContentStatus.PUBLISHED,
    deletedAt: null,
    ...options.partOverrides,
    material: MATERIAL,
  };

  const pkg = {
    id: 'pkg_1',
    title: 'Complete Physics Revision Package',
    price: '120',
    currency: 'EGP',
    isActive: true,
    status: ContentStatus.PUBLISHED,
    deletedAt: null,
    ...options.packageOverrides,
    material: MATERIAL,
    items: PARTS.map((p, i) => ({
      sortOrder: i,
      part: {
        id: p.id,
        isActive: !withdrawn.has(p.id),
        status: withdrawn.has(p.id) ? ContentStatus.ARCHIVED : ContentStatus.PUBLISHED,
        deletedAt: null,
      },
    })),
  };

  const purchaseCreate = jest.fn(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: 'lpu_1',
      purchasedAt: new Date('2026-09-18T04:00:00Z'),
      ...data,
    }),
  );
  const entitlementCreateMany = jest.fn(
    async (_args: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => ({
      count: _args.data.length,
    }),
  );

  const tx = {
    libraryPart: { findFirst: jest.fn(async () => part) },
    libraryPackage: { findFirst: jest.fn(async () => pkg) },
    user: { findFirst: jest.fn(async () => ({ id: 'usr_1', status: 'ACTIVE' })) },
    libraryEntitlement: {
      findMany: jest.fn(async ({ where }: { where: { libraryPartId: { in: string[] } } }) =>
        where.libraryPartId.in
          .filter((id) => owns.has(id))
          .map((libraryPartId) => ({ libraryPartId })),
      ),
      createMany: entitlementCreateMany,
    },
    libraryPurchase: { create: purchaseCreate },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    libraryPurchase: {
      findUnique: jest.fn(async () => options.existingPurchase ?? null),
    },
    libraryPart: { findFirst: jest.fn(async () => part) },
    libraryPackage: { findFirst: jest.fn(async () => pkg) },
    libraryEntitlement: {
      findMany: jest.fn(async ({ where }: { where: { libraryPartId: { in: string[] } } }) =>
        where.libraryPartId.in
          .filter((id) => owns.has(id))
          .map((libraryPartId) => ({ libraryPartId })),
      ),
    },
  };

  const debit = jest.fn(async (_t: unknown, request: { amount: string }) => {
    if (options.insufficientCredit) {
      throw new AppException(ErrorCode.INSUFFICIENT_CREDIT);
    }
    return {
      id: 'wtx_1',
      walletId: 'wal_1',
      amount: Number(request.amount),
      balanceBefore: 500,
      balanceAfter: 500 - Number(request.amount),
      direction: 'DEBIT',
      type: WalletTxType.PURCHASE,
      createdAt: new Date(),
      replayed: false,
    };
  });

  const wallet = {
    debit,
    summary: jest.fn(async () => ({ balance: 500, currency: 'EGP' })),
  };
  const audit = { record: jest.fn(async () => undefined) };

  const service = new LibraryPurchaseService(
    prisma as never,
    wallet as never,
    audit as never,
  );

  return { service, tx, prisma, debit, purchaseCreate, entitlementCreateMany };
}

const BUY_PART = {
  userId: 'usr_1',
  userRole: 'STUDENT' as const,
  kind: LibraryPurchaseKind.PART,
  targetId: 'lp_1',
};

const BUY_PACKAGE = {
  userId: 'usr_1',
  userRole: 'STUDENT' as const,
  kind: LibraryPurchaseKind.PACKAGE,
  targetId: 'pkg_1',
};

describe('buying a single part', () => {
  it('charges the price held in the database', async () => {
    const { service, debit } = build();

    const result = await service.purchase(BUY_PART);

    expect(result.pricePaid).toBe(50);
    expect(debit.mock.calls[0][1]).toMatchObject({
      amount: '50.00',
      type: WalletTxType.PURCHASE,
      source: WalletTxSource.LIBRARY_PART,
    });
  });

  it('grants exactly one entitlement, sourced as a direct purchase', async () => {
    const { service, entitlementCreateMany } = build();

    const result = await service.purchase(BUY_PART);

    const rows = entitlementCreateMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      libraryPartId: 'lp_1',
      source: LibraryEntitlementSource.PURCHASE,
      purchaseId: 'lpu_1',
    });
    expect(result.partsGranted).toBe(1);
  });

  it('links the purchase to the ledger entry that paid for it', async () => {
    const { service, purchaseCreate } = build();

    await service.purchase(BUY_PART);

    expect(purchaseCreate.mock.calls[0][0].data.walletTransactionId).toBe('wtx_1');
  });

  it('refuses one the student already owns', async () => {
    const { service, debit } = build({ owns: ['lp_1'] });

    await expect(service.purchase(BUY_PART)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(debit).not.toHaveBeenCalled();
  });
});

describe('buying a package', () => {
  it('charges the package price, not the sum of its parts', async () => {
    // 120 for what costs 140 separately — the bundle discount is the point.
    const { service, debit } = build();

    const result = await service.purchase(BUY_PACKAGE);

    expect(result.pricePaid).toBe(120);
    expect(debit.mock.calls[0][1]).toMatchObject({
      amount: '120.00',
      source: WalletTxSource.LIBRARY_PACKAGE,
    });
  });

  it('writes one entitlement per included part', async () => {
    // This is what freezes the membership: what the student owns is a set of
    // parts, not a pointer to a package that someone may edit later.
    const { service, entitlementCreateMany } = build();

    await service.purchase(BUY_PACKAGE);
    const rows = entitlementCreateMany.mock.calls[0][0].data;

    expect(rows.map((r) => r.libraryPartId)).toEqual(['lp_1', 'lp_2', 'lp_3']);
    expect(rows.every((r) => r.source === LibraryEntitlementSource.PACKAGE)).toBe(true);
  });

  it('records the whole membership in the snapshot', async () => {
    const { service, purchaseCreate } = build();

    await service.purchase(BUY_PACKAGE);

    expect(purchaseCreate.mock.calls[0][0].data.partIdsSnapshot).toEqual([
      'lp_1',
      'lp_2',
      'lp_3',
    ]);
  });

  it('allows a package that partly overlaps what the student holds', async () => {
    // A bundle at a bundle price. The quote told them about the overlap; this
    // is not the place to refuse the sale.
    const { service, entitlementCreateMany, purchaseCreate } = build({ owns: ['lp_2'] });

    const result = await service.purchase(BUY_PACKAGE);

    expect(result.partsAlreadyOwned).toBe(1);
    expect(result.partsGranted).toBe(2);

    const granted = entitlementCreateMany.mock.calls[0][0].data.map((r) => r.libraryPartId);
    expect(granted).toEqual(['lp_1', 'lp_3']);

    // The snapshot still records everything the package contained.
    expect(purchaseCreate.mock.calls[0][0].data.partIdsSnapshot).toEqual([
      'lp_1',
      'lp_2',
      'lp_3',
    ]);
  });

  it('refuses a package the student already owns entirely', async () => {
    // Taking credits for nothing is worse than an error.
    const { service, debit } = build({ owns: ['lp_1', 'lp_2', 'lp_3'] });

    await expect(service.purchase(BUY_PACKAGE)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(debit).not.toHaveBeenCalled();
  });

  it('excludes withdrawn parts from what the buyer receives', async () => {
    const { service, entitlementCreateMany, purchaseCreate } = build({
      withdrawnPartIds: ['lp_2'],
    });

    await service.purchase(BUY_PACKAGE);

    const granted = entitlementCreateMany.mock.calls[0][0].data.map((r) => r.libraryPartId);
    expect(granted).toEqual(['lp_1', 'lp_3']);
    expect(purchaseCreate.mock.calls[0][0].data.partIdsSnapshot).toEqual(['lp_1', 'lp_3']);
  });
});

describe('atomicity', () => {
  it('writes neither purchase nor entitlement when the wallet refuses', async () => {
    const { service, purchaseCreate, entitlementCreateMany } = build({
      insufficientCredit: true,
    });

    await expect(service.purchase(BUY_PART)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_CREDIT,
    });

    expect(purchaseCreate).not.toHaveBeenCalled();
    expect(entitlementCreateMany).not.toHaveBeenCalled();
  });

  it('debits only after every validation has passed', async () => {
    const { service, debit } = build({ owns: ['lp_1'] });

    await expect(service.purchase(BUY_PART)).rejects.toThrow(AppException);
    expect(debit).not.toHaveBeenCalled();
  });

  it('runs the whole purchase in one transaction', async () => {
    const { service, prisma } = build();

    await service.purchase(BUY_PART);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency and state', () => {
  it('returns the original purchase on a retry instead of buying twice', async () => {
    const { service, debit } = build({
      existingPurchase: {
        id: 'lpu_existing',
        userId: 'usr_1',
        kind: LibraryPurchaseKind.PART,
        libraryPartId: 'lp_1',
        libraryPackageId: null,
        titleSnapshot: 'Part 1 — Before Mid',
        priceAtPurchase: '50.00',
        currency: 'EGP',
        partIdsSnapshot: ['lp_1'],
        purchasedAt: new Date('2026-09-18T03:00:00Z'),
      },
    });

    const result = await service.purchase(BUY_PART);

    expect(result.alreadyPurchased).toBe(true);
    expect(result.purchaseId).toBe('lpu_existing');
    expect(debit).not.toHaveBeenCalled();
  });

  it('keys idempotency per student and per item', async () => {
    const { service, debit } = build();

    await service.purchase(BUY_PART);

    expect(debit.mock.calls[0][1]).toMatchObject({
      idempotencyKey: 'libpart:lp_1:usr_1',
    });
  });

  it('refuses an item priced at zero rather than writing an empty ledger row', async () => {
    // Free content is published with `isPreview` and needs no purchase at all.
    const { service, debit } = build({ partOverrides: { price: '0' } });

    await expect(service.purchase(BUY_PART)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(debit).not.toHaveBeenCalled();
  });

  it('refuses a deactivated part', async () => {
    const { service, debit } = build({ partOverrides: { isActive: false } });

    await expect(service.purchase(BUY_PART)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(debit).not.toHaveBeenCalled();
  });

  it('refuses a package whose parts have all been withdrawn', async () => {
    const { service, debit } = build({ withdrawnPartIds: ['lp_1', 'lp_2', 'lp_3'] });

    await expect(service.purchase(BUY_PACKAGE)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(debit).not.toHaveBeenCalled();
  });

  it('refuses a disabled student account', async () => {
    const { service, tx, debit } = build();
    tx.user.findFirst = jest.fn(async () => ({ id: 'usr_1', status: 'DISABLED' }));

    await expect(service.purchase(BUY_PART)).rejects.toMatchObject({
      code: ErrorCode.ACCOUNT_DISABLED,
    });
    expect(debit).not.toHaveBeenCalled();
  });
});

describe('quotes', () => {
  it('reports the shortfall when credit is short', async () => {
    const { service, prisma } = build();
    prisma.libraryPackage.findFirst = jest.fn(async () => ({
      id: 'pkg_1',
      title: 'Expensive bundle',
      price: '900',
      currency: 'EGP',
      isActive: true,
      status: ContentStatus.PUBLISHED,
      deletedAt: null,
      material: MATERIAL,
      items: PARTS.map((p, i) => ({
        sortOrder: i,
        part: { id: p.id, isActive: true, status: ContentStatus.PUBLISHED, deletedAt: null },
      })),
    }));

    const quote = await service.quote({
      userId: 'usr_1',
      kind: LibraryPurchaseKind.PACKAGE,
      targetId: 'pkg_1',
    });

    expect(quote.price).toBe(900);
    expect(quote.sufficientCredit).toBe(false);
    expect(quote.shortfall).toBe(400);
  });

  it('warns that a bundle is already fully owned', async () => {
    const { service } = build({ owns: ['lp_1', 'lp_2', 'lp_3'] });

    const quote = await service.quote({
      userId: 'usr_1',
      kind: LibraryPurchaseKind.PACKAGE,
      targetId: 'pkg_1',
    });

    expect(quote.partsAlreadyOwned).toBe(3);
    expect(quote.fullyOwned).toBe(true);
  });
});
