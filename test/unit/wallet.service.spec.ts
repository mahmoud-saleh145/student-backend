import { WalletTxDirection, WalletTxSource, WalletTxType } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { WalletService } from '../../src/modules/wallet/wallet.service';

/**
 * The credit ledger.
 *
 * Four invariants are tested here, and each one maps to a way real money goes
 * missing in a system like this:
 *
 *  1. **Every movement writes a ledger row**, with the balance either side of
 *     it frozen. A balance that changed without an entry explaining it is a
 *     balance nobody can audit.
 *  2. **A wallet cannot be overdrawn.** The debit is one conditional UPDATE —
 *     check and deduction in the same statement — so the "check, then deduct"
 *     race cannot happen.
 *  3. **Concurrent spends cannot both win.** Two purchases racing for the last
 *     50 credits: exactly one succeeds, the other is refused.
 *  4. **A retried request does not credit twice.** The idempotency key returns
 *     the original entry instead of moving credit again.
 *
 * The fake below models `wallets` as a single balance and honours the
 * `AND balance >= amount` clause exactly as PostgreSQL would, so the
 * double-spend test exercises the real decision rather than a stub of it.
 */

/** A stand-in for the row, with the conditional UPDATE semantics preserved. */
function fakeDb(startingBalance: number) {
  const state = {
    balance: startingBalance,
    totalRecharged: 0,
    totalSpent: 0,
    version: 0,
  };

  const created: Record<string, unknown>[] = [];

  const tx = {
    wallet: {
      upsert: jest.fn(async () => ({ id: 'wal_1', balance: state.balance, currency: 'EGP' })),
      findUniqueOrThrow: jest.fn(async () => ({ balance: state.balance, currency: 'EGP' })),
    },
    walletTransaction: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
        const hit = created.find((row) => row.idempotencyKey === where.idempotencyKey);
        return hit ?? null;
      }),
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `wtx_${created.length + 1}`, createdAt: new Date(), ...data };
        created.push(row);
        return row;
      }),
    },
    /**
     * Mimics the two statements the service issues. Which one it is is read
     * off the SQL text, and the debit honours its guard clause — returning no
     * rows when the balance will not cover the amount, exactly as the database
     * does.
     */
    $queryRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join(' ');
      const amount = Number(values.find((v) => typeof v === 'string' && /^\d/.test(v)));

      if (sql.includes('totalRecharged')) {
        state.balance += amount;
        state.totalRecharged += amount;
        state.version += 1;
        return [{ balance: state.balance.toFixed(2) }];
      }

      // Debit. The guard is the whole point.
      if (state.balance < amount) return [];
      state.balance -= amount;
      state.totalSpent += amount;
      state.version += 1;
      return [{ balance: state.balance.toFixed(2) }];
    }),
  };

  return { tx, state, created };
}

function buildService() {
  const prisma = {
    $transaction: jest.fn(),
    wallet: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn(), upsert: jest.fn() },
    walletTransaction: { aggregate: jest.fn() },
    user: { findFirst: jest.fn() },
  };
  const audit = { record: jest.fn(async () => undefined) };

  // Loosely typed on purpose: the assertions are about ledger behaviour, and a
  // fully typed Prisma mock would be mostly ceremony.
  const service = new WalletService(prisma as never, audit as never);
  return { service, prisma, audit };
}

describe('WalletService — ledger writes', () => {
  it('records the balance either side of a credit', async () => {
    const { service } = buildService();
    const { tx, state, created } = fakeDb(100);

    const entry = await service.credit(tx as never, {
      userId: 'usr_1',
      amount: 250,
      type: WalletTxType.CREDIT_RECHARGE,
      source: WalletTxSource.PAYMENT_CODE,
    });

    expect(state.balance).toBe(350);
    expect(entry.balanceBefore).toBe(100);
    expect(entry.balanceAfter).toBe(350);
    expect(entry.amount).toBe(250);
    expect(entry.direction).toBe(WalletTxDirection.CREDIT);

    // Exactly one explanatory row, carrying a positive amount and its own
    // direction — never a negative number.
    expect(created).toHaveLength(1);
    expect(created[0].amount).toBe('250.00');
    expect(created[0].direction).toBe(WalletTxDirection.CREDIT);
  });

  it('records the balance either side of a debit', async () => {
    const { service } = buildService();
    const { tx, state } = fakeDb(500);

    const entry = await service.debit(tx as never, {
      userId: 'usr_1',
      amount: 120.5,
      type: WalletTxType.PURCHASE,
      source: WalletTxSource.COURSE_PART,
      reference: { type: 'COURSE_PART', id: 'prt_1' },
    });

    expect(state.balance).toBe(379.5);
    expect(entry.balanceBefore).toBe(500);
    expect(entry.balanceAfter).toBe(379.5);
    expect(entry.direction).toBe(WalletTxDirection.DEBIT);
  });

  it('carries the purchase reference onto the ledger row', async () => {
    // How a later course-part or library purchase is traced back from the
    // ledger without this module knowing what either of those is.
    const { service } = buildService();
    const { tx, created } = fakeDb(500);

    await service.debit(tx as never, {
      userId: 'usr_1',
      amount: 50,
      type: WalletTxType.PURCHASE,
      source: WalletTxSource.LIBRARY_PACKAGE,
      reference: { type: 'LIBRARY_PACKAGE', id: 'pkg_9' },
    });

    expect(created[0].referenceType).toBe('LIBRARY_PACKAGE');
    expect(created[0].referenceId).toBe('pkg_9');
  });

  it('refuses a zero or negative amount', async () => {
    const { service } = buildService();
    const { tx } = fakeDb(500);

    await expect(
      service.credit(tx as never, {
        userId: 'usr_1',
        amount: 0,
        type: WalletTxType.CREDIT_RECHARGE,
        source: WalletTxSource.PAYMENT_CODE,
      }),
    ).rejects.toThrow(AppException);

    await expect(
      service.debit(tx as never, {
        userId: 'usr_1',
        amount: -10,
        type: WalletTxType.PURCHASE,
        source: WalletTxSource.COURSE_PART,
      }),
    ).rejects.toThrow(AppException);
  });
});

describe('WalletService — overdraw protection', () => {
  it('refuses a debit larger than the balance, and writes nothing', async () => {
    const { service } = buildService();
    const { tx, state, created } = fakeDb(40);

    await expect(
      service.debit(tx as never, {
        userId: 'usr_1',
        amount: 50,
        type: WalletTxType.PURCHASE,
        source: WalletTxSource.COURSE_PART,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_CREDIT });

    // The balance is untouched and no ledger row was written: a refused
    // purchase leaves no trace in the money history.
    expect(state.balance).toBe(40);
    expect(created).toHaveLength(0);
  });

  it('allows spending the balance down to exactly zero', async () => {
    const { service } = buildService();
    const { tx, state } = fakeDb(75);

    const entry = await service.debit(tx as never, {
      userId: 'usr_1',
      amount: 75,
      type: WalletTxType.PURCHASE,
      source: WalletTxSource.COURSE_PART,
    });

    expect(state.balance).toBe(0);
    expect(entry.balanceAfter).toBe(0);
  });

  it('lets only one of two concurrent spends win', async () => {
    // The double-spend case. Both purchases see 50 credits when they start;
    // the conditional UPDATE means the second one finds the balance already
    // gone and is refused rather than driving the wallet negative.
    const { service } = buildService();
    const { tx, state, created } = fakeDb(50);

    const spend = () =>
      service.debit(tx as never, {
        userId: 'usr_1',
        amount: 50,
        type: WalletTxType.PURCHASE,
        source: WalletTxSource.COURSE_PART,
      });

    const results = await Promise.allSettled([spend(), spend()]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: ErrorCode.INSUFFICIENT_CREDIT,
    });

    expect(state.balance).toBe(0);
    expect(state.balance).toBeGreaterThanOrEqual(0);
    expect(created).toHaveLength(1);
  });
});

describe('WalletService — idempotency', () => {
  it('returns the original entry instead of crediting twice', async () => {
    // A retried HTTP request, or a redemption replayed by a flaky client.
    const { service } = buildService();
    const { tx, state, created } = fakeDb(0);

    const request = {
      userId: 'usr_1',
      amount: 800,
      type: WalletTxType.CREDIT_RECHARGE,
      source: WalletTxSource.PAYMENT_CODE,
      idempotencyKey: 'recharge:cde_1:usr_1',
    } as const;

    const first = await service.credit(tx as never, request);
    const second = await service.credit(tx as never, request);

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.id).toBe(first.id);

    // The credit happened exactly once.
    expect(state.balance).toBe(800);
    expect(created).toHaveLength(1);
  });
});
