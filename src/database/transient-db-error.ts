import { Prisma } from '@prisma/client';

/**
 * Database connectivity failures, and a bounded retry for them.
 *
 * ## Why this exists
 *
 * The video worker runs on a PC and talks to Neon over the public internet
 * through Neon's pooler. Neon suspends idle computes, and a resume, a pooler
 * restart or a home-network blip all surface in Prisma as the same handful of
 * errors - most often `P1001 Can't reach database server`. None of them is a
 * verdict on the video being processed: the query simply did not run.
 *
 * Before this, the worker had no way to tell that apart from a real failure. A
 * blip in the middle of a Gumlet ingest either counted as a "Gumlet timeout",
 * or reached the processor's catch, which then tried to stamp the video FAILED
 * - with a live provider asset behind it, and with the raw Prisma text (which
 * names the database host) as the reason shown in the dashboard.
 *
 * ## What counts as transient
 *
 * Narrow on purpose. Only errors that mean "the database could not be reached,
 * or did not answer in time" are listed. Authentication failures (`P1000`), a
 * missing database (`P1003`), constraint violations and every other Prisma
 * error are definitive: retrying them turns a clear failure into a slow one.
 */
const TRANSIENT_CONNECTIVITY_CODES: ReadonlySet<string> = new Set([
  'P1001', // Can't reach database server
  'P1002', // The database server was reached but timed out
  'P1008', // Operations timed out
  'P1017', // Server has closed the connection
  'P2024', // Timed out fetching a new connection from the connection pool
]);

export function isTransientDatabaseError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return TRANSIENT_CONNECTIVITY_CODES.has(error.code);
  }
  if (error instanceof Prisma.PrismaClientInitializationError) {
    // An initialization error with no code is usually configuration (a bad
    // URL, a missing engine). Only a known connectivity code is a blip.
    return error.errorCode !== undefined && TRANSIENT_CONNECTIVITY_CODES.has(error.errorCode);
  }
  return false;
}

export interface DatabaseRetryOptions {
  /** Total attempts, including the first. Default 5. */
  attempts?: number;
  /** Ceiling of the first backoff window in ms; doubles each attempt. Default 500. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff window. Default 8000. */
  maxDelayMs?: number;
  /** Called before each wait, so the caller can log what it is waiting for. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
  /** Overridable so tests do not wait on real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Overridable so tests can pin the jitter. */
  random?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `operation`, retrying ONLY transient connectivity failures.
 *
 * Exponential backoff with full jitter: each wait is a random point in
 * `[0, min(max, base * 2^(attempt-1))]`. Without jitter, every worker that lost
 * the database at the same moment would reconnect at the same moment too.
 *
 * Bounded: with the defaults the waits add up to at most ~7.5 s on top of the
 * attempts themselves (each of which can spend Prisma's connect timeout). A
 * longer outage is handed back to the caller - for the worker, that means the
 * queue's own backoff and the recovery sweep take over.
 *
 * `operation` must be safe to run again. Reads always are. A write is only
 * safe if it sets fixed values (an idempotent update): `P1017` can arrive after
 * a write committed but before its acknowledgement, so the retry may be the
 * second application of the same change.
 */
export async function withDatabaseRetry<T>(
  operation: () => Promise<T>,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 5);
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientDatabaseError(error) || attempt >= attempts) throw error;
      const window = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      const delayMs = Math.round(random() * window);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}

/**
 * One-line description of a database error that is safe to log or store.
 *
 * Prisma's message for these errors names the host and port and spans several
 * lines. That is fine in a private log, but not in `processingError`, which the
 * dashboard shows. The code is what an operator needs.
 */
export function describeDatabaseError(error: unknown): string {
  if (error instanceof Prisma.PrismaClientKnownRequestError) return `database error ${error.code}`;
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return `database error ${error.errorCode ?? 'initialization'}`;
  }
  return 'database error';
}
