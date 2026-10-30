import { Injectable, Logger } from '@nestjs/common';
import {
  AccountDeletionStatus,
  AccountStatus,
  AuditAction,
  DeviceStatus,
  PlaybackTicketStatus,
  Prisma,
  SessionStatus,
  UserRole,
  WalletTxSource,
  WalletTxType,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';
import { PrismaService } from '../../database/prisma.service';
import { withSerializableRetry } from '../../database/serializable-retry';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';
import { AuthService, type RequestMeta } from '../auth/auth.service';
import { PasswordService } from '../auth/password.service';
import { StorageService } from '../storage/storage.service';
import { fromPiastres, toPiastres } from '../wallet/money';
import { WalletService } from '../wallet/wallet.service';

/**
 * Owner decision D5: a student can delete their own account from the app.
 *
 *   request  ->  PENDING for 30 days  ->  (cancel ->  CANCELLED)
 *                                     ->  sweep claims it: PROCESSING
 *                                     ->  personal data erased: COMPLETED
 *
 * WHAT "DELETED" MEANS HERE
 * The user row cannot be hard-deleted: payments, wallet ledger, enrollments,
 * redemptions, revenue rows and audit entries reference it with
 * `onDelete: Restrict`, and those are records the business must keep. So the
 * row stays as a pseudonymous anchor and everything that identifies the person
 * is erased or overwritten (see `erase`). What is retained, and why, is listed
 * in docs/audit-2026-10-27/OWNER_DECISIONS.md (D5).
 *
 * RELIABILITY
 * The state lives in `account_deletion_requests`, not in a timer. The hourly
 * sweep (AccountDeletionScheduler) re-reads the table each time, so a restart,
 * a redeploy or a missed run only delays erasure until the next sweep. Every
 * transition is a conditional `updateMany`, and a partial unique index allows
 * at most one PENDING request per user, so concurrent requests, a cancel racing
 * the sweep, or two sweepers cannot double-process an account.
 */

export const DELETION_GRACE_DAYS = 30;
/** Requests per sweep. Small: each erase is one transaction over one account. */
export const DELETION_SWEEP_BATCH = 25;
/**
 * After this many failed erase attempts the request is marked `failedAt` and
 * the sweep stops retrying it. It is then listed for an administrator
 * (`GET /admin/account-deletions/attention`), who can retry it or, on the
 * account holder's confirmed request, cancel it. Nothing was erased: each
 * attempt is one transaction that rolled back.
 */
export const DELETION_MAX_ATTEMPTS = 10;

/** Log marker an alert rule can match. Carries ids only, never personal data. */
export const DELETION_ALERT_MARKER = 'ACCOUNT_DELETION_NEEDS_ATTENTION';

/**
 * Log marker for deletion requests holding for physical settlement (Phase 6
 * §4.2): the deletion date arrived with money still in the wallet, so erasure
 * waits for an administrator to confirm the settlement. Ids only, never
 * personal data or amounts.
 */
export const DELETION_SETTLEMENT_MARKER = 'ACCOUNT_DELETION_SETTLEMENT_REQUIRED';

/**
 * What is stored in `lastError` and written to logs: the error's class and
 * Prisma/Node code, never its message. Messages can echo query arguments.
 */
export function describeEraseError(error: unknown): string {
  if (!error || typeof error !== 'object') return 'UnknownError';
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  const safeName = typeof name === 'string' && /^[A-Za-z0-9_]{1,60}$/.test(name) ? name : 'Error';
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9_]{1,20}$/.test(code) ? `:${code}` : '';
  return `${safeName}${safeCode}`;
}

export const DELETED_USER_NAME = 'Deleted user';
export const REDACTED_TEXT = '[removed at the account holder\'s request]';
/** Not a valid argon2/bcrypt string, so no password can ever verify against it. */
export const UNUSABLE_PASSWORD_HASH = '!account-deleted';

const REVOKE_REASON = 'Account deletion requested';

export interface DeletionRequestView {
  id: string;
  status: AccountDeletionStatus;
  requestedAt: string;
  scheduledFor: string;
  cancellable: boolean;
}

export interface DeletionSweepResult {
  claimed: number;
  completed: number;
  failed: number;
  skipped: number;
  /** Requests stopped after repeated failures, waiting for an administrator. */
  needsAttention?: number;
  /** Requests this sweep stopped before erasure because the wallet still holds money. */
  heldForSettlement?: number;
  /** Standing count of requests waiting for a settlement confirmation. */
  needsSettlement?: number;
}

function view(row: {
  id: string;
  status: AccountDeletionStatus;
  requestedAt: Date;
  scheduledFor: Date;
}): DeletionRequestView {
  return {
    id: row.id,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    scheduledFor: row.scheduledFor.toISOString(),
    cancellable:
      row.status === AccountDeletionStatus.PENDING && row.scheduledFor.getTime() > Date.now(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  ) || (typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002');
}

@Injectable()
export class AccountDeletionService {
  private readonly logger = new Logger(AccountDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    private readonly wallet: WalletService,
  ) {}

  // ---------------------------------------------------------------------------
  // Request
  // ---------------------------------------------------------------------------

  /**
   * Schedules deletion of the CALLER's own account. Requires the current
   * password, so an unlocked phone left on a desk is not enough.
   *
   * Idempotent: asking again while a request is open returns that request with
   * its ORIGINAL date (asking twice never moves the date).
   *
   * Every session, refresh token, live playback grant and push token is revoked
   * in the same transaction, so the account is unusable from this moment;
   * signing in again is refused until the deletion is cancelled.
   */
  async request(actor: AuthenticatedUser, password: string, meta: RequestMeta): Promise<DeletionRequestView> {
    if (actor.role !== UserRole.STUDENT) {
      // Staff accounts are managed by an administrator (users.softDelete),
      // which also protects courses from losing their only teacher.
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Staff accounts are deleted by an administrator.',
      });
    }

    const user = await this.prisma.user.findFirst({
      where: { id: actor.id, deletedAt: null },
      select: { id: true, passwordHash: true },
    });
    if (!user) throw AppException.notFound('User', actor.id);

    const valid = await this.passwords.verify(user.passwordHash, password);
    if (!valid) {
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'The password is incorrect.',
        fields: { password: ['The password is incorrect.'] },
      });
    }

    const open = await this.findOpen(user.id);
    if (open) return view(open);

    const now = new Date();
    const scheduledFor = new Date(now.getTime() + DELETION_GRACE_DAYS * 24 * 3600 * 1000);

    let created: { id: string; status: AccountDeletionStatus; requestedAt: Date; scheduledFor: Date };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.accountDeletionRequest.create({
          data: { userId: user.id, requestedAt: now, scheduledFor, source: 'app' },
          select: { id: true, status: true, requestedAt: true, scheduledFor: true },
        });
        await this.revokeAccessInTx(tx, user.id, now, REVOKE_REASON);
        await this.audit.recordTx(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.DELETE,
          entity: 'account_deletion_request',
          entityId: row.id,
          note: `Account deletion requested; scheduled for ${scheduledFor.toISOString()}`,
          ipAddress: meta.ip,
          userAgent: meta.userAgent,
          requestId: meta.requestId,
        });
        return row;
      });
    } catch (error) {
      // A concurrent request from the same account won the partial unique
      // index. That request is the answer.
      if (isUniqueViolation(error)) {
        const winner = await this.findOpen(user.id);
        if (winner) return view(winner);
      }
      throw error;
    }

    await this.redis.del(`pb:slots:${user.id}`);
    return view(created);
  }

  // ---------------------------------------------------------------------------
  // Cancel
  // ---------------------------------------------------------------------------

  /**
   * Cancels a pending deletion. Public: the account's sessions were revoked
   * when deletion was requested and sign-in is refused, so the phone and
   * password are the proof. `AuthService.verifyCredentials` gives this route
   * the same lockout, timing equalisation and failed-attempt accounting as
   * sign-in, and the route carries the credential throttle (keyed by phone).
   *
   * Only a request that is still PENDING and inside its 30 days can be
   * cancelled; the conditional update is what makes a cancel racing the sweep
   * safe - exactly one of them changes the row.
   */
  async cancel(phone: string, password: string, meta: RequestMeta): Promise<{ cancelled: true; requestId: string }> {
    const user = await this.auth.verifyCredentials(phone, password, meta);
    const now = new Date();

    const open = await this.prisma.accountDeletionRequest.findFirst({
      where: { userId: user.id, status: AccountDeletionStatus.PENDING },
      select: { id: true },
    });

    const { count } = open
      ? await this.prisma.accountDeletionRequest.updateMany({
          where: { id: open.id, status: AccountDeletionStatus.PENDING, scheduledFor: { gt: now } },
          data: { status: AccountDeletionStatus.CANCELLED, cancelledAt: now },
        })
      : { count: 0 };

    if (!open || count === 0) {
      const processing = await this.prisma.accountDeletionRequest.findFirst({
        where: { userId: user.id, status: { in: [AccountDeletionStatus.PENDING, AccountDeletionStatus.PROCESSING] } },
        select: { id: true },
      });
      throw new AppException(ErrorCode.INVALID_STATE, {
        // Past its 30 days (or being erased): the app can no longer cancel it.
        // If erasure stopped after repeated failures, an administrator can
        // still cancel it on the holder's confirmed request (cancelFailed).
        message: processing
          ? 'This deletion can no longer be cancelled in the app. Please contact support.'
          : 'There is no pending deletion for this account.',
      });
    }

    await this.audit.record({
      actorId: user.id,
      actorRole: user.role,
      action: AuditAction.UPDATE,
      entity: 'account_deletion_request',
      entityId: open.id,
      note: 'Account deletion cancelled by the account holder',
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });

    return { cancelled: true, requestId: open.id };
  }

  // ---------------------------------------------------------------------------
  // Sweep (called by AccountDeletionScheduler under a Redis lock)
  // ---------------------------------------------------------------------------

  async sweep(now = new Date()): Promise<DeletionSweepResult> {
    const result: DeletionSweepResult = { claimed: 0, completed: 0, failed: 0, skipped: 0 };

    const due = await this.prisma.accountDeletionRequest.findMany({
      where: {
        // Requests that ran out of attempts wait for an administrator.
        failedAt: null,
        AND: [
          {
            // A request holding for settlement (Phase 6 §4.2) waits for the
            // administrator's confirmation; once settled it rejoins the sweep.
            OR: [{ settlementRequiredAt: null }, { settledAt: { not: null } }],
          },
          {
            OR: [
              { status: AccountDeletionStatus.PENDING, scheduledFor: { lte: now } },
              // A PROCESSING row is one whose sweep died between the claim and the
              // erase transaction (which is atomic, so nothing half-done is left).
              // Erasure is idempotent, so it is simply run again.
              { status: AccountDeletionStatus.PROCESSING },
            ],
          },
        ],
      },
      orderBy: { scheduledFor: 'asc' },
      take: DELETION_SWEEP_BATCH,
      select: { id: true, userId: true, status: true, attempts: true, settledAt: true },
    });

    for (const row of due) {
      // D5 settlement (Phase 6 §4.2): erasure never runs over money. If the
      // wallet still holds a balance, the request stops here — identity
      // intact — and is listed for an administrator, who confirms the physical
      // settlement outside the app (confirmSettlement). erase() re-checks the
      // balance inside its transaction, so this read being stale can only
      // delay a hold, never let an erase through with money in the wallet.
      const walletRow = await this.prisma.wallet.findUnique({
        where: { userId: row.userId },
        select: { balance: true },
      });
      const balance = walletRow ? Number(walletRow.balance) : 0;
      if (balance > 0) {
        if (row.settledAt) {
          // Settled once, then money appeared again (only an administrative
          // credit can do that — the account has been signed out since the
          // request). Never erase value silently and never overwrite the
          // settlement record: an administrator drains the wallet through the
          // audited adjustment flow, and the next sweep proceeds.
          this.logger.error(
            `${DELETION_SETTLEMENT_MARKER}: request=${row.id} was settled but the wallet is no longer empty; administrator action required`,
          );
          result.skipped += 1;
          continue;
        }
        const held = await this.prisma.accountDeletionRequest.updateMany({
          where: { id: row.id, settlementRequiredAt: null, settledAt: null },
          data: { settlementRequiredAt: now, outstandingAmount: walletRow!.balance },
        });
        if (held.count > 0) {
          result.heldForSettlement = (result.heldForSettlement ?? 0) + 1;
          this.logger.warn(
            `${DELETION_SETTLEMENT_MARKER}: request=${row.id} holds for physical settlement before erasure`,
          );
        } else {
          // Already held by a concurrent sweep.
          result.skipped += 1;
        }
        continue;
      }

      const attempt = row.attempts + 1;
      if (row.status === AccountDeletionStatus.PENDING) {
        const claim = await this.prisma.accountDeletionRequest.updateMany({
          where: { id: row.id, status: AccountDeletionStatus.PENDING, scheduledFor: { lte: now } },
          data: { status: AccountDeletionStatus.PROCESSING, attempts: { increment: 1 } },
        });
        if (claim.count === 0) {
          // Cancelled (or claimed elsewhere) since it was read.
          result.skipped += 1;
          continue;
        }
      } else {
        await this.prisma.accountDeletionRequest.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        });
      }
      result.claimed += 1;

      try {
        await this.erase(row.id, row.userId);
        result.completed += 1;
      } catch (error) {
        result.failed += 1;
        const reason = describeEraseError(error);
        const exhausted = attempt >= DELETION_MAX_ATTEMPTS;
        this.logger.error(
          `account erase failed: request=${row.id} attempt=${attempt}/${DELETION_MAX_ATTEMPTS} error=${reason}` +
            (exhausted ? ` ${DELETION_ALERT_MARKER} (retries stopped; administrator action required)` : ''),
        );
        // Back to PENDING. The account stays blocked from sign-in (a pending
        // deletion), nothing was erased, and the date has passed, so the next
        // sweep retries - unless the attempts are used up.
        await this.prisma.accountDeletionRequest
          .updateMany({
            where: { id: row.id, status: AccountDeletionStatus.PROCESSING },
            data: {
              status: AccountDeletionStatus.PENDING,
              lastError: reason,
              ...(exhausted ? { failedAt: new Date() } : {}),
            },
          })
          .catch(() => undefined);
      }
    }

    // A standing signal while anything waits for an administrator, so an alert
    // on the marker keeps firing until someone acts.
    const waiting = await this.prisma.accountDeletionRequest
      .count({ where: { failedAt: { not: null }, status: AccountDeletionStatus.PENDING } })
      .catch(() => 0);
    if (waiting > 0) {
      this.logger.error(`${DELETION_ALERT_MARKER}: ${waiting} account deletion request(s) stopped after repeated failures`);
    }
    result.needsAttention = waiting;

    // Same standing-signal pattern for settlements: the marker keeps firing
    // every sweep until each settlement is confirmed.
    const awaitingSettlement = await this.prisma.accountDeletionRequest
      .count({ where: { settlementRequiredAt: { not: null }, settledAt: null } })
      .catch(() => 0);
    if (awaitingSettlement > 0) {
      this.logger.warn(
        `${DELETION_SETTLEMENT_MARKER}: ${awaitingSettlement} deletion request(s) waiting for physical settlement`,
      );
    }
    result.needsSettlement = awaitingSettlement;

    return result;
  }

  // ---------------------------------------------------------------------------
  // Administrator recovery (failed erasures only)
  // ---------------------------------------------------------------------------

  /** Requests whose erasure stopped after repeated failures. Ids and timings only. */
  async listNeedingAttention() {
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: { failedAt: { not: null }, status: AccountDeletionStatus.PENDING },
      orderBy: { failedAt: 'asc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        status: true,
        requestedAt: true,
        scheduledFor: true,
        attempts: true,
        failedAt: true,
        lastError: true,
      },
    });
    return rows.map((r) => ({
      ...r,
      requestedAt: r.requestedAt.toISOString(),
      scheduledFor: r.scheduledFor.toISOString(),
      failedAt: r.failedAt?.toISOString() ?? null,
    }));
  }

  /**
   * Re-queues a failed erasure: the account holder still wants deletion and
   * the cause has been fixed. Only a request that stopped after repeated
   * failures qualifies; a normal pending request is untouched.
   */
  async retryFailed(requestId: string, actor: AuthenticatedUser, reason: string, meta: RequestMeta) {
    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, status: AccountDeletionStatus.PENDING, failedAt: { not: null } },
      data: { failedAt: null, attempts: 0, lastError: null },
    });
    if (count === 0) throw this.notRecoverable();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'account_deletion_request',
      entityId: requestId,
      note: `Failed account erasure re-queued by an administrator: ${reason}`,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    return { id: requestId, requeued: true as const };
  }

  /**
   * Cancels a failed erasure on the account holder's confirmed request. The
   * account was never erased (every attempt rolled back), so cancelling makes
   * it usable again; the holder signs in normally. Explicit, reasoned and
   * audited - never automatic.
   */
  async cancelFailed(requestId: string, actor: AuthenticatedUser, reason: string, meta: RequestMeta) {
    const now = new Date();
    const { count } = await this.prisma.accountDeletionRequest.updateMany({
      where: { id: requestId, status: AccountDeletionStatus.PENDING, failedAt: { not: null } },
      data: { status: AccountDeletionStatus.CANCELLED, cancelledAt: now },
    });
    if (count === 0) throw this.notRecoverable();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'account_deletion_request',
      entityId: requestId,
      note: `Failed account erasure cancelled by an administrator at the holder's request: ${reason}`,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    });
    return { id: requestId, cancelled: true as const };
  }

  private notRecoverable() {
    return new AppException(ErrorCode.INVALID_STATE, {
      message: 'Only a deletion request whose erasure stopped after repeated failures can be recovered here.',
    });
  }

  // ---------------------------------------------------------------------------
  // Physical settlement before erasure (Phase 6 §4.2)
  // ---------------------------------------------------------------------------

  /**
   * Deletion requests holding for physical settlement. Minimal identity is
   * included deliberately: nothing has been erased yet (that is the point of
   * the hold), and the administrator must be able to identify the person they
   * are settling with. The LIVE wallet balance is the authoritative amount;
   * `outstandingAmount` is what the sweep saw when it placed the hold.
   *
   * WALLET BALANCE IS NOT AUTOMATICALLY MONEY OWED. The balance is prepaid
   * credit, and its ledger records how each pound got in: a recharge card the
   * student paid cash for is a real liability; an administrative or goodwill
   * credit may not be. Eligibility is an administrative decision, so each row
   * carries `ledger` — the lifetime credit and debit totals by type — to make
   * that decision with. The flow for a partially eligible balance is
   * DECOMPOSE, NOT PARTIAL-SETTLE: first remove the non-refundable portion
   * with the audited wallet adjustment (its own ADMIN_ADJUSTMENT ledger line,
   * with the reason), then confirm the settlement for the remaining balance
   * (its own REFUND line, with the method and reference). Every pound of the
   * cleared balance therefore ends in exactly one explicit, typed, reasoned
   * ledger entry — which is why confirmSettlement refuses any amount other
   * than the full current balance.
   */
  async listPendingSettlements() {
    const rows = await this.prisma.accountDeletionRequest.findMany({
      where: { settlementRequiredAt: { not: null }, settledAt: null },
      orderBy: { settlementRequiredAt: 'asc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        status: true,
        requestedAt: true,
        scheduledFor: true,
        settlementRequiredAt: true,
        outstandingAmount: true,
        user: {
          select: {
            fullName: true,
            phone: true,
            wallet: { select: { id: true, balance: true } },
          },
        },
      },
    });

    // Lifetime ledger totals per wallet, split by type and direction, so the
    // administrator can see how the balance arose (recharge cards vs
    // administrative credit) before deciding what is actually owed.
    const walletIds = rows
      .map((r) => r.user.wallet?.id)
      .filter((id): id is string => typeof id === 'string');
    const sums = walletIds.length
      ? await this.prisma.walletTransaction.groupBy({
          by: ['walletId', 'type', 'direction'],
          where: { walletId: { in: walletIds } },
          _sum: { amount: true },
        })
      : [];
    const ledgerByWallet = new Map<string, { credits: Record<string, number>; debits: Record<string, number> }>();
    for (const row of sums) {
      const entry = ledgerByWallet.get(row.walletId) ?? { credits: {}, debits: {} };
      const bucket = row.direction === 'CREDIT' ? entry.credits : entry.debits;
      bucket[row.type] = Number(row._sum.amount ?? 0);
      ledgerByWallet.set(row.walletId, entry);
    }

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      status: r.status,
      requestedAt: r.requestedAt.toISOString(),
      scheduledFor: r.scheduledFor.toISOString(),
      settlementRequiredAt: r.settlementRequiredAt?.toISOString() ?? null,
      outstandingAmount: r.outstandingAmount === null ? 0 : Number(r.outstandingAmount),
      currentBalance: r.user.wallet ? Number(r.user.wallet.balance) : 0,
      ledger: (r.user.wallet && ledgerByWallet.get(r.user.wallet.id)) ?? { credits: {}, debits: {} },
      fullName: r.user.fullName,
      phone: r.user.phone,
    }));
  }

  /**
   * Records that the remaining balance was physically settled with the account
   * holder outside the application, and lets erasure resume (Phase 6 §4.2).
   *
   * The administrator states the exact amount handed over, and it must equal
   * the wallet's CURRENT balance — the record can never claim an amount other
   * than what the ledger then moves. The debit is a REFUND/ADMIN ledger line
   * carrying the actor and the offline method, with idempotency key
   * `deletion-settlement:<requestId>`: a confirmation that crashed between the
   * debit and the request update can be repeated without moving money twice,
   * while the request-level `updateMany … settledAt: null` guard refuses an
   * outright duplicate confirmation. A zero balance (drained through the
   * audited adjustment flow after the hold) is confirmed with amount 0 and no
   * ledger line — there is nothing to move. Erasure resumes at the next sweep.
   *
   * PARTIAL SETTLEMENTS ARE REJECTED ON PURPOSE. A partial would leave money
   * in the wallet with no record of why the remainder was not owed, and the
   * erase guard would (correctly) keep blocking. When only part of the
   * balance is actually owed — say an administrative goodwill credit is not
   * refundable — the administrator first removes that portion with the
   * audited wallet adjustment (ADMIN_ADJUSTMENT, with a reason), then settles
   * the remainder here. The decomposition is the audit trail.
   */
  async confirmSettlement(
    requestId: string,
    actor: AuthenticatedUser,
    input: { amount: number; method: string; reference?: string; reason: string },
    meta: RequestMeta,
  ) {
    return withSerializableRetry(this.prisma, async (tx) => {
      const request = await tx.accountDeletionRequest.findUnique({
        where: { id: requestId },
        select: { id: true, userId: true, settlementRequiredAt: true, settledAt: true },
      });
      if (!request || !request.settlementRequiredAt) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: 'Only a deletion request holding for settlement can be confirmed here.',
        });
      }
      if (request.settledAt) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: 'This settlement was already confirmed.',
        });
      }

      const walletRow = await tx.wallet.findUnique({
        where: { userId: request.userId },
        select: { balance: true },
      });
      const balancePiastres = walletRow ? toPiastres(String(walletRow.balance), 'balance') : 0;
      if (toPiastres(input.amount, 'amount') !== balancePiastres) {
        throw AppException.validation(
          { amount: ['Must equal the current wallet balance.'] },
          `The stated amount must equal the current wallet balance (${fromPiastres(balancePiastres)} EGP).`,
        );
      }

      const detail = `${input.method}${input.reference ? `, ref ${input.reference}` : ''}`;
      let transactionId: string | null = null;
      if (balancePiastres > 0) {
        const entry = await this.wallet.debit(tx, {
          userId: request.userId,
          amount: fromPiastres(balancePiastres),
          type: WalletTxType.REFUND,
          source: WalletTxSource.ADMIN,
          performedByAdminId: actor.id,
          reference: { type: 'account_deletion', id: requestId },
          note: `Wallet settled physically outside the app (${detail}): ${input.reason}`,
          idempotencyKey: `deletion-settlement:${requestId}`,
        });
        transactionId = entry.id;
      }

      const now = new Date();
      const { count } = await tx.accountDeletionRequest.updateMany({
        where: { id: requestId, settledAt: null },
        data: {
          settledAt: now,
          settledById: actor.id,
          settledAmount: fromPiastres(balancePiastres),
          settlementTxId: transactionId,
        },
      });
      if (count === 0) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: 'This settlement was already confirmed.',
        });
      }

      await this.audit.recordTx(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.UPDATE,
        entity: 'account_deletion_request',
        entityId: requestId,
        note: `Physical settlement confirmed: ${fromPiastres(balancePiastres)} EGP (${detail}). ${input.reason}`,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        requestId: meta.requestId,
      });

      return {
        id: requestId,
        settled: true as const,
        amount: Number(fromPiastres(balancePiastres)),
        transactionId,
      };
    });
  }

  /**
   * Erases the person and keeps the records. One transaction: either every
   * step happens and the request is COMPLETED, or none does and the request is
   * retried.
   */
  async erase(requestId: string, userId: string): Promise<void> {
    const now = new Date();

    await this.prisma.$transaction(
      async (tx) => {
        // Re-read inside the transaction: the request must still be claimed
        // for exactly this account, and the account must be a student. A stale
        // or mismatched call can therefore never erase anyone else.
        const current = await tx.accountDeletionRequest.findUnique({
          where: { id: requestId },
          select: { userId: true, status: true },
        });
        if (!current || current.userId !== userId || current.status !== AccountDeletionStatus.PROCESSING) {
          throw Object.assign(new Error('deletion request is not claimed for this account'), {
            name: 'DeletionRequestMismatch',
          });
        }
        const target = await tx.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (!target || target.role !== UserRole.STUDENT) {
          throw Object.assign(new Error('deletion target is not a student account'), {
            name: 'DeletionTargetNotStudent',
          });
        }

        // D5 settlement (Phase 6 §4.2): the authoritative barrier. The sweep
        // holds such requests before claiming them; this in-transaction
        // re-read means no path — present or future — can erase an account
        // whose wallet still holds money. The throw rolls everything back and
        // the next sweep places the hold.
        const walletRow = await tx.wallet.findUnique({ where: { userId }, select: { balance: true } });
        if (walletRow && Number(walletRow.balance) > 0) {
          throw Object.assign(new Error('wallet balance must be settled before erasure'), {
            name: 'DeletionSettlementRequired',
          });
        }

        // Identity. The phone becomes a value that can never collide with a
        // real number, which also frees the number for a fresh registration.
        await tx.user.update({
          where: { id: userId },
          data: {
            fullName: DELETED_USER_NAME,
            phone: `deleted:${userId}`,
            email: null,
            avatarUrl: null,
            gender: null,
            passwordHash: UNUSABLE_PASSWORD_HASH,
            credentialsChangedAt: now,
            failedLoginCount: 0,
            lockedUntil: null,
            status: AccountStatus.DISABLED,
            deletedAt: now,
          },
        });
        await tx.studentProfile.updateMany({
          where: { userId },
          data: { studentNumber: null, notes: null },
        });

        // Access: anything a request-time revocation could have missed.
        await this.revokeAccessInTx(tx, userId, now, 'Account deleted');

        // Network and device identifiers.
        await tx.session.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null } });
        await tx.playbackTicket.updateMany({ where: { userId }, data: { ipAddress: null, userAgent: null } });
        await tx.securityEvent.updateMany({
          where: { userId },
          data: { ipAddress: null, userAgent: null, deviceKey: null, metadata: Prisma.DbNull },
        });
        await tx.accessCodeRedemption.updateMany({ where: { userId }, data: { ipAddress: null, deviceKey: null } });
        const devices = await tx.device.findMany({ where: { userId }, select: { id: true } });
        for (const device of devices) {
          // deviceKey is unique per user, so each row gets its own placeholder.
          await tx.device.update({
            where: { id: device.id },
            data: {
              deviceKey: `deleted:${device.id}`,
              name: 'Deleted device',
              model: null,
              osVersion: null,
              appVersion: null,
              status: DeviceStatus.REVOKED,
              revokedAt: now,
              revokedReason: 'Account deleted',
            },
          });
        }

        // Rows that exist only for the person and carry nothing to keep.
        await tx.deviceChangeRequest.deleteMany({ where: { userId } });
        await tx.pushToken.deleteMany({ where: { userId } });
        await tx.notification.deleteMany({ where: { userId } });
        await tx.notificationPreference.deleteMany({ where: { userId } });

        // Support: the ticket stays (staff workload and audit), what the
        // student wrote does not.
        await tx.supportTicket.updateMany({ where: { userId }, data: { subject: REDACTED_TEXT } });
        await tx.supportMessage.updateMany({ where: { authorId: userId }, data: { body: REDACTED_TEXT } });

        await tx.accountDeletionRequest.update({
          where: { id: requestId },
          data: { status: AccountDeletionStatus.COMPLETED, completedAt: now, lastError: null },
        });

        await this.audit.recordTx(tx, {
          actorId: null,
          actorRole: null,
          action: AuditAction.DELETE,
          entity: 'user',
          entityId: userId,
          note: `Personal data erased at the account holder's request (deletion request ${requestId})`,
        });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    // Outside the transaction, best effort: object storage and cache cannot
    // roll back with Postgres, and a leftover avatar file is unreferenced.
    await this.redis.del(`pb:slots:${userId}`);
    if (this.storage.isConfigured) {
      await this.storage
        .deletePrefix('media', `avatars/${userId}/`)
        .catch((error: Error) => this.logger.warn(`avatar cleanup failed for ${userId}: ${error.message}`));
    }
  }

  // ---------------------------------------------------------------------------

  private findOpen(userId: string) {
    // A request that stopped after repeated failures is still PENDING, so it is
    // still "open": asking again returns it rather than creating a second one.
    return this.prisma.accountDeletionRequest.findFirst({
      where: {
        userId,
        status: { in: [AccountDeletionStatus.PENDING, AccountDeletionStatus.PROCESSING] },
      },
      select: { id: true, status: true, requestedAt: true, scheduledFor: true },
    });
  }

  private async revokeAccessInTx(tx: Prisma.TransactionClient, userId: string, now: Date, reason: string) {
    await tx.session.updateMany({
      where: { userId, status: SessionStatus.ACTIVE },
      data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: reason },
    });
    await tx.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: reason },
    });
    await tx.playbackTicket.updateMany({
      where: { userId, status: PlaybackTicketStatus.ACTIVE },
      data: { status: PlaybackTicketStatus.REVOKED, revokedAt: now, revokedReason: reason },
    });
    // Queued pushes check `isActive`, so nothing more reaches the devices.
    await tx.pushToken.updateMany({ where: { userId, isActive: true }, data: { isActive: false } });
  }
}
