import { ConfigService } from '@nestjs/config';
import {
  CodeTargetType,
  ContentStatus,
  DiscountType,
  EnrollmentState,
  PartPricingModel,
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
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { CoursesService } from '../../src/modules/courses/courses.service';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';
import { WalletService } from '../../src/modules/wallet/wallet.service';

import { createCourse, createUser, resetDatabase } from './helpers';

/**
 * The Statistics screen's revenue, against REAL PostgreSQL.
 *
 * Revenue from an access card is the price it was issued at
 * (`access_codes.priceAmount`), recognised once, at its first redemption. The
 * price never decides whether a card unlocks anything, and no catalogue price
 * is ever read to value a card.
 *
 * Cards are issued with the production `generateBatch`. Redemption runs the
 * production `EnrollmentsService.redeemCode` — every authorization check, real
 * course targeting, the part entitlement — wherever the question is "does
 * this card still unlock?"; the revenue fixtures use the production
 * `redeemInTransaction` and then move each redemption's timestamp, to place
 * it precisely against the period's edges. Recharge cards go through the
 * production `redeemRechargeCode`, wallet adjustments and spending through the
 * production `WalletService`.
 *
 * The catalogue price is deliberately higher than every card here (course
 * 1,000; part 600), so a report that read the catalogue would be wrong.
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

const COURSE_CATALOGUE_PRICE = 1000;
const PART_CATALOGUE_PRICE = 600;

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
    teacherMay: async () => true,
    get: async () => null,
  };
  const codes = new CodesService(prisma, audit, settings as never);
  const wallet = new WalletService(prisma, audit);
  const analytics = new AnalyticsService(prisma, {} as never);
  const access = new CourseAccessService(prisma, settings as never, config);
  const courses = new CoursesService(prisma, access, {} as never);
  const enrollments = new EnrollmentsService(
    prisma,
    courses,
    access,
    {} as never, // payments: not used by code redemption
    codes,
    { createForUser: async () => undefined } as never, // notifications: a side effect only
    audit,
  );

  let admin: { id: string; role: UserRole };
  let teacherId: string;
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
    teacherId = teacher.id;
    courseId = (await createCourse(prisma, { teacherId, price: COURSE_CATALOGUE_PRICE })).id;

    students = [];
    for (let i = 0; i < 6; i += 1) {
      students.push(
        (await createUser(prisma, { fullName: `Student Number ${i + 1}` })).id,
      );
    }
  });

  /** One course card, issued the way the dashboard issues it. Returns its code. */
  async function card(extra: { priceAmount?: number; maxRedemptions?: number }) {
    const result = await codes.generateBatch(
      { targetType: CodeTargetType.COURSE, courseId, count: 1, ...extra },
      admin,
    );
    return result.codes[0]!;
  }

  /** Consumes a card through the production path, then dates the redemption. */
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

    await redeem(await card({ priceAmount: 600 }), s1, IN_A); // sold in October
    await redeem(await card({ priceAmount: 1000 }), s2, BEFORE); // sold in September
    await redeem(await card({ priceAmount: 80 }), s3, AFTER); // first used in November

    // Multi-use priced cards: priced once, as a card.
    const multiOld = await card({ priceAmount: 250, maxRedemptions: 3 });
    await redeem(multiOld, s1, BEFORE);
    await redeem(multiOld, s2, IN_A); // a later use is not a second sale
    const multiNew = await card({ priceAmount: 300, maxRedemptions: 3 });
    await redeem(multiNew, s3, IN_A);
    await redeem(multiNew, s4, IN_B);

    await card({ priceAmount: 700 }); // never redeemed: not revenue

    const free = await card({ priceAmount: 0, maxRedemptions: 5 });
    await redeem(free, s1, BEFORE);
    await redeem(free, s2, IN_A);
    await redeem(free, s5, IN_B);

    // Issued without a price, on a course whose catalogue price is 1,000:
    // reported as not recorded, never valued at 1,000.
    await redeem(await card({}), s4, IN_B);
    await redeem(await card({}), s6, BEFORE);

    // Wallet: 1000 face, 100 off → 900 paid in October; 450 in September.
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

    // 600 + 1000 + 80 + 250 + 300 — each priced card once; not the unused 700,
    // not the recharge card's face value (counted as a top-up), and not the
    // catalogue price for the cards issued without one.
    expect(stats.revenue.codeSalesAllTime).toBe(2230);
    expect(stats.purchases.paidCodeSalesAllTime).toBe(5);
    // October: 600 and 300 (first used in October). Not 250 (first used in
    // September) and not 80 (first used in November).
    expect(stats.revenue.codeSalesInPeriod).toBe(900);
    expect(stats.purchases.paidCodeSalesInPeriod).toBe(2);

    expect(stats.revenue.walletTopUpsAllTime).toBe(1350);
    expect(stats.revenue.walletTopUpCountAllTime).toBe(2);
    expect(stats.revenue.walletTopUpsInPeriod).toBe(900);
    expect(stats.revenue.walletTopUpCountInPeriod).toBe(1);

    // Online payments net of refunds, exactly as before.
    expect(stats.revenue.onlinePaymentsAllTime).toBe(250);
    expect(stats.revenue.onlinePaymentsInPeriod).toBe(150);
    expect(stats.revenue).toMatchObject({
      grossAllTime: 300,
      refundedAllTime: 50,
      netAllTime: 250,
      grossInPeriod: 200,
      refundedInPeriod: 50,
      netInPeriod: 150,
    });

    expect(stats.revenue.totalAllTime).toBe(2230 + 1350 + 250);
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

    await redeem(await card({ priceAmount: 10 }), s1, FROM);
    await redeem(await card({ priceAmount: 20 }), s2, TO);
    await redeem(await card({ priceAmount: 40 }), s3, new Date(FROM.getTime() - 1));
    await redeem(await card({ priceAmount: 80 }), s4, new Date(TO.getTime() + 1));
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
    await card({ priceAmount: 999 });
    await card({ priceAmount: 0 });
    await card({});
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
    expect(after.purchases.paidCodeSalesAllTime).toBe(before.purchases.paidCodeSalesAllTime);
    expect(after.activations).toEqual(before.activations);
  });

  it('lists every card with its issued price: a price, 0 for free, null when none', async () => {
    await card({ priceAmount: 600 });
    await card({ priceAmount: 0 });
    await card({});

    const list = await codes.list({ page: 1, pageSize: 50 });
    expect(list.items.map((c) => c.amount).sort()).toEqual([0, 600, null].sort());

    const batches = await codes.listBatches({ page: 1, pageSize: 50 });
    expect(batches.items.map((b) => b.amount).sort()).toEqual([0, 600, null].sort());

    const priced = batches.items.find((b) => b.amount === 600)!;
    const exported = await codes.batchCodes(priced.id);
    expect(exported.batch.amount).toBe(600);
    expect(exported.codes.map((c) => c.amount)).toEqual([600]);

    // Never written for an access card any more.
    const rows = await prisma.accessCode.findMany({ select: { actualPaidAmount: true } });
    expect(rows.every((r) => r.actualPaidAmount === null)).toBe(true);
  });

  describe('redemption never depends on the card price', () => {
    /** A published, on-sale part priced at 600, owning the course's first section. */
    async function partWithSection() {
      const section = await prisma.courseSection.findFirstOrThrow({
        where: { courseId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      });
      const part = await prisma.coursePart.create({
        data: {
          courseId,
          title: 'Part 1 - Before mid',
          sortOrder: 1,
          status: ContentStatus.PUBLISHED,
          isActive: true,
          pricingModel: PartPricingModel.FIXED,
          priceAmount: PART_CATALOGUE_PRICE,
          currency: 'EGP',
        },
      });
      await prisma.courseSection.update({ where: { id: section.id }, data: { partId: part.id } });
      return { part, section };
    }

    async function issue(input: {
      targetType: CodeTargetType;
      priceAmount?: number;
      coursePartId?: string;
      sectionId?: string;
    }) {
      const result = await codes.generateBatch(
        {
          ...input,
          courseId: input.targetType === CodeTargetType.TEACHER ? undefined : courseId,
          teacherId: input.targetType === CodeTargetType.TEACHER ? teacherId : undefined,
          count: 1,
        },
        admin,
      );
      return result.codes[0]!;
    }

    /** The real student redemption: every check in EnrollmentsService.redeemCode. */
    const redeemAsStudent = (userId: string, code: string) =>
      enrollments.redeemCode({ userId, role: UserRole.STUDENT, courseId, code });

    const enrollmentOf = (userId: string) =>
      prisma.enrollment.findUnique({ where: { userId_courseId: { userId, courseId } } });

    /** These redemptions happen "now"; only the all-time figures are asserted. */
    const allTime = () =>
      analytics.dashboard({ from: new Date(0), to: new Date(Date.now() + 60_000) });

    it('unlocks a course with a card priced below the catalogue price, and reports the card price', async () => {
      const code = await issue({ targetType: CodeTargetType.COURSE, priceAmount: 300 });

      await expect(redeemAsStudent(students[0]!, code)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });
      expect((await enrollmentOf(students[0]!))?.state).toBe(EnrollmentState.ACTIVE);

      const stats = await allTime();
      expect(stats.revenue.codeSalesAllTime).toBe(300); // not 1,000
      expect(stats.purchases.paidCodeSalesAllTime).toBe(1);
    });

    it('unlocks a part with a card priced below the part price, and reports the card price', async () => {
      const { part } = await partWithSection();
      const code = await issue({
        targetType: CodeTargetType.PART,
        coursePartId: part.id,
        priceAmount: 200,
      });

      await expect(redeemAsStudent(students[0]!, code)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });
      const entitlement = await prisma.coursePartEntitlement.findUnique({
        where: { userId_coursePartId: { userId: students[0]!, coursePartId: part.id } },
      });
      expect(entitlement?.revokedAt).toBeNull();

      const stats = await allTime();
      expect(stats.revenue.codeSalesAllTime).toBe(200); // not 600
    });

    it('unlocks a section with a cheap card, and a teacher-wide card likewise', async () => {
      const section = await prisma.courseSection.findFirstOrThrow({
        where: { courseId, deletedAt: null },
        orderBy: { sortOrder: 'asc' },
      });
      const sectionCode = await issue({
        targetType: CodeTargetType.SECTION,
        sectionId: section.id,
        priceAmount: 50,
      });
      const teacherCode = await issue({ targetType: CodeTargetType.TEACHER, priceAmount: 75 });

      await expect(redeemAsStudent(students[0]!, sectionCode)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });
      await expect(redeemAsStudent(students[1]!, teacherCode)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });

      const stats = await allTime();
      expect(stats.revenue.codeSalesAllTime).toBe(125);
      expect(stats.purchases.paidCodeSalesAllTime).toBe(2);
    });

    it('unlocks with a card issued without a price — counted as not recorded, not as a failure', async () => {
      const courseCode = await issue({ targetType: CodeTargetType.COURSE });
      const { part } = await partWithSection();
      const partCode = await issue({ targetType: CodeTargetType.PART, coursePartId: part.id });

      await expect(redeemAsStudent(students[0]!, courseCode)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });
      await expect(redeemAsStudent(students[1]!, partCode)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });

      const stats = await allTime();
      expect(stats.revenue.codeSalesAllTime).toBe(0);
      expect(stats.activations.unrecordedAllTime).toBe(2);
    });

    it('unlocks with a free card, which adds nothing to revenue', async () => {
      const code = await issue({ targetType: CodeTargetType.COURSE, priceAmount: 0 });

      await expect(redeemAsStudent(students[0]!, code)).resolves.toMatchObject({
        state: EnrollmentState.ACTIVE,
      });

      const stats = await allTime();
      expect(stats.revenue.totalAllTime).toBe(0);
      expect(stats.purchases.paidCodeSalesAllTime).toBe(0);
      expect(stats.activations.freeAllTime).toBe(1);
    });

    it('still refuses what it always refused — a used card stays used, whatever its price', async () => {
      const code = await issue({ targetType: CodeTargetType.COURSE, priceAmount: 5000 });
      await redeemAsStudent(students[0]!, code);

      // A single-use card, even one priced above the catalogue, does not
      // unlock for a second student: price grants nothing on its own.
      await expect(redeemAsStudent(students[1]!, code)).rejects.toMatchObject({
        code: 'CODE_ALREADY_USED',
      });

      const stats = await allTime();
      expect(stats.revenue.codeSalesAllTime).toBe(5000); // once
    });
  });
});
