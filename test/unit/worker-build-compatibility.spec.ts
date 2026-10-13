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
  function deepWith(worker: Partial<WorkerHeartbeatPayload> | null) {
    const controller = new HealthController(
      {
        ping: jest.fn(async () => true),
        video: { groupBy: jest.fn(async () => []) },
      } as never,
      { ping: jest.fn(async () => true), getJson: jest.fn(async () => worker) } as never,
      { health: jest.fn(async () => true) } as never,
      {
        getOrThrow: (k: string) =>
          k === 'app' ? { env: 'test', publicUrl: 'https://api.example' } : { buckets: { media: 'm' } },
      } as never,
    );
    return controller.deep();
  }

  const base = { pid: 1, host: 'edu-worker-pc', startedAt: 'x', at: 'y', ffmpeg: true, ffprobe: true };

  it('flags a worker that predates the DRM sweep (today\'s 99c0bb1 container)', async () => {
    const res = await deepWith(base);
    expect(res.checks.worker).toBe(true);
    expect(res.notes.drmSweep).toMatch(/predates the DRM verification sweep/);
    expect(res.videoPipeline.worker).toMatchObject({ build: null, capabilities: [] });
  });

  it('is quiet for a worker built with the sweep, and reports both builds', async () => {
    process.env.RENDER_GIT_COMMIT = 'c0f4883bbbbbbbbb';
    const res = await deepWith({ ...base, build: 'c0f4883bbbbb', capabilities: ['drm-verification-sweep'] });
    expect(res.notes.drmSweep).toBeUndefined();
    expect(res.videoPipeline).toMatchObject({
      apiBuild: 'c0f4883bbbbb',
      worker: { build: 'c0f4883bbbbb', capabilities: ['drm-verification-sweep'] },
    });
  });

  it('with no worker at all, keeps the existing "no worker" note', async () => {
    const res = await deepWith(null);
    expect(res.checks.worker).toBe(false);
    expect(res.notes.worker).toMatch(/No queue worker/);
  });
});
