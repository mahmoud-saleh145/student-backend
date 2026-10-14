import { ConfigService } from '@nestjs/config';
import { EnrollmentState, PaymentProvider, PaymentStatus, Prisma, UserRole } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { RefundsService } from '../../src/modules/payments/refunds.service';

/**
 * Refunds — `RefundsService`.
 *
 * Business rules under test:
 *
 *  - IMMEDIATE (the default) records a completed refund and reduces net
 *    revenue at once, only with the admin's explicit `confirmMoneyReturned`.
 *    It is recorded as admin-confirmed (MANUAL or EXTERNAL), never as
 *    provider-confirmed — the platform transfers no money.
 *  - PENDING reserves the amount without touching revenue; it is completed
 *    (with the same confirmation) or failed (releasing the reservation).
 *  - EVERY refund request — immediate or pending, full or partial — revokes
 *    access to that course, and only that course. A failed refund does not
 *    restore it.
 *  - Money is exact to the piastre; succeeded + pending never exceed the
 *    payment; the ledger is append-only and nets to zero on a full refund.
 *  - Retries cannot duplicate anything, including after the idempotency
 *    record has been purged; races cannot over-refund.
 *  - A late capture/fail event cannot re-activate access or rewrite a refund.
 *
 * The store is stateful and evaluates the `where` clauses the service sends.
 */

type Row = Record<string, unknown> & { id: string };

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const TEACHER = { id: 'usr_teacher', role: UserRole.TEACHER };

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    const value = row[key];
    if (condition instanceof Date) {
      return value instanceof Date && value.getTime() === condition.getTime();
    }
    if (condition !== null && typeof condition === 'object') {
      const c = condition as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      throw new Error(`fake store: unsupported filter on ${key}: ${JSON.stringify(c)}`);
    }
    return value === condition;
  });
}

const T0 = new Date('2026-09-01T10:00:00Z');

function paymentRow(overrides: Record<string, unknown> & { id: string }): Row {
  return {
    userId: 'usr_student',
    courseId: 'crs_a',
    enrollmentId: 'enr_a',
    amount: '300.00',
    currency: 'EGP',
    status: PaymentStatus.PAID,
    provider: PaymentProvider.MANUAL,
    providerReference: null,
    refundedAmount: '0.00',
    refundedAt: null,
    paidAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function seed(provider: PaymentProvider = PaymentProvider.MANUAL) {
  return {
    payment: [
      paymentRow({
        id: 'pay_1',
        provider,
        providerReference: provider === PaymentProvider.MANUAL ? null : 'txn_provider_1',
      }),
      // A pending checkout on the same enrollment: must be cancelled so it
      // cannot re-activate access later.
      paymentRow({ id: 'pay_pending', provider, status: PaymentStatus.PENDING, paidAt: null }),
      // The same student's payment for another course.
      paymentRow({ id: 'pay_other', courseId: 'crs_b', enrollmentId: 'enr_b', amount: '100.00', provider }),
    ],
    paymentTransaction: [] as Row[],
    revenueLedger: [
      // 60% teacher share, written at capture.
      {
        id: 'rev_1',
        paymentId: 'pay_1',
        courseId: 'crs_a',
        teacherId: 'usr_teacher',
        grossAmount: '300.00',
        teacherAmount: '180.00',
        platformAmount: '120.00',
        sharePercent: '60.00',
        currency: 'EGP',
        courseTitleSnapshot: 'Anatomy I',
      },
      {
        id: 'rev_other',
        paymentId: 'pay_other',
        courseId: 'crs_b',
        teacherId: 'usr_teacher',
        grossAmount: '100.00',
        teacherAmount: '60.00',
        platformAmount: '40.00',
        sharePercent: '60.00',
        currency: 'EGP',
        courseTitleSnapshot: 'Physiology',
      },
    ] as Row[],
    idempotencyRecord: [] as Row[],
    enrollment: [
      {
        id: 'enr_a',
        userId: 'usr_student',
        courseId: 'crs_a',
        state: EnrollmentState.ACTIVE,
        coversAllSections: true,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
      {
        id: 'enr_b',
        userId: 'usr_student',
        courseId: 'crs_b',
        state: EnrollmentState.ACTIVE,
        coversAllSections: true,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
    ] as Row[],
    enrollmentSectionGrant: [
      { id: 'grt_a', enrollmentId: 'enr_a', sectionId: 'sec_1', source: 'PART_PURCHASE', codeId: null, partId: 'prt_1', createdAt: T0 },
    ] as Row[],
    coursePartEntitlement: [
      { id: 'ent_a', userId: 'usr_student', courseId: 'crs_a', coursePartId: 'prt_1', revokedAt: null },
      { id: 'ent_b', userId: 'usr_student', courseId: 'crs_b', coursePartId: 'prt_9', revokedAt: null },
    ] as Row[],
    playbackTicket: [
      { id: 'tkt_a', userId: 'usr_student', courseId: 'crs_a', status: 'ACTIVE' },
      { id: 'tkt_b', userId: 'usr_student', courseId: 'crs_b', status: 'ACTIVE' },
    ] as Row[],
    accessCode: [{ id: 'cod_1', status: 'EXHAUSTED', redemptionCount: 1, maxRedemptions: 1 }] as Row[],
    accessCodeRedemption: [
      { id: 'red_1', codeId: 'cod_1', userId: 'usr_student', enrollmentId: 'enr_a', courseId: 'crs_a' },
    ] as Row[],
    course: [
      { id: 'crs_a', title: 'Anatomy I', studentCount: 1 },
      { id: 'crs_b', title: 'Physiology', studentCount: 1 },
    ] as Row[],
    user: [{ id: 'usr_student', fullName: 'Sara Student', phone: '01000000004' }] as Row[],
    auditLog: [] as Row[],
  };
}

type Store = ReturnType<typeof seed>;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function buildClient(db: Store) {
  let ids = 0;
  const nextId = (name: string) => `${name}_${++ids}`;

  const crud = (name: keyof Store) => ({
    findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      db[name].filter((r) => matches(r, where)),
    ),
    count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      db[name].filter((r) => matches(r, where)).length,
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        await tick();
        const hit = db[name].filter((r) => matches(r, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    ),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const keep = db[name].filter((r) => !matches(r, where));
      const count = db[name].length - keep.length;
      (db[name] as Row[]) = keep;
      return { count };
    }),
    createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
      for (const row of data) db[name].push({ id: nextId(name), createdAt: new Date(), ...row });
      return { count: data.length };
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: nextId(name), createdAt: new Date(), ...data } as Row;
      db[name].push(row);
      return row;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = db[name].find((r) => r.id === where.id);
        if (!row) throw new Error(`fake store: ${name} ${where.id} missing`);
        Object.assign(row, data);
        return row;
      },
    ),
  });

  return {
    payment: {
      ...crud('payment'),
      findUnique: jest.fn(
        async ({ where, include }: { where: { id: string }; include?: Record<string, unknown> }) => {
          // The snapshot is taken BEFORE yielding, like a database read: a
          // concurrent writer that runs in between is not seen. Reading after
          // the yield hid the over-reservation race from this test.
          const row = db.payment.find((r) => r.id === where.id);
          if (!row) {
            await tick();
            return null;
          }
          if (!include) {
            const plain = { ...row };
            await tick();
            return plain;
          }
          const course = db.course.find((c) => c.id === row.courseId)!;
          const snapshot = {
            ...row,
            revenue: db.revenueLedger.filter((l) => l.paymentId === row.id).map((l) => ({ ...l })),
            course: {
              id: course.id,
              title: course.title,
              teachers: [],
              accessDurationType: 'LIFETIME',
              accessDurationDays: null,
              accessEndsAt: null,
            },
            user: db.user.find((u) => u.id === row.userId),
            transactions: db.paymentTransaction
              .filter(
                (t) =>
                  t.paymentId === row.id &&
                  ['refund', 'refund_request', 'refund_failed'].includes(t.type as string),
              )
              .map((t) => ({ ...t })),
          };
          await tick();
          return snapshot;
        },
      ),
    },
    paymentTransaction: crud('paymentTransaction'),
    revenueLedger: crud('revenueLedger'),
    idempotencyRecord: {
      findUnique: jest.fn(async ({ where }: { where: { key: string } }) =>
        db.idempotencyRecord.find((r) => r.key === where.key) ?? null,
      ),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (db.idempotencyRecord.some((r) => r.key === data.key)) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
          });
        }
        const row = { id: String(data.key), ...data } as Row;
        db.idempotencyRecord.push(row);
        return row;
      }),
    },
    enrollment: {
      ...crud('enrollment'),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; userId_courseId?: { userId: string; courseId: string } };
        }) => {
          await tick();
          const row = where.id
            ? db.enrollment.find((r) => r.id === where.id)
            : db.enrollment.find(
                (r) =>
                  r.userId === where.userId_courseId?.userId &&
                  r.courseId === where.userId_courseId?.courseId,
              );
          if (!row) return null;
          return {
            ...row,
            sectionGrants: db.enrollmentSectionGrant.filter((g) => g.enrollmentId === row.id),
          };
        },
      ),
    },
    enrollmentSectionGrant: crud('enrollmentSectionGrant'),
    coursePartEntitlement: crud('coursePartEntitlement'),
    playbackTicket: crud('playbackTicket'),
    accessCodeRedemption: crud('accessCodeRedemption'),
    course: crud('course'),
    auditLog: crud('auditLog'),
  };
}

/**
 * `serial: true` runs transactions one after another — the observable effect
 * of Serializable isolation with retry. `serial: false` lets them interleave,
 * which is what the conditional writes must survive on their own.
 */
function build(db: Store = seed(), { serial = true } = {}) {
  const client = buildClient(db);
  let chain: Promise<unknown> = Promise.resolve();

  const prisma = {
    ...client,
    $transaction: jest.fn(async (fn: (t: typeof client) => Promise<unknown>) => {
      if (!serial) return fn(client);
      const run = chain.then(() => fn(client));
      chain = run.catch(() => undefined);
      return run;
    }),
  };

  const audit = {
    record: jest.fn(async () => undefined),
    recordTx: jest.fn(async (tx: typeof client, entry: Record<string, unknown>) => {
      await tx.auditLog.create({ data: entry });
    }),
  };

  const refunds = new RefundsService(prisma as never, audit as never);
  const payments = new PaymentsService(
    prisma as never,
    audit as never,
    {} as never,
    new ConfigService({ payment: { defaultPlatformSharePercent: 30 } }),
  );

  return { db, refunds, payments, prisma };
}

/** The default: immediate, with the admin's confirmation. */
const CONFIRMED = { confirmMoneyReturned: true };
const PENDING = { completion: 'PENDING' as const };
const DONE = { confirmMoneyReturned: true };

let keySeq = 0;
const key = () => `test-key-${++keySeq}-abcdef`;

const enrollment = (db: Store, id: string) => db.enrollment.find((r) => r.id === id)!;
const payment = (db: Store, id = 'pay_1') => db.payment.find((r) => r.id === id)!;
const contraLines = (db: Store) =>
  db.revenueLedger.filter((l) => l.paymentId === 'pay_1' && String(l.grossAmount).startsWith('-'));

/** What the revenue reports compute from the ledger, in piastres. */
function report(db: Store, courseId = 'crs_a') {
  const lines = db.revenueLedger.filter((l) => l.courseId === courseId);
  const p = (v: unknown) => Math.round(Number(v) * 100);
  const gross = lines.filter((l) => p(l.grossAmount) > 0).reduce((s, l) => s + p(l.grossAmount), 0);
  // `0 - sum` rather than `-sum`: negating an empty sum yields -0.
  const refunded = 0 - lines.filter((l) => p(l.grossAmount) < 0).reduce((s, l) => s + p(l.grossAmount), 0);
  const net = lines.reduce((s, l) => s + p(l.grossAmount), 0);
  const teacher = lines.reduce((s, l) => s + p(l.teacherAmount), 0);
  const platform = lines.reduce((s, l) => s + p(l.platformAmount), 0);
  return { gross, refunded, net, teacher, platform };
}

describe('immediate refund (the default)', () => {
  it('records a completed full refund and reduces net revenue once, keeping gross and the original lines', async () => {
    const { db, refunds } = build();

    const result = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(result.refund).toMatchObject({
      status: 'SUCCEEDED',
      amount: 300,
      currency: 'EGP',
      completionMethod: 'ADMIN_CONFIRMED_MANUAL',
    });
    expect(result.platformTransferredMoney).toBe(false);
    expect(payment(db)).toMatchObject({ status: PaymentStatus.REFUNDED, refundedAmount: '300.00', amount: '300.00' });

    expect(db.revenueLedger.find((l) => l.id === 'rev_1')).toMatchObject({ grossAmount: '300.00', teacherAmount: '180.00' });
    expect(contraLines(db)).toEqual([
      expect.objectContaining({ grossAmount: '-300.00', teacherAmount: '-180.00', platformAmount: '-120.00', sharePercent: '60.00' }),
    ]);
    expect(report(db)).toEqual({ gross: 30000, refunded: 30000, net: 0, teacher: 0, platform: 0 });
    expect(report(db, 'crs_b').net).toBe(10000);
  });

  it('is the default when no completion is sent', async () => {
    const { db, refunds } = build();
    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '50', idempotencyKey: key(), ...CONFIRMED }, ADMIN);
    expect(payment(db).refundedAmount).toBe('50.00');
  });

  it('refuses without the confirmation that the money was returned, changing nothing', async () => {
    const { db, refunds } = build();
    const before = JSON.stringify(db);

    for (const confirm of [undefined, false]) {
      await expect(
        refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), confirmMoneyReturned: confirm }, ADMIN),
      ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    }
    expect(JSON.stringify(db)).toBe(before);
  });

  it('records a provider payment as an admin-confirmed EXTERNAL refund, never provider-confirmed', async () => {
    const { db, refunds } = build(seed(PaymentProvider.PAYMOB));

    const result = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(result.refund).toMatchObject({ status: 'SUCCEEDED', completionMethod: 'ADMIN_CONFIRMED_EXTERNAL' });
    expect(result.summary.payment.providerRefundIntegrated).toBe(false);
    expect(db.auditLog.find((e) => e.action === 'PAYMENT_REFUND')).toMatchObject({
      after: expect.objectContaining({
        completionMethod: 'ADMIN_CONFIRMED_EXTERNAL',
        moneyReturnedConfirmedByAdmin: true,
        platformTransferredMoney: false,
      }),
    });
    expect(JSON.stringify(db)).not.toContain('PROVIDER_CONFIRMED');
  });

  it('after a partial refund, a full refund takes only the remaining balance', async () => {
    const { db, refunds } = build();

    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '100', idempotencyKey: key(), ...CONFIRMED }, ADMIN);
    const second = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(second.refund.amount).toBe(200);
    expect(payment(db)).toMatchObject({ status: PaymentStatus.REFUNDED, refundedAmount: '300.00' });
    expect(contraLines(db).map((l) => [l.grossAmount, l.teacherAmount, l.platformAmount])).toEqual([
      ['-100.00', '-60.00', '-40.00'],
      ['-200.00', '-120.00', '-80.00'],
    ]);
    expect(report(db)).toMatchObject({ net: 0, teacher: 0, platform: 0, refunded: 30000 });
  });

  it('settles the teacher share exactly even when partial refunds rounded', async () => {
    const { db, refunds } = build();

    // 0.05 at 60% is 0.03 rounded half-up; three of them round up three times.
    for (let i = 0; i < 3; i += 1) {
      await refunds.refund('pay_1', { type: 'PARTIAL', amount: '0.05', idempotencyKey: key(), ...CONFIRMED }, ADMIN);
    }
    await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(report(db)).toMatchObject({ net: 0, teacher: 0, platform: 0 });
  });

  it('a partial refund is proportional and leaves the rest refundable', async () => {
    const { db, refunds } = build();

    const result = await refunds.refund(
      'pay_1',
      { type: 'PARTIAL', amount: '120.50', reason: 'Missed half the term', idempotencyKey: key(), ...CONFIRMED },
      ADMIN,
    );

    expect(result.refund).toMatchObject({ status: 'SUCCEEDED', amount: 120.5, reason: 'Missed half the term' });
    expect(payment(db)).toMatchObject({ status: PaymentStatus.PARTIALLY_REFUNDED, refundedAmount: '120.50' });
    expect(contraLines(db)).toEqual([
      expect.objectContaining({ grossAmount: '-120.50', teacherAmount: '-72.30', platformAmount: '-48.20' }),
    ]);
    expect(report(db)).toMatchObject({ gross: 30000, refunded: 12050, net: 17950 });
    expect(result.summary.payment).toMatchObject({ refundableAmount: 179.5, refundableAmountText: '179.50', eligible: true });
  });
});

describe('amount validation', () => {
  it.each([
    ['zero', '0'],
    ['three decimals', '10.005'],
    ['not a number', 'ten'],
    ['negative', '-5'],
  ])('rejects %s', async (_label, amount) => {
    const { db, refunds } = build();
    const before = JSON.stringify(db);

    await expect(
      refunds.refund('pay_1', { type: 'PARTIAL', amount, idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(JSON.stringify(db)).toBe(before);
  });

  it('rejects more than the refundable balance', async () => {
    const { db, refunds } = build();
    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '250', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    await expect(
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '50.01', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    expect(payment(db).refundedAmount).toBe('250.00');
  });

  it('requires an amount for PARTIAL and refuses one for FULL', async () => {
    const { refunds } = build();
    await expect(
      refunds.refund('pay_1', { type: 'PARTIAL', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    await expect(
      refunds.refund('pay_1', { type: 'FULL', amount: '10', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses a payment that is already fully refunded, or was never paid', async () => {
    const { refunds } = build();
    await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    await expect(
      refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await expect(
      refunds.refund('pay_pending', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });
});

describe('pending refund', () => {
  it.each([PaymentProvider.MANUAL, PaymentProvider.PAYMOB])(
    'on a %s payment: reserves the amount, revokes access, and is not refunded money',
    async (provider) => {
      const { db, refunds } = build(seed(provider));

      const result = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '100', idempotencyKey: key(), ...PENDING }, ADMIN);

      expect(result.refund).toMatchObject({ status: 'PENDING', amount: 100, completionMethod: null });
      expect(payment(db)).toMatchObject({ status: PaymentStatus.PAID, refundedAmount: '0.00' });
      expect(contraLines(db)).toHaveLength(0);
      expect(report(db)).toMatchObject({ refunded: 0, net: 30000 });
      expect(enrollment(db, 'enr_a').state).toBe(EnrollmentState.REVOKED);
      expect(result.summary.payment).toMatchObject({ pendingRefundAmount: 100, refundableAmount: 200, refundedAmount: 0 });
    },
  );

  it('does not need the money-returned confirmation', async () => {
    const { refunds } = build();
    const result = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...PENDING }, ADMIN);
    expect(result.refund.status).toBe('PENDING');
  });

  it('pending + succeeded can never exceed the payment', async () => {
    const { refunds } = build();
    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '250', idempotencyKey: key(), ...PENDING }, ADMIN);

    await expect(
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '60', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
    const full = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);
    expect(full.refund.amount).toBe(50);
    await expect(
      refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...PENDING }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });

  it('completing it requires the confirmation, then records it and revenue once', async () => {
    const { db, refunds } = build(seed(PaymentProvider.STRIPE));
    const { refund } = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...PENDING }, ADMIN);

    await expect(refunds.completeRequest('pay_1', refund.id, {}, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
    expect(contraLines(db)).toHaveLength(0);

    const done = await refunds.completeRequest('pay_1', refund.id, { ...DONE, reference: 'st_rf_77' }, ADMIN);
    const again = await refunds.completeRequest('pay_1', refund.id, { ...DONE, reference: 'st_rf_77' }, ADMIN);

    expect(done.refund).toMatchObject({ status: 'SUCCEEDED', reference: 'st_rf_77', completionMethod: 'ADMIN_CONFIRMED_EXTERNAL' });
    expect(again.replayed).toBe(true);
    expect(payment(db)).toMatchObject({ status: PaymentStatus.REFUNDED, refundedAmount: '300.00' });
    expect(contraLines(db)).toHaveLength(1);
    expect(report(db).net).toBe(0);
    await expect(
      refunds.failRequest('pay_1', refund.id, { reason: 'too late' }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });

  it('completing a manual pending refund needs no reference', async () => {
    const { refunds } = build();
    const { refund } = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '30', idempotencyKey: key(), ...PENDING }, ADMIN);

    const done = await refunds.completeRequest('pay_1', refund.id, DONE, ADMIN);
    expect(done.refund).toMatchObject({ status: 'SUCCEEDED', reference: null, completionMethod: 'ADMIN_CONFIRMED_MANUAL' });
  });

  it('a failed request releases its amount without touching revenue, and does NOT restore access', async () => {
    const { db, refunds } = build();
    const { refund } = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...PENDING }, ADMIN);
    const ledgerBefore = JSON.stringify(db.revenueLedger);

    const failed = await refunds.failRequest('pay_1', refund.id, { reason: 'Student changed their mind' }, ADMIN);
    const again = await refunds.failRequest('pay_1', refund.id, { reason: 'Student changed their mind' }, ADMIN);

    expect(failed.refund.status).toBe('FAILED');
    expect(again.replayed).toBe(true);
    expect(failed.summary.payment).toMatchObject({ refundableAmount: 300, pendingRefundAmount: 0, refundedAmount: 0 });
    expect(payment(db)).toMatchObject({ status: PaymentStatus.PAID, refundedAmount: '0.00' });
    expect(JSON.stringify(db.revenueLedger)).toBe(ledgerBefore);
    expect(enrollment(db, 'enr_a').state).toBe(EnrollmentState.REVOKED);
    await expect(
      refunds.completeRequest('pay_1', refund.id, DONE, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
  });

  it('an unknown request id is not found', async () => {
    const { refunds } = build();
    await expect(refunds.completeRequest('pay_1', 'nope', DONE, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });
});

describe('every refund request revokes access to that course', () => {
  it.each([
    ['an immediate full refund', { type: 'FULL' as const, ...CONFIRMED }],
    ['an immediate partial refund', { type: 'PARTIAL' as const, amount: '1', ...CONFIRMED }],
    ['a pending full refund', { type: 'FULL' as const, ...PENDING }],
    ['a pending partial refund', { type: 'PARTIAL' as const, amount: '1', ...PENDING }],
  ])('%s revokes the enrollment, playback, grants, parts and the pending checkout', async (_l, input) => {
    const { db, refunds } = build();

    const result = await refunds.refund('pay_1', { ...input, idempotencyKey: key() }, ADMIN);

    expect(enrollment(db, 'enr_a')).toMatchObject({
      state: EnrollmentState.REVOKED,
      revokedById: ADMIN.id,
      coversAllSections: false,
    });
    expect(result.access).toMatchObject({ enrollmentId: 'enr_a', revoked: true, alreadyRevoked: false, cancelledPayments: 1 });
    expect(db.playbackTicket.find((t) => t.id === 'tkt_a')!.status).toBe('REVOKED');
    expect(db.enrollmentSectionGrant).toHaveLength(0);
    expect(db.coursePartEntitlement.find((e) => e.id === 'ent_a')!.revokedAt).toBeInstanceOf(Date);
    expect(payment(db, 'pay_pending').status).toBe(PaymentStatus.CANCELLED);

    // The student's other course is untouched.
    expect(enrollment(db, 'enr_b').state).toBe(EnrollmentState.ACTIVE);
    expect(db.playbackTicket.find((t) => t.id === 'tkt_b')!.status).toBe('ACTIVE');
    expect(db.coursePartEntitlement.find((e) => e.id === 'ent_b')!.revokedAt).toBeNull();
    expect(payment(db, 'pay_other').status).toBe(PaymentStatus.PAID);
  });

  it('records the refund and the revocation in the audit log', async () => {
    const { db, refunds } = build();
    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '50', reason: 'Duplicate', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(db.auditLog.find((e) => e.action === 'PAYMENT_REFUND')).toMatchObject({
      actorId: ADMIN.id,
      entity: 'payment',
      entityId: 'pay_1',
      note: 'Duplicate',
      after: expect.objectContaining({
        refundStatus: 'SUCCEEDED',
        completion: 'IMMEDIATE',
        completionMethod: 'ADMIN_CONFIRMED_MANUAL',
        amount: '50.00',
        currency: 'EGP',
        userId: 'usr_student',
        courseId: 'crs_a',
        accessRevoked: true,
      }),
    });
    expect(db.auditLog.find((e) => e.action === 'ACCESS_REVOKE')).toMatchObject({
      entityId: 'enr_a',
      note: 'Refunded: Duplicate',
      after: expect.objectContaining({ cause: 'refund', paymentId: 'pay_1', amount: '50.00' }),
    });
  });

  it('a late or repeated capture cannot restore access or add revenue — after a completed refund', async () => {
    const { db, refunds, payments } = build();
    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '10', idempotencyKey: key(), ...CONFIRMED }, ADMIN);
    const ledger = db.revenueLedger.length;

    await expect(payments.capture({ paymentId: 'pay_1' })).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    await expect(payments.capture({ paymentId: 'pay_pending' })).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });

    expect(enrollment(db, 'enr_a').state).toBe(EnrollmentState.REVOKED);
    expect(payment(db).status).toBe(PaymentStatus.PARTIALLY_REFUNDED);
    expect(db.revenueLedger).toHaveLength(ledger);
  });

  it('a late capture cannot restore access while a refund is still pending', async () => {
    const { db, refunds, payments } = build(seed(PaymentProvider.PAYMOB));
    await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...PENDING }, ADMIN);
    const ledger = db.revenueLedger.length;

    // The payment is still PAID: capture is a no-op, not a re-activation.
    await payments.capture({ paymentId: 'pay_1' });
    await expect(payments.capture({ paymentId: 'pay_pending' })).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });

    expect(enrollment(db, 'enr_a').state).toBe(EnrollmentState.REVOKED);
    expect(db.revenueLedger).toHaveLength(ledger);
  });

  it('a late failure event does not overwrite a refunded payment', async () => {
    const { db, refunds, payments } = build();
    await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    await payments.fail('pay_1', 'declined');

    expect(payment(db).status).toBe(PaymentStatus.REFUNDED);
  });

  it('a refund on an already-removed student still records the refund', async () => {
    const db = seed();
    enrollment(db, 'enr_a').state = EnrollmentState.REVOKED;
    const { refunds } = build(db);

    const result = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(result.refund.status).toBe('SUCCEEDED');
    expect(result.access).toMatchObject({ revoked: true, alreadyRevoked: true });
  });
});

describe('codes', () => {
  it('leaves the redeemed code consumed and its redemption linked', async () => {
    const { db, refunds } = build();
    await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, ADMIN);

    expect(db.accessCode).toEqual([{ id: 'cod_1', status: 'EXHAUSTED', redemptionCount: 1, maxRedemptions: 1 }]);
    expect(db.accessCodeRedemption).toEqual([
      { id: 'red_1', codeId: 'cod_1', userId: 'usr_student', enrollmentId: 'enr_a', courseId: 'crs_a' },
    ]);
  });
});

describe('historical refunds', () => {
  it('shows a refund written by the old bookkeeping refund as UNRECORDED, and counts it', async () => {
    const db = seed();
    Object.assign(payment(db), { status: PaymentStatus.PARTIALLY_REFUNDED, refundedAmount: '100.00' });
    db.paymentTransaction.push({
      id: 'ptx_legacy',
      paymentId: 'pay_1',
      type: 'refund',
      status: 'succeeded',
      amount: '100.00',
      currency: 'EGP',
      providerReference: null,
      rawPayload: null,
      createdAt: T0,
    });
    const { refunds } = build(db);

    const summary = await refunds.summary('pay_1', ADMIN);

    expect(summary.refunds).toEqual([
      expect.objectContaining({ id: 'ptx_legacy', status: 'SUCCEEDED', completionMethod: 'UNRECORDED', amount: 100 }),
    ]);
    expect(summary.payment).toMatchObject({ refundedAmount: 100, refundableAmount: 200 });
  });
});

describe('retries and races', () => {
  it('a retry with the same key returns the first result and records nothing new', async () => {
    const { db, refunds } = build();
    const k = key();

    const first = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN);
    const snapshot = JSON.stringify(db);
    const second = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN);

    expect(second.replayed).toBe(true);
    expect(second.refund).toEqual(first.refund);
    expect(JSON.stringify(db)).toBe(snapshot);
  });

  it('a retry after the idempotency record was purged (30 days) still records nothing new', async () => {
    const { db, refunds } = build();
    const k = key();
    const first = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN);

    // What the maintenance job does once `expiresAt` passes.
    db.idempotencyRecord.length = 0;
    const snapshot = JSON.stringify(db);
    const retry = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN);

    expect(retry.replayed).toBe(true);
    expect(retry.refund.id).toBe(first.refund.id);
    expect(JSON.stringify(db)).toBe(snapshot);
    expect(contraLines(db)).toHaveLength(1);
  });

  it('a purged-key retry of a pending request is also recognised', async () => {
    const { db, refunds } = build();
    const k = key();
    const first = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...PENDING }, ADMIN);
    db.idempotencyRecord.length = 0;

    const retry = await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...PENDING }, ADMIN);

    expect(retry.replayed).toBe(true);
    expect(retry.refund.id).toBe(first.refund.id);
    expect(retry.summary.payment.pendingRefundAmount).toBe(40);
  });

  it('refuses a reused key for a different refund — before and after the purge', async () => {
    const { db, refunds } = build();
    const k = key();
    await refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN);

    await expect(
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '41', idempotencyKey: k, ...CONFIRMED }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });

    db.idempotencyRecord.length = 0;
    await expect(
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...PENDING }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.INVALID_STATE });
    expect(payment(db).refundedAmount).toBe('40.00');
  });

  it('two concurrent submissions of the same refund record it once', async () => {
    const { db, refunds } = build();
    const k = key();

    const results = await Promise.all([
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN),
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '40', idempotencyKey: k, ...CONFIRMED }, ADMIN),
    ]);

    expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
    expect(payment(db).refundedAmount).toBe('40.00');
    expect(contraLines(db)).toHaveLength(1);
  });

  it('two different concurrent refunds cannot together exceed the payment', async () => {
    const { db, refunds } = build();

    const outcomes = await Promise.allSettled([
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '200', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '200', idempotencyKey: key(), ...CONFIRMED }, ADMIN),
    ]);

    expect(outcomes.map((o) => o.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(payment(db).refundedAmount).toBe('200.00');
    expect(contraLines(db)).toHaveLength(1);
  });

  it.each([
    ['two immediate refunds', CONFIRMED, CONFIRMED],
    ['two pending requests', PENDING, PENDING],
    ['a pending request and an immediate refund', PENDING, CONFIRMED],
  ])('interleaved without isolation, %s cannot over-reserve', async (_l, a, b) => {
    const { db, refunds } = build(seed(), { serial: false });

    const outcomes = await Promise.allSettled([
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '200', idempotencyKey: key(), ...a }, ADMIN),
      refunds.refund('pay_1', { type: 'PARTIAL', amount: '200', idempotencyKey: key(), ...b }, ADMIN),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const summary = await refunds.summary('pay_1', ADMIN);
    expect(summary.payment.refundedAmount + summary.payment.pendingRefundAmount).toBe(200);
    expect(contraLines(db).length).toBeLessThanOrEqual(1);
  });

  it('interleaved, completing and failing the same request cannot both take effect', async () => {
    const { db, refunds } = build(seed(), { serial: true });
    const { refund } = await refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...PENDING }, ADMIN);

    const racing = build(db, { serial: false }).refunds;
    const outcomes = await Promise.allSettled([
      racing.completeRequest('pay_1', refund.id, DONE, ADMIN),
      racing.failRequest('pay_1', refund.id, { reason: 'Racing' }, ADMIN),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const resolutions = db.paymentTransaction.filter(
      (t) => (t.rawPayload as Record<string, unknown> | null)?.requestId === refund.id,
    );
    expect(resolutions).toHaveLength(1);
  });
});

describe('authorization', () => {
  it('refuses a teacher for every refund operation, changing nothing', async () => {
    const { db, refunds } = build();
    const before = JSON.stringify(db);

    await expect(refunds.summary('pay_1', TEACHER)).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_ROLE });
    await expect(
      refunds.refund('pay_1', { type: 'FULL', idempotencyKey: key(), ...CONFIRMED }, TEACHER),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_ROLE });
    await expect(
      refunds.completeRequest('pay_1', 'r', DONE, TEACHER),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_ROLE });
    await expect(
      refunds.failRequest('pay_1', 'r', { reason: 'abc' }, TEACHER),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_ROLE });
    expect(JSON.stringify(db)).toBe(before);
  });
});
