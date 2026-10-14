import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  PaymentProvider,
  PaymentStatus,
  Prisma,
  type RevenueLedger,
  UserRole,
} from '@prisma/client';
import { createHash } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { withSerializableRetry } from '../../database/serializable-retry';
import { AuditService } from '../audit/audit.service';
import { revokeEnrollmentInTx } from '../enrollments/revoke-enrollment';

import {
  REFUND_TX_TYPES,
  TX_REFUND,
  TX_REQUEST,
  TX_REQUEST_FAILED,
  payloadOf,
  pendingRequests,
  resolutionOf,
} from './refund-state';
import {
  fromPiastres,
  parseAmount,
  percentOf,
  toBasisPoints,
  toEgpNumber,
  toPiastres,
} from '../wallet/money';

/**
 * Course payment refunds.
 *
 * ## Accounting
 *
 * A refund is recorded against one `Payment`. Revenue is reported from
 * `revenue_ledger` (overview, Statistics, revenue series, course analytics,
 * teacher earnings), so a COMPLETED refund appends one negative ("contra")
 * ledger line; the original payment and its positive revenue line are never
 * edited or deleted. Reports read:
 *
 *   gross revenue  = Σ positive ledger lines         (unchanged by a refund)
 *   refunded       = |Σ negative ledger lines|       (completed refunds only)
 *   net revenue    = Σ all ledger lines
 *
 * The contra line is split between teacher and platform in the SAME
 * proportion as the original line (its frozen `sharePercent`). Course payments
 * carry no fees, discounts or commissions, so the gross adjustment equals the
 * amount returned. The refund that empties a payment takes the teacher's exact
 * remainder, so piastre rounding across partial refunds always nets to zero.
 * All arithmetic is in integer piastres.
 *
 * ## Completion — what "completed" means, and what it does not
 *
 * The platform has NO outbound payment-provider integration: Paymob checkout
 * is a placeholder URL, Stripe returns none, and nothing calls a refund API.
 * The platform never moves money. Therefore:
 *
 *  - IMMEDIATE (the default): the refund is recorded as SUCCEEDED and revenue
 *    is reduced at once — but only with `confirmMoneyReturned: true`, the
 *    administrator's explicit statement that the money HAS been returned
 *    outside the platform. It is recorded as `ADMIN_CONFIRMED_MANUAL` (for a
 *    manual payment) or `ADMIN_CONFIRMED_EXTERNAL` (for a Paymob/Stripe
 *    payment refunded in that provider's own dashboard). Nothing claims a
 *    provider confirmed it.
 *  - PENDING: the money has not been returned yet. A request is recorded that
 *    reserves its amount against the refundable balance but is NOT refunded
 *    money and does NOT touch revenue. An administrator later completes it
 *    (again with `confirmMoneyReturned: true`) or marks it failed, which
 *    releases the reservation.
 *
 * `PROVIDER_CONFIRMED` is reserved for a future, verified provider
 * integration; nothing produces it today. Such an integration must complete a
 * request only from a verified provider success, never from submitting one.
 *
 * Code-based enrollments have no `Payment` (cards are sold for cash before
 * redemption and are not in the revenue ledger), so there is nothing here to
 * refund for them, and a redeemed code is never returned to circulation.
 *
 * ## Access
 *
 * Mandatory rule: EVERY refund request — full or partial, immediate or
 * pending — revokes the student's enrollment in that course, through the
 * shared revocation (`revokeEnrollmentInTx`), in the same transaction. That
 * also cancels PENDING checkouts on the enrollment, and
 * `PaymentsService.capture` / `fail` refuse to touch a (partially) refunded
 * payment, so a late or duplicate provider event can neither re-activate the
 * enrollment nor double-count revenue. A failed refund does NOT restore
 * access; restoring it is a separate administrative grant.
 *
 * ## Concurrency and retries
 *
 *  - Administrators only, checked here and on the route.
 *  - Every state change runs in one Serializable transaction and starts by
 *    bumping the payment row's `updatedAt` conditionally on the value read. Two
 *    concurrent changes to one payment therefore always collide on that row
 *    (a write-write conflict that Postgres resolves by aborting one, which
 *    `withSerializableRetry` retries) — the reservation arithmetic does not
 *    depend on predicate-lock detection alone.
 *  - A refund request carries a client idempotency key. A retry returns the
 *    first result. The key is also stored on the refund's own transaction row,
 *    so a retry still finds it after the 30-day `idempotency_records` entry has
 *    been purged; reusing a key for a different refund is refused.
 */

// `payment_transactions.type` values this service writes, and how they are
// read back, live in refund-state.ts so the payment lists share them.

const IDEMPOTENCY_TTL_MS = 30 * 24 * 3600 * 1000;

/**
 * How a SUCCEEDED refund came to be recorded.
 *
 *  - ADMIN_CONFIRMED_MANUAL   — manual payment; admin attests money returned.
 *  - ADMIN_CONFIRMED_EXTERNAL — Paymob/Stripe payment; admin attests it was
 *                               refunded outside the platform.
 *  - PROVIDER_CONFIRMED       — reserved for a verified provider integration.
 *  - UNRECORDED               — a refund written before this field existed
 *                               (the old bookkeeping-only refund). Shown as is,
 *                               never reinterpreted.
 */
export type CompletionMethod =
  | 'ADMIN_CONFIRMED_MANUAL'
  | 'ADMIN_CONFIRMED_EXTERNAL'
  | 'PROVIDER_CONFIRMED'
  | 'UNRECORDED';

interface Actor {
  id: string;
  role: UserRole;
}

export interface RefundInput {
  type: 'FULL' | 'PARTIAL';
  /** Decimal string (or number) with at most 2 decimals. PARTIAL only. */
  amount?: string | number;
  reason?: string;
  idempotencyKey: string;
  /** IMMEDIATE (default) records a completed refund; PENDING records a request. */
  completion?: 'IMMEDIATE' | 'PENDING';
  /** Required, and must be true, for IMMEDIATE: the money has been returned. */
  confirmMoneyReturned?: boolean;
}

/** One refund as the API and dashboard show it. */
export interface RefundView {
  id: string;
  amount: number;
  currency: string;
  /** SUCCEEDED = completed refund; PENDING = reserved, not refunded; FAILED = released. */
  status: 'SUCCEEDED' | 'PENDING' | 'FAILED';
  completionMethod: CompletionMethod | null;
  /** External reference the admin recorded (bank transfer id, provider refund id). */
  reference: string | null;
  reason: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

/** What `POST admin/payments/:id/refund` returns (and replays on a retry). */
export interface RefundResponse {
  refund: RefundView;
  /** Always false: the platform never transfers money. Stated so nobody assumes. */
  platformTransferredMoney: false;
  access: {
    enrollmentId: string;
    revoked: true;
    alreadyRevoked: boolean;
    cancelledPayments: number;
    revokedPartEntitlements: number;
    revokedPlaybackTickets: number;
  } | null;
  summary: RefundSummary;
}

export type RefundSummary = ReturnType<RefundsService['describe']>;

type PaymentWithLedger = Prisma.PaymentGetPayload<{
  include: {
    revenue: true;
    course: { select: { id: true; title: true } };
    user: { select: { id: true; fullName: true; phone: true } };
    transactions: true;
  };
}>;

/** A signed decimal (ledger lines are negative for refunds) in piastres. */
function signedPiastres(value: Prisma.Decimal | string | number, field: string): number {
  const text = String(value).trim();
  const negative = text.startsWith('-');
  const magnitude = toPiastres(negative ? text.slice(1) : text, field);
  return negative ? -magnitude : magnitude;
}


const COMPLETION_METHODS: readonly CompletionMethod[] = [
  'ADMIN_CONFIRMED_MANUAL',
  'ADMIN_CONFIRMED_EXTERNAL',
  'PROVIDER_CONFIRMED',
];

function completionMethodOf(row: { rawPayload: Prisma.JsonValue }): CompletionMethod {
  const value = payloadOf(row).completionMethod;
  return COMPLETION_METHODS.includes(value as CompletionMethod)
    ? (value as CompletionMethod)
    : 'UNRECORDED';
}

@Injectable()
export class RefundsService {
  private readonly logger = new Logger(RefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  /** Everything the Refund dialog shows, read fresh from the database. */
  async summary(paymentId: string, actor: Actor) {
    this.assertAdmin(actor);
    const payment = await this.loadPayment(this.prisma, paymentId);
    const enrollment = await this.findEnrollment(this.prisma, payment);
    return this.describe(payment, enrollment);
  }

  // ---------------------------------------------------------------------------
  // Refund
  // ---------------------------------------------------------------------------

  async refund(
    paymentId: string,
    input: RefundInput,
    actor: Actor,
  ): Promise<RefundResponse & { replayed: boolean }> {
    this.assertAdmin(actor);

    const completion = input.completion ?? 'IMMEDIATE';
    if (completion === 'IMMEDIATE' && input.confirmMoneyReturned !== true) {
      throw AppException.validation({
        confirmMoneyReturned: [
          'Confirm that the money has actually been returned to the student. The platform does not transfer money; to record a refund that has not happened yet, choose a pending refund instead.',
        ],
      });
    }

    const reason = input.reason?.trim() || null;
    const requestedPiastres = this.parseRequestedAmount(input);
    const idempotencyKey = `refund:${paymentId}:${input.idempotencyKey}`;
    const fingerprint = this.fingerprint({
      paymentId,
      type: input.type,
      amount: requestedPiastres,
      completion,
    });

    try {
      return await withSerializableRetry(this.prisma, async (tx) => {
        const replay = await this.replay<RefundResponse>(tx, idempotencyKey, fingerprint);
        if (replay) return replay;

        const payment = await this.loadPayment(tx, paymentId);

        // The idempotency record expires after 30 days and is purged. The key
        // also lives on the refund's own row, permanently, so an old retry is
        // still recognised rather than refunding a second time.
        const earlier = this.rowForKey(payment, input.idempotencyKey);
        if (earlier) {
          if (payloadOf(earlier).fingerprint !== fingerprint) {
            throw this.keyReused();
          }
          return { ...(await this.replayFromRow(tx, payment, earlier.id)), replayed: true };
        }

        this.assertRefundable(payment);
        await this.claimPayment(tx, payment);

        const balance = this.balanceOf(payment);
        if (balance.refundablePiastres <= 0) {
          throw new AppException(ErrorCode.INVALID_STATE, {
            message:
              balance.pendingPiastres > 0
                ? 'The rest of this payment is reserved by a pending refund. Complete or fail that request first.'
                : 'This payment has already been fully refunded.',
            details: { paymentId },
          });
        }

        const amount = requestedPiastres ?? balance.refundablePiastres;
        if (amount > balance.refundablePiastres) {
          throw AppException.validation({
            amount: [
              `must not exceed the refundable balance of ${fromPiastres(balance.refundablePiastres)} ${payment.currency}`,
            ],
          });
        }

        const now = new Date();
        const completionMethod = this.attestedMethod(payment);
        let refundId: string;

        if (completion === 'IMMEDIATE') {
          refundId = await this.applySucceededRefund(tx, payment, amount, {
            now,
            actorId: actor.id,
            reason,
            idempotencyKey: input.idempotencyKey,
            fingerprint,
            reference: null,
            requestId: null,
            completionMethod,
          });
        } else {
          const request = await tx.paymentTransaction.create({
            data: {
              paymentId: payment.id,
              type: TX_REQUEST,
              status: 'pending',
              amount: fromPiastres(amount),
              currency: payment.currency,
              rawPayload: {
                reason,
                actorId: actor.id,
                idempotencyKey: input.idempotencyKey,
                fingerprint,
                provider: payment.provider,
              },
            },
          });
          refundId = request.id;
        }

        // Mandatory: every refund request revokes access to this course, now.
        const revocation = await this.revokeAccess(tx, payment, actor, {
          refundId,
          status: completion === 'IMMEDIATE' ? 'SUCCEEDED' : 'PENDING',
          amount,
          reason,
        });

        await this.audit.recordTx(tx, {
          actorId: actor.id,
          actorRole: actor.role,
          action: AuditAction.PAYMENT_REFUND,
          entity: 'payment',
          entityId: payment.id,
          before: {
            status: payment.status,
            refundedAmount: fromPiastres(balance.refundedPiastres),
            pendingRefundAmount: fromPiastres(balance.pendingPiastres),
          },
          after: {
            refundId,
            refundStatus: completion === 'IMMEDIATE' ? 'SUCCEEDED' : 'PENDING',
            completion,
            completionMethod: completion === 'IMMEDIATE' ? completionMethod : null,
            moneyReturnedConfirmedByAdmin: completion === 'IMMEDIATE',
            platformTransferredMoney: false,
            amount: fromPiastres(amount),
            currency: payment.currency,
            userId: payment.userId,
            courseId: payment.courseId,
            provider: payment.provider,
            providerReference: payment.providerReference,
            idempotencyKey: input.idempotencyKey,
            enrollmentId: revocation?.enrollmentId ?? null,
            accessRevoked: revocation ? !revocation.alreadyRevoked : false,
          },
          note: reason ?? undefined,
        });

        const updated = await this.loadPayment(tx, paymentId);
        const enrollment = await this.findEnrollment(tx, updated);
        const response: RefundResponse = {
          refund: this.describeRefunds(updated).find((r) => r.id === refundId)!,
          platformTransferredMoney: false,
          access: revocation
            ? {
                enrollmentId: revocation.enrollmentId,
                revoked: true,
                alreadyRevoked: revocation.alreadyRevoked,
                cancelledPayments: revocation.cancelledPayments,
                revokedPartEntitlements: revocation.revokedPartEntitlements,
                revokedPlaybackTickets: revocation.revokedPlaybackTickets,
              }
            : null,
          summary: this.describe(updated, enrollment),
        };

        await tx.idempotencyRecord.create({
          data: {
            key: idempotencyKey,
            scope: 'payment-refund',
            statusCode: 200,
            response: { fingerprint, body: response } as unknown as Prisma.InputJsonValue,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
        });

        return { ...response, replayed: false };
      });
    } catch (error) {
      // Two identical requests raced: the loser hit the idempotency key's
      // primary key. Answer it with the winner's result.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const replay = await this.replay<RefundResponse>(this.prisma, idempotencyKey, fingerprint);
        if (replay) return replay;
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Resolving a pending refund
  // ---------------------------------------------------------------------------

  /**
   * Completes a pending refund once the money has actually been returned.
   * Only now is it counted as refunded and revenue reduced. Requires the same
   * explicit confirmation as an immediate refund. Idempotent.
   */
  async completeRequest(
    paymentId: string,
    requestId: string,
    input: { confirmMoneyReturned?: boolean; reference?: string; note?: string },
    actor: Actor,
  ) {
    this.assertAdmin(actor);
    if (input.confirmMoneyReturned !== true) {
      throw AppException.validation({
        confirmMoneyReturned: ['Confirm that the money has actually been returned to the student.'],
      });
    }

    return withSerializableRetry(this.prisma, async (tx) => {
      const payment = await this.loadPayment(tx, paymentId);
      const request = this.requireRequest(payment, requestId);
      const state = this.requestState(payment, requestId);

      if (state === 'SUCCEEDED') {
        return { ...(await this.result(tx, paymentId, requestId)), replayed: true };
      }
      if (state === 'FAILED') {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: 'This refund request was marked failed and cannot be completed. Start a new refund instead.',
        });
      }
      this.assertRefundable(payment);
      await this.claimPayment(tx, payment);

      const amount = toPiastres(request.amount ?? 0, 'amount');
      const completionMethod = this.attestedMethod(payment);
      const reference = input.reference?.trim() || null;
      const note = input.note?.trim() || null;

      await this.applySucceededRefund(tx, payment, amount, {
        now: new Date(),
        actorId: actor.id,
        reason: note,
        idempotencyKey: null,
        fingerprint: null,
        reference,
        requestId,
        completionMethod,
      });

      await this.audit.recordTx(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.PAYMENT_REFUND,
        entity: 'payment',
        entityId: payment.id,
        after: {
          refundId: requestId,
          refundStatus: 'SUCCEEDED',
          completionMethod,
          moneyReturnedConfirmedByAdmin: true,
          platformTransferredMoney: false,
          amount: fromPiastres(amount),
          currency: payment.currency,
          reference,
          userId: payment.userId,
          courseId: payment.courseId,
        },
        note: note ?? undefined,
      });

      return { ...(await this.result(tx, paymentId, requestId)), replayed: false };
    });
  }

  /**
   * Marks a pending refund failed: it will not happen. The reservation is
   * released. Access is NOT restored — giving the course back is a separate,
   * explicit grant. Idempotent.
   */
  async failRequest(
    paymentId: string,
    requestId: string,
    input: { reason: string },
    actor: Actor,
  ) {
    this.assertAdmin(actor);

    return withSerializableRetry(this.prisma, async (tx) => {
      const payment = await this.loadPayment(tx, paymentId);
      this.requireRequest(payment, requestId);
      const state = this.requestState(payment, requestId);

      if (state === 'FAILED') {
        return { ...(await this.result(tx, paymentId, requestId)), replayed: true };
      }
      if (state === 'SUCCEEDED') {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: 'This refund already succeeded and cannot be marked failed.',
        });
      }
      await this.claimPayment(tx, payment);

      await tx.paymentTransaction.create({
        data: {
          paymentId,
          type: TX_REQUEST_FAILED,
          status: 'failed',
          rawPayload: { requestId, reason: input.reason.trim(), actorId: actor.id },
        },
      });

      await this.audit.recordTx(tx, {
        actorId: actor.id,
        actorRole: actor.role,
        action: AuditAction.PAYMENT_REFUND,
        entity: 'payment',
        entityId: paymentId,
        after: {
          refundId: requestId,
          refundStatus: 'FAILED',
          reservationReleased: true,
          accessRestored: false,
          userId: payment.userId,
          courseId: payment.courseId,
        },
        note: input.reason,
      });

      return { ...(await this.result(tx, paymentId, requestId)), replayed: false };
    });
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private assertAdmin(actor: Actor) {
    if (actor.role !== UserRole.MASTER && actor.role !== UserRole.ADMIN) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Only administrators can refund payments',
      });
    }
  }

  private parseRequestedAmount(input: RefundInput): number | null {
    if (input.type === 'FULL') {
      if (input.amount !== undefined && input.amount !== null && input.amount !== '') {
        throw AppException.validation({
          amount: ['is only sent for a partial refund; a full refund returns the whole remaining balance'],
        });
      }
      return null;
    }
    if (input.amount === undefined || input.amount === null || input.amount === '') {
      throw AppException.validation({ amount: ['is required for a partial refund'] });
    }
    const piastres = parseAmount(input.amount, 'amount');
    if (piastres <= 0) throw AppException.validation({ amount: ['must be greater than 0'] });
    return piastres;
  }

  private assertRefundable(payment: PaymentWithLedger) {
    if (
      payment.status !== PaymentStatus.PAID &&
      payment.status !== PaymentStatus.PARTIALLY_REFUNDED
    ) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message:
          payment.status === PaymentStatus.REFUNDED
            ? 'This payment has already been fully refunded.'
            : `Only a paid payment can be refunded (this one is ${payment.status.toLowerCase().replace('_', ' ')}).`,
        details: { paymentId: payment.id, status: payment.status },
      });
    }
  }

  /**
   * Takes the payment row for this transaction: bumps `updatedAt`
   * conditionally on the value read. Any concurrent refund change to the same
   * payment writes the same row, so the two can never both commit from the
   * same starting balance — Postgres aborts one (P2034, retried by
   * `withSerializableRetry`), and without isolation the condition fails here.
   */
  private async claimPayment(tx: Prisma.TransactionClient, payment: PaymentWithLedger) {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, updatedAt: payment.updatedAt },
      data: { updatedAt: new Date(Math.max(Date.now(), payment.updatedAt.getTime() + 1)) },
    });
    if (count === 0) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This payment changed while the refund was being recorded. Reload and try again.',
        details: { paymentId: payment.id },
      });
    }
  }

  /** How an admin-confirmed completion is recorded for this payment. */
  private attestedMethod(payment: { provider: PaymentProvider }): CompletionMethod {
    return payment.provider === PaymentProvider.PAYMOB ||
      payment.provider === PaymentProvider.STRIPE
      ? 'ADMIN_CONFIRMED_EXTERNAL'
      : 'ADMIN_CONFIRMED_MANUAL';
  }

  private keyReused() {
    return new AppException(ErrorCode.INVALID_STATE, {
      message: 'This refund request id was already used for a different refund. Reload and try again.',
    });
  }

  private async loadPayment(
    client: Prisma.TransactionClient | PrismaService,
    paymentId: string,
  ): Promise<PaymentWithLedger> {
    const payment = await client.payment.findUnique({
      where: { id: paymentId },
      include: {
        revenue: true,
        course: { select: { id: true, title: true } },
        user: { select: { id: true, fullName: true, phone: true } },
        transactions: {
          where: { type: { in: REFUND_TX_TYPES } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!payment) throw AppException.notFound('Payment', paymentId);
    return payment;
  }

  /** The enrollment the payment paid for: its link, or the student's row in that course. */
  private async findEnrollment(
    client: Prisma.TransactionClient | PrismaService,
    payment: { enrollmentId: string | null; userId: string; courseId: string },
  ) {
    return payment.enrollmentId
      ? client.enrollment.findUnique({
          where: { id: payment.enrollmentId },
          select: { id: true, state: true, courseId: true },
        })
      : client.enrollment.findUnique({
          where: { userId_courseId: { userId: payment.userId, courseId: payment.courseId } },
          select: { id: true, state: true, courseId: true },
        });
  }

  private async revokeAccess(
    tx: Prisma.TransactionClient,
    payment: PaymentWithLedger,
    actor: Actor,
    refund: { refundId: string; status: string; amount: number; reason: string | null },
  ) {
    const enrollment = await this.findEnrollment(tx, payment);
    // No enrollment means no access to withdraw (the row was never created,
    // or the payment was taken outside an enrollment).
    if (!enrollment) return null;

    const outcome = await revokeEnrollmentInTx(tx, this.audit, {
      enrollmentId: enrollment.id,
      actor,
      expectedCourseId: payment.courseId,
      reason: refund.reason ? `Refunded: ${refund.reason}` : 'Refunded',
      ticketReason: 'Payment refunded',
      auditContext: {
        cause: 'refund',
        refundId: refund.refundId,
        refundStatus: refund.status,
        paymentId: payment.id,
        amount: fromPiastres(refund.amount),
        currency: payment.currency,
      },
    });
    return { enrollmentId: enrollment.id, ...outcome };
  }

  /** Succeeded, pending and refundable amounts, in piastres. */
  private balanceOf(payment: PaymentWithLedger) {
    const paidPiastres = toPiastres(payment.amount, 'amount');
    const refundedPiastres = toPiastres(payment.refundedAmount, 'refundedAmount');
    const pendingPiastres = this.pendingRequests(payment).reduce(
      (sum, row) => sum + toPiastres(row.amount ?? 0, 'amount'),
      0,
    );
    return {
      paidPiastres,
      refundedPiastres,
      pendingPiastres,
      refundablePiastres: Math.max(0, paidPiastres - refundedPiastres - pendingPiastres),
    };
  }

  private resolutionOf(payment: PaymentWithLedger, requestId: string) {
    return resolutionOf(payment.transactions, requestId);
  }

  private pendingRequests(payment: PaymentWithLedger) {
    return pendingRequests(payment.transactions);
  }

  /** The refund or request this idempotency key already produced, if any. */
  private rowForKey(payment: PaymentWithLedger, key: string) {
    return payment.transactions.find(
      (row) =>
        (row.type === TX_REQUEST || (row.type === TX_REFUND && !payloadOf(row).requestId)) &&
        payloadOf(row).idempotencyKey === key,
    );
  }

  private requireRequest(payment: PaymentWithLedger, requestId: string) {
    const request = payment.transactions.find(
      (row) => row.id === requestId && row.type === TX_REQUEST,
    );
    if (!request) throw AppException.notFound('Refund request', requestId);
    return request;
  }

  private requestState(payment: PaymentWithLedger, requestId: string): RefundView['status'] {
    const resolution = this.resolutionOf(payment, requestId);
    if (!resolution) return 'PENDING';
    return resolution.type === TX_REFUND ? 'SUCCEEDED' : 'FAILED';
  }

  /**
   * Writes a refund that has actually happened: the transaction row, the
   * contra revenue line, and the payment's refunded total and status — exactly
   * once, guarded by a write conditional on the refunded total read.
   */
  private async applySucceededRefund(
    tx: Prisma.TransactionClient,
    payment: PaymentWithLedger,
    amount: number,
    meta: {
      now: Date;
      actorId: string;
      reason: string | null;
      idempotencyKey: string | null;
      fingerprint: string | null;
      reference: string | null;
      requestId: string | null;
      completionMethod: CompletionMethod;
    },
  ): Promise<string> {
    const paid = toPiastres(payment.amount, 'amount');
    const refunded = toPiastres(payment.refundedAmount, 'refundedAmount');
    const total = refunded + amount;
    if (amount <= 0 || total > paid) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This refund would exceed the amount paid.',
        details: { paymentId: payment.id },
      });
    }
    const fullyRefunded = total === paid;

    const { count } = await tx.payment.updateMany({
      where: {
        id: payment.id,
        refundedAmount: fromPiastres(refunded),
        status: payment.status,
      },
      data: {
        refundedAmount: fromPiastres(total),
        refundedAt: meta.now,
        status: fullyRefunded ? PaymentStatus.REFUNDED : PaymentStatus.PARTIALLY_REFUNDED,
      },
    });
    if (count === 0) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'This payment changed while the refund was being recorded. Reload and try again.',
        details: { paymentId: payment.id },
      });
    }

    const row = await tx.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        type: TX_REFUND,
        status: 'succeeded',
        amount: fromPiastres(amount),
        currency: payment.currency,
        providerReference: meta.reference,
        rawPayload: {
          reason: meta.reason,
          actorId: meta.actorId,
          idempotencyKey: meta.idempotencyKey,
          fingerprint: meta.fingerprint,
          requestId: meta.requestId,
          completionMethod: meta.completionMethod,
          moneyReturnedConfirmedByAdmin: true,
          platformTransferredMoney: false,
        },
      },
    });

    await tx.revenueLedger.create({
      data: this.contraLine(payment, amount, fullyRefunded, meta.now),
    });

    return meta.requestId ?? row.id;
  }

  /**
   * The negative revenue line for a refund of `amount` piastres.
   *
   * Split like the original line. The refund that empties the payment takes
   * the exact remaining teacher amount instead of a rounded share, so the
   * payment's lines always net to zero for teacher and platform alike.
   */
  private contraLine(
    payment: PaymentWithLedger,
    amount: number,
    fullyRefunded: boolean,
    now: Date,
  ): Prisma.RevenueLedgerUncheckedCreateInput {
    const original: RevenueLedger | undefined = payment.revenue.find(
      (line) => signedPiastres(line.grossAmount, 'grossAmount') > 0,
    );
    const shareBp = original ? toBasisPoints(original.sharePercent.toString(), 'sharePercent') : 0;

    let teacherPiastres: number;
    if (!original) {
      teacherPiastres = 0;
    } else if (fullyRefunded) {
      teacherPiastres = payment.revenue.reduce(
        (sum, line) => sum + signedPiastres(line.teacherAmount, 'teacherAmount'),
        0,
      );
    } else {
      teacherPiastres = percentOf(amount, shareBp);
    }
    teacherPiastres = Math.min(Math.max(teacherPiastres, 0), amount);

    return {
      paymentId: payment.id,
      courseId: payment.courseId,
      teacherId: original?.teacherId ?? null,
      grossAmount: fromPiastres(-amount),
      teacherAmount: fromPiastres(-teacherPiastres),
      platformAmount: fromPiastres(-(amount - teacherPiastres)),
      sharePercent: original ? original.sharePercent : 0,
      currency: payment.currency,
      courseTitleSnapshot: original?.courseTitleSnapshot ?? payment.course.title,
      recognizedAt: now,
    };
  }

  private describeRefunds(payment: PaymentWithLedger): RefundView[] {
    const views: RefundView[] = [];
    for (const row of payment.transactions) {
      const payload = payloadOf(row);
      if (row.type === TX_REQUEST) {
        const resolution = this.resolutionOf(payment, row.id);
        const status: RefundView['status'] = !resolution
          ? 'PENDING'
          : resolution.type === TX_REFUND
            ? 'SUCCEEDED'
            : 'FAILED';
        views.push({
          id: row.id,
          amount: toEgpNumber(toPiastres(row.amount ?? 0, 'amount')),
          currency: row.currency ?? payment.currency,
          status,
          completionMethod: status === 'SUCCEEDED' && resolution ? completionMethodOf(resolution) : null,
          reference: resolution?.providerReference ?? null,
          reason: typeof payload.reason === 'string' ? payload.reason : null,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: resolution?.createdAt.toISOString() ?? null,
        });
      } else if (row.type === TX_REFUND && !payload.requestId) {
        // An immediate refund, or one recorded by the old bookkeeping-only
        // refund (no payload at all: completionMethod UNRECORDED).
        views.push({
          id: row.id,
          amount: toEgpNumber(toPiastres(row.amount ?? 0, 'amount')),
          currency: row.currency ?? payment.currency,
          status: 'SUCCEEDED',
          completionMethod: completionMethodOf(row),
          reference: row.providerReference,
          reason: typeof payload.reason === 'string' ? payload.reason : null,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.createdAt.toISOString(),
        });
      }
    }
    return views;
  }

  /** The summary the Refund dialog renders. Public only so its type can be named. */
  describe(
    payment: PaymentWithLedger,
    enrollment: { id: string; state: string } | null,
  ) {
    const balance = this.balanceOf(payment);
    return {
      payment: {
        id: payment.id,
        status: payment.status,
        provider: payment.provider,
        /**
         * Always false today: no provider refund API is integrated, so a
         * Paymob/Stripe refund must be made in the provider's own dashboard.
         */
        providerRefundIntegrated: false,
        amount: toEgpNumber(balance.paidPiastres),
        currency: payment.currency,
        paidAt: payment.paidAt?.toISOString() ?? null,
        refundedAmount: toEgpNumber(balance.refundedPiastres),
        pendingRefundAmount: toEgpNumber(balance.pendingPiastres),
        refundableAmount: toEgpNumber(balance.refundablePiastres),
        // Exact decimal string, so the dashboard can pre-fill and compare
        // without floating-point drift.
        refundableAmountText: fromPiastres(balance.refundablePiastres),
        eligible:
          (payment.status === PaymentStatus.PAID ||
            payment.status === PaymentStatus.PARTIALLY_REFUNDED) &&
          balance.refundablePiastres > 0,
      },
      student: payment.user,
      course: payment.course,
      enrollment: enrollment ? { id: enrollment.id, state: enrollment.state } : null,
      refunds: this.describeRefunds(payment),
    };
  }

  private async result(tx: Prisma.TransactionClient, paymentId: string, requestId: string) {
    const payment = await this.loadPayment(tx, paymentId);
    const enrollment = await this.findEnrollment(tx, payment);
    return {
      refund: this.describeRefunds(payment).find((r) => r.id === requestId)!,
      summary: this.describe(payment, enrollment),
    };
  }

  /** A retry recognised from the refund row itself (idempotency record purged). */
  private async replayFromRow(
    tx: Prisma.TransactionClient,
    payment: PaymentWithLedger,
    rowId: string,
  ): Promise<RefundResponse> {
    const enrollment = await this.findEnrollment(tx, payment);
    this.logger.log(`refund replayed from transaction row ${rowId}`);
    return {
      refund: this.describeRefunds(payment).find((r) => r.id === rowId)!,
      platformTransferredMoney: false,
      // The original revocation happened with the original request; this
      // reports the enrollment as it stands, and changes nothing.
      access: enrollment
        ? {
            enrollmentId: enrollment.id,
            revoked: true,
            alreadyRevoked: true,
            cancelledPayments: 0,
            revokedPartEntitlements: 0,
            revokedPlaybackTickets: 0,
          }
        : null,
      summary: this.describe(payment, enrollment),
    };
  }

  private fingerprint(request: Record<string, unknown>): string {
    return createHash('sha256').update(JSON.stringify(request)).digest('hex');
  }

  /** The stored result of an earlier request with this key, if there is one. */
  private async replay<T>(
    client: Prisma.TransactionClient | PrismaService,
    key: string,
    fingerprint: string,
  ): Promise<(T & { replayed: true }) | null> {
    const existing = await client.idempotencyRecord.findUnique({ where: { key } });
    if (!existing) return null;

    const stored = existing.response as unknown as { fingerprint?: string; body?: T };
    if (stored.fingerprint !== fingerprint) throw this.keyReused();
    this.logger.log(`refund replayed for key ${key}`);
    return { ...(stored.body as T), replayed: true };
  }
}
