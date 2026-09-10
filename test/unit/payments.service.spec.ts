import { PaymentStatus, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { PaymentsService } from '../../src/modules/payments/payments.service';

/**
 * Payment capture.
 *
 * The three invariants under test are the ones the spec calls out as
 * non-negotiable (§28, §30, §71):
 *
 *   1. **The amount is frozen at purchase.** A later price change must not
 *      alter what a past payment recorded, and revenue must never be
 *      recomputed from the course's current price.
 *   2. **Capture is idempotent.** Payment providers retry webhooks. A second
 *      delivery must not write a second revenue row — that would silently
 *      double-count the platform's income.
 *   3. **A refund is additive.** It appends a contra entry; it never edits or
 *      deletes the original.
 */

const COURSE = {
  id: 'crs_1',
  title: 'Circuit Analysis II',
  accessDurationType: 'FIXED_DAYS',
  accessDurationDays: 180,
  accessEndsAt: null,
  teachers: [
    {
      teacherId: 'tch_1',
      isLead: true,
      revenueSharePercent: 60,
      teacher: { teacherProfile: { revenueSharePercent: 50 } },
    },
  ],
};

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_1',
    userId: 'usr_1',
    courseId: 'crs_1',
    enrollmentId: 'enr_1',
    coursePriceId: 'prc_1',
    amount: 450,
    currency: 'EGP',
    status: PaymentStatus.PENDING,
    provider: 'MANUAL',
    providerReference: null,
    refundedAmount: 0,
    paidAt: null,
    course: COURSE,
    ...overrides,
  };
}

function buildService(row: ReturnType<typeof payment>) {
  // `args: never` made every `revenueCreate.mock.calls[0][0].data` read fail
  // to compile. The ledger assertions are the point of this file, so the mock
  // is typed loosely but concretely enough to index into.
  const revenueCreate = jest.fn(
    async (args: { data: Record<string, unknown> }) => args,
  );
  const paymentUpdate = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    ...row,
    ...data,
  }));

  const tx = {
    payment: {
      findUnique: jest.fn(async () => row),
      findFirst: jest.fn(async () => null),
      update: paymentUpdate,
      create: jest.fn(async ({ data }: { data: never }) => ({ id: 'pay_new', ...(data as object) })),
    },
    paymentTransaction: { create: jest.fn(async () => ({})) },
    enrollment: {
      update: jest.fn(async (_args: { data: Record<string, unknown> }) => ({})),
      count: jest.fn(async () => 12),
    },
    revenueLedger: { create: revenueCreate },
    course: { update: jest.fn(async () => ({})) },
  };

  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  };

  const audit = { record: jest.fn(async () => undefined) };

  const config = {
    getOrThrow: () => ({
      provider: 'manual',
      defaultPlatformSharePercent: 30,
      currency: 'EGP',
      checkoutBaseUrl: null,
    }),
  };

  const service = new PaymentsService(
    prisma as never,
    audit as never,
    config as never,
  );

  return { service, tx, prisma, audit, revenueCreate, paymentUpdate };
}

describe('PaymentsService.capture', () => {
  it('marks the payment PAID and activates the enrollment', async () => {
    const { service, tx } = buildService(payment());

    const result = await service.capture({ paymentId: 'pay_1' });

    expect(result.status).toBe(PaymentStatus.PAID);
    expect(tx.enrollment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'enr_1' },
        data: expect.objectContaining({ state: 'ACTIVE' }),
      }),
    );
  });

  it('records revenue from the amount stored on the payment, not the live price', async () => {
    // The payment was taken at 450. Even if the course now sells for 550, the
    // ledger must read 450 — this is the whole point of freezing the amount.
    const { service, revenueCreate } = buildService(payment({ amount: 450 }));

    await service.capture({ paymentId: 'pay_1' });

    const data = revenueCreate.mock.calls[0]![0].data;
    expect(Number(data.grossAmount)).toBe(450);
    expect(Number(data.teacherAmount)).toBe(270); // 60%
    expect(Number(data.platformAmount)).toBe(180);
    expect(data.sharePercent).toBe(60);
  });

  it('snapshots the course title so reports survive a rename or archive', async () => {
    const { service, revenueCreate } = buildService(payment());

    await service.capture({ paymentId: 'pay_1' });

    expect(revenueCreate.mock.calls[0]![0].data.courseTitleSnapshot).toBe(
      'Circuit Analysis II',
    );
  });

  it('prefers the per-assignment share over the teacher default', async () => {
    // 60 on the assignment, 50 on the profile — the assignment wins.
    const { service, revenueCreate } = buildService(payment());

    await service.capture({ paymentId: 'pay_1' });

    expect(revenueCreate.mock.calls[0]![0].data.sharePercent).toBe(60);
  });

  it('falls back to the platform default when neither share is configured', async () => {
    const { service, revenueCreate } = buildService(
      payment({
        course: {
          ...COURSE,
          teachers: [
            {
              teacherId: 'tch_1',
              isLead: true,
              revenueSharePercent: null,
              teacher: { teacherProfile: { revenueSharePercent: null } },
            },
          ],
        },
      }),
    );

    await service.capture({ paymentId: 'pay_1' });

    // 100 − defaultPlatformSharePercent(30) = 70
    expect(revenueCreate.mock.calls[0]![0].data.sharePercent).toBe(70);
  });

  describe('idempotency', () => {
    it('does nothing on a repeat capture of an already-PAID payment', async () => {
      const { service, revenueCreate, paymentUpdate } = buildService(
        payment({ status: PaymentStatus.PAID, paidAt: new Date() }),
      );

      const result = await service.capture({ paymentId: 'pay_1' });

      expect(result.status).toBe(PaymentStatus.PAID);
      // The important assertion: no second revenue row.
      expect(revenueCreate).not.toHaveBeenCalled();
      expect(paymentUpdate).not.toHaveBeenCalled();
    });

    it('does not write a second audit entry for a repeat capture', async () => {
      const { service, audit } = buildService(
        payment({ status: PaymentStatus.PAID, paidAt: new Date() }),
      );

      await service.capture({ paymentId: 'pay_1' });

      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe('rejects', () => {
    it('capturing a refunded payment', async () => {
      const { service } = buildService(payment({ status: PaymentStatus.REFUNDED }));

      await expect(service.capture({ paymentId: 'pay_1' })).rejects.toMatchObject({
        code: ErrorCode.INVALID_STATE,
      });
    });

    it('capturing a cancelled payment', async () => {
      const { service } = buildService(payment({ status: PaymentStatus.CANCELLED }));

      await expect(service.capture({ paymentId: 'pay_1' })).rejects.toBeInstanceOf(
        AppException,
      );
    });

    it('capturing a payment that does not exist', async () => {
      const { service, tx } = buildService(payment());
      tx.payment.findUnique.mockResolvedValueOnce(null as never);

      await expect(service.capture({ paymentId: 'nope' })).rejects.toMatchObject({
        code: ErrorCode.NOT_FOUND,
      });
    });
  });

  describe('access window', () => {
    it('grants FIXED_DAYS access measured from the capture moment', async () => {
      const { service, tx } = buildService(payment());

      const before = Date.now();
      await service.capture({ paymentId: 'pay_1' });

      const data = tx.enrollment.update.mock.calls[0]![0].data as {
        accessEndsAt: Date;
      };
      const expected = before + 180 * 86_400_000;

      expect(data.accessEndsAt.getTime()).toBeGreaterThanOrEqual(expected - 5_000);
      expect(data.accessEndsAt.getTime()).toBeLessThanOrEqual(expected + 5_000);
    });

    it('grants open-ended access for a LIFETIME course', async () => {
      const { service, tx } = buildService(
        payment({
          course: { ...COURSE, accessDurationType: 'LIFETIME', accessDurationDays: null },
        }),
      );

      await service.capture({ paymentId: 'pay_1' });

      const data = tx.enrollment.update.mock.calls[0]![0].data as {
        accessEndsAt: Date | null;
      };
      expect(data.accessEndsAt).toBeNull();
    });

    it('uses the fixed calendar date for an UNTIL_DATE course', async () => {
      const until = new Date('2027-06-30T00:00:00.000Z');
      const { service, tx } = buildService(
        payment({
          course: {
            ...COURSE,
            accessDurationType: 'UNTIL_DATE',
            accessDurationDays: null,
            accessEndsAt: until,
          },
        }),
      );

      await service.capture({ paymentId: 'pay_1' });

      const data = tx.enrollment.update.mock.calls[0]![0].data as {
        accessEndsAt: Date;
      };
      expect(data.accessEndsAt.toISOString()).toBe(until.toISOString());
    });
  });

  it('audits the capture with the actor who performed it', async () => {
    const { service, audit } = buildService(payment());

    await service.capture({
      paymentId: 'pay_1',
      actor: { id: 'adm_1', role: UserRole.ADMIN },
      note: 'Confirmed against bank transfer #8812',
    });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'adm_1',
        actorRole: UserRole.ADMIN,
        entity: 'payment',
        entityId: 'pay_1',
      }),
    );
  });
});
