import { Prisma } from '@prisma/client';

import {
  isWriteConflict,
  withSerializableRetry,
} from '../../src/database/serializable-retry';

/**
 * Bounded retry for Serializable transactions.
 *
 * The behaviour that matters is the one people argue about: a write conflict
 * must be retried, and almost nothing else must be. Retry too little and an
 * ordinary collision becomes a 500 for a student who did nothing wrong. Retry too
 * much and a genuine deadlock turns into a request that hangs, or a duplicated
 * side effect from a transaction that had already committed part of its work.
 */

const writeConflict = () =>
  new Prisma.PrismaClientKnownRequestError('Transaction failed due to a write conflict', {
    code: 'P2034',
    clientVersion: '6.19.3',
  });

/**
 * A prisma double. `attempts` counts how many times a transaction body was
 * entered, which is the only place that number can honestly come from — counting
 * inside the test closure would count the closure's own throws as well.
 */
function build() {
  const state = { attempts: 0, isolations: [] as string[] };

  const prisma = {
    $transaction: jest.fn(async (body: (tx: unknown) => Promise<unknown>, options: unknown) => {
      state.attempts += 1;
      state.isolations.push(String((options as { isolationLevel?: string })?.isolationLevel));
      return body({});
    }),
  };

  return { prisma: prisma as never, state };
}

const noSleep = async () => {};

describe('recognising a benign conflict', () => {
  it('treats P2034 as retryable', () => {
    expect(isWriteConflict(writeConflict())).toBe(true);
  });

  it('does not treat a unique violation as retryable', () => {
    // P2002 means the attempt reached a write that violated a constraint.
    // Retrying re-runs the same decision and fails the same way.
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '6.19.3',
    });
    expect(isWriteConflict(p2002)).toBe(false);
  });

  it('does not retry an ordinary error', () => {
    expect(isWriteConflict(new Error('connection reset'))).toBe(false);
    expect(isWriteConflict(undefined)).toBe(false);
    expect(isWriteConflict(null)).toBe(false);
  });
});

describe('retrying a write conflict', () => {
  it('returns the result of the attempt that succeeds', async () => {
    const { prisma, state } = build();

    const result = await withSerializableRetry(
      prisma,
      async () => {
        if (state.attempts === 1) throw writeConflict();
        return 'committed';
      },
      { sleep: noSleep },
    );

    expect(result).toBe('committed');
    expect(state.attempts).toBe(2);
  });

  it('re-reads on the retry instead of replaying a stale decision', async () => {
    // The second attempt must be able to see a different answer, because the
    // whole point is that it observes what the winner just committed. A retry
    // that could not change its mind would be a replay — and replaying a
    // read-then-write is how a card gets oversold anyway.
    const { prisma } = build();
    const reads: string[] = [];
    let winnerCommitted = false;

    const result = await withSerializableRetry(
      prisma,
      async () => {
        reads.push(winnerCommitted ? 'sold-out' : 'available');
        if (!winnerCommitted) {
          // Another transaction takes the last use and commits while we abort.
          winnerCommitted = true;
          throw writeConflict();
        }
        return 'saw it already gone';
      },
      { sleep: noSleep },
    );

    expect(reads).toEqual(['available', 'sold-out']);
    expect(result).toBe('saw it already gone');
  });

  it('gives up after the bounded number of attempts', async () => {
    const { prisma, state } = build();

    await expect(
      withSerializableRetry(
        prisma,
        async () => {
          throw writeConflict();
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'P2034' });

    // Bounded on purpose: sustained contention should surface, not hang.
    expect(state.attempts).toBe(3);
  });

  it('honours an attempt count of one', async () => {
    const { prisma, state } = build();

    await expect(
      withSerializableRetry(
        prisma,
        async () => {
          throw writeConflict();
        },
        { attempts: 1, sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: 'P2034' });

    expect(state.attempts).toBe(1);
  });

  it('survives a conflict late in the sequence', async () => {
    const { prisma, state } = build();

    const result = await withSerializableRetry(
      prisma,
      async () => {
        if (state.attempts < 3) throw writeConflict();
        return 'third time';
      },
      { sleep: noSleep },
    );

    expect(result).toBe('third time');
    expect(state.attempts).toBe(3);
  });

  it('rethrows the original conflict so the diagnostic survives', async () => {
    // "Gave up" would lose which row and which transaction collided, which is
    // the only part an operator can act on.
    const conflict = writeConflict();
    const { prisma } = build();

    await expect(
      withSerializableRetry(
        prisma,
        async () => {
          throw conflict;
        },
        { sleep: noSleep },
      ),
    ).rejects.toBe(conflict);
  });
});

describe('not retrying anything else', () => {
  it('propagates an ordinary error on the first attempt', async () => {
    const { prisma, state } = build();

    await expect(
      withSerializableRetry(
        prisma,
        async () => {
          throw new Error('connection reset');
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('connection reset');

    expect(state.attempts).toBe(1);
  });

  it('does not retry a business rejection', async () => {
    // An AppException from inside the transaction is a decision, not a race.
    const { prisma, state } = build();

    await expect(
      withSerializableRetry(
        prisma,
        async () => {
          throw new Error('CODE_ALREADY_USED');
        },
        { sleep: noSleep },
      ),
    ).rejects.toThrow('CODE_ALREADY_USED');

    expect(state.attempts).toBe(1);
  });
});

describe('transaction options', () => {
  it('runs at Serializable', async () => {
    const { prisma, state } = build();

    await withSerializableRetry(prisma, async () => 'ok', { sleep: noSleep });

    expect(state.isolations[0]).toBe('Serializable');
  });

  it('waits between attempts', async () => {
    // Without a pause, every loser of the same race retries in the same
    // millisecond and collides again, turning one contention event into a
    // synchronised second wave.
    const waits: number[] = [];
    const { prisma, state } = build();

    await withSerializableRetry(
      prisma,
      async () => {
        if (state.attempts < 3) throw writeConflict();
        return 'ok';
      },
      { sleep: async (ms: number) => { waits.push(ms); } },
    );

    expect(waits).toHaveLength(2);
    for (const wait of waits) {
      expect(wait).toBeGreaterThan(0);
      // Capped, so a long contention run cannot become a long stall.
      expect(wait).toBeLessThanOrEqual(400);
    }
  });
});