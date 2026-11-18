/**
 * The historical-HLS safety watchdog counts network FAILURE EVENTS - (job id, atm) -
 * dated by BullMQ's finishedOn or by when the watchdog first saw them, never by the
 * job's processedOn, which every pause deferral refreshes.
 *
 * Reproduces the production state of 2026-11-17 (Batch 5): eight delayed jobs, four of
 * them carrying a network failure from the day before (atm = 1), thousands of 60-second
 * pause deferrals that refreshed processedOn on all eight, and no new failure. The old
 * counting saw "4 recent failures" on every scan and would have re-paused immediately
 * after a resume.
 *
 * Runs everywhere: an in-memory double stands in for the handful of Redis commands the
 * watchdog uses. The real-BullMQ version of the same scenario is
 * watchdog-failure-ledger-real-queue.spec.ts.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wd = require('../../deploy/laptop-worker/watchdog/watchdog.js');

type Hash = Record<string, string>;
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Hash>();
  zsets = new Map<string, Map<string, number>>();
  lists = new Map<string, string[]>();
  async zrange(k: string): Promise<string[]> {
    return [...(this.zsets.get(k) ?? new Map()).entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zcard(k: string): Promise<number> {
    return this.zsets.get(k)?.size ?? 0;
  }
  async lrange(k: string): Promise<string[]> {
    return [...(this.lists.get(k) ?? [])];
  }
  async llen(k: string): Promise<number> {
    return this.lists.get(k)?.length ?? 0;
  }
  async hgetall(k: string): Promise<Hash> {
    return { ...(this.hashes.get(k) ?? {}) };
  }
  async hmget(k: string, ...f: string[]): Promise<Array<string | null>> {
    const h = this.hashes.get(k) ?? {};
    return f.map((x) => (x in h ? h[x] : null));
  }
  async hset(k: string, obj: Hash): Promise<number> {
    this.hashes.set(k, { ...(this.hashes.get(k) ?? {}), ...obj });
    return Object.keys(obj).length;
  }
  async hdel(k: string, ...f: string[]): Promise<number> {
    const h = this.hashes.get(k) ?? {};
    f.forEach((x) => delete h[x]);
    return f.length;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async get(k: string): Promise<string | null> {
    return this.strings.get(k) ?? null;
  }
  async set(k: string, v: string): Promise<'OK'> {
    this.strings.set(k, v);
    return 'OK';
  }
  async del(k: string): Promise<number> {
    return this.strings.delete(k) ? 1 : 0;
  }
  /** The watchdog's only script is its atomic snapshot (real Lua: the real-queue spec). */
  async eval(script: string, _n: number, mq: string): Promise<string[]> {
    expect(script).toBe(wd.SNAPSHOT_LUA);
    const out: string[] = [];
    const seen = new Set<string>();
    const ids = [
      ...(await this.zrange(mq + 'failed')),
      ...(await this.zrange(mq + 'delayed')),
      ...(await this.zrange(mq + 'prioritized')),
      ...(await this.lrange(mq + 'wait')),
      ...(await this.lrange(mq + 'active')),
      ...(await this.lrange(mq + 'paused')),
    ];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const h = this.hashes.get(mq + id) ?? {};
      if (h.failedReason) out.push(id, h.failedReason, h.atm ?? '', h.finishedOn ?? '');
    }
    return out;
  }
}

const PREFIX = 'edu';
const keys = wd.keysFor(PREFIX);
const MQ: string = keys.MQ;
const HOUR = 3600_000;
const T0 = Date.parse('2026-11-16T17:43:16Z'); // first Batch 5 failure

/** The eight Batch 5 jobs and the four failures, exactly as Redis holds them. */
const FAILED = [
  ['cmva5bgod008fdt01o60mvgiu', 'socket hang up'],
  ['cmva607km00abdt01wn8g7b7y', 'aborted'],
  ['cmvbbzo2k001fgc013fklemn7', 'aborted'],
  ['cmvbc937d001tgc01wsep5u4t', 'aborted'],
] as const;
const FRESH = [
  'cmva6lw6a00bndt01uxk5635l',
  'cmvb9e83301o6ea01vtg8pl12',
  'cmvbcjqll002jgc01ougqfsba',
  'cmvcrhg5y01j5e401f59jy3is',
];
const jobId = (v: string, i: number) => `mobile-hls:${v}:${1794847867000 + i}`;

function batch5(redis: FakeRedis, at: number): string[] {
  const ids: string[] = [];
  const delayed = new Map<string, number>();
  [...FAILED.map(([v]) => v), ...FRESH].forEach((v, i) => {
    const id = jobId(v, i);
    ids.push(id);
    const failure = FAILED.find(([f]) => f === v);
    redis.hashes.set(MQ + id, {
      name: 'mobile-hls',
      priority: '10',
      processedOn: String(at),
      ats: '1',
      ...(failure ? { atm: '1', failedReason: failure[1] } : {}),
    });
    delayed.set(id, at + 60_000);
  });
  redis.zsets.set(MQ + 'delayed', delayed);
  return ids;
}
/** One paused-worker pass over every delayed job: what MobileVideoProcessor.defer() does. */
function deferAll(redis: FakeRedis, ids: string[], at: number): void {
  for (const id of ids) {
    const h = redis.hashes.get(MQ + id)!;
    h.processedOn = String(at);
    h.ats = String(Number(h.ats) + 1); // moveToDelayed never touches atm or failedReason
  }
}
/** BullMQ retry failed again (atm+1), or a first attempt failed. */
function fail(
  redis: FakeRedis,
  id: string,
  reason: string,
  at: number,
  terminal = false,
): void {
  const h = redis.hashes.get(MQ + id) ?? {};
  h.atm = String(Number(h.atm ?? 0) + 1);
  h.failedReason = reason;
  h.processedOn = String(at);
  if (terminal) {
    h.finishedOn = String(at);
    redis.zsets.get(MQ + 'delayed')?.delete(id);
    const failed = redis.zsets.get(MQ + 'failed') ?? new Map();
    failed.set(id, at);
    redis.zsets.set(MQ + 'failed', failed);
  }
  redis.hashes.set(MQ + id, h);
}
/** A job left the queue (completed / removed). */
function complete(redis: FakeRedis, id: string): void {
  redis.zsets.get(MQ + 'delayed')?.delete(id);
  redis.lists.set(
    MQ + 'wait',
    (redis.lists.get(MQ + 'wait') ?? []).filter((x) => x !== id),
  );
}

/** The pre-fix rule, kept here to prove the scenario reproduces the incident. */
async function legacyRecentFailures(
  redis: FakeRedis,
  now: number,
  windowMin = 120,
): Promise<number> {
  let n = 0;
  for (const id of await redis.zrange(MQ + 'delayed')) {
    const [reason, finishedOn, processedOn] = await redis.hmget(
      MQ + id,
      'failedReason',
      'finishedOn',
      'processedOn',
    );
    const when = Number(finishedOn || processedOn || 0);
    if (reason && wd.NETWORK_FAILURE.test(reason) && when >= now - windowMin * 60_000)
      n += 1;
  }
  return n;
}

function harness(
  redis: FakeRedis,
  clock: { t: number },
  probeState: { redis?: string; db?: string; r2?: string } = {},
) {
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const probe = (name: 'redis' | 'db' | 'r2') => async () => {
    if (probeState[name]) throw new Error(probeState[name]);
  };
  const cfg = { ...wd.loadConfig({}), prefix: PREFIX };
  const w = wd.createWatchdog({
    redis,
    cfg,
    keys,
    now: () => clock.t,
    log: (event: string, data = {}) => events.push({ event, data }),
    probes: { redis: probe('redis'), db: probe('db'), r2: probe('r2') },
  });
  const count = (e: string) => events.filter((x) => x.event === e).length;
  return { w, events, count, cfg };
}
const pauseFlag = (redis: FakeRedis) => redis.strings.get(keys.PAUSE_KEY);
const operatorPause = (redis: FakeRedis) =>
  redis.strings.set(
    keys.PAUSE_KEY,
    JSON.stringify({
      reason: 'batch 5 paused',
      by: 'operator',
      at: new Date().toISOString(),
      scope: 'historical',
    }),
  );
const resume = (redis: FakeRedis) => redis.strings.delete(keys.PAUSE_KEY);

describe('watchdog failure ledger: the Batch 5 pattern (fixed watchdog deployed after the failures)', () => {
  it('reproduces the incident: the old rule sees 4 "recent" failures a day later, purely from deferrals', async () => {
    const redis = new FakeRedis();
    const ids = batch5(redis, T0);
    const now = T0 + 22 * HOUR;
    deferAll(redis, ids, now - 30_000); // the last 60-s deferral pass
    expect(await legacyRecentFailures(redis, now)).toBe(4);
  });

  it('4 historical failures + 8 delayed jobs + 3,000 deferrals + 0 new failures: no trip, no pause, and none after resume', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 + 2 * 60_000 };
    const ids = batch5(redis, T0);
    operatorPause(redis);
    // Paused for ~22 h: thousands of deferrals pass before the fixed watchdog starts.
    for (let i = 0; i < 1300; i++) {
      clock.t += 60_000;
      deferAll(redis, ids, clock.t);
    }

    const { w, count, events } = harness(redis, clock);
    await w.tick();
    expect(count('netfail_baseline')).toBe(1);
    expect(
      (
        events.find((e) => e.event === 'netfail_baseline')!.data.events as string[]
      ).sort(),
    ).toEqual(FAILED.map(([v], i) => `${jobId(v, i)}#1`).sort());
    expect(w.state.netfail).toMatchObject({
      newFailures: 0,
      recentFailures: 0,
      historicalFailures: 4,
      awaitingRetry: 4,
    });

    // ...and 1,700 more deferrals with the watchdog ticking every 30 s alongside.
    let deferrals = 1300 * 8;
    for (let i = 0; i < 1700; i++) {
      clock.t += 30_000;
      deferAll(redis, ids, clock.t);
      deferrals += 8;
      await w.tick();
      expect(await legacyRecentFailures(redis, clock.t)).toBe(4); // the old rule would trip on every tick
    }
    expect(deferrals).toBeGreaterThan(3000);
    expect(count('threshold_network_failures')).toBe(0);
    expect(count('netfail_seen')).toBe(0);
    expect(Object.keys(await redis.hgetall(keys.LEDGER_KEY))).toHaveLength(5); // 4 events + init marker

    // RESUME. The four retries and the four fresh jobs run; deferrals stop.
    resume(redis);
    for (let i = 0; i < 20; i++) {
      clock.t += 30_000;
      await w.tick();
    }
    for (const id of ids) {
      complete(redis, id);
      clock.t += 30 * 60_000;
      await w.tick();
    }
    expect(count('threshold_network_failures')).toBe(0);
    expect(count('PAUSED')).toBe(0);
    expect(pauseFlag(redis)).toBeUndefined();
    // The baseline events of the finished jobs are forgotten.
    expect(Object.keys(await redis.hgetall(keys.LEDGER_KEY))).toEqual(['__init__']);
  });

  it('after resume, a retry that fails AGAIN is a new event; three new ones trip the threshold and pause the backlog only', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 + 22 * HOUR };
    const ids = batch5(redis, T0);
    deferAll(redis, ids, clock.t);
    operatorPause(redis);
    const { w, count, events } = harness(redis, clock);
    await w.tick(); // baseline
    resume(redis);

    clock.t += 5 * 60_000;
    fail(redis, ids[1], 'aborted', clock.t, true); // retry of cmva607km fails for good
    await w.tick();
    clock.t += 5 * 60_000;
    fail(redis, ids[4], 'socket hang up', clock.t); // a fresh job, attempt 1
    await w.tick();
    expect(count('threshold_network_failures')).toBe(0); // 2 < 3
    clock.t += 5 * 60_000;
    fail(redis, ids[5], 'aborted', clock.t);
    await w.tick();

    expect(count('netfail_seen')).toBe(3);
    expect(count('threshold_network_failures')).toBe(1);
    expect(count('PAUSED')).toBe(1);
    const tripped = events.find((e) => e.event === 'threshold_network_failures')!.data
      .jobs as Array<{ event: string; src: string }>;
    expect(tripped.map((j) => j.event).sort()).toEqual(
      [`${ids[1]}#2`, `${ids[4]}#1`, `${ids[5]}#1`].sort(),
    );
    expect(tripped.find((j) => j.event === `${ids[1]}#2`)!.src).toBe('finishedOn'); // a terminal failure keeps its genuine time
    expect(JSON.parse(pauseFlag(redis)!)).toMatchObject({
      by: 'safety-watchdog',
      scope: 'historical',
    });
  });
});

describe('watchdog failure ledger: a watchdog that was running when the failures happened', () => {
  it('trips once on the real failures, never again during thousands of deferrals, and not after the operator resumes', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 - 10 * 60_000 };
    const ids = batch5(redis, T0 - 10 * 60_000);
    for (const id of ids) {
      const h = redis.hashes.get(MQ + id)!;
      delete h.atm;
      delete h.failedReason;
    }
    const { w, count } = harness(redis, clock);
    await w.tick(); // ledger exists, nothing failed yet

    FAILED.forEach(([, reason], i) => {
      clock.t += 3 * 60_000;
      fail(redis, ids[i], reason, clock.t);
    });
    await w.tick();
    expect(count('threshold_network_failures')).toBe(1);
    expect(count('PAUSED')).toBe(1); // nobody had paused yet: the watchdog does

    for (let i = 0; i < 3000; i++) {
      clock.t += 20_000;
      deferAll(redis, ids, clock.t);
      if (i % 10 === 0) await w.tick();
    }
    expect(count('threshold_network_failures')).toBe(1);

    resume(redis); // the operator has reviewed the four failures and resumes
    for (let i = 0; i < 10; i++) {
      clock.t += 30_000;
      await w.tick();
    }
    expect(count('PAUSED')).toBe(1);
    expect(pauseFlag(redis)).toBeUndefined();
  });

  it('a watchdog restart neither re-dates old failures nor re-trips on failures that already tripped', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 };
    const ids = batch5(redis, T0);
    for (const id of ids) {
      const h = redis.hashes.get(MQ + id)!;
      delete h.atm;
      delete h.failedReason;
    }
    await harness(redis, clock).w.tick();
    FAILED.forEach(([, reason], i) => fail(redis, ids[i], reason, clock.t));
    const first = harness(redis, clock);
    await first.w.tick();
    expect(first.count('threshold_network_failures')).toBe(1);
    resume(redis);

    const restarted = harness(redis, clock); // new process, same Redis ledger
    for (let i = 0; i < 5; i++) {
      clock.t += 30_000;
      deferAll(redis, ids, clock.t);
      await restarted.w.tick();
    }
    expect(restarted.count('netfail_baseline')).toBe(0);
    expect(restarted.count('netfail_seen')).toBe(0);
    expect(restarted.count('threshold_network_failures')).toBe(0);
    expect(pauseFlag(redis)).toBeUndefined();
  });
});

describe('watchdog: the other protections are unchanged', () => {
  it('an outage of WATCHDOG_OUTAGE_PAUSE_SEC pauses the backlog; a short one does not', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 };
    const ids = batch5(redis, T0);
    const probes: { db?: string } = {};
    const { w, count } = harness(redis, clock, probes);
    await w.tick();
    probes.db = "Can't reach database server";
    for (let s = 0; s < 300; s += 10) {
      clock.t += 10_000;
      await w.tick();
    }
    probes.db = undefined;
    await w.tick();
    expect(count('PAUSED')).toBe(0); // 5 min outage
    probes.db = "Can't reach database server";
    for (let s = 0; s <= 600; s += 10) {
      clock.t += 10_000;
      await w.tick();
    }
    expect(count('threshold_outage')).toBe(1);
    expect(count('PAUSED')).toBe(1);
    expect(JSON.parse(pauseFlag(redis)!).scope).toBe('historical');
    expect(ids).toHaveLength(8);
  });

  it('while Redis itself is down nothing is scanned or written; failures from that time are counted once it is back', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 };
    const ids = batch5(redis, T0);
    for (const id of ids) {
      const h = redis.hashes.get(MQ + id)!;
      delete h.atm;
      delete h.failedReason;
    }
    const probes: { redis?: string } = {};
    const { w, count } = harness(redis, clock, probes);
    await w.tick();
    probes.redis = 'redis timed out';
    for (let i = 0; i < 3; i++) {
      clock.t += 10_000;
      fail(redis, ids[4 + i], 'ECONNRESET', clock.t);
      await w.tick();
    }
    expect(count('netfail_seen')).toBe(0);
    probes.redis = undefined;
    clock.t += 10_000;
    await w.tick();
    expect(count('netfail_seen')).toBe(1);
    expect(count('threshold_network_failures')).toBe(1);
  });

  it('non-network failures are not counted; failures older than the window are historical', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 };
    const ids = batch5(redis, T0);
    for (const id of ids) {
      const h = redis.hashes.get(MQ + id)!;
      delete h.atm;
      delete h.failedReason;
    }
    const { w, count } = harness(redis, clock);
    await w.tick();
    for (let i = 0; i < 3; i++)
      fail(redis, ids[i], 'ffmpeg exited with code 1: Invalid data found', clock.t);
    await w.tick();
    expect(count('netfail_seen')).toBe(0);
    fail(redis, ids[4], 'aborted', clock.t);
    fail(redis, ids[5], 'aborted', clock.t);
    await w.tick();
    clock.t += 3 * HOUR; // the two drop out of the 120-min window
    fail(redis, ids[6], 'aborted', clock.t);
    await w.tick();
    expect(count('threshold_network_failures')).toBe(0);
    expect(w.state.netfail).toMatchObject({
      newFailures: 1,
      recentFailures: 1,
      historicalFailures: 2,
    });
  });

  it('never pauses when no historical work is queued, and never overwrites an existing pause', async () => {
    const redis = new FakeRedis();
    const clock = { t: T0 };
    const { w, count } = harness(redis, clock);
    await w.tick();
    for (let i = 0; i < 3; i++) {
      redis.hashes.set(MQ + `mobile-hls:v${i}:1`, {
        atm: '2',
        failedReason: 'aborted',
        finishedOn: String(clock.t),
      });
      redis.zsets.set(
        MQ + 'failed',
        new Map([
          ...(redis.zsets.get(MQ + 'failed') ?? new Map()),
          [`mobile-hls:v${i}:1`, clock.t],
        ]),
      );
    }
    await w.tick();
    expect(count('pause_skipped_no_historical_work')).toBe(1);
    expect(pauseFlag(redis)).toBeUndefined();

    batch5(redis, clock.t);
    operatorPause(redis);
    const before = pauseFlag(redis);
    for (let i = 0; i < 3; i++) {
      redis.hashes.set(MQ + `mobile-hls:w${i}:1`, { atm: '1', failedReason: 'aborted' });
      redis.zsets.get(MQ + 'delayed')!.set(`mobile-hls:w${i}:1`, clock.t);
    }
    clock.t += 30_000;
    await w.tick();
    expect(count('already_paused')).toBe(1);
    expect(pauseFlag(redis)).toBe(before);
  });
});
