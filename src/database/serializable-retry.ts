import { Prisma, type PrismaClient } from '@prisma/client';

import { MONEY_TX_OPTIONS } from './prisma.service';

/**
 * Bounded retry for Serializable transactions.
 *
 * ## Why this exists
 *
 * `MONEY_TX_OPTIONS` runs these paths at SERIALIZABLE because they read a shared
 * counter and then write it: how many times a code has been redeemed, how many
 * seats a section has left, what a wallet balance is. Under SERIALIZABLE that
 * read-then-write is correct — but the price of correctness is that the database
 * is entitled to abort one of the racers, and it does so with `40001`, which
 * Prisma surfaces as `P2034`.
 *
 * Aborting is the *right* outcome: the alternative is a code oversold. What was
 * wrong is that the abort reached the student as a 500. Two students redeeming
 * the last remaining use of a card at the same instant is ordinary traffic, not
 * an exceptional one, and one of them being told "server error" — for a request
 * that is perfectly valid and would succeed a moment later — is a support
 * ticket, not a safety property.
 *
 * So the loser of a benign race retries. Not forever: the attempt count is
 * bounded, because a genuine deadlock storm or a hot row should surface as an
 * error rather than as a request that hangs.
 *
 * ## The callback must be safe to run again
 *
 * Retrying re-runs the whole transaction from the top, including every read in
 * it. That is the point — the second attempt sees the committed state and takes
 * a different branch. It also means **`body` must not assume it is the only
 * writer**, and must not perform effects outside the database. Audit rows are
 * written inside these transactions deliberately, for exactly this reason; an
 * email or a push enqueued inside the callback would be sent twice.
 */
export interface SerializableRetryOptions {
  /** Total attempts, including the first. Default 3. */
  attempts?: number;
  /** First backoff step in ms; doubles each attempt. Default 25. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff. Default 400. */
  maxDelayMs?: number;
  /** Overridable so tests do not wait on real time. */
  sleep?: (ms: number) => Promise<void>;
}

/** Attempts, and the ceiling on total time spent waiting. */
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 25;
const DEFAULT_MAX_DELAY_MS = 400;

/**
 * Is this the one error that means "you raced, try again"?
 *
 * Narrow on purpose. `P2034` is a write conflict or deadlock under
 * serialization — the transaction did nothing, so re-running it is safe and
 * correct. Every other Prisma error means the attempt got far enough to do
 * something, or failed for a reason a retry cannot fix, and swallowing those
 * into a retry loop would turn a clear failure into a slow one.
 */
export function isWriteConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034'
  );
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `body` in a Serializable transaction, retrying benign write conflicts.
 *
 * The transaction is *not* the unit of retry — the closure is. Everything it
 * reads is re-read on the next attempt, so the retry is not a replay of stale
 * decisions.
 */
export async function withSerializableRetry<T>(
  prisma: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const sleep = options.sleep ?? realSleep;

  let lastConflict: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await prisma.$transaction(body, MONEY_TX_OPTIONS);
    } catch (error) {
      if (!isWriteConflict(error)) throw error;

      lastConflict = error;

      if (attempt === attempts) break;

      // Jitter matters here. Without it, every transaction that lost the same
      // race retries in the same millisecond and collides again, turning one
      // contention event into a synchronized second wave.
      const exponential = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(Math.random() * exponential);
    }
  }

  // Out of attempts on a write conflict. Rethrowing the original error keeps the
  // diagnostic — which row, which transaction — instead of replacing it with a
  // vaguer "gave up" message an operator cannot act on.
  throw lastConflict;
}