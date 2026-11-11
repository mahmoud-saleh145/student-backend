import { Prisma } from '@prisma/client';

/**
 * Bounded database operations for processes that must never wait forever on
 * the database (the laptop worker).
 *
 * WHY THIS EXISTS (production, 2026-11-10 and 2026-11-11)
 *
 * The worker's link to Neon drops several times a day. Twice, the Prisma call
 * a Gumlet poll made right after such a drop never settled - no result, no
 * error - while every other query in the process kept working. The video job
 * holding it stayed `active` for hours with its lock renewed, and the video
 * queue (concurrency 1) stopped.
 *
 * Reproduced against a local Postgres behind a proxy that silently stops
 * forwarding one connection while new connections work (Prisma 6.19.3, Rust
 * engine, no driver adapter; test/unit/prisma-dead-connection.spec.ts):
 *   - a query on the silently dead connection never settles;
 *   - `socket_timeout` in the URL does NOT reliably bound it. A model query on
 *     a connection that died as it was sent stayed pending at 5x the socket
 *     timeout. It fired only where the query had reached the server, and then
 *     as P2010 - not a connectivity code, so it would read as a real failure;
 *   - `connect_timeout` is honoured: a reconnect to an endpoint that accepts
 *     but never answers fails as a transient P1001;
 *   - `$disconnect()` itself never completes while such a query is stuck, so an
 *     engine reset is not a recovery path;
 *   - racing each operation against a deadline does release the caller, and
 *     the pool serves the next operations on a fresh connection.
 *
 * So the URL timeouts are a second layer, not the guarantee. Keep
 * socket_timeout ABOVE the operation timeout, so that the retryable P1008
 * always wins the race.
 *
 * So every operation is raced against a deadline and, when it loses, rejects
 * with a Prisma `P1008` ("Operations timed out"), which `isTransientDatabaseError`
 * already treats as a connectivity blip: every existing retry, backoff and
 * "leave the row unchanged" path handles it exactly like a dropped connection.
 *
 * What it does not do: cancel the engine's query. The abandoned query either
 * never ran or ran with its answer lost - the same ambiguity as `P1017`, which
 * the callers already respect (only idempotent writes are retried in place).
 * The dead socket is reclaimed by the operating system's TCP keepalive.
 */

/** A Prisma P1008 for an operation that did not settle within its deadline. */
export function databaseOperationTimeout(operation: string, timeoutMs: number): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `Database operation ${operation} did not settle within ${timeoutMs} ms (connection presumed dead)`,
    { code: 'P1008', clientVersion: Prisma.prismaVersion.client },
  );
}

/** `work`, or `onTimeout()`'s error once `timeoutMs` has passed. The timer never outlives the race. */
export function raceDeadline<T>(work: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * The Prisma client extension that bounds every operation: model queries,
 * raw queries and the queries inside interactive transactions alike.
 */
export function boundedOperationsExtension(timeoutMs: number) {
  return Prisma.defineExtension({
    name: 'bounded-operations',
    query: {
      async $allOperations({ model, operation, args, query }) {
        const label = model ? `${model}.${operation}` : operation;
        return raceDeadline(query(args), timeoutMs, () => databaseOperationTimeout(label, timeoutMs));
      },
    },
  });
}

/**
 * Adds `connect_timeout` / `socket_timeout` to a PostgreSQL URL unless the URL
 * already sets them. Measured on this engine: `connect_timeout` bounds a
 * connection attempt to an endpoint that accepts TCP but never answers;
 * `socket_timeout` makes the engine cancel a live but slow query. Neither
 * bounds a silently dead connection - that is `boundedOperationsExtension`'s job.
 */
export function withConnectionTimeouts(
  url: string,
  timeouts: { connectTimeoutSeconds?: number; socketTimeoutSeconds?: number },
): string {
  if (!timeouts.connectTimeoutSeconds && !timeouts.socketTimeoutSeconds) return url;
  const parsed = new URL(url);
  if (timeouts.connectTimeoutSeconds && !parsed.searchParams.has('connect_timeout')) {
    parsed.searchParams.set('connect_timeout', String(timeouts.connectTimeoutSeconds));
  }
  if (timeouts.socketTimeoutSeconds && !parsed.searchParams.has('socket_timeout')) {
    parsed.searchParams.set('socket_timeout', String(timeouts.socketTimeoutSeconds));
  }
  return parsed.toString();
}

/** Reads a positive integer setting; absent, empty or invalid means "not configured". */
export function positiveIntSetting(raw: string | number | undefined | null): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
