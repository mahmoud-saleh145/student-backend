/**
 * Fix 5 - an old worker must be detectable before the strict DRM gate relies
 * on the verification sweep.
 *
 * Verified current state (2026-10-13): the production worker is a PC-hosted
 * container built from 99c0bb1. Its maintenance processor logs and COMPLETES
 * any job name it does not know, so it would silently swallow the
 * `refresh-drm-verification` job the new API schedules every 30 minutes;
 * verified videos would then expire after DRM_VERIFICATION_TTL_SECONDS while
 * /meta/health/deep still reported `worker: true`.
 *
 * The heartbeat now carries the worker's build and capabilities, and the deep
 * health report flags a worker that cannot run the sweep.
 */
import { HealthController } from '../../src/modules/health/health.controller';
import {
  DRM_LAST_SWEEP_FAILURE_KEY,
  DRM_LAST_SWEEP_KEY,
} from '../../src/modules/playback/drm-verification-scheduler.service';
import {
  WORKER_CAPABILITIES,
  WorkerHeartbeat,
  runningBuild,
  type WorkerHeartbeatPayload,
} from '../../src/jobs/worker-heartbeat';

const ENV_KEYS = ['BUILD_COMMIT', 'RENDER_GIT_COMMIT'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('runningBuild()', () => {
  it('prefers BUILD_COMMIT, falls back to RENDER_GIT_COMMIT, and shortens to 12 chars', () => {
    process.env.RENDER_GIT_COMMIT = 'CF6ABD9712BD7B069D2B408E25C2789DAA4A2AF9';
    expect(runningBuild()).toBe('cf6abd9712bd');
    process.env.BUILD_COMMIT = 'c0f48831234567';
    expect(runningBuild()).toBe('c0f488312345');
  });

  it.each(['', 'not-a-sha', 'abc', '; rm -rf /'])('returns null for %p rather than echoing it', (v) => {
    process.env.BUILD_COMMIT = v;
    expect(runningBuild()).toBeNull();
  });
});

describe('the worker heartbeat', () => {
  it('advertises its build and the DRM sweep capability', async () => {
    process.env.BUILD_COMMIT = 'c0f4883aaaaa';
    const written: WorkerHeartbeatPayload[] = [];
    const redis = {
      setJson: jest.fn(async (_k: string, payload: WorkerHeartbeatPayload) => {
        written.push(payload);
      }),
    };
    const hb = new WorkerHeartbeat(redis as never, { getOrThrow: () => ({ ffmpegPath: 'x', ffprobePath: 'y' }) } as never);
    await (hb as unknown as { beat: () => Promise<void> }).beat();
    expect(written[0]).toMatchObject({ build: 'c0f4883aaaaa', capabilities: ['drm-verification-sweep'] });
    expect(WORKER_CAPABILITIES).toContain('drm-verification-sweep');
  });
});

describe('/meta/health/deep', () => {
  function deepWith(
    worker: Partial<WorkerHeartbeatPayload> | null,
    lastSweep: Record<string, unknown> | null = null,
    lastFailure: Record<string, unknown> | null = null,
  ) {
    const controller = new HealthController(
      {
        ping: jest.fn(async () => true),
        video: { groupBy: jest.fn(async () => []) },
      } as never,
      {
        ping: jest.fn(async () => true),
        getJson: jest.fn(async (key: string) =>
          key === DRM_LAST_SWEEP_KEY ? lastSweep : key === DRM_LAST_SWEEP_FAILURE_KEY ? lastFailure : worker,
        ),
      } as never,
      { health: jest.fn(async () => true) } as never,
      {
        getOrThrow: (k: string) =>
          k === 'app' ? { env: 'test', publicUrl: 'https://api.example' } : { buckets: { media: 'm' } },
      } as never,
    );
    return controller.deep();
  }

  const base = { pid: 1, host: 'edu-worker-pc', startedAt: 'x', at: 'y', ffmpeg: true, ffprobe: true };
  const sweep = (minutesAgo: number) => ({
    at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    host: 'srv-api',
    checked: 11, refreshed: 11, failed: 0, errored: 0, skippedFresh: 1, skippedPlatform: 0,
  });

  it('flags a sweep that has not completed recently - independent of which worker is running', async () => {
    // Today's 99c0bb1 container with no sweep record: exactly the state that
    // let proofs age to 35-38 h. Still reported, but now from the real signal.
    const res = await deepWith(base, null);
    expect(res.checks.worker).toBe(true);
    expect(res.notes.drmSweep).toMatch(/No DRM verification sweep has completed/);
    expect(res.drmVerification).toEqual({ sweepIntervalSeconds: 900, lastSweep: null, lastFailedAttemptAt: null });
    expect(res.videoPipeline.worker).toMatchObject({ build: null, capabilities: [] });
  });

  it('is quiet when a sweep completed within two intervals, and reports it', async () => {
    process.env.RENDER_GIT_COMMIT = 'c0f4883bbbbbbbbb';
    const res = await deepWith({ ...base, build: 'c0f4883bbbbb', capabilities: ['drm-verification-sweep'] }, sweep(5));
    expect(res.notes.drmSweep).toBeUndefined();
    expect(res.drmVerification.lastSweep).toMatchObject({ host: 'srv-api', refreshed: 11 });
    expect(res.videoPipeline).toMatchObject({
      apiBuild: 'c0f4883bbbbb',
      worker: { build: 'c0f4883bbbbb', capabilities: ['drm-verification-sweep'] },
    });
  });

  it('flags a sweep older than two intervals', async () => {
    const res = await deepWith(null, sweep(31));
    expect(res.notes.drmSweep).toMatch(/No DRM verification sweep has completed/);
  });

  describe('C3: a sweep that ran is not automatically a healthy one', () => {
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

    it('reports a sweep skipped because the platform is not configured', async () => {
      const res = await deepWith(null, { ...sweep(5), checked: 0, refreshed: 0, skippedFresh: 0, skippedPlatform: 1 });
      expect(res.notes.drmSweep).toMatch(/skipped: the platform is not configured/);
    });

    it('reports per-video definitive failures and provider errors with their counts', async () => {
      const res = await deepWith(null, { ...sweep(5), refreshed: 8, failed: 2, errored: 1 });
      expect(res.notes.drmSweep).toMatch(/2 video\(s\) failed verification/);
      expect(res.notes.drmSweep).toMatch(/1 could not be checked/);
    });

    it('reports provider errors alone (nothing failed definitively)', async () => {
      const res = await deepWith(null, { ...sweep(5), refreshed: 0, errored: 11 });
      expect(res.notes.drmSweep).toMatch(/0 video\(s\) failed verification.*; 11 could not be checked/);
    });

    it('reports an attempt that threw AFTER the last completed sweep, without any error text', async () => {
      const res = await deepWith(null, sweep(10), { at: minutesAgo(2), host: 'srv-api' });
      expect(res.notes.drmSweep).toMatch(/attempt .* failed before completing/);
      expect(res.drmVerification.lastFailedAttemptAt).toEqual(expect.any(String));
    });

    it('a failed attempt with no completed sweep at all is still reported as a failed attempt', async () => {
      const res = await deepWith(null, null, { at: minutesAgo(2), host: 'srv-api' });
      expect(res.notes.drmSweep).toMatch(/failed before completing/);
    });

    it('an older failed attempt superseded by a clean sweep is not reported', async () => {
      const res = await deepWith(null, sweep(2), { at: minutesAgo(10), host: 'srv-api' });
      expect(res.notes.drmSweep).toBeUndefined();
    });

    it('a clean recent sweep stays quiet', async () => {
      const res = await deepWith(null, sweep(2));
      expect(res.notes.drmSweep).toBeUndefined();
    });
  });

  describe('C5: health judges "overdue" against the interval the scheduler actually runs', () => {
    const saved = process.env.DRM_SWEEP_INTERVAL_SECONDS;
    afterEach(() => {
      if (saved === undefined) delete process.env.DRM_SWEEP_INTERVAL_SECONDS;
      else process.env.DRM_SWEEP_INTERVAL_SECONDS = saved;
    });

    it('DRM_SWEEP_INTERVAL_SECONDS=5 runs every 60 s, so a 3-minute-old sweep is overdue', async () => {
      process.env.DRM_SWEEP_INTERVAL_SECONDS = '5';
      const res = await deepWith(null, sweep(3));
      expect(res.drmVerification.sweepIntervalSeconds).toBe(60);
      expect(res.notes.drmSweep).toMatch(/No DRM verification sweep has completed/);
    });

    it('a non-numeric value disables the sweep in both places (no false "overdue")', async () => {
      process.env.DRM_SWEEP_INTERVAL_SECONDS = 'abc';
      const res = await deepWith(null, null);
      expect(res.drmVerification.sweepIntervalSeconds).toBe(0);
      expect(res.notes.drmSweep).toBeUndefined();
    });

    it('a fractional value is floored the same way as the scheduler', async () => {
      process.env.DRM_SWEEP_INTERVAL_SECONDS = '1234.7';
      const res = await deepWith(null, sweep(1));
      expect(res.drmVerification.sweepIntervalSeconds).toBe(1234);
    });
  });

  it('with no worker at all, keeps the existing "no worker" note', async () => {
    const res = await deepWith(null);
    expect(res.checks.worker).toBe(false);
    expect(res.notes.worker).toMatch(/No queue worker/);
  });
});
