import { ConfigService } from '@nestjs/config';
import {
  CodeTargetType,
  DiscountType,
  PaymentProvider,
  PaymentStatus,
  UserRole,
  WalletTxDirection,
  WalletTxSource,
  WalletTxType,
} from '@prisma/client';

import { MONEY_TX_OPTIONS, PrismaService } from '../../src/database/prisma.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import { CodesService } from '../../src/modules/codes/codes.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';

import { createCourse, createUser, resetDatabase } from './helpers';

/**
 * The Statistics screen's revenue, against REAL PostgreSQL.
 *
 * Cards are issued with the production `generateBatch`, redeemed with the
 * production `redeemInTransaction`, recharge cards go through the production
 * `redeemRechargeCode`, and wallet adjustments and spending through the
 * production `WalletService`. Only each redemption's timestamp is then moved,
 * to place it precisely against the period's edges.
 *
 * What this proves that the unit test cannot: that the relation filters
 * (`redemptions: { some, none }`, `code: { … }`), the Decimal sums, the
 * timestamp comparisons and the raw SQL behind the daily series all mean, in
 * a real database, what the definitions say — and that the series adds up to
 * the tiles.
 *
 * Needs a disposable database whose name ends in `_test` — see setup.ts.
 */

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T23:59:59.999Z');
const PERIOD = { from: FROM, to: TO };
const BEFORE = new Date('2026-09-15T09:00:00.000Z');
const IN_A = new Date('2026-10-05T10:00:00.000Z');
const IN_B = new Date('2026-10-20T16:30:00.000Z');
const AFTER = new Date('2026-11-03T08:00:00.000Z');

describe('revenue reporting on real PostgreSQL', () => {
  const config = new ConfigService({
    DATABASE_URL: process.env.DATABASE_URL,
    app: { env: 'test' },
    payment: { provider: 'none', defaultPlatformSharePercent: 30, currency: 'EGP' },
  });
  const prisma = new PrismaService(config);
  const audit = new AuditService(prisma);
  const settings = {
    rechargeBounds: async () => ({ minimum: 10, maximum: 100_000, allowOverride: false }),
  };
  const codes = new CodesService(prisma, audit, settings as never);
  const wallet = new WalletService(prisma, audit);
  const analytics = new AnalyticsService(prisma, {} as never);

  let admin: { id: string; role: UserRole };
  let courseId: string;
  let students: string[];

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);

    const adminUser = await createUser(prisma, {
      role: UserRole.ADMIN,
      fullName: 'Admin User',
    });
    const teacher = await createUser(prisma, {
      role: UserRole.TEACHER,
      fullName: 'Teacher User',
    });
    admin = { id: adminUser.id, role: UserRole.ADMIN };
    courseId = (await createCourse(prisma, { teacherId: teacher.id })).id;

    students = [];
    for (let i = 0; i < 6; i += 1) {
      students.push(
        (await createUser(prisma, { fullName: `Student Number ${i + 1}` })).id,
      );
    }
  });

  /** One card, issued the way the dashboard issues it. Returns its code. */
  async function card(extra: {
    amountCollected?: number;
    free?: boolean;
    maxRedemptions?: number;
  }) {
    const result = await codes.generateBatch(
      { targetType: CodeTargetType.COURSE, courseId, count: 1, ...extra },
      admin,
    );
    return result.codes[0]!;
  }

  /** Redeems through the production path, then dates the redemption. */
  async function redeem(rawCode: string, userId: string, at: Date) {
    await prisma.$transaction(
      (tx) => codes.redeemInTransaction(tx, { rawCode, userId, courseId }),
      MONEY_TX_OPTIONS,
    );
    const updated = await prisma.accessCodeRedemption.updateMany({
      where: { code: { code: rawCode }, userId },
      data: { redeemedAt: at },
    });
    expect(updated.count).toBe(1);
  }

  /** A recharge card sold and redeemed through the production wallet path. */
  async function topUp(
    userId: string,
    faceValue: number,
    discountAmount: number,
    at: Date,
  ) {
    const issued = await codes.generateRechargeBatch(
      {
        faceValue,
        discountType: discountAmount ? DiscountType.FIXED : DiscountType.NONE,
        discountAmount: discountAmount || undefined,
        count: 1,
      },
      admin,
    );
    await wallet.redeemRechargeCode({ rawCode: issued.codes[0]!, userId });
    const row = await prisma.rechargeRevenue.updateMany({
      where: { codeSnapshot: issued.codes[0]! },
      data: { recognizedAt: at },
    });
    expect(row.count).toBe(1);
  }

  /** A legacy card: issued before an amount was required. */
  async function legacyCard(code: string, priceAmount: number | null) {
    await prisma.accessCode.create({
      data: {
        code,
        targetType: CodeTargetType.COURSE,
        courseId,
        priceAmount,
        actualPaidAmount: null,
        issuedById: admin.id,
      },
    });
    return code;
  }

  /** An online payment and its ledger line (the disabled channel). */
  async function ledgerLine(userId: string, gross: number, at: Date) {
    const payment = await prisma.payment.create({
      data: {
        userId,
        courseId,
        amount: Math.abs(gross),
        status: PaymentStatus.PAID,
        provider: PaymentProvider.MANUAL,
        idempotencyKey: `it-rev-${Math.random().toString(36).slice(2)}`,
        paidAt: at,
      },
    });
    await prisma.revenueLedger.create({
      data: {
        paymentId: payment.id,
        courseId,
        grossAmount: gross,
        platformAmount: gross,
        teacherAmount: 0,
        sharePercent: 0,
        courseTitleSnapshot: 'Integration Test Course',
        recognizedAt: at,
      },
    });
  }

  /** The awkward picture, built through the production paths. */
  async function seed() {
    const [s1, s2, s3, s4, s5, s6] = students as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];

    await redeem(await card({ amountCollected: 600 }), s1, IN_A); // sold in October
    await redeem(await card({ amountCollected: 1000 }), s2, BEFORE); // sold in September
    await redeem(await card({ amountCollected: 80.5 }), s3, AFTER); // first used in November

    // Multi-use paid cards: the amount was collected once, for the card.
    const multiOld = await card({ amountCollected: 250, maxRedemptions: 3 });
    await redeem(multiOld, s1, BEFORE);
    await redeem(multiOld, s2, IN_A); // a later use is not a second sale
    const multiNew = await card({ amountCollected: 300, maxRedemptions: 3 });
    await redeem(multiNew, s3, IN_A);
    await redeem(multiNew, s4, IN_B);

    await card({ amountCollected: 700 }); // never redeemed: not revenue

    const free = await card({ free: true, maxRedemptions: 5 });
    await redeem(free, s1, BEFORE);
    await redeem(free, s2, IN_A);
    await redeem(free, s5, IN_B);

    // Legacy cards, one carrying only a printed price — never valued at it.
    await redeem(await legacyCard('LEGACYPRICED1', 1000), s4, IN_B);
    await redeem(await legacyCard('LEGACYBARE01', null), s6, BEFORE);

    // Wallet: 1000 face, 100 off → 900 collected in October; 450 in September.
    await topUp(s5, 1000, 100, IN_B);
    await topUp(s6, 450, 0, BEFORE);

    // Online channel: 200 sold and 50 refunded in October, 100 in September.
    await ledgerLine(s1, 200, IN_A);
    await ledgerLine(s1, -50, IN_B);
    await ledgerLine(s2, 100, BEFORE);
  }

  it('reports each source once, with the agreed definitions', async () => {
    await seed();

    const stats = await analytics.dashboard(PERIOD);

    // 600 + 1000 + 80.50 + 250 + 300 — each paid card once; not the unused 700,
    // not the recharge card's 900 (counted as a top-up), not a printed price.
    expect(stats.revenue.codeSalesAllTime).toBe(2230.5);
    expect(stats.purchases.paidCodeSalesAllTime).toBe(5);
    // October: 600 and 300 (first used in October). Not 250 (first used in
    // September) and not 80.50 (first used in November).
    expect(stats.revenue.codeSalesInPeriod).toBe(900);
    expect(stats.purchases.paidCodeSalesInPeriod).toBe(2);

    expect(stats.revenue.walletTopUpsAllTime).toBe(1350);
    expect(stats.revenue.walletTopUpCountAllTime).toBe(2);
    expect(stats.revenue.walletTopUpsInPeriod).toBe(900);
    expect(stats.revenue.walletTopUpCountInPeriod).toBe(1);

    expect(stats.revenue.onlinePaymentsAllTime).toBe(250);
    expect(stats.revenue.onlinePaymentsInPeriod).toBe(150);

    expect(stats.revenue.totalAllTime).toBe(2230.5 + 1350 + 250);
    expect(stats.revenue.totalInPeriod).toBe(900 + 900 + 150);
    expect(stats.revenue.profitAllTime).toBe(stats.revenue.totalAllTime);
    expect(stats.revenue.profitInPeriod).toBe(stats.revenue.totalInPeriod);

    expect(stats.activations).toEqual({
      freeAllTime: 3,
      freeInPeriod: 2,
      unrecordedAllTime: 2,
      unrecordedInPeriod: 1,
    });
  });

  it('draws a daily series that adds up to the tiles, on the right days', async () => {
    await seed();

    const [stats, series] = await Promise.all([
      analytics.dashboard(PERIOD),
      analytics.revenueSeries(PERIOD),
    ]);

    const total = (key: 'codeSales' | 'walletTopUps' | 'net' | 'total') =>
      Math.round(series.reduce((s, p) => s + p[key] * 100, 0)) / 100;

    expect(total('codeSales')).toBe(stats.revenue.codeSalesInPeriod);
    expect(total('walletTopUps')).toBe(stats.revenue.walletTopUpsInPeriod);
    expect(total('net')).toBe(stats.revenue.onlinePaymentsInPeriod);
    expect(total('total')).toBe(stats.revenue.totalInPeriod);

    expect(series).toEqual([
      expect.objectContaining({
        day: '2026-10-05',
        codeSales: 900,
        codeSaleCount: 2,
        walletTopUps: 0,
        net: 200,
        total: 1100,
      }),
      expect.objectContaining({
        day: '2026-10-20',
        codeSales: 0,
        walletTopUps: 900,
        walletTopUpCount: 1,
        net: -50,
        total: 850,
      }),
    ]);
  });

  it('treats both ends of the period as inside it, to the millisecond', async () => {
    const [s1, s2, s3, s4] = students as [string, string, string, string];

    await redeem(await card({ amountCollected: 10 }), s1, FROM);
    await redeem(await card({ amountCollected: 20 }), s2, TO);
    await redeem(await card({ amountCollected: 40 }), s3, new Date(FROM.getTime() - 1));
    await redeem(await card({ amountCollected: 80 }), s4, new Date(TO.getTime() + 1));
    await topUp(s1, 100, 0, FROM);
    await topUp(s2, 200, 0, TO);
    await topUp(s3, 400, 0, new Date(FROM.getTime() - 1));

    const stats = await analytics.dashboard(PERIOD);
    const series = await analytics.revenueSeries(PERIOD);

    expect(stats.revenue.codeSalesInPeriod).toBe(30);
    expect(stats.revenue.walletTopUpsInPeriod).toBe(300);
    expect(stats.revenue.totalInPeriod).toBe(330);
    expect(stats.revenue.totalAllTime).toBe(150 + 700);
    expect(series.reduce((s, p) => s + p.total, 0)).toBe(330);
  });

  it('is not moved by issuing cards, by admin wallet adjustments, or by spending credit', async () => {
    await seed();
    const before = await analytics.dashboard(PERIOD);
    const s1 = students[0]!;
    const s5 = students[4]!; // holds the 900 top-up's credit

    // More unsold stock.
    await card({ amountCollected: 999 });
    await card({ free: true });
    // An admin credit and debit: manual adjustments, never revenue.
    await wallet.adjust({
      userId: s1,
      amount: 5000,
      direction: WalletTxDirection.CREDIT,
      reason: 'Goodwill credit for testing',
      actor: admin,
    });
    await wallet.adjust({
      userId: s1,
      amount: 100,
      direction: WalletTxDirection.DEBIT,
      reason: 'Correction for testing',
      actor: admin,
    });
    // Spending top-up credit: the cash was already counted when it was paid.
    await prisma.$transaction(
      (tx) =>
        wallet.debit(tx, {
          userId: s5,
          amount: 300,
          type: WalletTxType.PURCHASE,
          source: WalletTxSource.LIBRARY_PART,
        }),
      MONEY_TX_OPTIONS,
    );

    const after = await analytics.dashboard(PERIOD);

    expect(after.revenue).toEqual(before.revenue);
    expect(after.purchases.paidCodeSalesAllTime).toBe(
      before.purchases.paidCodeSalesAllTime,
    );
    expect(after.activations).toEqual(before.activations);
  });

  it('shows the amount collected on every card listing', async () => {
    await card({ amountCollected: 600 });
    await card({ free: true });
    await legacyCard('LEGACYBARE02', 1000);

    const list = await codes.list({ page: 1, pageSize: 50 });
    const collected = list.items.map((c) => [c.amount, c.amountCollected]).sort();

    // [card price, amount collected]: the printed price is never copied over.
    expect(collected).toEqual(
      [
        [1000, null],
        [null, 0],
        [null, 600],
      ].sort(),
    );

    const batches = await codes.listBatches({ page: 1, pageSize: 50 });
    expect(batches.items.map((b) => b.amountCollected).sort()).toEqual([0, 600]);

    const exported = await codes.batchCodes(
      batches.items.find((b) => b.amountCollected === 600)!.id,
    );
    expect(exported.batch.amountCollected).toBe(600);
    expect(exported.codes.map((c) => c.amountCollected)).toEqual([600]);
  });
});
