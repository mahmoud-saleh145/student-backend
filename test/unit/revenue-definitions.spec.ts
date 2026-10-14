import { AnalyticsService } from '../../src/modules/analytics/analytics.service';

/**
 * What the Statistics screen calls revenue.
 *
 *   revenue        = code sales + wallet top-ups + online payments (net)
 *   code sales     = the amount collected for each paid ACCESS card, once,
 *                    at its FIRST redemption (unused cards are not revenue)
 *   wallet top-ups = recharge_revenue, the cash actually paid
 *   profit         = revenue (no expenses or teacher splits are recorded)
 *   purchases      = paid card sales only — never top-ups
 *   activations    = redemptions of free cards, and of cards whose amount was
 *                    never recorded; neither is revenue, and no printed or
 *                    catalogue price is ever used to value them.
 *
 * The fake below evaluates the `where` clauses the service actually sends
 * against in-memory rows, so every figure here is computed, not canned. The
 * same rules are checked against real PostgreSQL in
 * test/integration/revenue-reporting.e2e-spec.ts.
 */

const FROM = new Date('2026-10-01T00:00:00.000Z');
const TO = new Date('2026-10-31T23:59:59.999Z');
const PERIOD = { from: FROM, to: TO };
const IN = new Date('2026-10-10T12:00:00Z');
const IN_LATER = new Date('2026-10-20T12:00:00Z');
const BEFORE = new Date('2026-09-10T12:00:00Z');
const AFTER = new Date('2026-11-05T12:00:00Z');

type Code = {
  id: string;
  kind: 'ACCESS' | 'RECHARGE';
  actualPaidAmount: string | null;
  priceAmount: string | null;
};
type Redemption = { codeId: string; redeemedAt: Date };
type TopUp = { actualPaidAmount: string; recognizedAt: Date };
type LedgerLine = {
  grossAmount: number;
  platformAmount: number;
  teacherAmount: number;
  recognizedAt: Date;
};

interface World {
  codes: Code[];
  redemptions: Redemption[];
  topUps: TopUp[];
  ledger: LedgerLine[];
}

const time = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));

/** Scalar condition: equality, null, or { gt, lt, gte, lte }. */
function scalarMatches(value: unknown, cond: unknown): boolean {
  if (cond === null) return value === null;
  if (typeof cond === 'object' && !(cond instanceof Date)) {
    if (value === null || value === undefined) return false;
    const op = cond as Record<string, unknown>;
    const v = time(value);
    if (op.gt !== undefined && !(v > time(op.gt))) return false;
    if (op.lt !== undefined && !(v < time(op.lt))) return false;
    if (op.gte !== undefined && !(v >= time(op.gte))) return false;
    if (op.lte !== undefined && !(v <= time(op.lte))) return false;
    return true;
  }
  if (value === null || value === undefined) return false;
  return typeof cond === 'number' ? Number(value) === cond : value === cond;
}

function rowMatches(
  row: Record<string, unknown>,
  where: Record<string, unknown> = {},
): boolean {
  return Object.entries(where).every(([key, cond]) => scalarMatches(row[key], cond));
}

const piastres = (v: string | number) => Math.round(Number(v) * 100);
/** Prisma returns a Decimal; a decimal string behaves the same under Number(). */
const sum = (values: (string | number)[]) =>
  values.length
    ? (values.reduce<number>((s, v) => s + piastres(v), 0) / 100).toFixed(2)
    : null;

function buildPrisma(world: World) {
  const codeById = new Map(world.codes.map((c) => [c.id, c]));

  const accessCode = {
    aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const { redemptions, ...scalars } = where as {
        redemptions?: { some?: Record<string, unknown>; none?: Record<string, unknown> };
      };
      const rows = world.codes.filter((c) => {
        if (!rowMatches(c, scalars)) return false;
        const mine = world.redemptions.filter((r) => r.codeId === c.id);
        if (redemptions?.some && !mine.some((r) => rowMatches(r, redemptions.some)))
          return false;
        if (redemptions?.none && mine.some((r) => rowMatches(r, redemptions.none)))
          return false;
        return true;
      });
      return {
        _sum: { actualPaidAmount: sum(rows.map((r) => r.actualPaidAmount ?? 0)) },
        _count: { _all: rows.length },
      };
    }),
    groupBy: jest.fn(async () => []),
    count: jest.fn(async () => world.codes.length),
  };

  const accessCodeRedemption = {
    count: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const { code, ...scalars } = where as { code?: Record<string, unknown> };
      return world.redemptions.filter((r) => {
        const c = codeById.get(r.codeId)!;
        return rowMatches(r, scalars) && (!code || rowMatches(c, code));
      }).length;
    }),
  };

  const rechargeRevenue = {
    aggregate: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const rows = world.topUps.filter((t) => rowMatches(t, where));
      return {
        _sum: { actualPaidAmount: sum(rows.map((r) => r.actualPaidAmount)) },
        _count: { _all: rows.length },
      };
    }),
  };

  const revenueLedger = {
    aggregate: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const rows = world.ledger.filter((l) => rowMatches(l, where));
      return {
        _sum: {
          grossAmount: sum(rows.map((r) => r.grossAmount)),
          platformAmount: sum(rows.map((r) => r.platformAmount)),
          teacherAmount: sum(rows.map((r) => r.teacherAmount)),
        },
        _count: { _all: rows.length },
      };
    }),
  };

  // Wallet movements — spending, admin adjustments — are never revenue. The
  // dashboard must not even read them; reading them is how they would leak in.
  const forbidden = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => () => {
          throw new Error(`dashboard() must not read ${model}.${op}`);
        },
      },
    );

  const empty = {
    count: jest.fn(async () => 0),
    groupBy: jest.fn(async () => []),
    aggregate: jest.fn(async () => ({ _sum: {}, _count: { _all: 0 } })),
  };

  const models: Record<string, unknown> = {
    accessCode,
    accessCodeRedemption,
    rechargeRevenue,
    revenueLedger,
    walletTransaction: forbidden('walletTransaction'),
    wallet: forbidden('wallet'),
    libraryPurchase: forbidden('libraryPurchase'),
    coursePartPurchase: forbidden('coursePartPurchase'),
    coursePrice: forbidden('coursePrice'),
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };

  return new Proxy(models, { get: (t, prop: string) => (prop in t ? t[prop] : empty) });
}

const build = (world: World) =>
  new AnalyticsService(buildPrisma(world) as never, {} as never);

const code = (
  id: string,
  actualPaidAmount: string | null,
  extra: Partial<Code> = {},
): Code => ({
  id,
  kind: 'ACCESS',
  actualPaidAmount,
  priceAmount: null,
  ...extra,
});

/** The production picture, made deliberately awkward. */
function scenario(): World {
  return {
    codes: [
      code('paid_in', '600.00'), // sold this period
      code('paid_before', '1000.00'), // sold last month
      code('multi_before_and_in', '250.00'), // first used last month, again this month
      code('multi_in_twice', '300.00'), // two students this month: ONE sale
      code('paid_unused', '700.00'), // never redeemed: not revenue
      code('paid_after', '80.00'), // first redeemed after the period
      code('free', '0.00'), // a free card, three students
      code('unrecorded_priced', null, { priceAmount: '1000.00' }), // legacy, card price only
      code('unrecorded_bare', null), // legacy, nothing at all
      // A recharge card carries actualPaidAmount too. It is counted through
      // recharge_revenue, so it must not ALSO count as a code sale.
      code('recharge_in', '900.00', { kind: 'RECHARGE' }),
    ],
    redemptions: [
      { codeId: 'paid_in', redeemedAt: IN },
      { codeId: 'paid_before', redeemedAt: BEFORE },
      { codeId: 'multi_before_and_in', redeemedAt: BEFORE },
      { codeId: 'multi_before_and_in', redeemedAt: IN },
      { codeId: 'multi_in_twice', redeemedAt: IN },
      { codeId: 'multi_in_twice', redeemedAt: IN_LATER },
      { codeId: 'paid_after', redeemedAt: AFTER },
      { codeId: 'free', redeemedAt: BEFORE },
      { codeId: 'free', redeemedAt: IN },
      { codeId: 'free', redeemedAt: IN_LATER },
      { codeId: 'unrecorded_priced', redeemedAt: IN },
      { codeId: 'unrecorded_bare', redeemedAt: BEFORE },
      { codeId: 'recharge_in', redeemedAt: IN },
    ],
    topUps: [
      { actualPaidAmount: '900.00', recognizedAt: IN },
      { actualPaidAmount: '450.00', recognizedAt: BEFORE },
    ],
    ledger: [],
  };
}

describe('Statistics: revenue is money actually collected', () => {
  it('counts each paid card once, at its first redemption, and only ACCESS cards', async () => {
    const { revenue, purchases } = await build(scenario()).dashboard(PERIOD);

    // 600 + 1000 + 250 + 300 + 80. Not 700 (unused), not 900 (recharge card),
    // and 250 / 300 once each although each was redeemed twice.
    expect(revenue.codeSalesAllTime).toBe(2230);
    expect(purchases.paidCodeSalesAllTime).toBe(5);

    // In October: 600, and 300 (first used in October). Not 250 — its first
    // use was September — and not 80, first used in November.
    expect(revenue.codeSalesInPeriod).toBe(900);
    expect(purchases.paidCodeSalesInPeriod).toBe(2);
  });

  it('adds wallet top-ups once, from recharge_revenue', async () => {
    const { revenue } = await build(scenario()).dashboard(PERIOD);

    expect(revenue.walletTopUpsAllTime).toBe(1350);
    expect(revenue.walletTopUpCountAllTime).toBe(2);
    expect(revenue.walletTopUpsInPeriod).toBe(900);
    expect(revenue.walletTopUpCountInPeriod).toBe(1);
  });

  it('totals the sources without counting anything twice, and profit equals it', async () => {
    const { revenue } = await build(scenario()).dashboard(PERIOD);

    expect(revenue.totalAllTime).toBe(2230 + 1350);
    expect(revenue.totalInPeriod).toBe(900 + 900);
    expect(revenue.profitAllTime).toBe(revenue.totalAllTime);
    expect(revenue.profitInPeriod).toBe(revenue.totalInPeriod);
    // No online payments in this picture (the channel is off in production).
    expect(revenue.onlinePaymentsAllTime).toBe(0);
    expect(revenue.onlinePaymentsInPeriod).toBe(0);
  });

  it('keeps purchases to paid card sales: a top-up or a free card moves revenue, never purchases', async () => {
    const world = scenario();
    const before = await build(world).dashboard(PERIOD);

    world.topUps.push({ actualPaidAmount: '500.00', recognizedAt: IN });
    world.codes.push(code('free_2', '0.00'));
    world.redemptions.push({ codeId: 'free_2', redeemedAt: IN });
    const after = await build(world).dashboard(PERIOD);

    expect(after.purchases.paidCodeSalesInPeriod).toBe(
      before.purchases.paidCodeSalesInPeriod,
    );
    expect(after.purchases.paidCodeSalesAllTime).toBe(
      before.purchases.paidCodeSalesAllTime,
    );
    expect(after.revenue.totalInPeriod).toBe(before.revenue.totalInPeriod + 500);
    expect(after.activations.freeInPeriod).toBe(before.activations.freeInPeriod + 1);
  });

  it('reports free activations and unrecorded redemptions separately, never as revenue', async () => {
    const { activations, revenue } = await build(scenario()).dashboard(PERIOD);

    expect(activations).toEqual({
      freeAllTime: 3,
      freeInPeriod: 2,
      unrecordedAllTime: 2,
      unrecordedInPeriod: 1,
    });
    // The legacy card printed at 1000 is NOT valued at 1000.
    expect(revenue.totalAllTime).toBe(3580);
  });

  it('adds online payments net of refunds, once, beside the other two sources', async () => {
    const world = scenario();
    world.ledger = [
      { grossAmount: 200, platformAmount: 60, teacherAmount: 140, recognizedAt: IN },
      { grossAmount: -50, platformAmount: -15, teacherAmount: -35, recognizedAt: IN },
      { grossAmount: 100, platformAmount: 30, teacherAmount: 70, recognizedAt: BEFORE },
    ];

    const { revenue } = await build(world).dashboard(PERIOD);

    expect(revenue.onlinePaymentsAllTime).toBe(250);
    expect(revenue.onlinePaymentsInPeriod).toBe(150);
    // The ledger's own figures are unchanged by the new ones.
    expect(revenue).toMatchObject({
      netAllTime: 250,
      netInPeriod: 150,
      grossInPeriod: 200,
    });
    expect(revenue.totalAllTime).toBe(2230 + 1350 + 250);
    expect(revenue.totalInPeriod).toBe(900 + 900 + 150);
  });

  it('treats both ends of the period as inside it', async () => {
    const world: World = {
      codes: [
        code('at_from', '10.00'),
        code('at_to', '20.00'),
        code('just_before', '40.00'),
        code('just_after', '80.00'),
      ],
      redemptions: [
        { codeId: 'at_from', redeemedAt: FROM },
        { codeId: 'at_to', redeemedAt: TO },
        { codeId: 'just_before', redeemedAt: new Date(FROM.getTime() - 1) },
        { codeId: 'just_after', redeemedAt: new Date(TO.getTime() + 1) },
      ],
      topUps: [
        { actualPaidAmount: '1.00', recognizedAt: FROM },
        { actualPaidAmount: '2.00', recognizedAt: TO },
        { actualPaidAmount: '4.00', recognizedAt: new Date(FROM.getTime() - 1) },
      ],
      ledger: [],
    };

    const { revenue } = await build(world).dashboard(PERIOD);

    expect(revenue.codeSalesInPeriod).toBe(30);
    expect(revenue.walletTopUpsInPeriod).toBe(3);
    expect(revenue.totalInPeriod).toBe(33);
    expect(revenue.totalAllTime).toBe(150 + 7);
  });

  it('adds in whole piastres, with no float error', async () => {
    const world: World = {
      codes: [code('a', '0.10'), code('b', '0.20')],
      redemptions: [
        { codeId: 'a', redeemedAt: IN },
        { codeId: 'b', redeemedAt: IN },
      ],
      topUps: [{ actualPaidAmount: '0.10', recognizedAt: IN }],
      ledger: [],
    };

    const { revenue } = await build(world).dashboard(PERIOD);

    expect(revenue.codeSalesInPeriod).toBe(0.3);
    expect(revenue.totalInPeriod).toBe(0.4);
  });

  it('reads zero, not NaN, when nothing has been sold', async () => {
    const { revenue, purchases, activations } = await build({
      codes: [code('unused', '500.00')],
      redemptions: [],
      topUps: [],
      ledger: [],
    }).dashboard(PERIOD);

    expect(revenue).toMatchObject({
      totalAllTime: 0,
      totalInPeriod: 0,
      profitAllTime: 0,
      codeSalesAllTime: 0,
      walletTopUpsAllTime: 0,
    });
    expect(purchases.paidCodeSalesAllTime).toBe(0);
    expect(activations.freeAllTime).toBe(0);
  });
});
