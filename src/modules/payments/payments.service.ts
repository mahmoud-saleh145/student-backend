import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  type CoursePrice,
  EnrollmentState,
  PaymentProvider,
  PaymentStatus,
  type Prisma,
  UserRole,
} from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import type { PaymentConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { withSerializableRetry } from '../../database/serializable-retry';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';

import {
  CAPTURED_STATUSES,
  REFUND_TX_INCLUDE,
  type RefundTxRow,
  refundStateOf,
} from './refund-state';

export interface CheckoutSession {
  paymentId: string;
  checkoutUrl: string | null;
  reference: string;
  amount: number;
  currency: string;
  provider: PaymentProvider;
}

/**
 * Payments and revenue.
 *
 * The financial invariants this service exists to hold, all of which come
 * straight from spec §28/§30/§71/§92:
 *
 *  1. **A payment freezes its own price.** `amount` is copied at creation and
 *     `coursePriceId` pins the exact version. Repricing a course later cannot
 *     change what a past student paid, and revenue is never recomputed from
 *     the current price.
 *
 *  2. **Revenue is written once, at capture.** RevenueLedger rows carry the
 *     course title as a snapshot, so a renamed or archived course still
 *     reports correctly.
 *
 *  3. **Nothing financial is ever deleted.** Refunds are additive rows, not
 *     mutations that erase the original. The schema's Restrict constraints
 *     make deletion structurally impossible.
 *
 *  4. **Capture is idempotent.** Providers retry webhooks; a duplicate must
 *     not double-grant access or double-count revenue.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly cfg: PaymentConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CourseAccessService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<PaymentConfig>('payment');
  }

  // ---------------------------------------------------------------------------
  // Checkout
  // ---------------------------------------------------------------------------

  /**
   * Creates a PENDING payment for the price currently in force.
   *
   * Runs inside the caller's transaction so a payment row and the
   * PENDING_PAYMENT enrollment are created together or not at all.
   */
  async createPendingPayment(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      courseId: string;
      enrollmentId: string;
      price: CoursePrice;
      idempotencyKey?: string;
    },
  ): Promise<CheckoutSession> {
    const idempotencyKey =
      params.idempotencyKey ??
      `pay_${params.userId}_${params.courseId}_${randomUUID().slice(0, 8)}`;

    // A student who taps Join twice should reuse the open checkout rather than
    // create a second pending charge.
    const existing = await tx.payment.findFirst({
      where: {
        userId: params.userId,
        courseId: params.courseId,
        status: PaymentStatus.PENDING,
        createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return {
        paymentId: existing.id,
        checkoutUrl: existing.checkoutUrl,
        reference: existing.providerReference ?? existing.id,
        amount: Number(existing.amount),
        currency: existing.currency,
        provider: existing.provider,
      };
    }

    const provider = this.providerEnum();

    const payment = await tx.payment.create({
      data: {
        userId: params.userId,
        courseId: params.courseId,
        enrollmentId: params.enrollmentId,
        coursePriceId: params.price.id,
        // Frozen here. Never read back from Course/CoursePrice for reporting.
        amount: params.price.amount,
        currency: params.price.currency,
        status: PaymentStatus.PENDING,
        provider,
        idempotencyKey,
      },
    });

    await tx.paymentTransaction.create({
      data: {
        paymentId: payment.id,
        type: 'create',
        status: 'pending',
        amount: payment.amount,
        currency: payment.currency,
      },
    });

    const checkoutUrl = await this.buildCheckoutUrl(payment.id, payment.currency, Number(payment.amount));

    if (checkoutUrl) {
      await tx.payment.update({
        where: { id: payment.id },
        data: { checkoutUrl, providerReference: `ref_${payment.id}` },
      });
    }

    return {
      paymentId: payment.id,
      checkoutUrl,
      reference: `ref_${payment.id}`,
      amount: Number(payment.amount),
      currency: payment.currency,
      provider,
    };
  }

  private providerEnum(): PaymentProvider {
    switch (this.cfg.provider) {
      case 'paymob':
        return PaymentProvider.PAYMOB;
      case 'stripe':
        return PaymentProvider.STRIPE;
      default:
        return PaymentProvider.MANUAL;
    }
  }

  /**
   * Provider hand-off: permanently disabled.
   *
   * Owner decision (2026-10-30, Phase 6 §4.1): there are no online payments
   * in Student Center. This method used to build a Paymob/Stripe checkout URL
   * when a provider was configured; it now returns null unconditionally, so a
   * payment created by the enrolment flow always stays PENDING with no
   * external page to open, and an administrator confirms it after receiving
   * the money through the approved offline process (POST
   * admin/payments/:id/confirm). PAYMENT_PROVIDER is also locked to 'none' in
   * env.validation.ts, so this is defence in depth, not the only barrier.
   * Historical Payment rows, the capture/refund paths and the admin flow are
   * untouched.
   */
  private async buildCheckoutUrl(
    _paymentId: string,
    _currency: string,
    _amount: number,
  ): Promise<string | null> {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Capture
  // ---------------------------------------------------------------------------

  /**
   * Marks a payment paid, activates the enrollment and writes revenue.
   *
   * Idempotent by design: a payment already in PAID short-circuits, so a
   * retried webhook cannot double-grant access or duplicate the ledger line.
   */
  async capture(params: {
    paymentId: string;
    providerReference?: string;
    rawPayload?: Record<string, unknown>;
    actor?: { id: string; role: UserRole };
    note?: string;
  }) {
    const result = await withSerializableRetry(this.prisma, async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: params.paymentId },
        include: {
          course: {
            select: {
              id: true,
              title: true,
              accessDurationType: true,
              accessDurationDays: true,
              accessEndsAt: true,
              teachers: {
                select: {
                  teacherId: true,
                  isLead: true,
                  revenueSharePercent: true,
                  teacher: {
                    select: { teacherProfile: { select: { revenueSharePercent: true } } },
                  },
                },
              },
            },
          },
        },
      });

      if (!payment) throw AppException.notFound('Payment', params.paymentId);

      // --- idempotency ------------------------------------------------------
      if (payment.status === PaymentStatus.PAID) {
        this.logger.log(`capture ignored: payment ${payment.id} is already PAID`);
        return { payment, alreadyPaid: true, enrollmentId: payment.enrollmentId };
      }

      // PARTIALLY_REFUNDED belongs here too: it is a payment that was captured
      // and then partly returned. It used to fall through, so a late or repeated
      // provider event set it back to PAID, re-activated the enrollment the
      // refund had revoked, and wrote a second revenue line.
      if (
        payment.status === PaymentStatus.REFUNDED ||
        payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
        payment.status === PaymentStatus.CANCELLED
      ) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: `Cannot capture a ${payment.status.toLowerCase()} payment`,
        });
      }

      const now = new Date();

      const updated = await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: PaymentStatus.PAID,
          paidAt: now,
          providerReference: params.providerReference ?? payment.providerReference,
        },
      });

      await tx.paymentTransaction.create({
        data: {
          paymentId: payment.id,
          type: 'capture',
          status: 'succeeded',
          amount: payment.amount,
          currency: payment.currency,
          providerReference: params.providerReference,
          rawPayload: this.redactPayload(params.rawPayload) as Prisma.InputJsonValue,
        },
      });

      // --- activate access --------------------------------------------------
      const accessEndsAt = this.computeAccessEnd(payment.course, now);

      if (payment.enrollmentId) {
        await tx.enrollment.update({
          where: { id: payment.enrollmentId },
          data: {
            state: EnrollmentState.ACTIVE,
            accessStartsAt: now,
            accessEndsAt,
            revokedAt: null,
            revokedReason: null,
            // A payment buys the WHOLE course. Without this a student whose
            // earlier enrollment was section-scoped (a part code) or revoked
            // (which clears coverage) paid full price and stayed limited to
            // the old sections, or to none.
            coversAllSections: true,
          },
        });
      }

      // --- revenue, written once -------------------------------------------
      const gross = Number(payment.amount);
      const lead =
        payment.course.teachers.find((t) => t.isLead) ?? payment.course.teachers[0] ?? null;

      const sharePercent = lead
        ? Number(
            lead.revenueSharePercent ??
              lead.teacher.teacherProfile?.revenueSharePercent ??
              100 - this.cfg.defaultPlatformSharePercent,
          )
        : 0;

      const teacherAmount = Math.round(gross * (sharePercent / 100) * 100) / 100;
      const platformAmount = Math.round((gross - teacherAmount) * 100) / 100;

      await tx.revenueLedger.create({
        data: {
          paymentId: payment.id,
          courseId: payment.courseId,
          teacherId: lead?.teacherId ?? null,
          grossAmount: gross,
          teacherAmount,
          platformAmount,
          sharePercent,
          currency: payment.currency,
          // Snapshot so reports survive a rename or archive.
          courseTitleSnapshot: payment.course.title,
          recognizedAt: now,
        },
      });

      const studentCount = await tx.enrollment.count({
        where: { courseId: payment.courseId, state: EnrollmentState.ACTIVE },
      });
      await tx.course.update({
        where: { id: payment.courseId },
        data: { studentCount },
      });

      return { payment: updated, alreadyPaid: false, enrollmentId: payment.enrollmentId };
    });

    if (!result.alreadyPaid) {
      await this.audit.record({
        actorId: params.actor?.id ?? null,
        actorRole: params.actor?.role ?? null,
        action: AuditAction.PAYMENT_CONFIRM,
        entity: 'payment',
        entityId: params.paymentId,
        after: {
          status: PaymentStatus.PAID,
          amount: Number(result.payment.amount),
          currency: result.payment.currency,
        },
        note: params.note,
      });
    }

    return {
      id: result.payment.id,
      status: result.payment.status,
      amount: Number(result.payment.amount),
      currency: result.payment.currency,
      paidAt: result.payment.paidAt?.toISOString() ?? null,
      enrollmentId: result.enrollmentId,
    };
  }

  private computeAccessEnd(
    course: {
      accessDurationType: string;
      accessDurationDays: number | null;
      accessEndsAt: Date | null;
    },
    from: Date,
  ): Date | null {
    switch (course.accessDurationType) {
      case 'FIXED_DAYS':
        return course.accessDurationDays
          ? new Date(from.getTime() + course.accessDurationDays * 86_400_000)
          : null;
      case 'UNTIL_DATE':
        return course.accessEndsAt;
      case 'LIFETIME':
      default:
        return null;
    }
  }

  async fail(paymentId: string, code: string, rawPayload?: Record<string, unknown>) {
    const payment = await this.prisma.payment.findUnique({ where: { id: paymentId } });
    if (!payment) throw AppException.notFound('Payment', paymentId);
    if (
      payment.status === PaymentStatus.PAID ||
      payment.status === PaymentStatus.PARTIALLY_REFUNDED ||
      payment.status === PaymentStatus.REFUNDED
    ) {
      // A "failure" arriving after a capture is almost always an out-of-order
      // webhook. Record it, but do not undo the capture — or overwrite a
      // refunded payment's status, which would hide that money was returned.
      await this.prisma.paymentTransaction.create({
        data: {
          paymentId,
          type: 'webhook',
          status: 'ignored_after_capture',
          rawPayload: this.redactPayload(rawPayload) as Prisma.InputJsonValue,
        },
      });
      return { id: paymentId, status: payment.status };
    }

    // Not Serializable, and deliberately left that way: a single-row status write
    // with a companion ledger row has no read-then-write on shared state, so
    // there is no write conflict to retry. Raising the isolation level here
    // would only add serialization failures to the webhook path.
    const updated = await this.prisma.$transaction(async (tx) => {
      const p = await tx.payment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.FAILED, failedAt: new Date(), failureCode: code },
      });
      await tx.paymentTransaction.create({
        data: {
          paymentId,
          type: 'fail',
          status: code,
          rawPayload: this.redactPayload(rawPayload) as Prisma.InputJsonValue,
        },
      });
      return p;
    });

    return { id: updated.id, status: updated.status, failureCode: code };
  }

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  async listForUser(userId: string, page: number, pageSize: number) {
    const where = { userId };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          course: { select: { id: true, title: true } },
          transactions: REFUND_TX_INCLUDE,
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return paginated(
      rows.map((p) => this.serialize(p)),
      total,
      page,
      pageSize,
    );
  }

  async listForAdmin(params: {
    page: number;
    pageSize: number;
    /**
     * The staff member asking. A payment row carries the student's name and
     * phone, and the totals block is platform revenue, so visibility follows
     * the same `canViewRevenue` assignment capability analytics already
     * enforces rather than a second, laxer rule living in this method.
     */
    actor: { id: string; role: UserRole };
    courseId?: string;
    userId?: string;
    status?: PaymentStatus;
    from?: Date;
    to?: Date;
  }) {
    // `null` = master/admin, unrestricted. A teacher sees only the courses
    // whose assignment grants `revenue`, so the totals aggregate exactly the
    // rows they are allowed to see — never a platform-wide figure.
    const readable = await this.access.readableCourseIds(
      params.actor.id,
      params.actor.role,
      'revenue',
    );

    if (readable !== null && readable.length === 0) {
      const empty = paginated([], 0, params.page, params.pageSize);
      return {
        ...empty,
        meta: { ...empty.meta, totals: { paid: 0, refunded: 0, net: 0 } },
      };
    }

    // One composed `courseId`, not two spread keys that would overwrite.
    // Intersecting a requested courseId keeps probing outside the assignment
    // indistinguishable from probing a course that does not exist.
    const courseCondition: Prisma.PaymentWhereInput['courseId'] =
      readable === null
        ? params.courseId
        : params.courseId
          ? { in: readable.filter((id) => id === params.courseId) }
          : { in: readable };

    const where: Prisma.PaymentWhereInput = {
      ...(courseCondition ? { courseId: courseCondition } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.from || params.to
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total, sum] = await this.prisma.$transaction([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          course: { select: { id: true, title: true } },
          user: { select: { id: true, fullName: true, phone: true } },
          coursePrice: { select: { version: true, amount: true } },
          transactions: REFUND_TX_INCLUDE,
        },
      }),
      this.prisma.payment.count({ where }),
      // Captured payments, including (partly) refunded ones. This summed PAID
      // only, so `refunded` was always 0 — a refunded payment is no longer
      // PAID — and refunded payments vanished from `paid`. The same scoped
      // `where` (courseId stays at the top level); an explicit status filter
      // still narrows it, and a non-captured one totals nothing.
      this.prisma.payment.aggregate({
        where: {
          ...where,
          status: params.status
            ? { in: CAPTURED_STATUSES.filter((s) => s === params.status) }
            : { in: CAPTURED_STATUSES },
        },
        _sum: { amount: true, refundedAmount: true },
      }),
    ]);

    const page = paginated(
      rows.map((p) => ({
        ...this.serialize(p),
        user: p.user,
        priceVersion: p.coursePrice?.version ?? null,
      })),
      total,
      params.page,
      params.pageSize,
    );

    return {
      ...page,
      meta: {
        ...page.meta,
        totals: {
          paid: Number(sum._sum.amount ?? 0),
          refunded: Number(sum._sum.refundedAmount ?? 0),
          // Whole cents, so 0.1 + 0.2 style drift cannot reach a total.
          net:
            (Math.round(Number(sum._sum.amount ?? 0) * 100) -
              Math.round(Number(sum._sum.refundedAmount ?? 0) * 100)) /
            100,
        },
      },
    };
  }

  private serialize(payment: {
    id: string;
    amount: Prisma.Decimal;
    currency: string;
    status: PaymentStatus;
    provider: PaymentProvider;
    providerReference: string | null;
    refundedAmount: Prisma.Decimal;
    paidAt: Date | null;
    createdAt: Date;
    checkoutUrl: string | null;
    course?: { id: string; title: string } | null;
    transactions?: RefundTxRow[];
  }) {
    // `status` stays the payment's own state: a payment with a pending refund
    // is still PAID, because no money has gone back yet. The refund state is
    // reported beside it, so a client can show "refund pending" without
    // anyone mislabelling the payment as refunded.
    const refund = refundStateOf(payment, payment.transactions ?? []);
    return {
      id: payment.id,
      amount: Number(payment.amount),
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      reference: payment.providerReference,
      /** Completed refunds only. */
      refundedAmount: Number(payment.refundedAmount),
      /** Reserved by refund requests not yet completed — not refunded money. */
      pendingRefundAmount: refund.pendingRefundAmount,
      refundStatus: refund.refundStatus,
      paidAt: payment.paidAt?.toISOString() ?? null,
      createdAt: payment.createdAt.toISOString(),
      checkoutUrl: payment.checkoutUrl,
      course: payment.course ?? null,
    };
  }

  /** Card data must never reach the database, even inside a raw payload. */
  private redactPayload(payload?: Record<string, unknown>): unknown {
    if (!payload) return undefined;

    const BLOCK = [
      'card',
      'pan',
      'cvv',
      'cvc',
      'number',
      'expiry',
      'exp_month',
      'exp_year',
      'token',
      'secret',
      'apikey',
      'api_key',
      'hmac',
      'signature',
    ];

    const walk = (value: unknown, depth = 0): unknown => {
      if (depth > 6 || value == null) return value;
      if (Array.isArray(value)) return value.slice(0, 50).map((v) => walk(v, depth + 1));
      if (typeof value !== 'object') return value;

      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = BLOCK.some((b) => k.toLowerCase().includes(b))
          ? '«redacted»'
          : walk(v, depth + 1);
      }
      return out;
    };

    return walk(payload);
  }

  /** Stable fingerprint for webhook de-duplication. */
  static webhookFingerprint(provider: string, body: unknown): string {
    return createHash('sha256')
      .update(`${provider}:${JSON.stringify(body)}`)
      .digest('hex');
  }
}
