import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createServer, connect, type Server, type Socket } from 'node:net';

import {
  boundedOperationsExtension,
  databaseOperationTimeout,
  positiveIntSetting,
  raceDeadline,
  withConnectionTimeouts,
} from 'src/database/bounded-operations';
import { PrismaService } from 'src/database/prisma.service';
import { isTransientDatabaseError } from 'src/database/transient-db-error';

/**
 * THE ROOT CAUSE OF THE 2026-11-10/11 VIDEO QUEUE HANGS, AGAINST THE REAL ENGINE
 *
 * The laptop worker's link to Neon drops several times a day. Twice, the Prisma
 * call a Gumlet poll made right after a drop never settled, the job holding it
 * stayed `active` with its lock renewed, and the video queue stopped.
 *
 * These tests drive the real Prisma query engine (no mocks) through TCP servers
 * that misbehave the way a dead connection does:
 *
 *   - a "blackhole" that accepts the connection and never says anything. Runs
 *     everywhere, no database needed;
 *   - a proxy in front of a LOCAL Postgres whose in-use connections go silent
 *     while new ones work - the production failure. Runs only when
 *     DEAD_CONNECTION_TEST_DATABASE_URL points at a local database.
 */

function config(values: Record<string, string | undefined>) {
  return {
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      const v = values[key];
      if (v === undefined) throw new Error(`missing ${key}`);
      return v;
    },
  } as never;
}

/** Outcome of a promise, observable without awaiting it. */
function track<T>(p: Promise<T>) {
  const state: { settled: boolean; error?: unknown; value?: T; ms?: number } = { settled: false };
  const started = Date.now();
  p.then(
    (value) => Object.assign(state, { settled: true, value, ms: Date.now() - started }),
    (error) => Object.assign(state, { settled: true, error, ms: Date.now() - started }),
  );
  return state;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** $disconnect never completes while a query is stuck; never let it hang a test. */
const disconnect = (client: { $disconnect(): Promise<void> }) =>
  Promise.race([client.$disconnect().catch(() => undefined), sleep(2_000)]);

// ---------------------------------------------------------------------------

describe('bounded-operations helpers', () => {
  it('raceDeadline releases a promise that never settles, and clears its timer', async () => {
    jest.useFakeTimers();
    try {
      const raced = raceDeadline(new Promise<never>(() => undefined), 1_000, () =>
        databaseOperationTimeout('Video.findFirst', 1_000),
      ).catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(1_000);
      const error = await raced;
      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1008');
      expect(isTransientDatabaseError(error)).toBe(true);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('the timeout error names the operation but no host or credential', () => {
    const e = databaseOperationTimeout('Video.findFirst', 60_000);
    expect(e.message).toContain('Video.findFirst');
    expect(e.message).toContain('60000 ms');
    expect(e.message).not.toMatch(/postgres|neon|@/i);
  });

  it('withConnectionTimeouts adds missing parameters and keeps everything else', () => {
    const url = 'postgresql://u:p@db.example:5432/app?sslmode=require&channel_binding=require';
    const out = new URL(withConnectionTimeouts(url, { connectTimeoutSeconds: 10, socketTimeoutSeconds: 90 }));
    expect(out.searchParams.get('connect_timeout')).toBe('10');
    expect(out.searchParams.get('socket_timeout')).toBe('90');
    expect(out.searchParams.get('sslmode')).toBe('require');
    expect(out.searchParams.get('channel_binding')).toBe('require');
    expect(out.username).toBe('u');
    expect(out.pathname).toBe('/app');
  });

  it('withConnectionTimeouts never overrides a value already in the URL, and is a no-op when unset', () => {
    const url = 'postgresql://u:p@db.example:5432/app?connect_timeout=3';
    expect(new URL(withConnectionTimeouts(url, { connectTimeoutSeconds: 10 })).searchParams.get('connect_timeout')).toBe('3');
    expect(withConnectionTimeouts(url, {})).toBe(url);
  });

  it('positiveIntSetting treats absent or invalid values as "not configured"', () => {
    expect(positiveIntSetting(undefined)).toBeUndefined();
    expect(positiveIntSetting('')).toBeUndefined();
    expect(positiveIntSetting('abc')).toBeUndefined();
    expect(positiveIntSetting('-5')).toBeUndefined();
    expect(positiveIntSetting('1.5')).toBeUndefined();
    expect(positiveIntSetting('60000')).toBe(60_000);
    expect(positiveIntSetting(10)).toBe(10);
  });
});

// ---------------------------------------------------------------------------

describe('a Prisma operation that never resolves (real engine, blackhole server)', () => {
  let server: Server;
  const sockets = new Set<Socket>();
  let url: string;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    server = createServer((s) => {
      sockets.add(s); // accept, then say nothing - ever
      s.on('error', () => undefined);
      s.on('close', () => sockets.delete(s));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    url = `postgresql://user:pass@127.0.0.1:${port}/app`;
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy(); // lets the engine's stuck attempts fail
    await new Promise<void>((r) => server.close(() => r()));
    jest.restoreAllMocks();
  });

  it('with DATABASE_OPERATION_TIMEOUT_MS, the caller is released with a transient P1008', async () => {
    const prisma = new PrismaService(
      config({
        DATABASE_URL: url,
        DATABASE_OPERATION_TIMEOUT_MS: '1500',
        DATABASE_CONNECT_TIMEOUT_SECONDS: '60', // so only the operation bound can fire
      }),
    );

    const started = Date.now();
    const error = await prisma.video.findFirst({ where: { id: 'x' } }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1008');
    expect(isTransientDatabaseError(error)).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(1_400);
    expect(elapsed).toBeLessThan(5_000);
    void disconnect(prisma);
  }, 20_000);

  it('bounds raw queries and interactive-transaction queries too', async () => {
    const prisma = new PrismaService(
      config({ DATABASE_URL: url, DATABASE_OPERATION_TIMEOUT_MS: '1000', DATABASE_CONNECT_TIMEOUT_SECONDS: '60' }),
    );

    const raw = await prisma.$queryRaw`SELECT 1`.catch((e: unknown) => e);
    expect((raw as Prisma.PrismaClientKnownRequestError).code).toBe('P1008');

    const tx = await prisma
      .$transaction(async (t) => t.video.count(), { maxWait: 60_000, timeout: 60_000 })
      .catch((e: unknown) => e);
    // The transaction cannot even start on a dead connection; whichever bound
    // fires first, the caller is released with a transient error.
    expect(isTransientDatabaseError(tx)).toBe(true);
    void disconnect(prisma);
  }, 30_000);

  it('connect_timeout is honoured by this engine: an unanswered handshake fails instead of hanging', async () => {
    const prisma = new PrismaService(config({ DATABASE_URL: url, DATABASE_CONNECT_TIMEOUT_SECONDS: '2' }));

    const started = Date.now();
    const error = await prisma.video.findFirst({ where: { id: 'x' } }).catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    // A never-connected engine reports this as an initialization error. (Once
    // the process is connected - the worker connects at startup - a reconnect
    // that times out is a transient P1001; see the local-Postgres block below.)
    expect(error).toBeInstanceOf(Prisma.PrismaClientInitializationError);
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(elapsed).toBeLessThan(10_000);
    void disconnect(prisma);
  }, 20_000);

  it('only a process that opts in is bounded: the API (no settings) keeps its exact client', () => {
    const logs = jest.spyOn(Logger.prototype, 'log');
    logs.mockClear();

    const plain = new PrismaService(config({ DATABASE_URL: url }));
    expect(logs).not.toHaveBeenCalledWith(expect.stringContaining('bounded'));

    const bounded = new PrismaService(config({ DATABASE_URL: url, DATABASE_OPERATION_TIMEOUT_MS: '60000' }));
    expect(logs).toHaveBeenCalledWith('Database operations are bounded at 60000 ms in this process');
    // The extended client still exposes the service's own methods.
    expect(typeof bounded.ping).toBe('function');
    expect(typeof bounded.onModuleInit).toBe('function');
    expect(typeof bounded.truncateAllForTests).toBe('function');
    void disconnect(plain);
    void disconnect(bounded);
  });
});

// ---------------------------------------------------------------------------

const LOCAL_DB = process.env.DEAD_CONNECTION_TEST_DATABASE_URL;
const localOnly = (() => {
  if (!LOCAL_DB) return false;
  const host = new URL(LOCAL_DB).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error('DEAD_CONNECTION_TEST_DATABASE_URL must point at a LOCAL database');
  }
  return true;
})();

/**
 * The production failure, modelled exactly: a proxy in front of a local
 * Postgres. At a chosen moment every IN-USE connection goes silent (no bytes,
 * no reset - what a NAT or pooler drop looks like from the client), while new
 * connections work normally.
 */
(localOnly ? describe : describe.skip)('a Neon connection drop during a query (real engine, local Postgres)', () => {
  let server: Server;
  const flows = new Set<{ dead: boolean; client: Socket; upstream: Socket }>();
  const silentClients = new Set<Socket>();
  let proxiedUrl: string;
  /** When set, NEW connections are accepted and never answered. */
  let acceptSilently = false;

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const target = new URL(LOCAL_DB!);
    server = createServer((client) => {
      client.on('error', () => undefined);
      if (acceptSilently) {
        silentClients.add(client);
        return;
      }
      const upstream = connect(Number(target.port || 5432), '127.0.0.1');
      const flow = { dead: false, client, upstream };
      flows.add(flow);
      client.on('data', (d) => !flow.dead && upstream.write(d));
      upstream.on('data', (d) => !flow.dead && client.write(d));
      const close = () => {
        client.destroy();
        upstream.destroy();
        flows.delete(flow);
      };
      for (const s of [client, upstream]) {
        s.on('error', close);
        s.on('close', close);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const proxied = new URL(LOCAL_DB!);
    proxied.hostname = '127.0.0.1';
    proxied.port = String((server.address() as { port: number }).port);
    proxiedUrl = proxied.toString();
  });

  afterAll(async () => {
    for (const f of flows) {
      f.client.destroy();
      f.upstream.destroy();
    }
    for (const s of silentClients) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    jest.restoreAllMocks();
  });

  /** Opens the first connection, tolerating a slow local Postgres (e.g. a busy machine). */
  const warmUp = async (prisma: PrismaService) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await prisma.$queryRawUnsafe('SELECT 1');
        return;
      } catch (error) {
        if (attempt >= 5) throw error;
        await sleep(2_000);
      }
    }
  };

  const killInUseFlows = () => {
    for (const f of flows) f.dead = true;
  };
  const closeInUseFlows = () => {
    for (const f of flows) {
      f.client.destroy();
      f.upstream.destroy();
    }
    flows.clear();
  };

  it('REPRODUCTION: without the bound, the poll query never settles - socket_timeout does not help', async () => {
    const prisma = new PrismaService(
      config({ DATABASE_URL: proxiedUrl, DATABASE_SOCKET_TIMEOUT_SECONDS: '2', DATABASE_CONNECT_TIMEOUT_SECONDS: '15' }),
    );
    await warmUp(prisma);

    // The query a Gumlet poll makes, on a connection that dies as it is sent.
    const stuck = track(prisma.video.findFirst({ where: { id: 'x' }, select: { id: true } }));
    killInUseFlows();
    await sleep(8_000);

    // Four times socket_timeout later: still no result and no error.
    expect(stuck.settled).toBe(false);
    void disconnect(prisma);
  }, 60_000);

  it('with the bound, the stuck poll query is released as P1008 and the next queries work', async () => {
    const prisma = new PrismaService(
      config({
        DATABASE_URL: proxiedUrl,
        DATABASE_OPERATION_TIMEOUT_MS: '3000',
        DATABASE_CONNECT_TIMEOUT_SECONDS: '15',
        DATABASE_SOCKET_TIMEOUT_SECONDS: '30',
      }),
    );
    await warmUp(prisma);

    const stuck = prisma.video.findFirst({ where: { id: 'x' }, select: { id: true } }).catch((e: unknown) => e);
    killInUseFlows();

    const error = await stuck;
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1008');
    expect(isTransientDatabaseError(error)).toBe(true);

    // The pool opens a fresh connection for the next operations. (A retry may
    // itself land on another dead pooled connection; it is bounded the same
    // way, so a few attempts always get through.)
    let recovered: unknown;
    for (let attempt = 0; attempt < 5 && recovered === undefined; attempt += 1) {
      recovered = await prisma.$queryRawUnsafe<Array<{ n: number }>>('SELECT 3 AS n').catch(() => undefined);
    }
    expect(recovered).toEqual([{ n: 3 }]);
    void disconnect(prisma);
  }, 90_000);

  it('socket_timeout is honoured for a live but slow query - as P2010, which is NOT retryable', async () => {
    const prisma = new PrismaService(
      config({ DATABASE_URL: proxiedUrl, DATABASE_SOCKET_TIMEOUT_SECONDS: '1', DATABASE_CONNECT_TIMEOUT_SECONDS: '15' }),
    );

    const started = Date.now();
    const error = await prisma.$queryRawUnsafe('SELECT pg_sleep(4)').catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(3_500);
    expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');
    // Why the worker keeps socket_timeout ABOVE the operation bound: this error
    // would read as a genuine failure, the bound's P1008 as an outage.
    expect(isTransientDatabaseError(error)).toBe(false);
    void disconnect(prisma);
  }, 60_000);

  it('a closed connection, then a silent endpoint: every error is transient and the process recovers', async () => {
    // Measured on this engine: after the server closes the connection, queries
    // fail fast with P1017 until the pool discards it (~15 s); the reconnect to
    // an endpoint that never answers fails at connect_timeout with P1001. All
    // of it is what the poll loop's database backoff already waits out.
    const prisma = new PrismaService(
      config({ DATABASE_URL: proxiedUrl, DATABASE_CONNECT_TIMEOUT_SECONDS: '2', DATABASE_OPERATION_TIMEOUT_MS: '6000' }),
    );
    await warmUp(prisma);
    
    acceptSilently = true;
    closeInUseFlows();

    const codes = new Set<string>();
    let reconnectTimedOutMs: number | undefined;
    let recovered = false;
    for (let attempt = 0; attempt < 40 && !recovered; attempt += 1) {
      const started = Date.now();
      const outcome = await prisma.$queryRawUnsafe('SELECT 1').then(
        () => undefined,
        (e: unknown) => e,
      );
      if (outcome === undefined) {
        recovered = true;
        break;
      }
      expect(isTransientDatabaseError(outcome)).toBe(true);
      const code = (outcome as Prisma.PrismaClientKnownRequestError).code;
      codes.add(code);
      if (code === 'P1001' && acceptSilently) {
        reconnectTimedOutMs = Date.now() - started;
        acceptSilently = false; // the database is back
      }
      await sleep(1_000);
    }

    expect(codes.has('P1001')).toBe(true);
    expect(reconnectTimedOutMs).toBeLessThan(4_000); // connect_timeout=2 s, not forever
    expect(recovered).toBe(true);
    void disconnect(prisma);
  }, 120_000);

  it('boundedOperationsExtension can be applied to any client the same way', () => {
    expect(typeof boundedOperationsExtension(1_000)).toBe('function');
  });
});
