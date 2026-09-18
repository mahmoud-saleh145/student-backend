import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  ContentStatus,
  LibraryEntitlementSource,
  LibraryPurchaseKind,
  Prisma,
  UserRole,
  WalletTxSource,
  WalletTxType,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { MONEY_TX_OPTIONS, PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { fromPiastres, parseAmount, toEgpNumber } from '../wallet/money';
import { WalletService } from '../wallet/wallet.service';

export interface LibraryPurchaseResult {
  purchaseId: string;
  kind: LibraryPurchaseKind;
  targetId: string;
  title: string;
  pricePaid: number;
  currency: string;
  balanceAfter: number;
  /** Parts the student can now open as a result of this purchase. */
  partsGranted: number;
  /** Parts in the bundle they already held; granted nothing new. */
  partsAlreadyOwned: number;
  purchasedAt: string;
  /** True when a retry returned the original purchase rather than buying again. */
  alreadyPurchased: boolean;
}

/**
 * Buying library documents with wallet credits.
 *
 * ── This is what the wallet is for ──────────────────────────────────────────
 *
 * Library parts and packages are the *only* things credits buy. Courses never
 * debit the wallet — they are sold as access cards, offline. The two financial
 * systems do not meet, and nothing in this file knows what a course is.
 *
 * ── The invariant ───────────────────────────────────────────────────────────
 *
 *   The wallet debit and the entitlements succeed together, or neither happens.
 *
 * Every step below runs inside ONE Serializable transaction
 * (`MONEY_TX_OPTIONS`). A debit with no entitlement takes a student's credits
 * and gives nothing; an entitlement with no debit gives documents away.
 *
 * ── Entitlements are always per part ────────────────────────────────────────
 *
 * Buying a package writes one `library_entitlements` row per included part.
 * That is what makes the access check a single indexed lookup, and it is also
 * what freezes the package's membership: editing the package next month cannot
 * reach backwards and change what somebody already owns, because what they own
 * is a set of parts, not a pointer to a package.
 *
 * ── Money ───────────────────────────────────────────────────────────────────
 *
 * The price is read from the database inside the transaction. The request
 * carries no amount and there is no parameter to put one in. Arithmetic is
 * integer piastres; no float touches a credit value.
 *
 * Spending credits is an *allocation* of cash already recognised at recharge
 * (`recharge_revenue`), not new revenue. No `revenue_ledger` row is written —
 * counting both would double-count every pound.
 */
@Injectable()
export class LibraryPurchaseService {
  private readonly logger = new Logger(LibraryPurchaseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Quotes
  // ---------------------------------------------------------------------------

  /**
   * Prices a part or package without buying it.
   *
   * For a package this also reports how much of it the student already owns,
   * because a bundle overlapping what they hold is worth less to them than the
   * sticker price suggests and they deserve to know before they spend.
   */
  async quote(params: {
    userId: string;
    kind: LibraryPurchaseKind;
    targetId: string;
  }) {
    const [balance, target] = await Promise.all([
      this.wallet.summary(params.userId),
      params.kind === LibraryPurchaseKind.PART
        ? this.loadPart(this.prisma, params.targetId)
        : this.loadPackage(this.prisma, params.targetId),
    ]);

    const owned = await this.ownedPartIds(
      this.prisma,
      params.userId,
      target.partIds,
    );

    const price = toEgpNumber(target.pricePiastres);

    return {
      kind: params.kind,
      targetId: params.targetId,
      title: target.title,
      materialTitle: target.materialTitle,
      price,
      currency: target.currency,
      balance: balance.balance,
      sufficientCredit: balance.balance >= price,
      shortfall: Math.max(0, Number((price - balance.balance).toFixed(2))),
      partCount: target.partIds.length,
      partsAlreadyOwned: owned.size,
      /** Everything in it is already owned — buying would grant nothing. */
      fullyOwned: target.partIds.length > 0 && owned.size === target.partIds.length,
      purchasable: target.pricePiastres > 0 && target.partIds.length > 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Purchase
  // ---------------------------------------------------------------------------

  async purchase(params: {
    userId: string;
    userRole: UserRole;
    kind: LibraryPurchaseKind;
    targetId: string;
  }): Promise<LibraryPurchaseResult> {
    const idempotencyKey =
      params.kind === LibraryPurchaseKind.PART
        ? `libpart:${params.targetId}:${params.userId}`
        : `libpkg:${params.targetId}:${params.userId}`;

    // The retry path — far more common than a genuine race — answers without
    // opening a transaction.
    const existing = await this.findExisting(idempotencyKey);
    if (existing) return existing;

    const result = await this.prisma
      .$transaction(async (tx) => {
        const target =
          params.kind === LibraryPurchaseKind.PART
            ? await this.loadPart(tx, params.targetId)
            : await this.loadPackage(tx, params.targetId);

        if (target.partIds.length === 0) {
          throw new AppException(ErrorCode.INVALID_STATE, {
            message: 'This item has no readable content and cannot be bought',
          });
        }

        // A zero price is a configuration mistake, not a free item: free
        // content is published with `isPreview`, which needs no purchase at
        // all. Charging nothing and writing a ledger entry for nothing would
        // put a meaningless row in the money history.
        if (target.pricePiastres <= 0) {
          throw new AppException(ErrorCode.INVALID_STATE, {
            message: 'This item is not for sale',
          });
        }

        const student = await tx.user.findFirst({
          where: { id: params.userId, ...notDeleted },
          select: { id: true, status: true },
        });
        if (!student) throw AppException.notFound('Student', params.userId);
        if (student.status !== 'ACTIVE') {
          throw new AppException(ErrorCode.ACCOUNT_DISABLED);
        }

        const owned = await this.ownedPartIds(tx, params.userId, target.partIds);

        // Everything in it is already owned. Taking credits for nothing is
        // worse than an error, so this is refused rather than allowed through.
        // A package that only *partly* overlaps is allowed: it is a bundle at a
        // bundle price, and the quote told them what they already held.
        if (owned.size === target.partIds.length) {
          throw AppException.conflict(
            params.kind === LibraryPurchaseKind.PART
              ? 'You already own this'
              : 'You already own every item in this package',
            { targetId: params.targetId },
          );
        }

        // --- the debit -----------------------------------------------------
        // Throws INSUFFICIENT_CREDIT, which rolls back everything above.
        const entry = await this.wallet.debit(tx, {
          userId: params.userId,
          amount: fromPiastres(target.pricePiastres),
          type: WalletTxType.PURCHASE,
          source:
            params.kind === LibraryPurchaseKind.PART
              ? WalletTxSource.LIBRARY_PART
              : WalletTxSource.LIBRARY_PACKAGE,
          reference: { type: `LIBRARY_${params.kind}`, id: params.targetId },
          note: target.materialTitle
            ? `${target.materialTitle} — ${target.title}`
            : target.title,
          idempotencyKey,
        });

        const purchase = await tx.libraryPurchase.create({
          data: {
            userId: params.userId,
            kind: params.kind,
            libraryPartId:
              params.kind === LibraryPurchaseKind.PART ? params.targetId : null,
            libraryPackageId:
              params.kind === LibraryPurchaseKind.PACKAGE ? params.targetId : null,
            priceAtPurchase: fromPiastres(target.pricePiastres),
            currency: target.currency,
            titleSnapshot: target.title,
            materialTitleSnapshot: target.materialTitle,
            // The whole membership, not just what was newly granted. This is
            // the explicit record of what the package contained on this day.
            partIdsSnapshot: target.partIds,
            walletTransactionId: entry.id,
            idempotencyKey,
          },
          select: { id: true, purchasedAt: true },
        });

        // One entitlement per part not already held. `createMany` with
        // `skipDuplicates` leans on the unique (userId, libraryPartId) index,
        // so a concurrent purchase that got there first cannot cause a crash —
        // it simply contributes nothing.
        const toGrant = target.partIds.filter((id) => !owned.has(id));

        await tx.libraryEntitlement.createMany({
          data: toGrant.map((libraryPartId) => ({
            userId: params.userId,
            libraryPartId,
            source:
              params.kind === LibraryPurchaseKind.PART
                ? LibraryEntitlementSource.PURCHASE
                : LibraryEntitlementSource.PACKAGE,
            purchaseId: purchase.id,
          })),
          skipDuplicates: true,
        });

        return {
          purchaseId: purchase.id,
          kind: params.kind,
          targetId: params.targetId,
          title: target.title,
          pricePaid: toEgpNumber(target.pricePiastres),
          currency: target.currency,
          balanceAfter: entry.balanceAfter,
          partsGranted: toGrant.length,
          partsAlreadyOwned: owned.size,
          purchasedAt: purchase.purchasedAt.toISOString(),
          alreadyPurchased: false,
        };
      }, MONEY_TX_OPTIONS)
      .catch(async (error: unknown) => {
        // A unique violation means a concurrent request won. From the
        // student's point of view they now own it, so the original purchase is
        // returned rather than an error.
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          const winner = await this.findExisting(idempotencyKey);
          if (winner) {
            this.logger.warn(
              `concurrent library purchase ${idempotencyKey}; returning the winning record`,
            );
            return winner;
          }
        }
        throw error;
      });

    if (result.alreadyPurchased) return result;

    await this.audit.record({
      actorId: params.userId,
      actorRole: params.userRole,
      action: AuditAction.WALLET_DEBIT,
      entity: 'library_purchase',
      entityId: result.purchaseId,
      after: {
        kind: result.kind,
        targetId: result.targetId,
        title: result.title,
        pricePaid: result.pricePaid,
        partsGranted: result.partsGranted,
        balanceAfter: result.balanceAfter,
      },
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------

  async myPurchases(userId: string, page: number, pageSize: number) {
    const where = { userId };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.libraryPurchase.findMany({
        where,
        orderBy: { purchasedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          kind: true,
          libraryPartId: true,
          libraryPackageId: true,
          titleSnapshot: true,
          materialTitleSnapshot: true,
          priceAtPurchase: true,
          currency: true,
          partIdsSnapshot: true,
          purchasedAt: true,
        },
      }),
      this.prisma.libraryPurchase.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        targetId: row.libraryPartId ?? row.libraryPackageId,
        title: row.titleSnapshot,
        materialTitle: row.materialTitleSnapshot,
        // The frozen price. A later change never appears here.
        pricePaid: Number(row.priceAtPurchase),
        currency: row.currency,
        partCount: row.partIdsSnapshot.length,
        purchasedAt: row.purchasedAt.toISOString(),
      })),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / Math.max(1, pageSize))),
        hasNext: page * pageSize < total,
        hasPrevious: page > 1,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async findExisting(
    idempotencyKey: string,
  ): Promise<LibraryPurchaseResult | null> {
    const row = await this.prisma.libraryPurchase.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        userId: true,
        kind: true,
        libraryPartId: true,
        libraryPackageId: true,
        titleSnapshot: true,
        priceAtPurchase: true,
        currency: true,
        partIdsSnapshot: true,
        purchasedAt: true,
      },
    });
    if (!row) return null;

    const wallet = await this.wallet.summary(row.userId);

    return {
      purchaseId: row.id,
      kind: row.kind,
      targetId: (row.libraryPartId ?? row.libraryPackageId)!,
      title: row.titleSnapshot,
      pricePaid: Number(row.priceAtPurchase),
      currency: row.currency,
      balanceAfter: wallet.balance,
      partsGranted: row.partIdsSnapshot.length,
      partsAlreadyOwned: 0,
      purchasedAt: row.purchasedAt.toISOString(),
      alreadyPurchased: true,
    };
  }

  /** Which of these parts the student already holds, unrevoked. */
  private async ownedPartIds(
    tx: Prisma.TransactionClient | PrismaService,
    userId: string,
    partIds: string[],
  ): Promise<Set<string>> {
    if (partIds.length === 0) return new Set();

    const rows = await tx.libraryEntitlement.findMany({
      where: { userId, libraryPartId: { in: partIds }, revokedAt: null },
      select: { libraryPartId: true },
    });
    return new Set(rows.map((r) => r.libraryPartId));
  }

  private async loadPart(
    tx: Prisma.TransactionClient | PrismaService,
    partId: string,
  ) {
    const part = await tx.libraryPart.findFirst({
      where: { id: partId, ...notDeleted },
      include: { material: { select: { title: true, status: true, isActive: true, deletedAt: true } } },
    });
    if (!part) throw AppException.notFound('Library part', partId);

    this.assertOnSale(part.isActive, part.status, part.material);

    return {
      title: part.title,
      materialTitle: part.material.title,
      currency: part.currency,
      pricePiastres: parseAmount(part.price.toString(), 'price'),
      partIds: [part.id],
    };
  }

  private async loadPackage(
    tx: Prisma.TransactionClient | PrismaService,
    packageId: string,
  ) {
    const pkg = await tx.libraryPackage.findFirst({
      where: { id: packageId, ...notDeleted },
      include: {
        material: { select: { title: true, status: true, isActive: true, deletedAt: true } },
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            part: {
              select: {
                id: true,
                isActive: true,
                status: true,
                deletedAt: true,
              },
            },
          },
        },
      },
    });
    if (!pkg) throw AppException.notFound('Library package', packageId);

    if (!pkg.isActive || pkg.status === ContentStatus.ARCHIVED || pkg.deletedAt) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This package is not currently on sale',
      });
    }

    // Withdrawn parts are excluded from what the buyer receives. Selling access
    // to material that has been taken down would be selling nothing.
    const partIds = pkg.items
      .filter(
        (item) =>
          item.part.isActive &&
          item.part.deletedAt === null &&
          item.part.status !== ContentStatus.ARCHIVED,
      )
      .map((item) => item.part.id);

    return {
      title: pkg.title,
      materialTitle: pkg.material?.title ?? null,
      currency: pkg.currency,
      pricePiastres: parseAmount(pkg.price.toString(), 'price'),
      partIds,
    };
  }

  private assertOnSale(
    isActive: boolean,
    status: ContentStatus,
    material: { status: ContentStatus; isActive: boolean; deletedAt: Date | null },
  ): void {
    if (!isActive || status === ContentStatus.ARCHIVED) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This item is not currently on sale',
      });
    }
    if (
      material.deletedAt ||
      !material.isActive ||
      material.status === ContentStatus.ARCHIVED ||
      material.status === ContentStatus.DRAFT
    ) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This material is not currently available',
      });
    }
  }
}
