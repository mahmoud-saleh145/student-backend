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
import { MONEY_TX_OPTIONS, PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

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
   * Provider hand-off.
   *
   * With PAYMENT_PROVIDER=none the platform runs a manual flow: the payment
   * stays PENDING and an administrator confirms it after receiving the money
   * (bank transfer, cash at the centre — how these platforms usually operate
   * before card processing is live). Returning null tells the client there is
   * no external page to open.
   *
   * The real provider call belongs here; the surrounding contract does not
   * change when it is added.
   */
  private async buildCheckoutUrl(
    paymentId: string,
    _currency: string,
    _amount: number,
  ): Promise<string | null> {
    switch (this.cfg.provider) {
      case 'paymob':
        if (!this.cfg.paymob.apiKey) {
          this.logger.warn('PAYMENT_PROVIDER=paymob but PAYMOB_API_KEY is empty');
          return null;
        }
        // See docs/MANUAL_STEPS.md §Payments for the exact call sequence.
        return `https://accept.paymob.com/api/acceptance/iframes/${this.cfg.paymob.iframeId}?payment_token=PENDING_${paymentId}`;

      case 'stripe':
        if (!this.cfg.stripe.secretKey) {
          this.logger.warn('PAYMENT_PROVIDER=stripe but STRIPE_SECRET_KEY is empty');
          return null;
        }
        return null;

      default:
        return null;
    }
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
    const result = await this.prisma.$transaction(async (tx) => {
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

      if (
        payment.status === PaymentStatus.REFUNDED ||
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
    }, MONEY_TX_OPTIONS);

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
    if (payment.status === PaymentStatus.PAID) {
      // A "failure" arriving after a capture is almost always an out-of-order
      // webhook. Record it, but do not undo the capture.
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

  /**
   * Refund.
   *
   * Additive: the original payment keeps its amount and paidAt; a refund
   * transaction and a negative revenue line are appended. Reversing the
   * original row would destroy the record that money was taken at all.
   */
  async refund(
    paymentId: string,
    input: { amount?: number; reason: string },
    actor: { id: string; role: UserRole },
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { course: { select: { title: true } }, revenue: true },
      });

      if (!payment) throw AppException.notFound('Payment', paymentId);
      if (payment.status !== PaymentStatus.PAID && payment.status !== PaymentStatus.PARTIALLY_REFUNDED) {
        throw new AppException(ErrorCode.INVALID_STATE, {
          message: `Only a paid payment can be refunded (current: ${payment.status})`,
        });
      }

      const alreadyRefunded = Number(payment.refundedAmount);
      const gross = Number(payment.amount);
      const requested = input.amount ?? gross - alreadyRefunded;

      if (requested <= 0 || alreadyRefunded + requested > gross) {
        throw AppException.validation({
          amount: [`must be between 0 and ${gross - alreadyRefunded}`],
        });
      }

      const now = new Date();
      const total = alreadyRefunded + requested;
      const fullyRefunded = total >= gross;

      const updated = await tx.payment.update({
        where: { id: paymentId },
        data: {
          refundedAmount: total,
          refundedAt: now,
          status: fullyRefunded
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PARTIALLY_REFUNDED,
        },
      });

      await tx.paymentTransaction.create({
        data: {
          paymentId,
          type: 'refund',
          status: 'succeeded',
          amount: requested,
          currency: payment.currency,
        },
      });

      // Contra revenue line. Reporting sums the ledger, so a negative row is
      // the correct way to reduce recognised revenue without editing history.
      const original = payment.revenue[0];
      const sharePercent = original ? Number(original.sharePercent) : 0;
      const teacherPortion = Math.round(requested * (sharePercent / 100) * 100) / 100;

      await tx.revenueLedger.create({
        data: {
          paymentId,
          courseId: payment.courseId,
          teacherId: original?.teacherId ?? null,
          grossAmount: -requested,
          teacherAmount: -teacherPortion,
          platformAmount: -(Math.round((requested - teacherPortion) * 100) / 100),
          sharePercent,
          currency: payment.currency,
          courseTitleSnapshot: payment.course.title,
          recognizedAt: now,
        },
      });

      // A full refund ends access; a partial one does not.
      if (fullyRefunded && payment.enrollmentId) {
        await tx.enrollment.update({
          where: { id: payment.enrollmentId },
          data: {
            state: EnrollmentState.REVOKED,
            revokedAt: now,
            revokedById: actor.id,
            revokedReason: `Refunded: ${input.reason}`,
          },
        });
        await tx.playbackTicket.updateMany({
          where: { userId: payment.userId, courseId: payment.courseId, status: 'ACTIVE' },
          data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Payment refunded' },
        });
      }

      return { payment: updated, requested, fullyRefunded };
    }, MONEY_TX_OPTIONS);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.PAYMENT_REFUND,
      entity: 'payment',
      entityId: paymentId,
      after: {
        refundedAmount: Number(result.payment.refundedAmount),
        status: result.payment.status,
      },
      note: input.reason,
    });

    return {
      id: paymentId,
      status: result.payment.status,
      refundedAmount: Number(result.payment.refundedAmount),
      fullyRefunded: result.fullyRefunded,
    };
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
        include: { course: { select: { id: true, title: true } } },
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
    courseId?: string;
    userId?: string;
    status?: PaymentStatus;
    from?: Date;
    to?: Date;
  }) {
    const where: Prisma.PaymentWhereInput = {
      ...(params.courseId ? { courseId: params.courseId } : {}),
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
        },
      }),
      this.prisma.payment.count({ where }),
      this.prisma.payment.aggregate({
        where: { ...where, status: PaymentStatus.PAID },
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
          net: Number(sum._sum.amount ?? 0) - Number(sum._sum.refundedAmount ?? 0),
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
  }) {
    return {
      id: payment.id,
      amount: Number(payment.amount),
      currency: payment.currency,
      status: payment.status,
      provider: payment.provider,
      reference: payment.providerReference,
      refundedAmount: Number(payment.refundedAmount),
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
