import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  CodeKind,
  CodeStatus,
  type Prisma,
  UserRole,
  WalletTxDirection,
  WalletTxSource,
  WalletTxType,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { MONEY_TX_OPTIONS, PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

import { fromPiastres, parseAmount, toEgpNumber, toPiastres } from './money';

/**
 * A credit movement, as the rest of the platform asks for it.
 *
 * `reference` is how a purchase links itself to its ledger entry without this
 * module needing to know what a course part or a library package is. Later
 * phases pass `{ type: 'COURSE_PART', id }` and nothing here changes.
 */
export interface LedgerRequest {
  userId: string;
  /** EGP. Always positive; `credit()` and `debit()` carry the direction. */
  amount: number | string;
  type: WalletTxType;
  source: WalletTxSource;
  accessCodeId?: string | null;
  reference?: { type: string; id: string } | null;
  performedByAdminId?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue | null;
  /**
   * Makes a retried request harmless. A second call with the same key returns
   * the first entry instead of moving credit again.
   */
  idempotencyKey?: string | null;
}

export interface LedgerEntry {
  id: string;
  walletId: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  direction: WalletTxDirection;
  type: WalletTxType;
  createdAt: Date;
  /** True when an existing entry was returned for a repeated idempotency key. */
  replayed: boolean;
}

/**
 * Wallet and credit ledger.
 *
 * ── The money rules, and how each one is actually enforced ──────────────────
 *
 * **The ledger is the truth.** `wallets.balance` is a cache. It is only ever
 * written in the same database transaction as the `wallet_transactions` row
 * that explains the change, so the two cannot drift. `verifyIntegrity()`
 * re-derives the balance from the ledger and reports any difference; it exists
 * because a cache nobody checks is a cache nobody should trust.
 *
 * **Nothing is ever edited.** There is no update or delete path for a ledger
 * row anywhere in this service. A mistake is corrected by writing a
 * compensating REVERSAL or ADMIN_ADJUSTMENT entry, which leaves the original
 * visible. That is what makes the history auditable rather than merely stored.
 *
 * **A balance cannot go negative.** Three independent mechanisms, because this
 * is the one failure that turns into real money:
 *
 *   1. The debit is a single conditional statement —
 *      `UPDATE wallets SET balance = balance - x WHERE id = ? AND balance >= x`
 *      — so the check and the deduction are the same atomic operation. Two
 *      concurrent purchases cannot both pass the check: whichever commits
 *      second finds the balance already reduced and updates zero rows.
 *   2. The caller runs it inside a Serializable transaction
 *      (`MONEY_TX_OPTIONS`), so the surrounding purchase rolls back as a unit.
 *   3. A CHECK constraint on the column refuses a negative balance outright,
 *      whatever the application does.
 *
 * Read-modify-write on the balance in application code would defeat all three,
 * which is why the raw statement is used rather than `prisma.wallet.update`.
 *
 * **Every method that moves credit takes a transaction client.** Crediting a
 * wallet is never the whole operation — it is always part of "redeem this code
 * *and* record the revenue" or "debit *and* create the entitlement". Composing
 * at the caller is what lets the whole thing roll back together.
 * ────────────────────────────────────────────────────────────────────────────
 */
@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Wallet lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Returns the user's wallet, creating it on first touch.
   *
   * Lazy creation rather than a registration hook: every student who existed
   * before this feature would otherwise need a back-fill, and a back-fill that
   * misses a row produces a confusing "no wallet" error months later. `upsert`
   * on the unique `userId` makes a concurrent first purchase safe.
   */
  async ensureWallet(
    userId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<{ id: string; balance: string; currency: string }> {
    const db = tx ?? this.prisma;

    const wallet = await db.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
      select: { id: true, balance: true, currency: true },
    });

    return {
      id: wallet.id,
      balance: wallet.balance.toString(),
      currency: wallet.currency,
    };
  }

  /** The student-facing summary. */
  async summary(userId: string) {
    const wallet = await this.ensureWallet(userId);
    const row = await this.prisma.wallet.findUniqueOrThrow({
      where: { id: wallet.id },
      select: {
        balance: true,
        currency: true,
        totalRecharged: true,
        totalSpent: true,
        updatedAt: true,
        _count: { select: { transactions: true } },
      },
    });

    return {
      balance: Number(row.balance),
      currency: row.currency,
      totalRecharged: Number(row.totalRecharged),
      totalSpent: Number(row.totalSpent),
      transactionCount: row._count.transactions,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // Ledger writes
  // ---------------------------------------------------------------------------

  /** Adds credit. See the class note for why this takes a transaction client. */
  async credit(tx: Prisma.TransactionClient, request: LedgerRequest): Promise<LedgerEntry> {
    return this.move(tx, request, WalletTxDirection.CREDIT);
  }

  /**
   * Spends credit, refusing rather than overdrawing.
   *
   * Throws `INSUFFICIENT_CREDIT` when the balance will not cover the amount —
   * including when a concurrent debit got there first, which is the case the
   * conditional UPDATE exists for.
   */
  async debit(tx: Prisma.TransactionClient, request: LedgerRequest): Promise<LedgerEntry> {
    return this.move(tx, request, WalletTxDirection.DEBIT);
  }

  private async move(
    tx: Prisma.TransactionClient,
    request: LedgerRequest,
    direction: WalletTxDirection,
  ): Promise<LedgerEntry> {
    // `parseAmount`, not `toPiastres`: this value comes from a caller, so a
    // malformed one is a bad request (422 naming the field), never a 500.
    const piastres = parseAmount(request.amount);
    if (piastres <= 0) {
      throw AppException.validation({ amount: ['must be greater than zero'] });
    }
    const amount = fromPiastres(piastres);

    // Replay protection first: a retried HTTP request must not move credit a
    // second time, and answering from the existing row is both correct and
    // cheaper than discovering the unique-index violation.
    if (request.idempotencyKey) {
      const existing = await tx.walletTransaction.findUnique({
        where: { idempotencyKey: request.idempotencyKey },
        select: {
          id: true,
          walletId: true,
          amount: true,
          balanceBefore: true,
          balanceAfter: true,
          direction: true,
          type: true,
          createdAt: true,
        },
      });
      if (existing) {
        return {
          id: existing.id,
          walletId: existing.walletId,
          amount: Number(existing.amount),
          balanceBefore: Number(existing.balanceBefore),
          balanceAfter: Number(existing.balanceAfter),
          direction: existing.direction,
          type: existing.type,
          createdAt: existing.createdAt,
          replayed: true,
        };
      }
    }

    const wallet = await this.ensureWallet(request.userId, tx);

    // One statement does the check and the movement together. Splitting them
    // into a read and a write is precisely the race this avoids.
    const updated =
      direction === WalletTxDirection.CREDIT
        ? await tx.$queryRaw<{ balance: string }[]>`
            UPDATE "wallets"
               SET "balance"        = "balance" + ${amount}::decimal,
                   "totalRecharged" = "totalRecharged" + ${amount}::decimal,
                   "version"        = "version" + 1,
                   "updatedAt"      = NOW()
             WHERE "id" = ${wallet.id}
            RETURNING "balance"::text AS balance`
        : await tx.$queryRaw<{ balance: string }[]>`
            UPDATE "wallets"
               SET "balance"    = "balance" - ${amount}::decimal,
                   "totalSpent" = "totalSpent" + ${amount}::decimal,
                   "version"    = "version" + 1,
                   "updatedAt"  = NOW()
             WHERE "id" = ${wallet.id}
               AND "balance" >= ${amount}::decimal
            RETURNING "balance"::text AS balance`;

    if (updated.length === 0) {
      // For a debit this is the expected, correct outcome of an overdraw
      // attempt. For a credit it means the wallet vanished mid-transaction,
      // which should be impossible.
      if (direction === WalletTxDirection.DEBIT) {
        throw new AppException(ErrorCode.INSUFFICIENT_CREDIT, {
          details: { required: toEgpNumber(piastres) },
        });
      }
      throw new AppException(ErrorCode.SERVER_ERROR, {
        message: `wallet ${wallet.id} disappeared during a credit`,
      });
    }

    const afterPiastres = toPiastres(updated[0].balance, 'balance');
    const beforePiastres =
      direction === WalletTxDirection.CREDIT
        ? afterPiastres - piastres
        : afterPiastres + piastres;

    const entry = await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        userId: request.userId,
        type: request.type,
        direction,
        source: request.source,
        amount,
        currency: wallet.currency,
        balanceBefore: fromPiastres(beforePiastres),
        balanceAfter: fromPiastres(afterPiastres),
        accessCodeId: request.accessCodeId ?? null,
        referenceType: request.reference?.type ?? null,
        referenceId: request.reference?.id ?? null,
        performedByAdminId: request.performedByAdminId ?? null,
        note: request.note ?? null,
        metadata: request.metadata ?? undefined,
        idempotencyKey: request.idempotencyKey ?? null,
      },
      select: { id: true, createdAt: true },
    });

    return {
      id: entry.id,
      walletId: wallet.id,
      amount: toEgpNumber(piastres),
      balanceBefore: toEgpNumber(beforePiastres),
      balanceAfter: toEgpNumber(afterPiastres),
      direction,
      type: request.type,
      createdAt: entry.createdAt,
      replayed: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Redemption
  // ---------------------------------------------------------------------------

  /**
   * Redeems a recharge code into the student's wallet.
   *
   * Everything below happens in one Serializable transaction, so a failure at
   * any step leaves no trace at all — no half-consumed code, no orphan credit,
   * no revenue row without a redemption:
   *
   *   1. the code is re-read and re-validated *inside* the transaction;
   *   2. the wallet is credited with the code's frozen `creditAmount`;
   *   3. the redemption row is written (the unique `(codeId, userId)` index is
   *      the real double-redeem guarantee);
   *   4. the code is marked exhausted;
   *   5. the immutable revenue row is written at `actualPaidAmount`.
   *
   * The amounts come from the code, never from the request. A client that
   * posts an amount is ignored — there is no parameter to post it into.
   */
  async redeemRechargeCode(params: {
    rawCode: string;
    userId: string;
    ipAddress?: string | null;
    deviceKey?: string | null;
  }) {
    const normalized = params.rawCode.trim().toUpperCase().replace(/\s+/g, '');

    const result = await this.prisma.$transaction(async (tx) => {
      const code = await tx.accessCode.findUnique({
        where: { code: normalized },
        include: { batch: { select: { id: true, name: true } } },
      });

      // Unknown, revoked and expired codes deliberately produce the identical
      // error: distinguishing them turns this endpoint into an oracle for
      // guessing valid codes.
      const invalid = () => new AppException(ErrorCode.INVALID_CODE);

      if (!code) throw invalid();
      if (code.kind !== CodeKind.RECHARGE) {
        throw new AppException(ErrorCode.CODE_NOT_RECHARGEABLE);
      }
      if (code.status === CodeStatus.REVOKED) throw invalid();
      if (code.status === CodeStatus.EXPIRED) throw invalid();
      if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) throw invalid();
      if (code.reservedForUserId && code.reservedForUserId !== params.userId) throw invalid();
      if (code.redemptionCount >= code.maxRedemptions) {
        throw new AppException(ErrorCode.CODE_ALREADY_USED);
      }

      const already = await tx.accessCodeRedemption.findUnique({
        where: { codeId_userId: { codeId: code.id, userId: params.userId } },
        select: { id: true },
      });
      if (already) throw new AppException(ErrorCode.CODE_ALREADY_USED);

      // A RECHARGE code without its frozen amounts is a corrupt row, not a
      // zero-value card. Refusing is safer than inventing a number.
      if (code.creditAmount === null || code.actualPaidAmount === null || code.faceValue === null) {
        this.logger.error(`recharge code ${code.id} is missing its frozen amounts`);
        throw invalid();
      }

      // Same treatment as the missing-amount case above: a corrupt row is a
      // card we refuse, logged loudly, rather than an unhandled error that
      // reaches the student as "the server broke".
      let creditPiastres: number;
      try {
        creditPiastres = toPiastres(code.creditAmount, 'creditAmount');
      } catch {
        this.logger.error(`recharge code ${code.id} has a malformed creditAmount`);
        throw invalid();
      }

      // A fully discounted card is legal and credits nothing. It still has to
      // be consumed, and it still books a zero-revenue row, so the giveaway is
      // visible in the report rather than absent from it.
      const entry =
        creditPiastres > 0
          ? await this.credit(tx, {
              userId: params.userId,
              amount: code.creditAmount.toString(),
              type: WalletTxType.CREDIT_RECHARGE,
              source: WalletTxSource.PAYMENT_CODE,
              accessCodeId: code.id,
              reference: { type: 'ACCESS_CODE', id: code.id },
              note: code.batch?.name ? `Recharge — ${code.batch.name}` : 'Recharge',
              idempotencyKey: `recharge:${code.id}:${params.userId}`,
            })
          : null;

      await tx.accessCodeRedemption.create({
        data: {
          codeId: code.id,
          userId: params.userId,
          courseId: null,
          ipAddress: params.ipAddress ?? null,
          deviceKey: params.deviceKey ?? null,
          walletTransactionId: entry?.id ?? null,
          creditedAmount: code.creditAmount,
        },
      });

      const nextCount = code.redemptionCount + 1;

      await tx.accessCode.update({
        where: { id: code.id },
        data: {
          redemptionCount: nextCount,
          status: nextCount >= code.maxRedemptions ? CodeStatus.EXHAUSTED : code.status,
          redeemedAt: new Date(),
          redeemedByUserId: params.userId,
        },
      });

      // The cash-in record. Written here, inside the same transaction, so
      // revenue and redemption can never disagree about what happened.
      await tx.rechargeRevenue.create({
        data: {
          accessCodeId: code.id,
          batchId: code.batchId,
          userId: params.userId,
          faceValue: code.faceValue,
          discountType: code.discountType,
          discountPercent: code.discountPercent,
          discountAmount: code.discountAmount ?? 0,
          actualPaidAmount: code.actualPaidAmount,
          creditAmount: code.creditAmount,
          currency: code.currency,
          batchNameSnapshot: code.batch?.name ?? null,
          codeSnapshot: code.code,
        },
      });

      const wallet = await tx.wallet.findUniqueOrThrow({
        where: { userId: params.userId },
        select: { balance: true, currency: true },
      });

      return {
        codeId: code.id,
        code: code.code,
        credited: Number(code.creditAmount),
        balance: Number(wallet.balance),
        currency: wallet.currency,
        transactionId: entry?.id ?? null,
      };
    }, MONEY_TX_OPTIONS);

    await this.audit.record({
      actorId: params.userId,
      actorRole: UserRole.STUDENT,
      action: AuditAction.CODE_REDEEM,
      entity: 'wallet_recharge',
      entityId: result.codeId,
      after: { credited: result.credited, balance: result.balance },
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Administrative adjustment
  // ---------------------------------------------------------------------------

  /**
   * Moves credit by hand.
   *
   * Requires a reason and records the administrator on both the ledger row and
   * the audit log — an unexplained balance change is the one thing that makes
   * a financial history worthless. A debit that would overdraw is refused like
   * any other.
   */
  async adjust(params: {
    userId: string;
    amount: number | string;
    direction: WalletTxDirection;
    reason: string;
    actor: { id: string; role: UserRole };
  }) {
    const student = await this.prisma.user.findFirst({
      where: { id: params.userId, role: UserRole.STUDENT, deletedAt: null },
      select: { id: true, fullName: true },
    });
    if (!student) throw AppException.notFound('Student', params.userId);

    const entry = await this.prisma.$transaction(async (tx) => {
      const request = {
        userId: params.userId,
        amount: params.amount,
        type: WalletTxType.ADMIN_ADJUSTMENT,
        source: WalletTxSource.ADMIN,
        performedByAdminId: params.actor.id,
        note: params.reason,
      } as const;

      return params.direction === WalletTxDirection.CREDIT
        ? this.credit(tx, request)
        : this.debit(tx, request);
    }, MONEY_TX_OPTIONS);

    await this.audit.record({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.WALLET_ADJUST,
      entity: 'wallet',
      entityId: entry.walletId,
      before: { balance: entry.balanceBefore },
      after: {
        balance: entry.balanceAfter,
        direction: params.direction,
        amount: entry.amount,
        studentId: params.userId,
        transactionId: entry.id,
      },
      note: params.reason,
    });

    return {
      transactionId: entry.id,
      studentId: params.userId,
      direction: params.direction,
      amount: entry.amount,
      balanceBefore: entry.balanceBefore,
      balanceAfter: entry.balanceAfter,
    };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /**
   * Ledger history, server-side filtered, sorted and paginated.
   *
   * `userId` is supplied by the controller from the authenticated principal for
   * the student route and from the path for the admin route; it is never read
   * from the query string, so a student cannot page through another wallet.
   */
  async transactions(params: {
    page: number;
    pageSize: number;
    userId?: string;
    type?: WalletTxType;
    direction?: WalletTxDirection;
    source?: WalletTxSource;
    from?: Date;
    to?: Date;
    q?: string;
    order?: 'asc' | 'desc';
    /** Admin views include the acting administrator; student views must not. */
    includeAdmin?: boolean;
  }) {
    const where: Prisma.WalletTransactionWhereInput = {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.direction ? { direction: params.direction } : {}),
      ...(params.source ? { source: params.source } : {}),
      ...(params.from || params.to
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
      ...(params.q
        ? {
            OR: [
              { note: { contains: params.q, mode: 'insensitive' } },
              { referenceId: { contains: params.q } },
              { accessCodeId: { contains: params.q } },
              ...(params.includeAdmin
                ? [
                    {
                      user: { fullName: { contains: params.q, mode: 'insensitive' as const } },
                    },
                  ]
                : []),
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: params.order ?? 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          type: true,
          direction: true,
          source: true,
          amount: true,
          currency: true,
          balanceBefore: true,
          balanceAfter: true,
          referenceType: true,
          referenceId: true,
          accessCodeId: true,
          note: true,
          createdAt: true,
          user: { select: { id: true, fullName: true, phone: true } },
          performedByAdmin: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        type: row.type,
        direction: row.direction,
        source: row.source,
        amount: Number(row.amount),
        currency: row.currency,
        balanceBefore: Number(row.balanceBefore),
        balanceAfter: Number(row.balanceAfter),
        referenceType: row.referenceType,
        referenceId: row.referenceId,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
        // The administrative fields are selected once and dropped here rather
        // than switched in the `select`, because a conditional projection is
        // exactly the kind of thing that silently leaks a field after a later
        // edit. A student never sees who acted on their wallet, or which card
        // a credit came from.
        ...(params.includeAdmin
          ? {
              student: row.user,
              performedBy: row.performedByAdmin,
              accessCodeId: row.accessCodeId,
            }
          : {}),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /** Student balances for the admin table. */
  async listWallets(params: {
    page: number;
    pageSize: number;
    q?: string;
    order?: 'asc' | 'desc';
    sort?: 'balance' | 'totalSpent' | 'totalRecharged' | 'updatedAt';
    minBalance?: number;
  }) {
    const where: Prisma.WalletWhereInput = {
      user: {
        role: UserRole.STUDENT,
        deletedAt: null,
        ...(params.q
          ? {
              OR: [
                { fullName: { contains: params.q, mode: 'insensitive' } },
                { phone: { contains: params.q.replace(/\D/g, '') } },
              ],
            }
          : {}),
      },
      ...(params.minBalance !== undefined ? { balance: { gte: params.minBalance } } : {}),
    };

    // Built explicitly rather than from a computed key, so an unexpected sort
    // value cannot reach Prisma as a column name.
    const direction = params.order ?? 'desc';
    const orderBy: Prisma.WalletOrderByWithRelationInput =
      params.sort === 'totalSpent'
        ? { totalSpent: direction }
        : params.sort === 'totalRecharged'
          ? { totalRecharged: direction }
          : params.sort === 'updatedAt'
            ? { updatedAt: direction }
            : { balance: direction };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.wallet.findMany({
        where,
        orderBy,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          balance: true,
          currency: true,
          totalRecharged: true,
          totalSpent: true,
          updatedAt: true,
          user: { select: { id: true, fullName: true, phone: true } },
          _count: { select: { transactions: true } },
        },
      }),
      this.prisma.wallet.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        student: row.user,
        balance: Number(row.balance),
        currency: row.currency,
        totalRecharged: Number(row.totalRecharged),
        totalSpent: Number(row.totalSpent),
        transactionCount: row._count.transactions,
        updatedAt: row.updatedAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /**
   * Re-derives the balance from the ledger and compares it with the cache.
   *
   * This is the check that makes the cached balance safe to rely on. It is a
   * read-only diagnostic: when it reports a mismatch the fix is a compensating
   * ledger entry, never a silent write to `wallets.balance`, because the whole
   * point of the ledger is that it explains every pound.
   */
  async verifyIntegrity(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      select: { id: true, balance: true },
    });
    if (!wallet) throw AppException.notFound('Wallet for user', userId);

    const [credits, debits] = await this.prisma.$transaction([
      this.prisma.walletTransaction.aggregate({
        where: { walletId: wallet.id, direction: WalletTxDirection.CREDIT },
        _sum: { amount: true },
      }),
      this.prisma.walletTransaction.aggregate({
        where: { walletId: wallet.id, direction: WalletTxDirection.DEBIT },
        _sum: { amount: true },
      }),
    ]);

    const creditPiastres = toPiastres(credits._sum.amount ?? 0, 'credits');
    const debitPiastres = toPiastres(debits._sum.amount ?? 0, 'debits');
    const derived = creditPiastres - debitPiastres;
    const cached = toPiastres(wallet.balance, 'balance');

    const consistent = derived === cached;
    if (!consistent) {
      this.logger.error(
        `WALLET MISMATCH user=${userId} ledger=${fromPiastres(derived)} cached=${fromPiastres(cached)}`,
      );
    }

    return {
      walletId: wallet.id,
      userId,
      ledgerBalance: toEgpNumber(derived),
      cachedBalance: toEgpNumber(cached),
      difference: toEgpNumber(cached - derived),
      totalCredited: toEgpNumber(creditPiastres),
      totalDebited: toEgpNumber(debitPiastres),
      consistent,
    };
  }
}
