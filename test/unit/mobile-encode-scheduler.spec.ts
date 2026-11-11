import {
  ENCODE_SLOT_RENEW_MS,
  ENCODE_SLOT_TTL_MS,
  isHistoricalMobileJob,
  MobileEncodeScheduler,
  UPLOAD_WAIT_STALE_MS,
} from '../../src/jobs/processors/mobile-encode-scheduler';
import { MOBILE_JOB_PRIORITY, VIDEO_JOBS } from '../../src/jobs/queue.constants';

/**
 * The cross-queue half of "new uploads before historical mobile HLS work":
 * what counts as upload pressure in the ORIGINAL queue, what never does (so
 * historical work cannot starve), and the single encode slot shared by every
 * worker process.
 */

const NOW = Date.parse('2026-11-11T16:00:00Z');

function originalQueue(jobs: Array<{ name: string; ageMs: number }>, paused = false) {
  return {
    isPaused: jest.fn(async () => paused),
    getJobs: jest.fn(async (types: string[]) => {
      // Only wait + prioritized are ever asked for: delayed/active never count.
      expect(types).toEqual(['wait', 'prioritized']);
      return jobs.map((j) => ({ name: j.name, timestamp: NOW - j.ageMs }));
    }),
  };
}

/** An in-memory Redis with SET NX PX, GET and the two compare-and-act scripts. */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  let clock = NOW;
  const live = (k: string) => {
    const e = store.get(k);
    if (e && e.expiresAt <= clock) store.delete(k);
    return store.get(k);
  };
  const client = {
    set: jest.fn(async (k: string, v: string, _px: string, ttl: number, nx: string) => {
      if (nx === 'NX' && live(k)) return null;
      store.set(k, { value: v, expiresAt: clock + ttl });
      return 'OK';
    }),
    get: jest.fn(async (k: string) => live(k)?.value ?? null),
    eval: jest.fn(async (script: string, _n: number, k: string, holder: string, ttl?: string) => {
      const e = live(k);
      if (!e || e.value !== holder) return 0;
      if (script.includes('pexpire')) {
        e.expiresAt = clock + Number(ttl);
        return 1;
      }
      store.delete(k);
      return 1;
    }),
  };
  return {
    service: { client, key: (...p: string[]) => ['edu', ...p].join(':') },
    client,
    advance: (ms: number) => (clock += ms),
  };
}

describe('uploadPressure: what holds historical HLS work back', () => {
  const scheduler = (q: ReturnType<typeof originalQueue>) =>
    new MobileEncodeScheduler(q as never, fakeRedis().service as never);

  it('counts fresh original-upload jobs waiting for their worker', async () => {
    const q = originalQueue([
      { name: VIDEO_JOBS.transcode, ageMs: 5_000 },
      { name: VIDEO_JOBS.transcode, ageMs: 60_000 },
    ]);
    await expect(scheduler(q).uploadPressure(NOW)).resolves.toEqual({
      waiting: 2,
      ignoredStale: 0,
      originalQueuePaused: false,
    });
  });

  it('is zero when nothing waits (delayed retries and the active job are never asked for)', async () => {
    await expect(scheduler(originalQueue([])).uploadPressure(NOW)).resolves.toMatchObject({ waiting: 0 });
  });

  it('ignores a waiting job so old that no original-queue consumer can be running', async () => {
    const q = originalQueue([{ name: VIDEO_JOBS.transcode, ageMs: UPLOAD_WAIT_STALE_MS + 1 }]);
    await expect(scheduler(q).uploadPressure(NOW)).resolves.toEqual({
      waiting: 0,
      ignoredStale: 1,
      originalQueuePaused: false,
    });
  });

  it('ignores other job names in the original queue', async () => {
    const q = originalQueue([{ name: 'something-else', ageMs: 1_000 }]);
    await expect(scheduler(q).uploadPressure(NOW)).resolves.toMatchObject({ waiting: 0 });
  });

  it('keeps the pause controls independent: a PAUSED original queue does not hold mobile back', async () => {
    const q = originalQueue([{ name: VIDEO_JOBS.transcode, ageMs: 1_000 }], true);
    await expect(scheduler(q).uploadPressure(NOW)).resolves.toEqual({
      waiting: 0,
      ignoredStale: 0,
      originalQueuePaused: true,
    });
    expect(q.getJobs).not.toHaveBeenCalled();
  });

  it('propagates a Redis read failure (the processor then defers, never starts blind)', async () => {
    const q = { isPaused: jest.fn(async () => { throw new Error('ECONNRESET'); }), getJobs: jest.fn() };
    await expect(scheduler(q as never).uploadPressure(NOW)).rejects.toThrow('ECONNRESET');
  });
});

describe('the single mobile encode slot', () => {
  beforeEach(() => jest.useFakeTimers({ now: NOW }));
  afterEach(() => jest.useRealTimers());

  it('lets exactly one job hold it; a second (any process) gets null', async () => {
    const r = fakeRedis();
    const a = new MobileEncodeScheduler({} as never, r.service as never);
    const b = new MobileEncodeScheduler({} as never, r.service as never);

    const slot = await a.acquireEncodeSlot('job_1');
    expect(slot).not.toBeNull();
    await expect(b.acquireEncodeSlot('job_2')).resolves.toBeNull();
    await expect(a.encodeSlotHolder()).resolves.toContain(':job_1');

    await slot!.release();
    await expect(b.acquireEncodeSlot('job_2')).resolves.not.toBeNull();
  });

  it('is renewed while the encode runs, so a long encode keeps it', async () => {
    const r = fakeRedis();
    const s = new MobileEncodeScheduler({} as never, r.service as never);
    const slot = await s.acquireEncodeSlot('job_long');

    // An hour of encoding, in renewal steps.
    for (let t = 0; t < 3_600_000; t += ENCODE_SLOT_RENEW_MS) {
      r.advance(ENCODE_SLOT_RENEW_MS);
      await jest.advanceTimersByTimeAsync(ENCODE_SLOT_RENEW_MS);
    }
    await expect(s.acquireEncodeSlot('job_other')).resolves.toBeNull();
    await slot!.release();
  });

  it('frees itself when the holder dies (no renewal) within the lease TTL', async () => {
    const r = fakeRedis();
    const s = new MobileEncodeScheduler({} as never, r.service as never);
    await s.acquireEncodeSlot('job_crashed');
    jest.clearAllTimers(); // the process died: nothing renews

    r.advance(ENCODE_SLOT_TTL_MS + 1);
    await expect(s.acquireEncodeSlot('job_next')).resolves.not.toBeNull();
  });

  it('never releases a slot it no longer owns', async () => {
    const r = fakeRedis();
    const s = new MobileEncodeScheduler({} as never, r.service as never);
    const old = await s.acquireEncodeSlot('job_old');
    jest.clearAllTimers();
    r.advance(ENCODE_SLOT_TTL_MS + 1); // lease lapsed
    const fresh = await s.acquireEncodeSlot('job_new');

    await old!.release(); // late release from the old holder
    await expect(s.encodeSlotHolder()).resolves.toContain(':job_new');
    await fresh!.release();
  });

  it('stops renewing once released (no timer left behind)', async () => {
    const s = new MobileEncodeScheduler({} as never, fakeRedis().service as never);
    const slot = await s.acquireEncodeSlot('job_1');
    expect(jest.getTimerCount()).toBe(1);
    await slot!.release();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('which mobile work is historical', () => {
  it('migration and recovery yield; upload and staff retry do not', () => {
    expect(isHistoricalMobileJob('migration')).toBe(true);
    expect(isHistoricalMobileJob('recovery')).toBe(true);
    expect(isHistoricalMobileJob('upload')).toBe(false);
    expect(isHistoricalMobileJob('retry')).toBe(false);
  });

  it('gives only historical work a BullMQ priority (the plain wait list is always taken first)', () => {
    expect(MOBILE_JOB_PRIORITY).toEqual({ upload: undefined, retry: undefined, recovery: 5, migration: 10 });
  });
});
