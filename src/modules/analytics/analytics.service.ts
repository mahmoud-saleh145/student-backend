import { Injectable } from '@nestjs/common';
import { CodeKind, Prisma, UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { CourseAccessService } from '../courses/course-access.service';

/**
 * Reporting.
 *
 * Every money figure comes from a recorded amount, never from a course's
 * current price: a course repriced from 100 to 150 must still report its
 * historical sales at 100 (spec §28). Online payments are read from
 * `revenue_ledger`; the Statistics screen's total also adds card sales
 * (the issued card price, `access_codes.priceAmount`) and wallet top-ups
 * (`recharge_revenue`) —
 * see `dashboard()`.
 *
 * Time-series reads hit `daily_course_stats`, the nightly rollup, rather than
 * scanning `watch_events` — which grows by millions of rows a term.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
  ) { }

  /** Platform-wide numbers for the master/admin dashboard. */
  async overview(params: { from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();

    const [
      students,
      activeStudents,
      teachers,
      publishedCourses,
      enrollments,
      revenue,
      refunds,
      watchAggregate,
    ] = await this.prisma.$transaction([
      this.prisma.user.count({ where: { role: UserRole.STUDENT, ...notDeleted } }),
      this.prisma.user.count({
        where: {
          role: UserRole.STUDENT,
          ...notDeleted,
          sessions: { some: { lastSeenAt: { gte: from } } },
        },
      }),
      this.prisma.user.count({ where: { role: UserRole.TEACHER, ...notDeleted } }),
      this.prisma.course.count({ where: { status: 'PUBLISHED', ...notDeleted } }),
      this.prisma.enrollment.count({
        where: { createdAt: { gte: from, lte: to } },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { recognizedAt: { gte: from, lte: to }, grossAmount: { gt: 0 } },
        _sum: { grossAmount: true, platformAmount: true, teacherAmount: true },
        _count: { _all: true },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { recognizedAt: { gte: from, lte: to }, grossAmount: { lt: 0 } },
        _sum: { grossAmount: true },
      }),
      this.prisma.dailyCourseStat.aggregate({
        where: { day: { gte: from, lte: to } },
        _sum: { watchSeconds: true, uniqueViewers: true },
      }),
    ]);

    const gross = Number(revenue._sum.grossAmount ?? 0);
    const refunded = Math.abs(Number(refunds._sum.grossAmount ?? 0));

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      users: { students, activeStudents, teachers },
      catalogue: { publishedCourses },
      enrollments,
      revenue: {
        gross,
        refunded,
        net: Math.round((gross - refunded) * 100) / 100,
        platform: Number(revenue._sum.platformAmount ?? 0),
        teachers: Number(revenue._sum.teacherAmount ?? 0),
        transactions: revenue._count._all,
      },
      engagement: {
        watchSeconds: watchAggregate._sum.watchSeconds ?? 0,
        viewerDays: watchAggregate._sum.uniqueViewers ?? 0,
      },
    };
  }

  /** One course's numbers. Teachers see only their own courses. */
  async course(params: {
    courseId: string;
    actorId: string;
    role: UserRole;
    from?: Date;
    to?: Date;
  }) {
    await this.access.assertCanManageCourse(
      params.actorId,
      params.role,
      params.courseId,
      'students',
    );

    const from = params.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();

    const canSeeRevenue =
      params.role === UserRole.MASTER || params.role === UserRole.ADMIN
        ? true
        : await this.teacherMaySeeRevenue(params.actorId, params.courseId);

    const [course, enrollmentsByState, daily, completion] = await this.prisma.$transaction([
      this.prisma.course.findUnique({
        where: { id: params.courseId },
        select: { id: true, title: true, lessonCount: true, studentCount: true },
      }),
      this.prisma.enrollment.groupBy({
        by: ['state'],
        where: { courseId: params.courseId },
        _count: { _all: true },
        orderBy: { state: 'asc' },
      }),
      this.prisma.dailyCourseStat.findMany({
        where: { courseId: params.courseId, day: { gte: from, lte: to } },
        orderBy: { day: 'asc' },
      }),
      this.prisma.watchProgress.aggregate({
        where: { courseId: params.courseId },
        _avg: { percent: true },
        _count: { _all: true },
      }),
    ]);

    // Two aggregates, positive (sales) and negative (completed refunds) lines:
    // a single sum over both used to be reported as `gross` although it was
    // really net. Teacher/platform stay net (all lines), which is what a
    // teacher is actually owed.
    const [revenue, refunds] = canSeeRevenue
      ? await this.prisma.$transaction([
        this.prisma.revenueLedger.aggregate({
          where: { courseId: params.courseId, recognizedAt: { gte: from, lte: to } },
          _sum: { grossAmount: true, teacherAmount: true, platformAmount: true },
          _count: { _all: true },
        }),
        this.prisma.revenueLedger.aggregate({
          where: {
            courseId: params.courseId,
            recognizedAt: { gte: from, lte: to },
            grossAmount: { lt: 0 },
          },
          _sum: { grossAmount: true },
          _count: { _all: true },
        }),
      ])
      : [null, null];

    return {
      course,
      period: { from: from.toISOString(), to: to.toISOString() },
      enrollments: Object.fromEntries(
        enrollmentsByState.map((row) => [
          row.state,
          typeof row._count === 'object' && row._count !== null
            ? row._count._all ?? 0
            : 0,
        ]),
      ),
      engagement: {
        averageProgressPercent: Math.round(completion._avg.percent ?? 0),
        trackedLessons: completion._count._all,
        daily: daily.map((d) => ({
          day: d.day.toISOString().slice(0, 10),
          uniqueViewers: d.uniqueViewers,
          watchSeconds: d.watchSeconds,
          lessonsStarted: d.lessonsStarted,
          lessonsCompleted: d.lessonsCompleted,
          newEnrollments: d.newEnrollments,
        })),
      },
      revenue: revenue && refunds
        ? (() => {
          const netCents = Math.round(Number(revenue._sum.grossAmount ?? 0) * 100);
          const refundCents = Math.round(Number(refunds._sum.grossAmount ?? 0) * 100);
          return {
            /** Sales only (positive ledger lines). */
            gross: (netCents - refundCents) / 100,
            /** Completed refunds, as a positive amount. */
            refunded: -refundCents / 100 || 0,
            /** Gross minus completed refunds. */
            net: netCents / 100,
            teacher: Number(revenue._sum.teacherAmount ?? 0),
            platform: Number(revenue._sum.platformAmount ?? 0),
            /** Sale lines only; refunds are counted separately. */
            transactions: revenue._count._all - refunds._count._all,
            refunds: refunds._count._all,
          };
        })()
        : null,
    };
  }

  private async teacherMaySeeRevenue(teacherId: string, courseId: string): Promise<boolean> {
    const assignment = await this.prisma.courseTeacher.findUnique({
      where: { courseId_teacherId: { courseId, teacherId } },
      select: { canViewRevenue: true },
    });
    return assignment?.canViewRevenue ?? false;
  }

  /** A teacher's earnings across every course they are paid on. */
  async teacherEarnings(params: { teacherId: string; from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();

    const rows = await this.prisma.revenueLedger.groupBy({
      by: ['courseId', 'courseTitleSnapshot'],
      where: { teacherId: params.teacherId, recognizedAt: { gte: from, lte: to } },
      _sum: { teacherAmount: true, grossAmount: true },
      _count: { _all: true },
    });

    // Completed refunds per course, so `gross` can mean sales only. Earnings
    // stay net: a refunded sale is not money the teacher keeps.
    const refundRows = await this.prisma.revenueLedger.groupBy({
      by: ['courseId', 'courseTitleSnapshot'],
      where: {
        teacherId: params.teacherId,
        recognizedAt: { gte: from, lte: to },
        grossAmount: { lt: 0 },
      },
      _sum: { grossAmount: true },
      _count: { _all: true },
    });
    const refundsFor = (courseId: string, title: string) =>
      refundRows.find((r) => r.courseId === courseId && r.courseTitleSnapshot === title);

    const total = rows.reduce((sum, r) => sum + Number(r._sum.teacherAmount ?? 0), 0);

    return {
      period: { from: from.toISOString(), to: to.toISOString() },
      total: Math.round(total * 100) / 100,
      // The snapshot title is used so an archived or renamed course still
      // reads correctly in an earnings statement.
      courses: rows.map((r) => {
        const refund = refundsFor(r.courseId, r.courseTitleSnapshot);
        const netCents = Math.round(Number(r._sum.grossAmount ?? 0) * 100);
        const refundCents = Math.round(Number(refund?._sum.grossAmount ?? 0) * 100);
        return {
          courseId: r.courseId,
          title: r.courseTitleSnapshot,
          earnings: Number(r._sum.teacherAmount ?? 0),
          /** Sales only. This used to be the net sum under this name. */
          gross: (netCents - refundCents) / 100,
          refunded: -refundCents / 100 || 0,
          net: netCents / 100,
          transactions: r._count._all - (refund?._count._all ?? 0),
          refunds: refund?._count._all ?? 0,
        };
      }),
    };
  }

  /**
   * Revenue by day for charting.
   *
   * `gross`, `net` and `transactions` are the online-payment ledger, exactly
   * as before. `codeSales` and `walletTopUps` are the other two revenue
   * sources, under the same rules as `dashboard()`: a paid card on the day of
   * its first redemption, a top-up on the day its recharge card was redeemed.
   * `total` is all three, so over the same range the points add up to
   * `dashboard().revenue.totalInPeriod`.
   *
   * With `courseId`, cards are filtered to cards for that course; wallet
   * top-ups belong to no course and are left out.
   */
  async revenueSeries(params: { from: Date; to: Date; courseId?: string }) {
    // Composed with Prisma.sql fragments rather than string interpolation:
    // splicing `courseId` into the template directly would be an injection
    // hole, and Prisma cannot parameterise a conditional clause on its own.
    const courseFilter = params.courseId
      ? Prisma.sql`AND "courseId" = ${params.courseId}`
      : Prisma.empty;
    const cardCourseFilter = params.courseId
      ? Prisma.sql`AND c."courseId" = ${params.courseId}`
      : Prisma.empty;

    const [ledger, cardSales, topUps] = await Promise.all([
      this.prisma.$queryRaw<
        { day: Date; gross: string; net: string; transactions: bigint }[]
      >(
        Prisma.sql`
          SELECT
            DATE("recognizedAt")                                                   AS day,
            COALESCE(SUM("grossAmount") FILTER (WHERE "grossAmount" > 0), 0)::text AS gross,
            COALESCE(SUM("grossAmount"), 0)::text                                  AS net,
            COUNT(*)                                                               AS transactions
          FROM revenue_ledger
          WHERE "recognizedAt" >= ${params.from}
            AND "recognizedAt" <= ${params.to}
            ${courseFilter}
          GROUP BY DATE("recognizedAt")
          ORDER BY day ASC
        `,
      ),
      // One row per paid card, dated by its first redemption.
      this.prisma.$queryRaw<{ day: Date; amount: string; sales: bigint }[]>(Prisma.sql`
        SELECT DATE(s."soldAt") AS day, SUM(s.amount)::text AS amount, COUNT(*) AS sales
        FROM (
          SELECT c."priceAmount" AS amount, MIN(r."redeemedAt") AS "soldAt"
          FROM access_codes c
          JOIN access_code_redemptions r ON r."codeId" = c.id
          WHERE c.kind = 'ACCESS'
            AND c."priceAmount" > 0
            ${cardCourseFilter}
          GROUP BY c.id, c."priceAmount"
        ) s
        WHERE s."soldAt" >= ${params.from}
          AND s."soldAt" <= ${params.to}
        GROUP BY DATE(s."soldAt")
      `),
      params.courseId
        ? Promise.resolve([] as { day: Date; amount: string; topUps: bigint }[])
        : this.prisma.$queryRaw<{ day: Date; amount: string; topUps: bigint }[]>(
            Prisma.sql`
              SELECT DATE("recognizedAt") AS day, SUM("actualPaidAmount")::text AS amount,
                     COUNT(*) AS "topUps"
              FROM recharge_revenue
              WHERE "recognizedAt" >= ${params.from}
                AND "recognizedAt" <= ${params.to}
              GROUP BY DATE("recognizedAt")
            `,
          ),
    ]);

    // Merged in whole piastres; a day appears if any source has a row on it.
    const piastres = (value: unknown): number => Math.round(Number(value ?? 0) * 100);
    const empty = {
      gross: 0,
      net: 0,
      transactions: 0,
      codeSales: 0,
      codeSaleCount: 0,
      walletTopUps: 0,
      walletTopUpCount: 0,
    };
    const days = new Map<string, typeof empty>();
    const dayOf = (value: Date) => {
      const key = new Date(value).toISOString().slice(0, 10);
      let row = days.get(key);
      if (!row) {
        row = { ...empty };
        days.set(key, row);
      }
      return row;
    };

    for (const r of ledger) {
      const row = dayOf(r.day);
      row.gross = piastres(r.gross);
      row.net = piastres(r.net);
      row.transactions = Number(r.transactions);
    }
    for (const r of cardSales) {
      const row = dayOf(r.day);
      row.codeSales = piastres(r.amount);
      row.codeSaleCount = Number(r.sales);
    }
    for (const r of topUps) {
      const row = dayOf(r.day);
      row.walletTopUps = piastres(r.amount);
      row.walletTopUpCount = Number(r.topUps);
    }

    return [...days.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([day, r]) => ({
        day,
        gross: r.gross / 100,
        net: r.net / 100,
        transactions: r.transactions,
        codeSales: r.codeSales / 100,
        codeSaleCount: r.codeSaleCount,
        walletTopUps: r.walletTopUps / 100,
        walletTopUpCount: r.walletTopUpCount,
        total: (r.codeSales + r.walletTopUps + r.net) / 100,
      }));
  }

  /**
   * The Statistics screen, in one round trip.
   *
   * `/analytics/overview` stays exactly as it was — it is what the existing
   * clients call. This adds the counts the dashboard's tiles need (courses by
   * status, codes by status, purchases) without changing that response, and
   * without the dashboard having to fire eight list requests with pageSize=1
   * just to read their totals.
   *
   * Revenue is money actually collected, from three sources that never
   * overlap, each counted once:
   *
   *  - **code sales** — the price a paid ACCESS card was issued at
   *    (`access_codes.priceAmount > 0`), recognised once, when the card is
   *    first redeemed. An unused card is not revenue. A multi-use card is not
   *    counted again by its later redemptions: it was priced once, as a card.
   *    The price is what the card was sold for; it never decides whether the
   *    card unlocks anything, and the catalogue price is never read here;
   *  - **wallet top-ups** — `recharge_revenue`, one immutable row per redeemed
   *    recharge card at the cash actually paid. Spending the credit (library
   *    purchases) is not revenue again, and admin wallet adjustments never
   *    write a `recharge_revenue` row, so they are excluded by construction;
   *  - **online payments** — `revenue_ledger`, net of completed refunds. The
   *    channel is disabled today, so this is 0; it is kept in the total so
   *    enabling it later cannot silently drop revenue. No code redemption or
   *    recharge ever writes a ledger line, so nothing is counted twice.
   *
   * Profit equals total revenue: no expenses or teacher splits are recorded.
   * Purchases count paid card sales only — not top-ups. A free card's
   * (price 0) redemption is an activation, and a redemption of a card issued
   * without a price is reported as "not recorded"; neither is ever valued from
   * a course or part catalogue price.
   *
   * The existing ledger fields (`grossAllTime`, `netInPeriod`, …) keep their
   * meaning; the new figures are added beside them.
   */
  async dashboard(params: { from?: Date; to?: Date }) {
    const from = params.from ?? new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const to = params.to ?? new Date();
    const prismaAny = this.prisma as any;

    const window = { gte: from, lte: to };
    // ACCESS only: a recharge card also carries a priceAmount (its face value),
    // and it is counted through recharge_revenue instead.
    const paidCard = { kind: CodeKind.ACCESS, priceAmount: { gt: 0 } };
    const freeCard = { kind: CodeKind.ACCESS, priceAmount: 0 };
    const unrecordedCard = { kind: CodeKind.ACCESS, priceAmount: null };

    const [
      students,
      blockedStudents,
      teachers,
      admins,
      coursesByStatus,
      codesByStatus,
      codeTotal,
      paidPayments,
      revenueAll,
      revenueWindow,
      refundsAll,
      enrollmentsWindow,
      activeEnrollments,
      supportOpen,
      pendingDeviceRequests,
      refundsWindow,
      codeSalesAll,
      codeSalesWindow,
      topUpsAll,
      topUpsWindow,
      freeAll,
      freeWindow,
      unrecordedAll,
      unrecordedWindow,
    ] = await this.prisma.$transaction([
      this.prisma.user.count({ where: { role: UserRole.STUDENT, ...notDeleted } }),
      this.prisma.user.count({
        where: {
          role: UserRole.STUDENT,
          ...notDeleted,
          status: { in: ['SUSPENDED', 'DISABLED'] },
        },
      }),
      this.prisma.user.count({ where: { role: UserRole.TEACHER, ...notDeleted } }),
      this.prisma.user.count({
        where: { role: { in: [UserRole.ADMIN, UserRole.MASTER] }, ...notDeleted },
      }),
      this.prisma.course.groupBy({
        by: ['status'],
        where: notDeleted,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.accessCode.groupBy({
        by: ['status'],
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.accessCode.count(),
      // Captured payments, including ones later (partly) refunded: a refund
      // changes the payment's status, but it was still a captured purchase.
      // Counting PAID alone made every refund silently shrink this number.
      this.prisma.payment.count({
        where: { status: { in: ['PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'] } },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { grossAmount: { gt: 0 } },
        _sum: { grossAmount: true },
        _count: { _all: true },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { recognizedAt: { gte: from, lte: to }, grossAmount: { gt: 0 } },
        _sum: { grossAmount: true, platformAmount: true, teacherAmount: true },
        _count: { _all: true },
      }),
      this.prisma.revenueLedger.aggregate({
        where: { grossAmount: { lt: 0 } },
        _sum: { grossAmount: true },
      }),
      this.prisma.enrollment.count({ where: { createdAt: { gte: from, lte: to } } }),
      this.prisma.enrollment.count({ where: { state: 'ACTIVE' } }),
      prismaAny.supportTicket.count({ where: { status: { in: ['OPEN', 'PENDING'] } } }),
      prismaAny.deviceChangeRequest.count({ where: { status: 'PENDING' } }),
      // Completed refunds recognised in the period (pending refund requests
      // are not ledger lines and so never appear here).
      this.prisma.revenueLedger.aggregate({
        where: { recognizedAt: { gte: from, lte: to }, grossAmount: { lt: 0 } },
        _sum: { grossAmount: true },
      }),
      // Paid cards that have been redeemed: each card's amount once.
      this.prisma.accessCode.aggregate({
        where: { ...paidCard, redemptions: { some: {} } },
        _sum: { priceAmount: true },
        _count: { _all: true },
      }),
      // ...whose FIRST redemption falls in the period: one in the window and
      // none before it. A later redemption of a multi-use card is not a sale.
      this.prisma.accessCode.aggregate({
        where: {
          ...paidCard,
          redemptions: {
            some: { redeemedAt: window },
            none: { redeemedAt: { lt: from } },
          },
        },
        _sum: { priceAmount: true },
        _count: { _all: true },
      }),
      this.prisma.rechargeRevenue.aggregate({
        _sum: { actualPaidAmount: true },
        _count: { _all: true },
      }),
      this.prisma.rechargeRevenue.aggregate({
        where: { recognizedAt: window },
        _sum: { actualPaidAmount: true },
        _count: { _all: true },
      }),
      this.prisma.accessCodeRedemption.count({ where: { code: freeCard } }),
      this.prisma.accessCodeRedemption.count({
        where: { code: freeCard, redeemedAt: window },
      }),
      this.prisma.accessCodeRedemption.count({ where: { code: unrecordedCard } }),
      this.prisma.accessCodeRedemption.count({
        where: { code: unrecordedCard, redeemedAt: window },
      }),
    ]);

    // Prisma types groupBy's `_count` as `true | {...}` depending on the
    // argument shape, so it is narrowed here rather than asserted away.
    const tally = (count: unknown): number =>
      typeof count === 'object' && count !== null && '_all' in count
        ? Number((count as { _all?: number })._all ?? 0)
        : 0;

    const courseCounts = Object.fromEntries(
      coursesByStatus.map((row) => [row.status, tally(row._count)]),
    ) as Record<string, number>;

    const codeCounts = Object.fromEntries(
      codesByStatus.map((row) => [row.status, tally(row._count)]),
    ) as Record<string, number>;

    const grossAll = Number(revenueAll._sum.grossAmount ?? 0);
    const refundedAll = Math.abs(Number(refundsAll._sum.grossAmount ?? 0));

    // Totals are added in whole piastres, so no float error creeps into a sum
    // the dashboard shows beside its parts.
    const piastres = (value: unknown): number => Math.round(Number(value ?? 0) * 100);
    const onlineAll = piastres(grossAll) - piastres(refundedAll);
    const onlineWindow =
      piastres(revenueWindow._sum.grossAmount) + piastres(refundsWindow._sum.grossAmount);
    const codeSalesAllP = piastres(codeSalesAll._sum.priceAmount);
    const codeSalesWindowP = piastres(codeSalesWindow._sum.priceAmount);
    const topUpsAllP = piastres(topUpsAll._sum.actualPaidAmount);
    const topUpsWindowP = piastres(topUpsWindow._sum.actualPaidAmount);
    const totalAll = (codeSalesAllP + topUpsAllP + onlineAll) / 100;
    const totalWindow = (codeSalesWindowP + topUpsWindowP + onlineWindow) / 100;

    return {
      period: { from: from.toISOString(), to: to.toISOString() },

      users: {
        students,
        blockedStudents,
        activeStudents: students - blockedStudents,
        teachers,
        admins,
      },

      courses: {
        total: Object.values(courseCounts).reduce((sum, n) => sum + n, 0),
        // Named for the dashboard's tiles; the enum names are kept alongside
        // so a new CourseStatus does not silently vanish from the response.
        published: courseCounts.PUBLISHED ?? 0,
        draft: courseCounts.DRAFT ?? 0,
        hidden: courseCounts.HIDDEN ?? 0,
        suspended: courseCounts.SUSPENDED ?? 0,
        archived: courseCounts.ARCHIVED ?? 0,
        byStatus: courseCounts,
      },

      codes: {
        total: codeTotal,
        // CodeStatus is ACTIVE / EXHAUSTED / EXPIRED / REVOKED. The dashboard
        // labels EXHAUSTED as "used" and REVOKED as "cancelled"; the mapping
        // is done here so it exists in exactly one place.
        active: codeCounts.ACTIVE ?? 0,
        used: codeCounts.EXHAUSTED ?? 0,
        expired: codeCounts.EXPIRED ?? 0,
        cancelled: codeCounts.REVOKED ?? 0,
        byStatus: codeCounts,
      },

      purchases: {
        paidPayments,
        transactionsAllTime: revenueAll._count._all,
        transactionsInPeriod: revenueWindow._count._all,
        enrollmentsInPeriod: enrollmentsWindow,
        activeEnrollments,
        // Paid card sales: cards issued at a price above 0, counted once at
        // their first redemption. Wallet top-ups and free cards are not purchases.
        paidCodeSalesAllTime: codeSalesAll._count._all,
        paidCodeSalesInPeriod: codeSalesWindow._count._all,
      },

      // Redemptions that are not revenue, shown so they are not mistaken for it.
      activations: {
        // Cards issued free (price 0).
        freeAllTime: freeAll,
        freeInPeriod: freeWindow,
        // Cards issued without a price: redeemed, but what they were sold for
        // is unknown, so they are in no revenue figure.
        unrecordedAllTime: unrecordedAll,
        unrecordedInPeriod: unrecordedWindow,
      },

      revenue: {
        currency: 'EGP',

        // Revenue: money actually collected, each source counted once.
        totalAllTime: totalAll,
        totalInPeriod: totalWindow,
        // No expenses or teacher splits are recorded, so profit is revenue.
        profitAllTime: totalAll,
        profitInPeriod: totalWindow,
        codeSalesAllTime: codeSalesAllP / 100,
        codeSalesInPeriod: codeSalesWindowP / 100,
        walletTopUpsAllTime: topUpsAllP / 100,
        walletTopUpsInPeriod: topUpsWindowP / 100,
        walletTopUpCountAllTime: topUpsAll._count._all,
        walletTopUpCountInPeriod: topUpsWindow._count._all,
        // The online channel's ledger, net of completed refunds (the same
        // figures as netAllTime / netInPeriod below).
        onlinePaymentsAllTime: onlineAll / 100,
        onlinePaymentsInPeriod: onlineWindow / 100,

        // The revenue ledger alone (online payments), unchanged.
        grossAllTime: grossAll,
        refundedAllTime: refundedAll,
        netAllTime: Math.round((grossAll - refundedAll) * 100) / 100,
        grossInPeriod: Number(revenueWindow._sum.grossAmount ?? 0),
        // Completed refunds in the period, and gross minus them. Before these
        // the period tile showed gross only, so a refund reduced "Total
        // revenue" (net) but never the period figure beside it.
        refundedInPeriod: Math.abs(Number(refundsWindow._sum.grossAmount ?? 0)),
        netInPeriod:
          (Math.round(Number(revenueWindow._sum.grossAmount ?? 0) * 100) +
            Math.round(Number(refundsWindow._sum.grossAmount ?? 0) * 100)) /
          100,
        // Gross splits (positive lines only), as before.
        platformInPeriod: Number(revenueWindow._sum.platformAmount ?? 0),
        teachersInPeriod: Number(revenueWindow._sum.teacherAmount ?? 0),
      },

      queues: { supportOpen, pendingDeviceRequests },
    };
  }

  /**
   * Per-student viewing data for one lecture.
   *
   * The completion rule is the course's own — the platform default is 90 %,
   * configurable per course and per lesson — and it is read from the stored
   * `WatchProgress.completed` flag rather than recomputed here, so this screen
   * and the student's own progress can never disagree.
   */
  async lessonViewers(params: {
    lessonId: string;
    actorId: string;
    role: UserRole;
    page: number;
    pageSize: number;
    q?: string;
  }) {
    const lesson = await this.prisma.lesson.findFirst({
      where: { id: params.lessonId, deletedAt: null },
      select: {
        id: true,
        title: true,
        courseId: true,
        durationSeconds: true,
        completionRuleType: true,
        completionThreshold: true,
        video: { select: { id: true, durationSeconds: true } },
        course: {
          select: {
            id: true,
            title: true,
            completionRuleType: true,
            completionThreshold: true,
          },
        },
      },
    });
    if (!lesson) throw AppException.notFound('Lesson', params.lessonId);

    await this.access.assertCanManageCourse(
      params.actorId,
      params.role,
      lesson.courseId,
      'students',
    );

    // The phone clause only applies when the query has digits in it. For a name
    // query the stripped string is '' and `contains: ''` matches every row,
    // which made searching "Ahmed" return all viewers.
    const phoneDigits = params.q?.replace(/\D/g, '') ?? '';

    const where: Prisma.WatchProgressWhereInput = {
      lessonId: lesson.id,
      ...(params.q
        ? {
          user: {
            OR: [
              { fullName: { contains: params.q, mode: 'insensitive' } },
              ...(phoneDigits ? [{ phone: { contains: phoneDigits } }] : []),
            ],
          },
        }
        : {}),
    };

    const [rows, total, aggregate] = await this.prisma.$transaction([
      this.prisma.watchProgress.findMany({
        where,
        orderBy: { lastWatchedAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              studentProfile: {
                select: {
                  university: { select: { name: true, nameAr: true } },
                  faculty: { select: { name: true, nameAr: true } },
                  academicYear: { select: { name: true, nameAr: true, order: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.watchProgress.count({ where }),
      this.prisma.watchProgress.aggregate({
        where: { lessonId: lesson.id },
        _avg: { percent: true },
        _sum: { watchedSeconds: true },
        _count: { _all: true },
      }),
    ]);

    const completedCount = await this.prisma.watchProgress.count({
      where: { lessonId: lesson.id, completed: true },
    });

    return {
      lesson: {
        id: lesson.id,
        title: lesson.title,
        courseId: lesson.courseId,
        courseTitle: lesson.course.title,
        videoId: lesson.video?.id ?? null,
        durationSeconds: lesson.durationSeconds || lesson.video?.durationSeconds || 0,
        completionRule: {
          type: lesson.completionRuleType ?? lesson.course.completionRuleType,
          threshold: lesson.completionThreshold ?? lesson.course.completionThreshold,
        },
      },
      summary: {
        viewers: aggregate._count._all,
        completed: completedCount,
        averagePercent: Math.round(aggregate._avg.percent ?? 0),
        totalWatchSeconds: aggregate._sum.watchedSeconds ?? 0,
      },
      items: rows.map((row) => ({
        student: {
          id: row.user.id,
          fullName: row.user.fullName,
          phone: row.user.phone,
          university: row.user.studentProfile?.university ?? null,
          faculty: row.user.studentProfile?.faculty ?? null,
          academicYear: row.user.studentProfile?.academicYear ?? null,
        },
        firstWatchedAt: row.firstWatchedAt.toISOString(),
        lastWatchedAt: row.lastWatchedAt.toISOString(),
        positionSeconds: row.positionSeconds,
        watchedSeconds: row.watchedSeconds,
        durationSeconds: row.durationSeconds,
        percent: row.percent,
        completed: row.completed,
        completedAt: row.completedAt?.toISOString() ?? null,
      })),
      meta: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        hasNext: params.page * params.pageSize < total,
        hasPrevious: params.page > 1,
      },
    };
  }
}
