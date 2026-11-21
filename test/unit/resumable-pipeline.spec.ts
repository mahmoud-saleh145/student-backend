import { Prisma } from '@prisma/client';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => []),
  mkdir: jest.fn(async () => undefined),
  writeFile: jest.fn(async () => undefined),
  readFile: jest.fn(async () => Buffer.from('')),
  stat: jest.fn(async () => ({ size: 1 })),
  copyFile: jest.fn(async () => undefined),
}));

import { BOOT_RECOVERY_MAX_TRIES, BootRecovery } from '../../src/jobs/boot-recovery';
import {
  HlsTranscoder,
  RUNG_UPLOAD_MARKER,
  persistCheckpointBounded,
  type RungCheckpoint,
} from '../../src/jobs/processors/hls-transcoder';
import { MOBILE_MAX_STALLED_COUNT } from '../../src/jobs/processors/mobile-video.processor';
import { VIDEO_LOCK_DURATION_MS, VIDEO_MAX_STALLED_COUNT } from '../../src/jobs/processors/video.processor';
import {
  GUMLET_JOB_POLL_BUDGET_MS,
  GumletIngestService,
  resolveJobPollBudgetMs,
} from '../../src/modules/videos/gumlet-ingest.service';
import {
  noteGumletAssetPending,
  peekGumletPendingHint,
  setGumletMonitorActive,
  takeGumletPendingHint,
} from '../../src/modules/videos/gumlet-monitor-signal';
import {
  GumletStatusMonitor,
  MAX_ERRORS_PER_TICK,
  MAX_SYNCS_PER_TICK,
  MONITOR_MIN_SCAN_GAP_MS,
  gumletCheckIntervalMs,
  gumletErrorBackoffMs,
  monitorDisabledReason,
  monitorEnabledFlag,
  normalizeMonitorIdleSeconds,
} from '../../src/modules/videos/gumlet-status-monitor.service';
import { RECOVERY_SWEEP_LOCK, VideosService } from '../../src/modules/videos/videos.service';
import { JOB, SOURCE, VIDEO, delivery, jobData, processorFor, settle, world } from './helpers/mobile-claim-world';

/**
 * Resumable processing on a laptop that is shut down, restarted, put to sleep
 * and moved between networks (2026-11-21), including the fixes for the
 * independent review (H1, M1-M4, shared sweep lock). Everything here uses
 * doubles: no Gumlet, no R2, no database, no Redis.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const p1001 = () => new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 't' });

beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

// ===========================================================================
// 1. Web queue throughput: submit and release (only with an active monitor)
// ===========================================================================

function ingestForSubmit(row: Record<string, unknown> = {}) {
  const video = { id: VIDEO, drmProvider: 'gumlet', sourceKey: SOURCE, status: 'PROCESSING', ...row };
  const prisma = { video: { findFirst: jest.fn(async () => video) } };
  const config = { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: { workspaceId: 'ws' } } }) };
  const service = new GumletIngestService(prisma as never, {} as never, {} as never, {} as never, config as never, {} as never);
  const adopt = jest.spyOn(service, 'adopt').mockResolvedValue({ assetId: 'asset_1', status: 'pre-queued' });
  const sync = jest.spyOn(service, 'sync').mockResolvedValue({ assetId: 'asset_1', status: 'processing', playable: false });
  return { service, adopt, sync };
}

describe('web queue: submit to Gumlet, record the asset, release the slot', () => {
  beforeEach(() => setGumletMonitorActive(true));
  afterEach(() => {
    takeGumletPendingHint();
    setGumletMonitorActive(false);
  });

  it('with a monitor running here, the job ends as soon as the asset id is recorded', async () => {
    const t = ingestForSubmit();
    const started = Date.now();
    await expect(t.service.processFromJob(VIDEO, SOURCE)).resolves.toEqual({ handled: true, status: 'pre-queued', playable: false });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(t.adopt).toHaveBeenCalledTimes(1);
    expect(t.sync).not.toHaveBeenCalled(); // no 20-minute poll
    expect(peekGumletPendingHint()).toBe(true);
  });

  it('three uploads in a row are submitted back to back (no serial polling between them)', async () => {
    const order: string[] = [];
    for (const id of ['v_a', 'v_b', 'v_c']) {
      const t = ingestForSubmit({ id });
      t.adopt.mockImplementation(async (v: string) => {
        order.push(v);
        return { assetId: `asset_${v}`, status: 'pre-queued' };
      });
      const started = Date.now();
      await t.service.processFromJob(id, SOURCE);
      expect(Date.now() - started).toBeLessThan(1000);
      expect(t.sync).not.toHaveBeenCalled();
    }
    expect(order).toEqual(['v_a', 'v_b', 'v_c']);
  });

  it('H1: WITHOUT a monitor in this process (the default) the job keeps the previous in-job polling', async () => {
    setGumletMonitorActive(false);
    const t = ingestForSubmit();
    t.sync.mockResolvedValue({ assetId: 'asset_1', status: 'ready', playable: true });
    await expect(t.service.processFromJob(VIDEO, SOURCE)).resolves.toEqual({ handled: true, status: 'ready', playable: true });
    expect(t.sync).toHaveBeenCalled();
    expect(peekGumletPendingHint()).toBe(false);
  });

  it('the rollback switch: GUMLET_JOB_POLL_BUDGET_SECONDS > 0 polls even with a monitor, capped at 20 min', async () => {
    expect(resolveJobPollBudgetMs(undefined)).toBe(0);
    expect(resolveJobPollBudgetMs('0')).toBe(0);
    expect(resolveJobPollBudgetMs('abc')).toBe(0);
    expect(resolveJobPollBudgetMs('300')).toBe(300_000);
    expect(resolveJobPollBudgetMs('99999')).toBe(GUMLET_JOB_POLL_BUDGET_MS);
    const t = ingestForSubmit();
    (t.service as unknown as { jobPollBudgetMs: number }).jobPollBudgetMs = 300_000;
    t.sync.mockResolvedValue({ assetId: 'asset_1', status: 'ready', playable: true });
    await expect(t.service.processFromJob(VIDEO, SOURCE)).resolves.toMatchObject({ playable: true });
    expect(t.sync).toHaveBeenCalled();
  });
});

// ===========================================================================
// 2. GumletStatusMonitor
// ===========================================================================

type MonRow = { id: string; createdAt: Date; gumletUpdatedAt: Date | null; gumletAssetId: string };

/** A Redis double with lock lifetimes and plain keys (what the monitor uses). */
function fakeRedis(opts: { down?: boolean } = {}) {
  const locks = new Map<string, number>(); // lock name -> ttl ms
  const kv = new Map<string, string>();
  const lockName = (k: string) => k.replace(/^edu:lock:/, '');
  const redis = {
    down: opts.down ?? false,
    locks,
    kv,
    acquireLock: jest.fn(async (name: string, ttlSeconds: number) => {
      if (redis.down || locks.has(name)) return null;
      locks.set(name, ttlSeconds * 1000);
      return async () => void locks.delete(name);
    }),
    key: (...parts: Array<string | number>) => ['edu', ...parts].join(':'),
    client: {
      mget: jest.fn(async (...keys: string[]) => {
        if (redis.down) throw new Error('ECONNREFUSED');
        return keys.map((k) => kv.get(k) ?? null);
      }),
      multi: () => {
        const ops: Array<[string, string]> = [];
        const m = {
          set: (k: string, v: string) => (ops.push([k, v]), m),
          exec: async () => (ops.forEach(([k, v]) => kv.set(k, v)), []),
        };
        return m;
      },
      pttl: jest.fn(async (k: string) => locks.get(lockName(k)) ?? -2),
      pexpire: jest.fn(async (k: string, ms: number) => {
        if (locks.has(lockName(k))) locks.set(lockName(k), ms);
        return 1;
      }),
    },
    /** Expire every lock (time passed). */
    expireAll: () => locks.clear(),
  };
  return redis;
}

function monitorWith(
  rows: MonRow[],
  opts: {
    redis?: ReturnType<typeof fakeRedis>;
    drm?: boolean;
    playable?: (id: string) => boolean;
    failSync?: (id: string) => Error | null;
    sync?: jest.Mock;
  } = {},
) {
  const redis = opts.redis ?? fakeRedis();
  const sync =
    opts.sync ??
    jest.fn(async (id: string) => {
      const err = opts.failSync?.(id);
      if (err) throw err;
      return { assetId: `a_${id}`, status: opts.playable?.(id) ? 'ready' : 'processing', playable: opts.playable?.(id) ?? false };
    });
  const findMany = jest.fn(async () => rows);
  const drm = { isPlatformUsable: () => opts.drm ?? true };
  const gumlet = { isAssetApiConfigured: () => true };
  const monitor = new GumletStatusMonitor({ video: { findMany } } as never, { sync } as never, drm as never, gumlet as never, redis as never);
  return { monitor, sync, findMany, redis };
}

const seen = (redis: ReturnType<typeof fakeRedis>, id: string, asset: string, at: number) =>
  redis.kv.set(`edu:gumlet-monitor:seen:${id}`, `${asset}|${at}`);

describe('Gumlet status monitor: opt-in and DRM-gated (review H1)', () => {
  const now = Date.parse('2026-11-21T09:30:00Z');
  const row: MonRow = { id: 'v1', createdAt: new Date(now - HOUR), gumletUpdatedAt: new Date(now - 10 * MIN), gumletAssetId: 'a1' };
  afterEach(() => {
    delete process.env.GUMLET_MONITOR_ENABLED;
    takeGumletPendingHint();
  });

  it('is OFF by default: no flag, no scan, no sync', async () => {
    delete process.env.GUMLET_MONITOR_ENABLED;
    const t = monitorWith([row]);
    expect(t.monitor.enabled).toBe(false);
    expect(t.monitor.disabledReason).toMatch(/GUMLET_MONITOR_ENABLED/);
    await expect(t.monitor.tick(now)).resolves.toBeNull();
    noteGumletAssetPending();
    await expect(t.monitor.wake(now + HOUR)).resolves.toBe(false);
    expect(t.findMany).not.toHaveBeenCalled();
    expect(t.sync).not.toHaveBeenCalled();
  });

  it('stays OFF when the flag is set but this process cannot verify DRM (a local API or script against production)', async () => {
    process.env.GUMLET_MONITOR_ENABLED = 'true';
    const t = monitorWith([row], { drm: false });
    expect(t.monitor.enabled).toBe(false);
    expect(t.monitor.disabledReason).toMatch(/cannot verify DRM/);
    await expect(t.monitor.tick(now)).resolves.toBeNull();
    expect(t.sync).not.toHaveBeenCalled();
  });

  it('every precondition is required; only an explicit true enables it', () => {
    const ok = { flag: true, idleSeconds: 600, drmUsable: true, assetApi: true, redis: true };
    expect(monitorDisabledReason(ok)).toBeNull();
    expect(monitorDisabledReason({ ...ok, flag: false })).not.toBeNull();
    expect(monitorDisabledReason({ ...ok, idleSeconds: 0 })).not.toBeNull();
    expect(monitorDisabledReason({ ...ok, drmUsable: false })).not.toBeNull();
    expect(monitorDisabledReason({ ...ok, assetApi: false })).not.toBeNull();
    expect(monitorDisabledReason({ ...ok, redis: false })).not.toBeNull();
    expect(['true', '1', 'TRUE'].map(monitorEnabledFlag)).toEqual([true, true, true]);
    expect([undefined, '', 'false', '0', 'no'].map(monitorEnabledFlag)).toEqual([false, false, false, false, false]);
  });

  it('a test process never tells the ingest to release slots', () => {
    process.env.GUMLET_MONITOR_ENABLED = 'true';
    const t = monitorWith([row]);
    expect(t.monitor.enabled).toBe(true);
    // NODE_ENV=test: constructed, but the in-process "monitor active" signal stays off.
    const { isGumletMonitorActive } = jest.requireActual('../../src/modules/videos/gumlet-monitor-signal');
    expect(isGumletMonitorActive()).toBe(false);
  });
});

describe('Gumlet status monitor: schedule, load and backoff (review M3, M4)', () => {
  const now = Date.parse('2026-11-21T09:30:00Z');
  beforeEach(() => (process.env.GUMLET_MONITOR_ENABLED = 'true'));
  afterEach(() => {
    delete process.env.GUMLET_MONITOR_ENABLED;
    takeGumletPendingHint();
  });

  it('intervals by time since SUBMISSION: 1 min (3 h), 5 min (24 h), 15 min (72 h), then hourly; bounded backoff', () => {
    expect(gumletCheckIntervalMs(5 * MIN)).toBe(MIN);
    expect(gumletCheckIntervalMs(2 * HOUR)).toBe(MIN);
    expect(gumletCheckIntervalMs(10 * HOUR)).toBe(5 * MIN);
    expect(gumletCheckIntervalMs(30 * HOUR)).toBe(15 * MIN);
    expect(gumletCheckIntervalMs(4 * 24 * HOUR)).toBe(HOUR);
    expect([1, 2, 3, 6, 10].map(gumletErrorBackoffMs)).toEqual([MIN, 2 * MIN, 4 * MIN, 30 * MIN, 30 * MIN]);
    expect(normalizeMonitorIdleSeconds(undefined)).toBe(600);
    expect(normalizeMonitorIdleSeconds('0')).toBe(0);
    expect(normalizeMonitorIdleSeconds('10')).toBe(60);
  });

  it('REGRESSION 2026-11-21 (M3): a lecture uploaded 5 h before the laptop came back is checked every MINUTE after submission', async () => {
    const r1: MonRow = { id: 'overnight', createdAt: new Date(now - 5 * HOUR), gumletUpdatedAt: new Date(now - 2 * MIN), gumletAssetId: 'a1' };
    const t = monitorWith([r1]);
    const res = await t.monitor.tick(now);
    expect(res).toMatchObject({ synced: 1 });
    expect(t.redis.acquireLock).toHaveBeenCalledWith('gumlet-monitor:overnight', 60);
    expect(res!.nextScanAt).toBe(now + MIN);
    // The submission time was recorded for every later scan, in any process.
    expect(t.redis.kv.get('edu:gumlet-monitor:seen:overnight')).toBe(`a1|${now}`);
  });

  it('a REPLACEMENT asset on a months-old video starts a fresh 1-minute schedule; an asset seen 30 h ago is checked every 15 min', async () => {
    const redis = fakeRedis();
    seen(redis, 'replaced', 'old_asset', now - 90 * 24 * HOUR);
    seen(redis, 'slow', 'a_slow', now - 30 * HOUR);
    const rows: MonRow[] = [
      { id: 'replaced', createdAt: new Date(now - 90 * 24 * HOUR), gumletUpdatedAt: new Date(now - 2 * MIN), gumletAssetId: 'new_asset' },
      { id: 'slow', createdAt: new Date(now - 31 * HOUR), gumletUpdatedAt: new Date(now - 20 * MIN), gumletAssetId: 'a_slow' },
    ];
    const t = monitorWith(rows, { redis });
    await t.monitor.tick(now);
    expect(t.redis.acquireLock).toHaveBeenCalledWith('gumlet-monitor:replaced', 60);
    expect(t.redis.acquireLock).toHaveBeenCalledWith('gumlet-monitor:slow', 15 * 60);
  });

  it('syncs only DUE videos, and reports READY only when sync says playable (DRM verified)', async () => {
    const rows: MonRow[] = [
      { id: 'due_ready', createdAt: new Date(now - 40 * MIN), gumletUpdatedAt: new Date(now - 2 * MIN), gumletAssetId: 'a1' },
      { id: 'due_processing', createdAt: new Date(now - 10 * MIN), gumletUpdatedAt: new Date(now - 2 * MIN), gumletAssetId: 'a2' },
      { id: 'not_due', createdAt: new Date(now - 10 * MIN), gumletUpdatedAt: new Date(now - 10_000), gumletAssetId: 'a3' },
    ];
    const t = monitorWith(rows, { playable: (id) => id === 'due_ready' });
    const r = await t.monitor.tick(now);
    expect(t.sync.mock.calls.map((c) => c[0]).sort()).toEqual(['due_processing', 'due_ready']);
    expect(r).toMatchObject({ scanned: 3, due: 2, synced: 2, ready: 1 });
    // A final verdict frees the video's lock at once (a reprocess is not held back);
    // a still-processing one keeps it for its interval.
    expect(t.redis.locks.has('gumlet-monitor:due_ready')).toBe(false);
    expect(t.redis.locks.has('gumlet-monitor:due_processing')).toBe(true);
  });

  it('M4: when nothing is due, the next database query waits for the earliest due video (no 30 s polling)', async () => {
    const redis = fakeRedis();
    seen(redis, 'stuck', 'a_stuck', now - 30 * HOUR); // 15-min interval
    seen(redis, 'soon', 'a_soon', now - 30 * MIN); // 1-min interval
    const rows: MonRow[] = [
      { id: 'stuck', createdAt: new Date(now - 31 * HOUR), gumletUpdatedAt: new Date(now - MIN), gumletAssetId: 'a_stuck' },
    ];
    const t = monitorWith(rows, { redis });
    const r = await t.monitor.tick(now);
    expect(r).toMatchObject({ due: 0, synced: 0 });
    expect(r!.nextScanAt).toBe(now + 14 * MIN > now + 600_000 ? now + 600_000 : now + 14 * MIN);
    for (const dt of [30_000, 60_000, 5 * MIN, 9 * MIN]) await expect(t.monitor.wake(now + dt)).resolves.toBe(false);
    expect(t.findMany).toHaveBeenCalledTimes(1);

    rows.push({ id: 'soon', createdAt: new Date(now - HOUR), gumletUpdatedAt: new Date(now + 10 * MIN - 50_000), gumletAssetId: 'a_soon' });
    await expect(t.monitor.wake(now + 10 * MIN)).resolves.toBe(true);
    const later = await t.monitor.tick(now + 11 * MIN);
    expect(later!.nextScanAt - (now + 11 * MIN)).toBeLessThanOrEqual(MIN);
  });

  it('an idle monitor scans again after the idle interval; a submission hint brings the scan forward (gap ≥ 30 s)', async () => {
    const t = monitorWith([]);
    await t.monitor.tick(now);
    await expect(t.monitor.wake(now + MONITOR_MIN_SCAN_GAP_MS)).resolves.toBe(false);
    noteGumletAssetPending();
    await expect(t.monitor.wake(now + 10_000)).resolves.toBe(false); // never closer than the gap
    await expect(t.monitor.wake(now + MONITOR_MIN_SCAN_GAP_MS)).resolves.toBe(true);
    await expect(t.monitor.wake(now + MONITOR_MIN_SCAN_GAP_MS + 600_000)).resolves.toBe(true);
    expect(t.findMany).toHaveBeenCalledTimes(3);
  });

  it('REGRESSION 2026-11-21: after 8 hours offline every pending asset is due, but at most MAX_SYNCS_PER_TICK per scan', async () => {
    const rows: MonRow[] = Array.from({ length: 12 }, (_, i) => ({
      id: `v${i}`,
      createdAt: new Date(now - 9 * HOUR),
      gumletUpdatedAt: new Date(now - 8 * HOUR),
      gumletAssetId: `a${i}`,
    }));
    const t = monitorWith(rows, { playable: () => true });
    const r = await t.monitor.tick(now);
    expect(r).toMatchObject({ scanned: 12, due: 12, synced: MAX_SYNCS_PER_TICK, ready: MAX_SYNCS_PER_TICK });
    expect(r!.nextScanAt).toBe(now + MONITOR_MIN_SCAN_GAP_MS); // the rest drain on the next scans
  });

  it('M4: a Gumlet outage stops the scan after a few failures and backs EVERY process off from those videos', async () => {
    const rows: MonRow[] = Array.from({ length: 5 }, (_, i) => ({
      id: `v${i}`,
      createdAt: new Date(now - HOUR),
      gumletUpdatedAt: new Date(now - 10 * MIN),
      gumletAssetId: `a${i}`,
    }));
    const t = monitorWith(rows, { failSync: () => new Error('Gumlet timeout') });
    const r = await t.monitor.tick(now);
    expect(r).toMatchObject({ errors: MAX_ERRORS_PER_TICK, synced: 0 });
    expect(t.sync).toHaveBeenCalledTimes(MAX_ERRORS_PER_TICK);
    // The failed videos stay locked for the backoff, for every process.
    expect(t.redis.locks.get('gumlet-monitor:v0')).toBe(gumletErrorBackoffMs(1));
    const other = monitorWith(rows, { redis: t.redis, sync: t.sync });
    await other.monitor.tick(now + 1000);
    expect(t.sync).toHaveBeenCalledTimes(MAX_ERRORS_PER_TICK + 2); // only v3, v4 (not backed off) were tried
    // Second failure of the same video: the backoff doubles.
    t.redis.expireAll();
    await t.monitor.tick(now + 2 * MIN);
    expect(t.redis.locks.get('gumlet-monitor:v0')).toBe(gumletErrorBackoffMs(2));
  });

  it('a video locked by another process is skipped and looked at again when that lock runs out', async () => {
    const redis = fakeRedis();
    redis.locks.set('gumlet-monitor:v1', 4 * MIN);
    const t = monitorWith([{ id: 'v1', createdAt: new Date(now - HOUR), gumletUpdatedAt: new Date(now - 10 * MIN), gumletAssetId: 'a1' }], { redis });
    const r = await t.monitor.tick(now);
    expect(r).toMatchObject({ synced: 0, skippedLocked: 1 });
    expect(r!.nextScanAt).toBe(now + 4 * MIN);
  });

  it('without Redis it syncs nothing (fail closed)', async () => {
    const t = monitorWith([{ id: 'v1', createdAt: new Date(now - HOUR), gumletUpdatedAt: new Date(now - 10 * MIN), gumletAssetId: 'a1' }], {
      redis: fakeRedis({ down: true }),
    });
    expect(await t.monitor.tick(now)).toMatchObject({ synced: 0, skippedLocked: 1 });
    expect(t.sync).not.toHaveBeenCalled();
  });

  it('the API and the worker monitoring at once: each video is synced once, and not again within its interval', async () => {
    const rows = ['v1', 'v2', 'v3'].map((id) => ({ id, createdAt: new Date(now - HOUR), gumletUpdatedAt: new Date(now - 10 * MIN), gumletAssetId: `a_${id}` }));
    const a = monitorWith(rows);
    const b = monitorWith(rows, { redis: a.redis, sync: a.sync });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    a.sync.mockImplementation(async (id: string) => {
      await gate;
      return { assetId: `a_${id}`, status: 'processing', playable: false };
    });
    const ta = a.monitor.tick(now);
    const tb = b.monitor.tick(now);
    await settle();
    release();
    await Promise.all([ta, tb]);
    expect(a.sync.mock.calls.map((c) => c[0]).sort()).toEqual(['v1', 'v2', 'v3']);
    await b.monitor.tick(now + 1000);
    expect(a.sync).toHaveBeenCalledTimes(3);
  });

  it('a database outage skips the scan without throwing and backs off', async () => {
    const t = monitorWith([]);
    (t.findMany as jest.Mock).mockRejectedValue(p1001());
    await expect(t.monitor.tick(now)).resolves.toBeNull();
    await expect(t.monitor.wake(now + MONITOR_MIN_SCAN_GAP_MS)).resolves.toBe(false);
    await expect(t.monitor.wake(now + MIN)).resolves.toBe(true);
  });
});

// ===========================================================================
// 3. Rung checkpoints (review M1, M2)
// ===========================================================================

const SEG = (tier: number, n: number) => `hls/${VIDEO}/${tier}p/seg_${String(n).padStart(3, '0')}.ts`;

const checkpoint = (over: Partial<RungCheckpoint> = {}): RungCheckpoint => ({
  tier: 480,
  width: 864,
  height: 480,
  bitrateKbps: 1200,
  playlistKey: `hls/${VIDEO}/480p/index.m3u8`,
  sizeBytes: 123,
  keyVersion: 'v2',
  encryptionKeyId: `derived:v2:r1:${VIDEO}`,
  at: '2026-11-21T09:00:00Z',
  playlistBytes: 900,
  segmentCount: 3,
  firstSegment: { key: SEG(480, 0), bytes: 1000 },
  lastSegment: { key: SEG(480, 2), bytes: 700 },
  ...over,
});

/** A fake R2 bucket: key -> size. `blip` makes the next HEAD of a key throw. */
function fakeR2(initial: Record<string, number> = {}) {
  const objects = new Map<string, number>(Object.entries(initial));
  const blips = new Set<string>();
  const storage = {
    objects,
    blips,
    objectSizeStrict: jest.fn(async (_b: string, key: string) => {
      if (blips.has(key)) {
        blips.delete(key);
        throw new Error('ENOTFOUND r2');
      }
      return objects.get(key) ?? null;
    }),
    putObject: jest.fn(async (p: { objectKey: string; body: Buffer | string }) => void objects.set(p.objectKey, Buffer.byteLength(p.body))),
    deleteObject: jest.fn(async (_b: string, key: string) => void objects.delete(key)),
    downloadToFile: jest.fn(async () => undefined),
  };
  return storage;
}

const finished480 = () =>
  fakeR2({ [`hls/${VIDEO}/480p/index.m3u8`]: 900, [SEG(480, 0)]: 1000, [SEG(480, 1)]: 1000, [SEG(480, 2)]: 700 });

function reusableOn(storage: ReturnType<typeof fakeR2>) {
  const t = new HlsTranscoder(storage as never, { getOrThrow: () => ({}) } as never, {} as never);
  return (t as unknown as {
    reusableRung: (c: RungCheckpoint[] | undefined, r: { tier: number; width: number; height: number }, kv: string | null, kid: string | null, prefix: string) => Promise<RungCheckpoint | null>;
  }).reusableRung.bind(t);
}

describe('rung checkpoints: what may be reused (M1)', () => {
  const rung = { tier: 480, width: 864, height: 480 };
  const kid = `derived:v2:r1:${VIDEO}`;
  const prefix = `hls/${VIDEO}/`;

  it('reuses a finished rung whose playlist, first and last segment are on R2 with the verified sizes and no upload marker', async () => {
    const r2 = finished480();
    await expect(reusableOn(r2)([checkpoint()], rung, 'v2', kid, prefix)).resolves.toMatchObject({ tier: 480 });
  });

  const cases: Array<[string, (r2: ReturnType<typeof fakeR2>) => void, Partial<RungCheckpoint>]> = [
    ['an upload was interrupted (marker left on R2)', (r2) => r2.objects.set(`hls/${VIDEO}/480p/${RUNG_UPLOAD_MARKER}`, 24), {}],
    ['the marker check cannot reach R2', (r2) => r2.blips.add(`hls/${VIDEO}/480p/${RUNG_UPLOAD_MARKER}`), {}],
    ['the playlist was overwritten (size differs)', (r2) => r2.objects.set(`hls/${VIDEO}/480p/index.m3u8`, 901), {}],
    ['the playlist is missing', (r2) => r2.objects.delete(`hls/${VIDEO}/480p/index.m3u8`), {}],
    ['the last segment is missing (incomplete output)', (r2) => r2.objects.delete(SEG(480, 2)), {}],
    ['the last segment has another size (partially overwritten)', (r2) => r2.objects.set(SEG(480, 2), 650), {}],
    ['the first segment has another size', (r2) => r2.objects.set(SEG(480, 0), 999), {}],
    ['R2 cannot be asked about a segment', (r2) => r2.blips.add(SEG(480, 2)), {}],
    ['the checkpoint predates the integrity fields', () => undefined, { playlistBytes: undefined as never, lastSegment: null }],
    ['the key version differs (v1 checkpoint, v2 run)', () => undefined, { keyVersion: 'v1' }],
    ['the key id differs (rotated key root)', () => undefined, { encryptionKeyId: 'derived:v2:r2:x' }],
    ['the output size differs', () => undefined, { width: 854 }],
    ['the playlist is outside this video', () => undefined, { playlistKey: 'hls/other/480p/index.m3u8' }],
    ['a segment is outside this rung', () => undefined, { lastSegment: { key: SEG(720, 2), bytes: 700 } }],
  ];
  it.each(cases)('does NOT reuse when %s', async (_l, mutate, over) => {
    const r2 = finished480();
    mutate(r2);
    await expect(reusableOn(r2)([checkpoint(over)], rung, 'v2', kid, prefix)).resolves.toBeNull();
  });
});

describe('rung checkpoints: run() never leaves a half-overwritten rung reusable (M1) and never waits on Redis (M2)', () => {
  const probe = { durationSeconds: 60, width: 864, height: 480, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' };
  const ladderCfg = { keyVersion: 'v2', keyRoots: { r1: 'root' }, keyRootId: 'r1', ffmpegPath: 'ffmpeg', segmentSeconds: 6, threads: 0 };

  /** A transcoder whose ffmpeg/verify are doubles and whose upload writes the rung to the fake R2. */
  function pipeline(r2: ReturnType<typeof fakeR2>, opts: { crashUpload?: boolean; checkpointTimeoutMs?: number } = {}) {
    const t = new HlsTranscoder(r2 as never, { getOrThrow: () => ladderCfg } as never, {} as never);
    const x = t as unknown as Record<string, unknown>;
    const encodes: number[] = [];
    x.checkpointTimeoutMs = opts.checkpointTimeoutMs ?? 50;
    x.probe = async () => probe;
    x.assertFreeSpace = async () => undefined;
    x.writeKeyInfoV2 = async () => ({ keyInfoPath: 'k', keyPath: 'k' });
    x.effectiveThreads = () => 1;
    x.exec = async (_bin: string, args: string[]) => void encodes.push(args.some((a) => /480/.test(String(a))) ? 480 : 0);
    x.verifyRendition = async () => undefined;
    x.uploadWithRetry = async (_k: string, fn: () => Promise<unknown>) => fn();
    x.extractThumbnail = async () => null;
    x.throwIfSuperseded = () => undefined;
    x.uploadRendition = async (_dir: string, prefix: string, tier: number) => {
      // Segments first; a "shutdown" after the first one.
      r2.objects.set(`${prefix}${tier}p/seg_000.ts`, 1111);
      if (opts.crashUpload) throw new Error('worker shut down mid-upload');
      r2.objects.set(`${prefix}${tier}p/seg_001.ts`, 1111);
      r2.objects.set(`${prefix}${tier}p/seg_002.ts`, 777);
      r2.objects.set(`${prefix}${tier}p/index.m3u8`, 950);
      return {
        totalBytes: 2999,
        playlistBytes: 950,
        segmentCount: 3,
        firstSegment: { key: `${prefix}${tier}p/seg_000.ts`, bytes: 1111 },
        lastSegment: { key: `${prefix}${tier}p/seg_002.ts`, bytes: 777 },
      };
    };
    const run = (p: Record<string, unknown>) =>
      (t as unknown as { runPipeline: (p: unknown, s: number, prog: () => Promise<void>) => Promise<unknown> }).runPipeline(
        { videoId: VIDEO, sourceKey: SOURCE, workDir: '/tmp/w', ladder: [480], encrypt: true, ...p },
        1,
        async () => undefined,
      );
    return { run, encodes };
  }

  it('INTERRUPTED UPLOAD: a re-encode that dies mid-upload leaves the rung non-reusable even though its old checkpoint survives', async () => {
    const r2 = finished480();
    // Attempt 1: the old checkpoint cannot be verified (R2 blip), so the rung is
    // re-encoded; Redis does not answer the invalidation; the upload dies.
    r2.blips.add(`hls/${VIDEO}/480p/${RUNG_UPLOAD_MARKER}`);
    const hang = () => new Promise<void>(() => undefined);
    const a1 = pipeline(r2, { crashUpload: true });
    await expect(a1.run({ completedRungs: [checkpoint()], onRungInvalidated: hang })).rejects.toThrow(/mid-upload/);
    expect(a1.encodes).toEqual([480]);
    expect(r2.objects.has(`hls/${VIDEO}/480p/${RUNG_UPLOAD_MARKER}`)).toBe(true);

    // Attempt 2 still holds the stale checkpoint, and the old playlist and last
    // segment still match it - but the marker refuses reuse.
    const a2 = pipeline(r2);
    const saved: RungCheckpoint[] = [];
    await a2.run({ completedRungs: [checkpoint()], onRungCompleted: async (c: RungCheckpoint) => void saved.push(c) });
    expect(a2.encodes).toEqual([480]);
    expect(r2.objects.has(`hls/${VIDEO}/480p/${RUNG_UPLOAD_MARKER}`)).toBe(false); // cleared after a verified upload
    expect(saved[0]).toMatchObject({ playlistBytes: 950, lastSegment: { key: SEG(480, 2), bytes: 777 } });

    // Attempt 3 (another restart): now the rung IS finished and is reused.
    const a3 = pipeline(r2);
    await a3.run({ completedRungs: saved });
    expect(a3.encodes).toEqual([]);
  });

  it('the stale checkpoint is invalidated BEFORE the rung is overwritten', async () => {
    const r2 = finished480();
    r2.objects.set(`hls/${VIDEO}/480p/index.m3u8`, 1); // checkpoint no longer matches
    const order: string[] = [];
    r2.putObject.mockImplementation(async (p: { objectKey: string; body: Buffer | string }) => {
      order.push(`put ${p.objectKey.split('/').pop()}`);
      r2.objects.set(p.objectKey, Buffer.byteLength(p.body));
    });
    const a = pipeline(r2);
    await a.run({ completedRungs: [checkpoint()], onRungInvalidated: async (tier: number) => void order.push(`invalidate ${tier}`) });
    expect(order.slice(0, 2)).toEqual([`put ${RUNG_UPLOAD_MARKER}`, 'invalidate 480']);
  });

  it('M2: a checkpoint write that never returns (Redis down) does not stop the encode', async () => {
    const r2 = fakeR2();
    const a = pipeline(r2, { checkpointTimeoutMs: 30 });
    const started = Date.now();
    await expect(a.run({ ladder: [480], onRungCompleted: () => new Promise<void>(() => undefined) })).resolves.toBeTruthy();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('M2: the bounded write reports success, failure and timeout', async () => {
    await expect(persistCheckpointBounded(async () => undefined, 50)).resolves.toBe(true);
    await expect(persistCheckpointBounded(async () => { throw new Error('READONLY'); }, 50)).resolves.toBe(false);
    await expect(persistCheckpointBounded(() => new Promise<void>(() => undefined), 20)).resolves.toBe(false);
  });
});

describe('rung checkpoints (processor): shutdown during the FFmpeg stage', () => {
  function rungTranscoder() {
    const seen: Array<RungCheckpoint[] | undefined> = [];
    const result = {
      probe: { durationSeconds: 750, width: 1280, height: 720, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
      renditions: [
        { height: 480, width: 854, bitrateKbps: 1200, playlistKey: `hls/${VIDEO}/480p/index.m3u8`, sizeBytes: 1 },
        { height: 720, width: 1280, bitrateKbps: 2400, playlistKey: `hls/${VIDEO}/720p/index.m3u8`, sizeBytes: 2 },
      ],
      hlsPrefix: `hls/${VIDEO}/`,
      masterPlaylistKey: `hls/${VIDEO}/master.m3u8`,
      isEncrypted: true,
      encryptionKeyId: `derived:v2:r1:${VIDEO}`,
    };
    let crashAfterFirstRung = true;
    const transcoder = {
      preflight: jest.fn(async () => ({ sourceMissing: false, sourceBytes: 1, budgetBytes: 1, assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 } })),
      abortSuperseded: jest.fn(),
      run: jest.fn(async (p: { completedRungs?: RungCheckpoint[]; onRungCompleted?: (r: RungCheckpoint) => Promise<void> }) => {
        seen.push(p.completedRungs);
        if (!p.completedRungs?.some((r) => r.tier === 480)) {
          await p.onRungCompleted?.(checkpoint({ width: 854 }));
        }
        if (crashAfterFirstRung) {
          crashAfterFirstRung = false;
          throw new Error('ffmpeg was stopped by a worker shutdown');
        }
        return result;
      }),
    };
    return { transcoder, seen };
  }

  it('the re-run of the same job receives the finished 480p rung, so only 720p is encoded again', async () => {
    const w = world();
    const { transcoder, seen } = rungTranscoder();
    const proc = processorFor(w.videos, transcoder);
    const shared = jobData();
    await expect(proc.process({ ...delivery(shared), attemptsMade: 0 } as never, 'tok-1')).rejects.toThrow(/shutdown/);
    expect(shared.data.rungCheckpoints).toMatchObject({ jobId: JOB, sourceKey: SOURCE, rungs: [expect.objectContaining({ tier: 480 })] });
    await expect(proc.process(delivery(shared) as never, 'tok-2')).resolves.toMatchObject({ renditions: 2 });
    expect(seen[0]).toBeUndefined();
    expect(seen[1]).toEqual([expect.objectContaining({ tier: 480 })]);
    expect(w.row.mobileStatus).toBe('READY');
  });

  it('invalidation removes exactly that tier from the job data', async () => {
    const w = world();
    const shared = jobData();
    shared.data.rungCheckpoints = { jobId: JOB, sourceKey: SOURCE, rungs: [checkpoint(), checkpoint({ tier: 720, playlistKey: `hls/${VIDEO}/720p/index.m3u8` })] };
    const transcoder = {
      preflight: jest.fn(async () => ({ sourceMissing: false, sourceBytes: 1, budgetBytes: 1, assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 } })),
      abortSuperseded: jest.fn(),
      run: jest.fn(async (p: { onRungInvalidated?: (t: number) => Promise<void> }) => {
        await p.onRungInvalidated?.(480);
        throw new Error('stop here');
      }),
    };
    await processorFor(w.videos, transcoder).process(delivery(shared) as never, 'tok').catch(() => undefined);
    expect((shared.data.rungCheckpoints as { rungs: RungCheckpoint[] }).rungs.map((r) => r.tier)).toEqual([720]);
  });

  it('checkpoints of another generation or another source file are never used', async () => {
    const w = world();
    const { transcoder, seen } = rungTranscoder();
    const proc = processorFor(w.videos, transcoder);
    for (const notes of [
      { jobId: `mobile-hls:${VIDEO}:p1g3`, sourceKey: SOURCE, rungs: [checkpoint()] },
      { jobId: JOB, sourceKey: 'source/videos/replaced.mp4', rungs: [checkpoint()] },
    ]) {
      const shared = jobData();
      shared.data.rungCheckpoints = notes;
      await proc.process(delivery(shared) as never, 'tok').catch(() => undefined);
    }
    expect(seen.every((s) => s === undefined)).toBe(true);
  });
});

// ===========================================================================
// 4. Restarts: lock expiry, stall budgets, one shared recovery sweep
// ===========================================================================

describe('restart-safe worker settings', () => {
  it('a web job from a worker that was shut down is freed within minutes, not half an hour', () => {
    expect(VIDEO_LOCK_DURATION_MS).toBeLessThanOrEqual(5 * MIN);
  });
  it('several shutdowns/sleeps during one job do not fail it', () => {
    expect(VIDEO_MAX_STALLED_COUNT).toBeGreaterThanOrEqual(5);
    expect(MOBILE_MAX_STALLED_COUNT).toBeGreaterThanOrEqual(10);
  });
});

type TryLock = { status: 'acquired'; release: () => Promise<void> } | { status: 'held' } | { status: 'error' };

/** tryLock double over a shared lock table; `error` makes it answer like a Redis outage. */
function lockTable() {
  const held = new Map<string, number>();
  const t = {
    held,
    error: false,
    tryLock: jest.fn(async (name: string, ttl: number): Promise<TryLock> => {
      if (t.error) return { status: 'error' };
      if (held.has(name)) return { status: 'held' };
      held.set(name, ttl);
      return { status: 'acquired', release: async () => void held.delete(name) };
    }),
  };
  return t;
}

describe('shared recovery sweep lock', () => {
  function videosWith(locks: ReturnType<typeof lockTable>, sweep: () => Promise<unknown>) {
    const v = Object.create(VideosService.prototype) as VideosService;
    Object.assign(v, { redis: locks, logger: { log: jest.fn(), warn: jest.fn() } });
    jest.spyOn(v, 'recoverStrandedVideos').mockImplementation(sweep as never);
    return v;
  }
  const result = { requeued: 0, failed: 0, synced: 1, mobile: { requeued: 0, failed: 0 } };

  it('two sweeps (scheduled + boot) never overlap: the second is skipped while the first runs', async () => {
    const locks = lockTable();
    let finish!: () => void;
    const v = videosWith(locks, () => new Promise((r) => (finish = () => r(result))));
    const first = v.recoverStrandedVideosExclusive('scheduled');
    await settle();
    await expect(v.recoverStrandedVideosExclusive('boot')).resolves.toEqual({ skipped: 'locked' });
    finish();
    await expect(first).resolves.toMatchObject({ skipped: false, synced: 1 });
    expect(v.recoverStrandedVideos).toHaveBeenCalledTimes(1);
    expect(locks.held.has(RECOVERY_SWEEP_LOCK)).toBe(false); // released at the end
  });

  it('the lock is released even when the sweep fails, and carries an expiry for a process that dies', async () => {
    const locks = lockTable();
    const v = videosWith(locks, async () => {
      throw p1001();
    });
    await expect(v.recoverStrandedVideosExclusive('scheduled')).rejects.toThrow();
    expect(locks.held.size).toBe(0);
    expect(locks.tryLock).toHaveBeenCalledWith(RECOVERY_SWEEP_LOCK, expect.any(Number));
    expect(locks.tryLock.mock.calls[0]![1]).toBeGreaterThan(0);
  });

  it('a Redis error is reported as such (not as "someone else is sweeping")', async () => {
    const locks = lockTable();
    locks.error = true;
    const v = videosWith(locks, async () => result);
    await expect(v.recoverStrandedVideosExclusive('scheduled')).resolves.toEqual({ skipped: 'redis-unavailable' });
    expect(v.recoverStrandedVideos).not.toHaveBeenCalled();
  });
});

describe('boot recovery', () => {
  function boot(opts: { sweep?: () => Promise<unknown> } = {}) {
    const locks = lockTable();
    const videos = {
      recoverStrandedVideosExclusive: jest.fn(
        opts.sweep ?? (async () => ({ skipped: false, requeued: 0, failed: 0, synced: 1, mobile: { requeued: 0, failed: 0 } })),
      ),
    };
    const b = new BootRecovery(videos as never, locks as never);
    return { b, locks, videos };
  }

  it('runs the shared sweep once after a start and KEEPS the boot marker, so repeated restarts do not repeat it', async () => {
    const t = boot();
    await expect(t.b.run()).resolves.toBe('done');
    expect(t.videos.recoverStrandedVideosExclusive).toHaveBeenCalledWith('boot');
    expect(t.locks.held.has('boot-recovery')).toBe(true);
    const again = new BootRecovery(t.videos as never, t.locks as never);
    await expect(again.run()).resolves.toBe('locked');
    expect(t.videos.recoverStrandedVideosExclusive).toHaveBeenCalledTimes(1);
  });

  it('the scheduled sweep running right now counts as the boot sweep', async () => {
    const t = boot({ sweep: async () => ({ skipped: 'locked' }) });
    await expect(t.b.run()).resolves.toBe('sweep-running');
  });

  it('L3: a Redis ERROR is retried, never mistaken for "already ran"', async () => {
    jest.useFakeTimers();
    try {
      const t = boot();
      t.locks.error = true;
      await expect(t.b.run()).resolves.toBe('retry');
      expect(t.videos.recoverStrandedVideosExclusive).not.toHaveBeenCalled();
      t.b.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a database or Redis outage during the sweep: bounded retries, marker freed each time, then the scheduled sweep takes over', async () => {
    jest.useFakeTimers();
    try {
      const t = boot({ sweep: async () => { throw p1001(); } });
      for (let i = 1; i < BOOT_RECOVERY_MAX_TRIES; i += 1) {
        await expect(t.b.run()).resolves.toBe('retry');
        expect(t.locks.held.has('boot-recovery')).toBe(false);
      }
      await expect(t.b.run()).resolves.toBe('gave-up');
      const unavailable = boot({ sweep: async () => ({ skipped: 'redis-unavailable' }) });
      await expect(unavailable.b.run()).resolves.toBe('retry');
      expect(unavailable.locks.held.has('boot-recovery')).toBe(false);
      t.b.onModuleDestroy();
      unavailable.b.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
