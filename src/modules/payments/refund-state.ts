import { PaymentStatus, type Prisma } from '@prisma/client';

import { toEgpNumber, toPiastres } from '../wallet/money';

/**
 * Refund state derived from a payment's own transaction log.
 *
 * One definition, used by `RefundsService` (to reserve balance) and by every
 * payment list (to show it), so "pending" can never mean two different things.
 *
 *  - `refund`          — a completed refund. Immediate refunds have no
 *                        `requestId`; completing a request writes one that
 *                        carries the request's id.
 *  - `refund_request`  — a pending refund request, until resolved.
 *  - `refund_failed`   — resolves a request as failed.
 */
export const TX_REFUND = 'refund';
export const TX_REQUEST = 'refund_request';
export const TX_REQUEST_FAILED = 'refund_failed';
export const REFUND_TX_TYPES = [TX_REFUND, TX_REQUEST, TX_REQUEST_FAILED];

/** The payment statuses of a captured payment (money was taken). */
export const CAPTURED_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

export interface RefundTxRow {
  id: string;
  type: string;
  amount: Prisma.Decimal | string | number | null;
  rawPayload: Prisma.JsonValue;
}

export function payloadOf(row: { rawPayload: Prisma.JsonValue }): Record<string, unknown> {
  return row.rawPayload && typeof row.rawPayload === 'object' && !Array.isArray(row.rawPayload)
    ? (row.rawPayload as Record<string, unknown>)
    : {};
}

/** The row that resolved a request (completed or failed), if any. */
export function resolutionOf<T extends RefundTxRow>(rows: T[], requestId: string): T | undefined {
  return rows.find(
    (row) =>
      (row.type === TX_REFUND || row.type === TX_REQUEST_FAILED) &&
      payloadOf(row).requestId === requestId,
  );
}

/** Refund requests that are neither completed nor failed. */
export function pendingRequests<T extends RefundTxRow>(rows: T[]): T[] {
  return rows.filter((row) => row.type === TX_REQUEST && !resolutionOf(rows, row.id));
}

export function pendingRefundPiastres(rows: RefundTxRow[]): number {
  return pendingRequests(rows).reduce((sum, row) => sum + toPiastres(row.amount ?? 0, 'amount'), 0);
}

/**
 * The refund state of one payment, for display.
 *
 * Deliberately separate from the payment's own `status`, which is left as it
 * is: a payment with a pending refund is still PAID — no money has gone back
 * yet — and labelling it "refunded" would be false.
 *
 *   NONE                — no refund recorded
 *   PENDING             — a refund request awaits completion (nothing of it
 *                         refunded yet); may coexist with earlier completed
 *                         refunds, shown in `refundedAmount`
 *   PARTIALLY_REFUNDED  — completed refunds cover part of the payment
 *   REFUNDED            — completed refunds cover all of it
 */
export type RefundStatus = 'NONE' | 'PENDING' | 'PARTIALLY_REFUNDED' | 'REFUNDED';

export function refundStateOf(
  payment: { status: PaymentStatus },
  rows: RefundTxRow[] | undefined,
): { refundStatus: RefundStatus; pendingRefundAmount: number } {
  const pending = pendingRefundPiastres(rows ?? []);
  const refundStatus: RefundStatus =
    pending > 0
      ? 'PENDING'
      : payment.status === PaymentStatus.REFUNDED
        ? 'REFUNDED'
        : payment.status === PaymentStatus.PARTIALLY_REFUNDED
          ? 'PARTIALLY_REFUNDED'
          : 'NONE';
  return { refundStatus, pendingRefundAmount: toEgpNumber(pending) };
}

/** The `include` that loads exactly the rows `refundStateOf` needs. */
export const REFUND_TX_INCLUDE = {
  where: { type: { in: REFUND_TX_TYPES } },
  select: { id: true, type: true, amount: true, rawPayload: true },
  orderBy: { createdAt: 'asc' as const },
};
