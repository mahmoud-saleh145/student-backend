import { MAINTENANCE_JOBS } from '../../src/jobs/queue.constants';
import { MaintenanceScheduler } from '../../src/jobs/schedulers/maintenance.scheduler';
import {
  DRM_LAST_SWEEP_FAILURE_KEY,
  DRM_LAST_SWEEP_KEY,
  DrmVerificationScheduler,
  normalizeSweepIntervalSeconds,
  worstCaseSweepSeconds,
} from '../../src/modules/playback/drm-verification-scheduler.service';
import {
  SWEEP_DEFAULT_BATCH_SIZE,
  SWEEP_VERIFY_ATTEMPTS,
} from '../../src/modules/playback/drm-verification-sweep.service';

/**
 * Where the DRM re-verification sweep runs.
 *
 * Verified production state (2026-10-13): the sweep was a BullMQ repeatable,
 * consumed only by the PC-hosted worker - and that worker's build completes job
 * names it does not know, so the sweep never ran (proofs aged 35-38 h). The
 * sweep now runs IN PROCESS under a Redis lock in every process that loads
 * PlaybackModule (the always-on API included). No queue is involved, so no
 * process can swallow it, and the lock prevents concurrent sweeps.
 */

function fakeQueue() {
  const add = jest.fn(async (_name: string, _data: unknown, _opts: unknown) => undefined);
  return { add };
}

describe('the BullMQ maintenance schedule', () => {
  it('keeps the job name stable, so a hand-enqueued job still reaches the processor', () => {
    expect(MAINTENANCE_JOBS.refreshDrmVerification).toBe('refresh-drm-verification');
  });

  it('no longer registers the DRM sweep as a repeatable (an old worker would swallow it)', async () => {
    const maintenance = fakeQueue();
    const scheduler = new MaintenanceScheduler(maintenance as never, fakeQueue() as never);
    await scheduler.onModuleInit();
    const names = maintenance.add.mock.calls.map((c) => c[0] as string);
    expect(names).not.toContain(MAINTENANCE_JOBS.refreshDrmVerification);
  });

  it('keeps every other scheduled job intact', async () => {
    const maintenance = fakeQueue();
    const scheduler = new MaintenanceScheduler(maintenance as never, fakeQueue() as never);
    await scheduler.onModuleInit();
    const names = maintenance.add.mock.calls.map((c) => c[0] as string);
    expect(names).toEqual(
      expect.arrayContaining([
        MAINTENANCE_JOBS.expireEnrollments,
        MAINTENANCE_JOBS.expireTickets,
        MAINTENANCE_JOBS.reclaimStreamSlots,
        MAINTENANCE_JOBS.dispatchAnnouncements,
        MAINTENANCE_JOBS.recoverStrandedVideos,
      ]),
    );
  });
});

describe('DrmVerificationScheduler (in-process, Redis-locked)', () => {
  const SWEEP = { skippedFresh: 1, checked: 11, refreshed: 11, failed: 0, errored: 0, skippedPlatform: 0 };

  function build(opts: { lockFree?: boolean; sweepThrows?: boolean; httpTimeoutMs?: number } = {}) {
    const release = jest.fn(async () => undefined);
    const redis = {
      acquireLock: jest.fn(async (_name: string, _ttl: number) => (opts.lockFree === false ? null : release)),
      setJson: jest.fn(async (_k: string, _v: unknown, _t: number) => undefined),
    };
    const sweeper = {
      sweep: jest.fn(async () => {
        if (opts.sweepThrows) throw new Error('db down');
        return SWEEP;
      }),
    };
    const config = {
      get: (key: string) =>
        key === 'video' ? { drm: { gumlet: { httpTimeoutMs: opts.httpTimeoutMs ?? 5000 } } } : undefined,
    };
    const scheduler = new DrmVerificationScheduler(sweeper as never, redis as never, config as never);
    return { scheduler, redis, sweeper, release };
  }

  const saved = process.env.DRM_SWEEP_INTERVAL_SECONDS;
  afterEach(() => {
    if (saved === undefined) delete process.env.DRM_SWEEP_INTERVAL_SECONDS;
    else process.env.DRM_SWEEP_INTERVAL_SECONDS = saved;
    jest.useRealTimers();
  });

  it('runs one sweep under the lock, records it for health, and releases the lock', async () => {
    const { scheduler, redis, sweeper, release } = build();
    expect(await scheduler.tick()).toEqual(SWEEP);
    expect(redis.acquireLock).toHaveBeenCalledWith('drm-verification-sweep', scheduler.lockSeconds);
    expect(sweeper.sweep).toHaveBeenCalledTimes(1);
    expect(redis.setJson).toHaveBeenCalledWith(
      DRM_LAST_SWEEP_KEY,
      expect.objectContaining({ ...SWEEP, at: expect.any(String), host: expect.any(String) }),
      7 * 24 * 3600,
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does nothing while another process holds the lock (no duplicate sweeps)', async () => {
    const { scheduler, sweeper } = build({ lockFree: false });
    expect(await scheduler.tick()).toBeNull();
    expect(sweeper.sweep).not.toHaveBeenCalled();
  });

  it('releases the lock even when the sweep throws, and records the failed attempt (time and host only)', async () => {
    const { scheduler, release, redis } = build({ sweepThrows: true });
    expect(await scheduler.tick()).toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
    // Not recorded as a completed sweep...
    expect(redis.setJson).not.toHaveBeenCalledWith(DRM_LAST_SWEEP_KEY, expect.anything(), expect.anything());
    // ...but as a failed attempt, without the error message (health is public).
    expect(redis.setJson).toHaveBeenCalledWith(
      DRM_LAST_SWEEP_FAILURE_KEY,
      { at: expect.any(String), host: expect.any(String) },
      7 * 24 * 3600,
    );
  });

  it('the sweep constants the lock is sized from are the ones the sweep uses', () => {
    expect(SWEEP_DEFAULT_BATCH_SIZE).toBe(25);
    expect(SWEEP_VERIFY_ATTEMPTS).toBe(2);
    // 25 videos x 2 requests x (2 tries x timeout + 250 ms backoff)
    expect(worstCaseSweepSeconds(5000)).toBe(Math.ceil((25 * 2 * (2 * 5000 + 250)) / 1000));
    expect(worstCaseSweepSeconds(30000)).toBe(Math.ceil((25 * 2 * (2 * 30000 + 250)) / 1000));
  });

  it.each([500, 5000, 10000, 30000])(
    'holds the lock longer than the worst-case sweep at GUMLET_HTTP_TIMEOUT_MS=%i',
    (httpTimeoutMs) => {
      delete process.env.DRM_SWEEP_INTERVAL_SECONDS;
      const { scheduler } = build({ httpTimeoutMs });
      expect(scheduler.lockSeconds).toBeGreaterThan(worstCaseSweepSeconds(httpTimeoutMs));
      // ...and never shorter than the interval.
      expect(scheduler.lockSeconds).toBeGreaterThanOrEqual(scheduler.intervalSeconds);
    },
  );

  it('at the maximum allowed timeout (30 s) the lock covers ~3000 s, not the old fixed 900 s', () => {
    delete process.env.DRM_SWEEP_INTERVAL_SECONDS;
    const { scheduler } = build({ httpTimeoutMs: 30000 });
    expect(scheduler.lockSeconds).toBeGreaterThanOrEqual(25 * 2 * 2 * 30);
    expect(scheduler.lockSeconds).toBeGreaterThan(900);
  });

  it('normalizeSweepIntervalSeconds is the interval the scheduler runs', () => {
    for (const raw of [undefined, '0', '-5', 'abc', '5', '59.9', '60', '900', '1234.7', '86400']) {
      if (raw === undefined) delete process.env.DRM_SWEEP_INTERVAL_SECONDS;
      else process.env.DRM_SWEEP_INTERVAL_SECONDS = raw;
      expect(build().scheduler.intervalSeconds).toBe(normalizeSweepIntervalSeconds(raw));
    }
    expect(normalizeSweepIntervalSeconds(undefined)).toBe(900);
    expect(normalizeSweepIntervalSeconds('0')).toBe(0);
    expect(normalizeSweepIntervalSeconds('abc')).toBe(0);
    expect(normalizeSweepIntervalSeconds('5')).toBe(60);
    expect(normalizeSweepIntervalSeconds('1234.7')).toBe(1234);
  });

  it('defaults to every 15 minutes, and 0 disables the timer', () => {
    delete process.env.DRM_SWEEP_INTERVAL_SECONDS;
    expect(build().scheduler.intervalSeconds).toBe(900);
    process.env.DRM_SWEEP_INTERVAL_SECONDS = '0';
    expect(build().scheduler.intervalSeconds).toBe(0);
    process.env.DRM_SWEEP_INTERVAL_SECONDS = '5';
    expect(build().scheduler.intervalSeconds).toBe(60); // floor
  });

  it('starts its timers on boot outside tests, and ticks soon after boot', async () => {
    jest.useFakeTimers();
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    process.env.DRM_SWEEP_INTERVAL_SECONDS = '900';
    try {
      const { scheduler, sweeper } = build();
      scheduler.onApplicationBootstrap();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(sweeper.sweep).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(900_000);
      expect(sweeper.sweep).toHaveBeenCalledTimes(2);
      scheduler.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(900_000);
      expect(sweeper.sweep).toHaveBeenCalledTimes(2);
    } finally {
      process.env.NODE_ENV = env;
    }
  });
});
