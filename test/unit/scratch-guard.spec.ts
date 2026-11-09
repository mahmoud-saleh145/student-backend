import { hostname } from 'node:os';

import { ScratchGuard, formatBytes, readPauseState, writePauseState } from '../../src/jobs/processors/scratch-guard';

jest.mock('node:fs/promises', () => ({
  statfs: jest.fn(),
}));
import { statfs } from 'node:fs/promises';

const GB = 1024 ** 3;

/**
 * Disk protection for the laptop's system drive: the reserve is absolute,
 * other jobs' reservations count, the watchdog fires once, and the pause flag
 * is a persistent Redis value.
 */
function build(opts: { freeGB?: number | null; reserved?: Record<string, number>; minFreeGB?: number; check?: number } = {}) {
  const store = new Map<string, string>();
  for (const [id, bytes] of Object.entries(opts.reserved ?? {})) {
    store.set(`edu:transcode:reserve:${hostname()}:${id}`, JSON.stringify({ bytes }));
  }
  const redis = {
    getJson: jest.fn(async (key: string) => {
      const raw = store.get(`edu:${key}`);
      return raw ? JSON.parse(raw) : null;
    }),
    setJson: jest.fn(async (key: string, value: unknown) => void store.set(`edu:${key}`, JSON.stringify(value))),
    setJsonPersistent: jest.fn(async (key: string, value: unknown) => void store.set(`edu:${key}`, JSON.stringify(value))),
    del: jest.fn(async (...keys: string[]) => keys.forEach((k) => store.delete(`edu:${k}`))),
    scanJson: jest.fn(async (pattern: string) => {
      const prefix = `edu:${pattern.replace(/\*$/, '')}`;
      return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, JSON.parse(v)]);
    }),
  };
  (statfs as jest.Mock).mockImplementation(async () => {
    if (opts.freeGB === null) throw new Error('ENOSYS');
    return { bavail: BigInt(Math.round((opts.freeGB ?? 60) * GB) / 4096), bsize: 4096 };
  });
  const config = {
    getOrThrow: () => ({ minFreeBytes: (opts.minFreeGB ?? 25) * GB, diskCheckSeconds: opts.check ?? 5 }),
  };
  return { guard: new ScratchGuard(redis as never, config as never), redis, store };
}

describe('ScratchGuard.assess', () => {
  it('passes when the budget fits above the reserve', async () => {
    const { guard } = build({ freeGB: 60 });
    const v = await guard.assess('/scratch', 10 * GB);
    expect(v.ok).toBe(true);
    expect(v.shortfallBytes).toBe(0);
    expect(v.minFreeBytes).toBe(25 * GB);
  });

  it('refuses when the budget would eat into the reserve, and says by how much', async () => {
    const { guard } = build({ freeGB: 30 });
    const v = await guard.assess('/scratch', 10 * GB);
    expect(v.ok).toBe(false);
    expect(v.shortfallBytes).toBe(5 * GB);
  });

  it('counts other jobs’ reservations on this host against the free space', async () => {
    const { guard } = build({ freeGB: 60, reserved: { other: 30 * GB } });
    const v = await guard.assess('/scratch', 10 * GB, 'mine');
    expect(v.reservedByOthers).toBe(30 * GB);
    expect(v.ok).toBe(false);
    expect(v.shortfallBytes).toBe(5 * GB);
  });

  it('does not count the job’s own reservation twice', async () => {
    const { guard } = build({ freeGB: 60, reserved: { mine: 30 * GB } });
    const v = await guard.assess('/scratch', 10 * GB, 'mine');
    expect(v.reservedByOthers).toBe(0);
    expect(v.ok).toBe(true);
  });

  it('measures a scratch directory that does not exist yet through its parent', async () => {
    const { guard } = build({ freeGB: 60 });
    (statfs as jest.Mock).mockImplementation(async (p: string) => {
      if (p.endsWith('mobile')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { bavail: BigInt((60 * GB) / 4096), bsize: 4096 };
    });
    expect(await guard.freeBytes('/scratch/mobile')).toBe(60 * GB);
  });

  it('lets an unmeasurable volume through, as the old preflight did', async () => {
    const { guard } = build({ freeGB: null });
    const v = await guard.assess('/scratch', 10 * GB);
    expect(v.ok).toBe(true);
    expect(v.freeBytes).toBeNull();
  });
});

describe('ScratchGuard.reserve', () => {
  it('records the budget until released', async () => {
    const { guard } = build({ freeGB: 60 });
    const release = await guard.reserve('v_1', 7 * GB);
    expect(await guard.reservedByOthers()).toBe(7 * GB);
    expect(await guard.reservedByOthers('v_1')).toBe(0);
    await release();
    expect(await guard.reservedByOthers()).toBe(0);
  });
});

describe('ScratchGuard.watch', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fires once when free space drops below the reserve, and not while it is above', async () => {
    const { guard } = build({ freeGB: 60, check: 5 });
    const onPressure = jest.fn();
    const stop = guard.watch('/scratch', onPressure);

    await jest.advanceTimersByTimeAsync(5_500);
    expect(onPressure).not.toHaveBeenCalled();

    (statfs as jest.Mock).mockImplementation(async () => ({ bavail: BigInt((20 * GB) / 4096), bsize: 4096 }));
    await jest.advanceTimersByTimeAsync(5_500);
    await jest.advanceTimersByTimeAsync(5_500);
    expect(onPressure).toHaveBeenCalledTimes(1);
    expect(onPressure).toHaveBeenCalledWith(20 * GB);
    stop();
  });

  it('never polls faster than every five seconds', async () => {
    const { guard } = build({ freeGB: 10, check: 1 });
    const onPressure = jest.fn();
    const stop = guard.watch('/scratch', onPressure);
    await jest.advanceTimersByTimeAsync(4_000);
    expect(onPressure).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1_500);
    expect(onPressure).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe('ScratchGuard.snapshot', () => {
  it('reports the volume, the reserve, reservations and whether it is safe', async () => {
    const { guard } = build({ freeGB: 40, reserved: { other: 10 * GB } });
    const s = await guard.snapshot('/scratch/mobile');
    expect(s).toEqual({ path: '/scratch/mobile', freeBytes: 40 * GB, minFreeBytes: 25 * GB, reservedBytes: 10 * GB, safe: true });
    const { guard: tight } = build({ freeGB: 30, reserved: { other: 10 * GB } });
    expect((await tight.snapshot('/scratch/mobile')).safe).toBe(false);
  });
});

describe('pause flag', () => {
  it('is absent by default, persists with who and why, and clears on resume', async () => {
    const { guard, redis } = build();
    expect(await guard.pauseState()).toEqual({ paused: false, reason: null, by: null, at: null });

    const paused = await guard.setPaused(true, 'admin_1', 'laptop in use');
    expect(paused.paused).toBe(true);
    expect(paused.reason).toBe('laptop in use');
    expect(paused.by).toBe('admin_1');
    expect(redis.setJsonPersistent).toHaveBeenCalled(); // no TTL: survives restarts

    expect(await readPauseState(redis as never)).toMatchObject({ paused: true });
    const resumed = await writePauseState(redis as never, false, 'admin_1');
    expect(resumed.paused).toBe(false);
  });
});

describe('formatBytes', () => {
  it('prints GB above a gigabyte and MB below', () => {
    expect(formatBytes(3 * GB)).toBe('3.0 GB');
    expect(formatBytes(512 * 1024 * 1024)).toBe('512 MB');
    expect(formatBytes(null)).toBe('unknown');
  });
});
