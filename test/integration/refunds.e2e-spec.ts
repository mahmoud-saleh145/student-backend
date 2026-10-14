import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  EnrollmentMethod,
  EnrollmentState,
  PaymentProvider,
  PaymentStatus,
  UserRole,
} from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { PrismaService } from '../../src/database/prisma.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/payments/refunds.service';

import { createCourse, createUser, resetDatabase } from './helpers';

/**
 * Refunds against REAL PostgreSQL and the real Prisma client.
 *
 * The unit tests use an in-memory store; they prove the logic but cannot
 * prove the database's side of the bargain. These tests do:
 *
 *  - Serializable isolation, the write conflicts it raises, and the retry in
 *    `withSerializableRetry` — under genuinely concurrent transactions on
 *    separate pooled connections;
 *  - the conditional writes on `Decimal` (`refundedAmount`) and `updatedAt`;
 *  - transaction rollback leaving no partial financial or access change;
 *  - the idempotency record's primary key, and its purge.
 *
 * The services are the production classes, built directly (the HTTP app would
 * need Redis and storage credentials this suite does not need).
 *
 * Needs a disposable database whose name ends in `_test` — see setup.ts.
 */

const ADMIN_ACTOR = (id: string) => ({ id, role: UserRole.ADMIN });
let keySeq = 0;
const key = () => `it-refund-key-${Date.now().toString(36)}-${++keySeq}`;

describe('refunds on real PostgreSQL', () => {
  const config = new ConfigService({
    DATABASE_URL: process.env.DATABASE_URL,
    app: { env: 'test' },
    payment: { provider: 'none', defaultPlatformSharePercent: 30, currency: 'EGP' },
  });
  const prisma = new PrismaService(config);
  const audit = new AuditService(prisma);
  const refunds = new RefundsService(prisma, audit);
  const payments = new PaymentsService(
    prisma,
    audit,
    { readableCourseIds: async () => null } as never,
    config,
  );

  let adminId: string;
  let studentId: string;
  let classmateId: string;
  let courseA: string;
  let courseB: string;
  let paymentId: string;
  let checkoutId: string;
  let enrollmentA: string;
  let enrollmentB: string;
  let classmateEnrollment: string;

  /** A captured payment, made the way the product makes one: PENDING, then capture(). */
  async function paidEnrollment(userId: string, courseId: string, amount: number) {
    const enrollment = await prisma.enrollment.create({
      data: {
        userId,
        courseId,
        state: EnrollmentState.PENDING_PAYMENT,
        method: EnrollmentMethod.PAYMENT,
      },
    });
    const payment = await prisma.payment.create({
      data: {
        userId,
        courseId,
        enrollmentId: enrollment.id,
        amount,
        currency: 'EGP',
        status: PaymentStatus.PENDING,
        provider: PaymentProvider.MANUAL,
        idempotencyKey: `pay-${userId}-${courseId}-${Date.now()}`,
      },
    });
    await payments.capture({ paymentId: payment.id });
    return { enrollmentId: enrollment.id, paymentId: payment.id };
  }

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);

    const admin = await createUser(prisma, { role: UserRole.ADMIN, fullName: 'Admin User' });
    const teacher = await createUser(prisma, { role: UserRole.TEACHER, fullName: 'Teacher User' });
    const student = await createUser(prisma, { fullName: 'Refund Student' });
    const classmate = await createUser(prisma, { fullName: 'Classmate Student' });
    adminId = admin.id;
    studentId = student.id;
    classmateId = classmate.id;

    courseA = (await createCourse(prisma, { teacherId: teacher.id, price: 300 })).id;
    courseB = (await createCourse(prisma, { teacherId: teacher.id, price: 100 })).id;

    const a = await paidEnrollment(studentId, courseA, 300);
    paymentId = a.paymentId;
    enrollmentA = a.enrollmentId;
    enrollmentB = (await paidEnrollment(studentId, courseB, 100)).enrollmentId;
    classmateEnrollment = (await paidEnrollment(classmateId, courseA, 300)).enrollmentId;

    // An open checkout on the refunded enrollment: a late confirmation of it
    // must never re-activate access.
    checkoutId = (
      await prisma.payment.create({
        data: {
          userId: studentId,
          courseId: courseA,
          enrollmentId: enrollmentA,
          amount: 300,
          currency: 'EGP',
          status: PaymentStatus.PENDING,
          provider: PaymentProvider.MANUAL,
          idempotencyKey: `checkout-${Date.now()}`,
        },
      })
    ).id;
  });

  // --- what the database holds -------------------------------------------------

  async function paymentRow() {
    return prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  }

  async function contraLines() {
    return prisma.revenueLedger.findMany({
      where: { paymentId, grossAmount: { lt: 0 } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Gross / refunded / net for course A, as the reports compute them, in cents. */
  async function courseRevenue() {
    const [gross, refunded] = await Promise.all([
      prisma.revenueLedger.aggregate({ where: { courseId: courseA, grossAmount: { gt: 0 } }, _sum: { grossAmount: true } }),
      prisma.revenueLedger.aggregate({ where: { courseId: courseA, grossAmount: { lt: 0 } }, _sum: { grossAmount: true } }),
    ]);
    const g = Math.round(Number(gross._sum.grossAmount ?? 0) * 100);
    const r = -Math.round(Number(refunded._sum.grossAmount ?? 0) * 100) || 0;
    return { gross: g, refunded: r, net: g - r };
  }

  async function balance() {
    const s = await refunds.summary(paymentId, ADMIN_ACTOR(adminId));
    return {
      refunded: Math.round(s.payment.refundedAmount * 100),
      pending: Math.round(s.payment.pendingRefundAmount * 100),
      refundable: Math.round(s.payment.refundableAmount * 100),
    };
  }

  const state = async (id: string) =>
    (await prisma.enrollment.findUniqueOrThrow({ where: { id } })).state;

  // --- immediate and pending -----------------------------------------------------

  it('an immediate refund reduces net revenue once, keeps gross, and revokes only that access', async () => {
    const before = await courseRevenue();

    await refunds.refund(
      paymentId,
      { type: 'PARTIAL', amount: '120.50', idempotencyKey: key(), confirmMoneyReturned: true },
      ADMIN_ACTOR(adminId),
    );

    expect(await courseRevenue()).toEqual({
      gross: before.gross,
      refunded: before.refunded + 12050,
      net: before.net - 12050,
    });
    expect(await contraLines()).toHaveLength(1);
    const p = await paymentRow();
    expect(p.status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(p.refundedAmount.toString()).toBe('120.5');

    expect(await state(enrollmentA)).toBe(EnrollmentState.REVOKED);
    expect(await state(enrollmentB)).toBe(EnrollmentState.ACTIVE);
    expect(await state(classmateEnrollment)).toBe(EnrollmentState.ACTIVE);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: checkoutId } })).status).toBe(
      PaymentStatus.CANCELLED,
    );
  });

  it('a pending refund reserves the balance without touching revenue; failing it releases the reservation but not access', async () => {
    const before = await courseRevenue();

    const { refund } = await refunds.refund(
      paymentId,
      { type: 'PARTIAL', amount: '100', idempotencyKey: key(), completion: 'PENDING' },
      ADMIN_ACTOR(adminId),
    );

    expect(await courseRevenue()).toEqual(before);
    expect(await balance()).toEqual({ refunded: 0, pending: 10000, refundable: 20000 });
    expect((await paymentRow()).status).toBe(PaymentStatus.PAID);
    expect(await state(enrollmentA)).toBe(EnrollmentState.REVOKED);

    await refunds.failRequest(paymentId, refund.id, { reason: 'Student withdrew request' }, ADMIN_ACTOR(adminId));

    expect(await courseRevenue()).toEqual(before);
    expect(await balance()).toEqual({ refunded: 0, pending: 0, refundable: 30000 });
    expect(await state(enrollmentA)).toBe(EnrollmentState.REVOKED);
  });

  it('the student payment list shows PAID with a pending refund status — not "refunded"', async () => {
    await refunds.refund(
      paymentId,
      { type: 'FULL', idempotencyKey: key(), completion: 'PENDING' },
      ADMIN_ACTOR(adminId),
    );

    const page = await payments.listForUser(studentId, 1, 20);
    const row = page.items.find((p) => p.id === paymentId)!;
    expect(row).toMatchObject({
      status: PaymentStatus.PAID,
      refundStatus: 'PENDING',
      refundedAmount: 0,
      pendingRefundAmount: 300,
    });
  });

  // --- concurrency ------------------------------------------------------------------

  it.each([
    ['two immediate refunds', { confirmMoneyReturned: true }, { confirmMoneyReturned: true }],
    ['two pending requests', { completion: 'PENDING' as const }, { completion: 'PENDING' as const }],
    ['a pending request and an immediate refund', { completion: 'PENDING' as const }, { confirmMoneyReturned: true }],
  ])('%s racing for 200 each of a 300 payment: exactly one wins', async (_label, a, b) => {
    const outcomes = await Promise.allSettled([
      refunds.refund(paymentId, { type: 'PARTIAL', amount: '200', idempotencyKey: key(), ...a }, ADMIN_ACTOR(adminId)),
      refunds.refund(paymentId, { type: 'PARTIAL', amount: '200', idempotencyKey: key(), ...b }, ADMIN_ACTOR(adminId)),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
    expect([ErrorCode.VALIDATION_ERROR, ErrorCode.INVALID_STATE]).toContain(
      (loser.reason as { code?: string }).code,
    );

    const b2 = await balance();
    expect(b2.refunded + b2.pending).toBe(20000);
    expect((await contraLines()).length).toBe(b2.refunded / 20000);
  });

  it('many concurrent partial refunds never exceed the payment, and the ledger matches exactly', async () => {
    const outcomes = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        refunds.refund(
          paymentId,
          {
            type: 'PARTIAL',
            amount: '80',
            idempotencyKey: key(),
            ...(i % 2 ? { completion: 'PENDING' as const } : { confirmMoneyReturned: true }),
          },
          ADMIN_ACTOR(adminId),
        ),
      ),
    );

    const won = outcomes.filter((o) => o.status === 'fulfilled').length;
    const b = await balance();
    expect(b.refunded + b.pending).toBe(won * 8000);
    expect(b.refunded + b.pending).toBeLessThanOrEqual(30000);
    const ledgerCents = (await contraLines()).reduce(
      (sum, l) => sum - Math.round(Number(l.grossAmount) * 100),
      0,
    );
    expect(ledgerCents).toBe(b.refunded);
    expect((await paymentRow()).refundedAmount.toString()).toBe(String(b.refunded / 100));
    // Every loser failed cleanly, with a known error, never a partial write.
    for (const o of outcomes.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
      const code = (o.reason as { code?: string }).code;
      expect([ErrorCode.VALIDATION_ERROR, ErrorCode.INVALID_STATE, 'P2034']).toContain(code);
    }
  });

  it('completing and failing the same pending refund at once: exactly one takes effect', async () => {
    const { refund } = await refunds.refund(
      paymentId,
      { type: 'PARTIAL', amount: '150', idempotencyKey: key(), completion: 'PENDING' },
      ADMIN_ACTOR(adminId),
    );
    const before = await courseRevenue();

    const outcomes = await Promise.allSettled([
      refunds.completeRequest(paymentId, refund.id, { confirmMoneyReturned: true }, ADMIN_ACTOR(adminId)),
      refunds.failRequest(paymentId, refund.id, { reason: 'Racing failure' }, ADMIN_ACTOR(adminId)),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const resolutions = (
      await prisma.paymentTransaction.findMany({ where: { paymentId, type: { in: ['refund', 'refund_failed'] } } })
    ).filter((t) => (t.rawPayload as { requestId?: string } | null)?.requestId === refund.id);
    expect(resolutions).toHaveLength(1);

    const b = await balance();
    if (resolutions[0]!.type === 'refund') {
      expect(b).toEqual({ refunded: 15000, pending: 0, refundable: 15000 });
      expect(await contraLines()).toHaveLength(1);
      expect((await courseRevenue()).net).toBe(before.net - 15000);
    } else {
      expect(b).toEqual({ refunded: 0, pending: 0, refundable: 30000 });
      expect(await contraLines()).toHaveLength(0);
      expect(await courseRevenue()).toEqual(before);
    }
  });

  // --- duplicates and retries -----------------------------------------------------

  it('the same request sent twice at once is recorded once', async () => {
    const k = key();
    const results = await Promise.all([
      refunds.refund(paymentId, { type: 'PARTIAL', amount: '40', idempotencyKey: k, confirmMoneyReturned: true }, ADMIN_ACTOR(adminId)),
      refunds.refund(paymentId, { type: 'PARTIAL', amount: '40', idempotencyKey: k, confirmMoneyReturned: true }, ADMIN_ACTOR(adminId)),
    ]);

    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(results[0].refund.id).toBe(results[1].refund.id);
    expect(await contraLines()).toHaveLength(1);
    expect((await paymentRow()).refundedAmount.toString()).toBe('40');
  });

  it('a retry after the idempotency record expired and was purged is still recorded once', async () => {
    const k = key();
    const first = await refunds.refund(
      paymentId,
      { type: 'PARTIAL', amount: '40', idempotencyKey: k, confirmMoneyReturned: true },
      ADMIN_ACTOR(adminId),
    );

    // Age the record past its 30 days, then purge exactly as the maintenance
    // job does (maintenance.processor.ts › pruneIdempotency).
    await prisma.idempotencyRecord.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    const purged = await prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    expect(purged.count).toBe(1);

    const retry = await refunds.refund(
      paymentId,
      { type: 'PARTIAL', amount: '40', idempotencyKey: k, confirmMoneyReturned: true },
      ADMIN_ACTOR(adminId),
    );
    expect(retry.replayed).toBe(true);
    expect(retry.refund.id).toBe(first.refund.id);
    expect(await contraLines()).toHaveLength(1);
    expect((await paymentRow()).refundedAmount.toString()).toBe('40');

    await expect(
      refunds.refund(paymentId, { type: 'PARTIAL', amount: '41', idempotencyKey: k, confirmMoneyReturned: true }, ADMIN_ACTOR(adminId)),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });

  // --- atomicity ----------------------------------------------------------------------

  it('a transaction that fails part-way leaves no financial or access change behind', async () => {
    // Fails on the refund's own audit entry — after the payment update, the
    // contra ledger line, the revocation and its audit entry were written in
    // the same transaction.
    const failingAudit = {
      record: audit.record.bind(audit),
      recordTx: async (tx: never, entry: { action: AuditAction }) => {
        if (entry.action === AuditAction.PAYMENT_REFUND) throw new Error('simulated failure mid-transaction');
        return audit.recordTx(tx, entry as never);
      },
    };
    const failing = new RefundsService(prisma, failingAudit as never);
    const before = {
      payment: await paymentRow(),
      revenue: await courseRevenue(),
      tx: await prisma.paymentTransaction.count({ where: { paymentId } }),
      audits: await prisma.auditLog.count(),
    };

    await expect(
      failing.refund(paymentId, { type: 'FULL', idempotencyKey: key(), confirmMoneyReturned: true }, ADMIN_ACTOR(adminId)),
    ).rejects.toThrow('simulated failure mid-transaction');

    const after = await paymentRow();
    expect(after.status).toBe(before.payment.status);
    expect(after.refundedAmount.toString()).toBe(before.payment.refundedAmount.toString());
    expect(after.updatedAt.getTime()).toBe(before.payment.updatedAt.getTime());
    expect(await courseRevenue()).toEqual(before.revenue);
    expect(await prisma.paymentTransaction.count({ where: { paymentId } })).toBe(before.tx);
    expect(await prisma.auditLog.count()).toBe(before.audits);
    expect(await prisma.idempotencyRecord.count()).toBe(0);
    expect(await state(enrollmentA)).toBe(EnrollmentState.ACTIVE);
    expect((await prisma.payment.findUniqueOrThrow({ where: { id: checkoutId } })).status).toBe(
      PaymentStatus.PENDING,
    );
  });

  // --- late events --------------------------------------------------------------------

  it('late captures after a refund neither re-activate access nor add revenue', async () => {
    await refunds.refund(
      paymentId,
      { type: 'PARTIAL', amount: '10', idempotencyKey: key(), confirmMoneyReturned: true },
      ADMIN_ACTOR(adminId),
    );
    const revenue = await courseRevenue();

    await expect(payments.capture({ paymentId })).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await expect(payments.capture({ paymentId: checkoutId })).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await payments.fail(paymentId, 'late_decline');

    expect(await state(enrollmentA)).toBe(EnrollmentState.REVOKED);
    expect((await paymentRow()).status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(await courseRevenue()).toEqual(revenue);
  });

  it('a late capture while a refund is pending is a no-op', async () => {
    await refunds.refund(
      paymentId,
      { type: 'FULL', idempotencyKey: key(), completion: 'PENDING' },
      ADMIN_ACTOR(adminId),
    );
    const revenue = await courseRevenue();

    await payments.capture({ paymentId });

    expect(await state(enrollmentA)).toBe(EnrollmentState.REVOKED);
    expect(await courseRevenue()).toEqual(revenue);
    expect(courseB).toBeDefined();
  });
});
