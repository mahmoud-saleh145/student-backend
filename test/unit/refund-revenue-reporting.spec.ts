import { UserRole } from '@prisma/client';

import { AnalyticsService } from '../../src/modules/analytics/analytics.service';

/**
 * Revenue reports after refunds.
 *
 * Completed refunds are negative `revenue_ledger` lines; pending refund
 * requests are not ledger lines at all. Every report must therefore show:
 *
 *   gross    = sales (positive lines) — unchanged by a refund
 *   refunded = completed refunds
 *   net      = gross − refunded
 *
 * Fixed here: the Statistics period tile showed gross only (a refund never
 * reduced it), "Paid purchases" dropped refunded payments, and course
 * analytics / teacher earnings reported the net sum under the name `gross`.
 *
 * The fake evaluates the aggregate and groupBy queries the service sends
 * against an in-memory ledger, so the figures are computed, not canned.
 */

const PERIOD = { from: new Date('2026-10-01T00:00:00Z'), to: new Date('2026-10-31T23:59:59Z') };
const IN = new Date('2026-10-10T12:00:00Z');
const BEFORE = new Date('2026-09-10T12:00:00Z');

type Line = {
  courseId: string;
  teacherId: string | null;
  courseTitleSnapshot: string;
  grossAmount: number;
  teacherAmount: number;
  platformAmount: number;
  recognizedAt: Date;
};

const LEDGER: Line[] = [
  // A 300 sale last month, refunded 100 this month, then 50 more this month.
  { courseId: 'crs_a', teacherId: 'tch_1', courseTitleSnapshot: 'Anatomy I', grossAmount: 300, teacherAmount: 180, platformAmount: 120, recognizedAt: BEFORE },
  { courseId: 'crs_a', teacherId: 'tch_1', courseTitleSnapshot: 'Anatomy I', grossAmount: -100, teacherAmount: -60, platformAmount: -40, recognizedAt: IN },
  { courseId: 'crs_a', teacherId: 'tch_1', courseTitleSnapshot: 'Anatomy I', grossAmount: -50, teacherAmount: -30, platformAmount: -20, recognizedAt: IN },
  // A 200 sale this month, not refunded.
  { courseId: 'crs_a', teacherId: 'tch_1', courseTitleSnapshot: 'Anatomy I', grossAmount: 200, teacherAmount: 120, platformAmount: 80, recognizedAt: IN },
  // Another course, untouched.
  { courseId: 'crs_b', teacherId: 'tch_1', courseTitleSnapshot: 'Physiology', grossAmount: 100, teacherAmount: 60, platformAmount: 40, recognizedAt: IN },
];

const PAYMENTS = [
  { status: 'PAID' },
  { status: 'PARTIALLY_REFUNDED' },
  { status: 'REFUNDED' },
  { status: 'PENDING' },
  { status: 'CANCELLED' },
];

function lineMatches(line: Line, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, c]) => {
    const value = (line as unknown as Record<string, unknown>)[key];
    if (c !== null && typeof c === 'object' && !(c instanceof Date)) {
      const op = c as Record<string, number | Date>;
      const v = value instanceof Date ? value.getTime() : (value as number);
      const n = (x: number | Date) => (x instanceof Date ? x.getTime() : x);
      if (op.gt !== undefined && !(v > n(op.gt))) return false;
      if (op.lt !== undefined && !(v < n(op.lt))) return false;
      if (op.gte !== undefined && !(v >= n(op.gte))) return false;
      if (op.lte !== undefined && !(v <= n(op.lte))) return false;
      return true;
    }
    return value === c;
  });
}

function sumOf(rows: Line[], fields: Record<string, boolean> = {}) {
  return Object.fromEntries(
    Object.keys(fields).map((f) => [
      f,
      rows.length ? rows.reduce((s, r) => s + Math.round((r as unknown as Record<string, number>)[f]! * 100), 0) / 100 : null,
    ]),
  );
}

function buildPrisma() {
  const revenueLedger = {
    aggregate: jest.fn(async ({ where, _sum }: { where?: Record<string, unknown>; _sum?: Record<string, boolean> }) => {
      const rows = LEDGER.filter((l) => lineMatches(l, where));
      return { _sum: sumOf(rows, _sum), _count: { _all: rows.length } };
    }),
    groupBy: jest.fn(async ({ by, where, _sum }: { by: string[]; where?: Record<string, unknown>; _sum?: Record<string, boolean> }) => {
      const rows = LEDGER.filter((l) => lineMatches(l, where));
      const groups = new Map<string, Line[]>();
      for (const r of rows) {
        const k = by.map((b) => String((r as unknown as Record<string, unknown>)[b])).join('|');
        groups.set(k, [...(groups.get(k) ?? []), r]);
      }
      return [...groups.values()].map((g) => ({
        ...Object.fromEntries(by.map((b) => [b, (g[0] as unknown as Record<string, unknown>)[b]])),
        _sum: sumOf(g, _sum),
        _count: { _all: g.length },
      }));
    }),
  };

  const payment = {
    count: jest.fn(async ({ where }: { where?: { status?: unknown } } = {}) => {
      const status = where?.status as string | { in: string[] } | undefined;
      return PAYMENTS.filter((p) =>
        status === undefined ? true : typeof status === 'string' ? p.status === status : status.in.includes(p.status),
      ).length;
    }),
  };

  // Every other model answers with an empty result.
  const empty = {
    count: jest.fn(async () => 0),
    groupBy: jest.fn(async () => []),
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => ({ id: 'crs_a', title: 'Anatomy I', lessonCount: 0, studentCount: 0 })),
    aggregate: jest.fn(async () => ({ _sum: {}, _avg: { percent: null }, _count: { _all: 0 } })),
  };

  return new Proxy(
    {
      revenueLedger,
      payment,
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    } as Record<string, unknown>,
    { get: (target, prop: string) => (prop in target ? target[prop] : empty) },
  );
}

function build() {
  const prisma = buildPrisma();
  const access = { assertCanManageCourse: jest.fn(async () => undefined) };
  return new AnalyticsService(prisma as never, access as never);
}

describe('Statistics after refunds', () => {
  it('reports gross, completed refunds and net, all time and in the period', async () => {
    const stats = await build().dashboard(PERIOD);

    expect(stats.revenue).toMatchObject({
      grossAllTime: 600,
      refundedAllTime: 150,
      netAllTime: 450,
      // In the period: 300 of sales (200 + 100) and 150 of refunds.
      grossInPeriod: 300,
      refundedInPeriod: 150,
      netInPeriod: 150,
    });
  });

  it('counts refunded payments among captured purchases, but not pending or cancelled ones', async () => {
    const stats = await build().dashboard(PERIOD);
    expect(stats.purchases.paidPayments).toBe(3);
  });
});

describe('course analytics after refunds', () => {
  it('reports sales as gross, refunds separately, and teacher/platform net', async () => {
    const result = await build().course({
      courseId: 'crs_a',
      actorId: 'usr_admin',
      role: UserRole.ADMIN,
      from: new Date('2026-01-01T00:00:00Z'),
      to: PERIOD.to,
    });

    expect(result.revenue).toEqual({
      gross: 500,
      refunded: 150,
      net: 350,
      teacher: 210,
      platform: 140,
      transactions: 2,
      refunds: 2,
    });
  });
});

describe('teacher earnings after refunds', () => {
  it('pays the teacher net of refunds and labels gross as sales', async () => {
    const result = await build().teacherEarnings({
      teacherId: 'tch_1',
      from: new Date('2026-01-01T00:00:00Z'),
      to: PERIOD.to,
    });

    expect(result.total).toBe(270);
    expect(result.courses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ courseId: 'crs_a', earnings: 210, gross: 500, refunded: 150, net: 350, transactions: 2, refunds: 2 }),
        expect.objectContaining({ courseId: 'crs_b', earnings: 60, gross: 100, refunded: 0, net: 100, transactions: 1, refunds: 0 }),
      ]),
    );
  });
});
