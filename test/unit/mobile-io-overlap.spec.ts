import { DelayedError, type Job } from 'bullmq';

import {
  HlsTranscoder,
  TranscodeDiskPressureError,
  TranscodeSupersededError,
} from '../../src/jobs/processors/hls-transcoder';
import { ENCODE_SLOT_KEY, ENCODE_SLOT_TTL_MS, encodeSlotKeys, MobileEncodeScheduler } from '../../src/jobs/processors/mobile-encode-scheduler';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { MOBILE_VIDEO_JOBS, type MobileTranscodeJobData } from '../../src/jobs/queue.constants';

jest.mock('node:fs/promises', () => ({
  ...jest.requireActual('node:fs/promises'),
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => []),
  mkdir: jest.fn(async () => undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wd = require('../../deploy/laptop-worker/watchdog/watchdog.js');

/**
 * MOBILE_JOB_CONCURRENCY / MOBILE_ENCODE_SLOTS ("2 jobs, 1 encode slot"):
 *  - the encode slot covers each rung's ffmpeg ENCODE only, so one video's
 *    download and uploads overlap another video's encode;
 *  - the number of encodes at once never exceeds the slots, in one process or
 *    across processes, and a crashed holder's lease expires;
 *  - two jobs of one video never run side by side in one process;
 *  - per-run abort/supersede state: stopping one video never touches another;
 *  - the defaults (1 and 1) keep the original behaviour.
 */

const NOW = Date.parse('2026-11-23T20:00:00Z');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** In-memory Redis: SET NX PX, GET, and the renew / release compare-and-act scripts. */
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
    store,
    live,
    advance: (ms: number) => (clock += ms),
  };
}

const schedulerOn = (r: ReturnType<typeof fakeRedis>) =>
  new MobileEncodeScheduler({ isPaused: async () => false, getJobs: async () => [] } as never, r.service as never);

describe('encode slots: N leases shared by every worker process', () => {
  it('encodeSlotKeys: slot 1 keeps the original key, then :2, :3 …', () => {
    expect(encodeSlotKeys(1)).toEqual([ENCODE_SLOT_KEY]);
    expect(encodeSlotKeys(3)).toEqual([ENCODE_SLOT_KEY, `${ENCODE_SLOT_KEY}:2`, `${ENCODE_SLOT_KEY}:3`]);
    expect(encodeSlotKeys(0)).toEqual([ENCODE_SLOT_KEY]);
  });

  it('default (1 slot): a second encode anywhere is refused while the first holds it', async () => {
    const r = fakeRedis();
    const a = await schedulerOn(r).acquireEncodeSlot('job-a');
    expect(a).not.toBeNull();
    await expect(schedulerOn(r).acquireEncodeSlot('job-b')).resolves.toBeNull();
    await a!.release();
    await expect(schedulerOn(r).acquireEncodeSlot('job-b')).resolves.not.toBeNull();
  });

  it('2 slots: exactly two holders on distinct keys; the third is refused', async () => {
    const r = fakeRedis();
    const s = schedulerOn(r);
    const a = await s.acquireEncodeSlot('a', 2);
    const b = await s.acquireEncodeSlot('b', 2);
    expect(a && b).toBeTruthy();
    await expect(s.acquireEncodeSlot('c', 2)).resolves.toBeNull();
    expect(r.live(`edu:${ENCODE_SLOT_KEY}`)).toBeTruthy();
    expect(r.live(`edu:${ENCODE_SLOT_KEY}:2`)).toBeTruthy();
  });

  it('mixed fleet: a 1-slot worker and a 2-slot worker still exclude each other on slot 1', async () => {
    const r = fakeRedis();
    const newer = await schedulerOn(r).acquireEncodeSlot('new', 2); // takes slot 1 first
    await expect(schedulerOn(r).acquireEncodeSlot('old', 1)).resolves.toBeNull();
    await newer!.release();
    const old = await schedulerOn(r).acquireEncodeSlot('old', 1);
    expect(old).not.toBeNull();
    // The 2-slot worker now gets slot 2: total encodes = 2 = its own configured limit.
    await expect(schedulerOn(r).acquireEncodeSlot('new2', 2)).resolves.not.toBeNull();
    await expect(schedulerOn(r).acquireEncodeSlot('new3', 2)).resolves.toBeNull();
  });

  it('WORKER CRASH: a holder that stops renewing loses its lease after the TTL; another job then encodes', async () => {
    const r = fakeRedis();
    await schedulerOn(r).acquireEncodeSlot('crashed'); // its process "dies": no renewal, no release
    await expect(schedulerOn(r).acquireEncodeSlot('next')).resolves.toBeNull();
    r.advance(ENCODE_SLOT_TTL_MS + 1);
    await expect(schedulerOn(r).acquireEncodeSlot('next')).resolves.not.toBeNull();
  });

  it('release is idempotent and never frees a slot another job holds', async () => {
    const r = fakeRedis();
    const s = schedulerOn(r);
    const a = await s.acquireEncodeSlot('a');
    r.advance(ENCODE_SLOT_TTL_MS + 1); // a's lease lapses (Redis outage) ...
    const b = await s.acquireEncodeSlot('b'); // ... and b takes it
    await a!.release();
    await a!.release();
    expect(r.live(`edu:${ENCODE_SLOT_KEY}`)?.value).toBe(b!.holder);
  });
});

describe('transcoder: per-run abort state (two videos in one process)', () => {
  /** Two long-running children, one per run context, through the real exec(). */
  function twoRuns() {
    const t = new HlsTranscoder({} as never, { getOrThrow: () => ({}) } as never, {} as never);
    const x = t as unknown as {
      runs: Set<unknown>;
      runScope: { run: <T>(ctx: unknown, fn: () => T) => T };
      exec: (cmd: string, args: string[]) => Promise<string>;
    };
    const ctx = (videoId: string) => ({ videoId, children: new Set(), aborting: null, superseded: null });
    const a = ctx('vid-a');
    const b = ctx('vid-b');
    x.runs.add(a);
    x.runs.add(b);
    const sleeper = ['-e', 'setTimeout(() => {}, 20000)'];
    const pa = x.runScope.run(a, () => x.exec(process.execPath, sleeper));
    const pb = x.runScope.run(b, () => x.exec(process.execPath, sleeper));
    return { t, a, b, pa, pb };
  }

  it('abortSuperseded(why, video) stops only that video; the other keeps running', async () => {
    const { t, b, pa, pb } = twoRuns();
    await sleep(100);
    t.abortSuperseded('another attempt owns vid-a', 'vid-a');
    await expect(pa).rejects.toBeInstanceOf(TranscodeSupersededError);
    expect(b.children.size).toBe(1); // vid-b's child is still alive
    t.abortActive('disk low', 'vid-b');
    await expect(pb).rejects.toBeInstanceOf(TranscodeDiskPressureError);
  }, 20_000);

  it('the original single-argument API still stops every run (backward compatible)', async () => {
    const { t, pa, pb } = twoRuns();
    await sleep(100);
    t.abortSuperseded('superseded');
    // Both reject together: settle them together (no unhandled rejection in between).
    const [ra, rb] = await Promise.allSettled([pa, pb]);
    expect(ra.status === 'rejected' && ra.reason).toBeInstanceOf(TranscodeSupersededError);
    expect(rb.status === 'rejected' && rb.reason).toBeInstanceOf(TranscodeSupersededError);
  }, 20_000);
});

describe('transcoder: the encode slot covers each rung ffmpeg encode only', () => {
  const VIDEO = 'cmvoverlap01';
  const probe = { durationSeconds: 60, width: 1280, height: 720, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' };
  const cfg = { keyVersion: 'v2', keyRoots: { r1: 'root' }, keyRootId: 'r1', ffmpegPath: 'ffmpeg', segmentSeconds: 6 };

  function pipeline(order: string[], opts: { failEncode?: boolean; source?: typeof probe } = {}) {
    const storage = {
      objectSizeStrict: jest.fn(async () => null),
      putObject: jest.fn(async () => undefined),
      deleteObject: jest.fn(async () => undefined),
      downloadToFile: jest.fn(async () => void order.push('download')),
    };
    const t = new HlsTranscoder(storage as never, { getOrThrow: () => cfg } as never, {} as never);
    const x = t as unknown as Record<string, unknown>;
    x.probe = async () => opts.source ?? probe;
    x.assertFreeSpace = async () => undefined;
    x.writeKeyInfoV2 = async () => ({ keyInfoPath: 'k', keyPath: 'k' });
    x.effectiveThreads = () => 1;
    x.exec = async (_bin: string, args: string[]) => {
      if (opts.failEncode) throw new Error('ffmpeg exited with 1');
      order.push(`encode ${args.find((a) => /scale=/.test(a)) ? 'rung' : '?'}`);
    };
    x.verifyRendition = async () => void order.push('verify');
    x.uploadWithRetry = async (_k: string, fn: () => Promise<unknown>) => fn();
    x.extractThumbnail = async () => null;
    x.uploadRendition = async (_d: string, prefix: string, tier: number) => {
      order.push(`upload ${tier}`);
      return { totalBytes: 1, playlistBytes: 1, segmentCount: 1, firstSegment: { key: `${prefix}${tier}p/seg_000.ts`, bytes: 1 }, lastSegment: { key: `${prefix}${tier}p/seg_000.ts`, bytes: 1 } };
    };
    return (p: Record<string, unknown>) =>
      (t as unknown as { runPipeline: (p: unknown, s: number, prog: () => Promise<void>) => Promise<unknown> }).runPipeline(
        { videoId: VIDEO, sourceKey: 'source/x.mp4', workDir: '/tmp/w', ladder: [480, 720], encrypt: true, ...p },
        1,
        async () => undefined,
      );
  }

  it('download happens before any slot; each slot is released before that rung is verified and uploaded', async () => {
    const order: string[] = [];
    const run = pipeline(order);
    await run({
      acquireEncodeSlot: async () => {
        order.push('acquire');
        return { release: async () => void order.push('release') };
      },
    });
    expect(order[0]).toBe('download');
    const rung = ['acquire', 'encode rung', 'release', 'verify'];
    expect(order.slice(1, 5)).toEqual(rung);
    expect(order[5]).toBe('upload 480');
    expect(order.slice(6, 10)).toEqual(rung);
    expect(order[10]).toBe('upload 720');
    expect(order.filter((o) => o === 'acquire')).toHaveLength(2);
  });

  it('a 480p+720p-only job (TRANSCODE_LADDER=480,720) on a 1080p source: two encodes, two slot takes, no 1080p rung', async () => {
    const order: string[] = [];
    const run = pipeline(order, { source: { ...probe, width: 1920, height: 1080 } });
    const res = (await run({
      ladder: [480, 720],
      acquireEncodeSlot: async () => {
        order.push('acquire');
        return { release: async () => void order.push('release') };
      },
    })) as { renditions: Array<{ height: number }> };
    expect(order.filter((o) => o === 'acquire')).toHaveLength(2);
    expect(order.filter((o) => o === 'release')).toHaveLength(2);
    expect(order.filter((o) => o.startsWith('upload'))).toEqual(['upload 480', 'upload 720']);
    expect(res.renditions.map((r) => r.height)).toEqual([480, 720]);
  });

  it('a slot that cannot be had stops the run before any ffmpeg (the caller defers)', async () => {
    const order: string[] = [];
    const run = pipeline(order);
    await expect(run({ acquireEncodeSlot: async () => Promise.reject(new Error('no slot')) })).rejects.toThrow('no slot');
    expect(order).toEqual(['download']);
  });

  it('the slot is released even when the encode itself fails', async () => {
    const order: string[] = [];
    const release = jest.fn(async () => undefined);
    await expect(pipeline(order, { failEncode: true })({ acquireEncodeSlot: async () => ({ release }) })).rejects.toThrow('ffmpeg exited');
    expect(release).toHaveBeenCalledTimes(1);
    expect(order).not.toContain('upload 480');
  });
});

describe('processor: 2 jobs, 1 encode slot (overlap without a second encode)', () => {
  /** A semaphore standing in for the Redis slots, with an observer of concurrent encodes. */
  function slots(n: number) {
    let held = 0;
    const stats = { maxEncoding: 0, encoding: 0 };
    return {
      stats,
      scheduler: {
        uploadPressure: async () => ({ waiting: 0, ignoredStale: 0, originalQueuePaused: false }),
        acquireEncodeSlot: jest.fn(async (jobId: string) => {
          if (held >= n) return null;
          held += 1;
          let done = false;
          return { holder: jobId, release: async () => { if (!done) { done = true; held -= 1; } } };
        }),
      },
    };
  }

  /** Fake ladder: per rung, ENCODE_MS under the slot, then UPLOAD_MS without it. */
  function transcoderWith(stats: { maxEncoding: number; encoding: number }, timeline: Array<{ v: string; what: string; at: number }>, encodeMs = 60, uploadMs = 60) {
    return {
      preflight: async () => ({ sourceMissing: false, sourceBytes: 1, budgetBytes: 1, assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 } }),
      abortSuperseded: jest.fn(),
      run: jest.fn(async (p: { videoId: string; acquireEncodeSlot?: () => Promise<{ release(): Promise<void> }> }) => {
        timeline.push({ v: p.videoId, what: 'download', at: Date.now() });
        await sleep(uploadMs / 2);
        for (let rung = 0; rung < 2; rung += 1) {
          const slot = await p.acquireEncodeSlot!();
          stats.encoding += 1;
          stats.maxEncoding = Math.max(stats.maxEncoding, stats.encoding);
          timeline.push({ v: p.videoId, what: 'encode', at: Date.now() });
          await sleep(encodeMs);
          stats.encoding -= 1;
          await slot.release();
          timeline.push({ v: p.videoId, what: 'upload', at: Date.now() });
          await sleep(uploadMs);
        }
        return { probe: { durationSeconds: 1, width: 1, height: 1, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' }, renditions: [], hlsPrefix: `hls/${p.videoId}/`, masterPlaylistKey: 'm', isEncrypted: true };
      }),
    };
  }

  function processorWith(transcoder: unknown, scheduler: unknown, cfg: Record<string, unknown> = {}) {
    const videos = {
      async claimMobileProcessing() { return { claimedAt: new Date() }; },
      mobileOwnership: async () => undefined,
      markMobileReady: jest.fn(async () => undefined),
      markMobileFailed: jest.fn(async () => undefined),
      markMobileRetrying: jest.fn(async () => undefined),
      markMobileDeferred: jest.fn(async () => undefined),
    };
    const guard = {
      pauseState: async () => ({ paused: false, reason: null, by: null, at: null }),
      noteActive: jest.fn(), noteProgress: jest.fn(), noteFinished: jest.fn(), noteDeferred: jest.fn(),
    };
    const p = new MobileVideoProcessor(
      transcoder as never,
      videos as never,
      { getOrThrow: () => ({ workDir: '/tmp/t', mobileEncodeSlots: 1, encodeSlotWaitMs: 60_000, ...cfg }) } as never,
      guard as never,
      scheduler as never,
    );
    (p as unknown as { encodeSlotPollMs: number }).encodeSlotPollMs = 5;
    return { p, videos, guard };
  }

  const job = (videoId: string, n = 1) =>
    ({
      id: `mobile-hls:${videoId}:${n}`,
      name: MOBILE_VIDEO_JOBS.transcode,
      attemptsMade: 0,
      opts: { attempts: 2 },
      data: { videoId, sourceKey: `source/${videoId}.mp4`, ladder: [480, 720], encrypt: true, trigger: 'retry' as const },
      updateProgress: jest.fn(async () => undefined),
      updateData: jest.fn(async () => undefined),
      moveToDelayed: jest.fn(async () => undefined),
    }) as unknown as Job<MobileTranscodeJobData>;

  it('two videos at once: never two encodes, and one video uploads while the other encodes', async () => {
    const s = slots(1);
    const timeline: Array<{ v: string; what: string; at: number }> = [];
    const { p } = processorWith(transcoderWith(s.stats, timeline), s.scheduler);
    const started = Date.now();
    await Promise.all([p.process(job('cmva'), 't1'), p.process(job('cmvb'), 't2')]);
    const overlappedWall = Date.now() - started;

    expect(s.stats.maxEncoding).toBe(1);
    // Overlap: while one video uploads, the other's encode has started.
    const uploadsA = timeline.filter((e) => e.v === 'cmva' && e.what === 'upload').map((e) => e.at);
    const encodesB = timeline.filter((e) => e.v === 'cmvb' && e.what === 'encode').map((e) => e.at);
    expect(encodesB.some((b) => uploadsA.some((a) => b >= a && b < a + 60))).toBe(true);

    // Serial reference: the same two jobs one after the other.
    const s2 = slots(1);
    const { p: serial } = processorWith(transcoderWith(s2.stats, []), s2.scheduler);
    const t0 = Date.now();
    await serial.process(job('cmvc'), 't3');
    await serial.process(job('cmvd'), 't4');
    const serialWall = Date.now() - t0;
    expect(overlappedWall).toBeLessThan(serialWall * 0.9);
  }, 20_000);

  it('MOBILE_ENCODE_SLOTS=2 allows two encodes at once, never three', async () => {
    const s = slots(2);
    const { p } = processorWith(transcoderWith(s.stats, []), s.scheduler, { mobileEncodeSlots: 2 });
    await Promise.all(['cmv1', 'cmv2', 'cmv3'].map((v, i) => p.process(job(v), `t${i}`)));
    expect(s.stats.maxEncoding).toBe(2);
    expect(s.scheduler.acquireEncodeSlot).toHaveBeenCalledWith(expect.any(String), 2);
  }, 20_000);

  it('NO DUPLICATES: a second job for a video already running in this process is deferred, not run', async () => {
    const s = slots(1);
    const tr = transcoderWith(s.stats, []);
    const { p, guard } = processorWith(tr, s.scheduler);
    const first = p.process(job('cmvsame', 1), 't1');
    await sleep(5);
    const second = job('cmvsame', 2);
    await expect(p.process(second, 't2')).rejects.toBeInstanceOf(DelayedError);
    expect(second.moveToDelayed).toHaveBeenCalled();
    expect(guard.noteDeferred).toHaveBeenCalledWith('cmvsame', expect.stringContaining('another job for this video'));
    await first;
    expect(tr.run).toHaveBeenCalledTimes(1);
    // Once the first finished, the video is free again.
    await expect(p.process(job('cmvsame', 3), 't3')).resolves.toMatchObject({ videoId: 'cmvsame' });
  }, 20_000);

  it('SUPERSEDED while waiting for the slot: the wait ends at once, nothing is recorded, no slot is taken', async () => {
    const s = slots(0); // never a free slot
    const tr = {
      preflight: async () => ({ sourceMissing: false, sourceBytes: 1, budgetBytes: 1, assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 } }),
      abortSuperseded: jest.fn(),
      run: jest.fn(async (p: { acquireEncodeSlot?: (c: () => string | null) => Promise<unknown> }) => {
        let polls = 0;
        await p.acquireEncodeSlot!(() => (++polls >= 3 ? 'a newer attempt owns the video' : null));
        throw new Error('unreachable');
      }),
    };
    const { p, videos } = processorWith(tr, s.scheduler, { encodeSlotWaitMs: 60 * 60_000 });
    await expect(p.process(job('cmvlost'), 't')).resolves.toMatchObject({ videoId: 'cmvlost', superseded: true });
    expect(videos.markMobileReady).not.toHaveBeenCalled();
    expect(videos.markMobileFailed).not.toHaveBeenCalled();
  });

  it('a deferral for an unavailable slot keeps finished rungs and uses no attempt', async () => {
    const s = slots(0); // never a free slot
    const tr = transcoderWith(s.stats, []);
    const { p, videos } = processorWith(tr, s.scheduler, { encodeSlotWaitMs: 1 });
    const j = job('cmvwait');
    await expect(p.process(j, 't')).rejects.toBeInstanceOf(DelayedError);
    expect(videos.markMobileDeferred).toHaveBeenCalled();
    expect(videos.markMobileFailed).not.toHaveBeenCalled();
    expect(videos.markMobileRetrying).not.toHaveBeenCalled();
  });

  it('defaults: no MOBILE_JOB_CONCURRENCY leaves the BullMQ worker at 1; 2 is applied at bootstrap', () => {
    const s = slots(1);
    const plain = processorWith(transcoderWith(s.stats, []), s.scheduler).p;
    const w1 = { concurrency: 1 };
    Object.defineProperty(plain, 'worker', { get: () => w1 });
    plain.onApplicationBootstrap();
    expect(w1.concurrency).toBe(1);

    const two = processorWith(transcoderWith(s.stats, []), s.scheduler, { mobileJobConcurrency: 2 }).p;
    const w2 = { concurrency: 1 };
    Object.defineProperty(two, 'worker', { get: () => w2 });
    two.onApplicationBootstrap();
    expect(w2.concurrency).toBe(2);
  });
});

describe('configuration defaults and bounds', () => {
  const load = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    jest.isolateModules(() => undefined);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { videoConfig } = require('../../src/config/configuration');
    const cfg = videoConfig();
    process.env = saved;
    return cfg;
  };

  it('unset: 1 job, 1 encode slot, 3 h wait', () => {
    const c = load({ MOBILE_JOB_CONCURRENCY: undefined, MOBILE_ENCODE_SLOTS: undefined, MOBILE_ENCODE_SLOT_WAIT_SECONDS: undefined });
    expect([c.mobileJobConcurrency, c.mobileEncodeSlots, c.encodeSlotWaitMs]).toEqual([1, 1, 3 * 3600 * 1000]);
  });

  it('clamped: concurrency 1..4, slots 1..8, wait >= 60 s', () => {
    const c = load({ MOBILE_JOB_CONCURRENCY: '9', MOBILE_ENCODE_SLOTS: '99', MOBILE_ENCODE_SLOT_WAIT_SECONDS: '5' });
    expect([c.mobileJobConcurrency, c.mobileEncodeSlots, c.encodeSlotWaitMs]).toEqual([4, 8, 60_000]);
  });
});

describe('watchdog: one network blip with two jobs in flight is one incident (WATCHDOG_NETFAIL_CLUSTER_SEC)', () => {
  const ev = (iso: string) => ({ at: iso });

  it('cluster 0 (default): every failure counts, exactly as before', () => {
    expect(wd.countIncidents([ev('2026-11-23T10:00:00Z'), ev('2026-11-23T10:00:05Z'), ev('2026-11-23T10:30:00Z')], 0)).toBe(3);
    expect(wd.loadConfig({}).netfailClusterSec).toBe(0);
  });

  it('cluster 300 s: two jobs failing in the same blip count once; a later blip counts again', () => {
    const events = [ev('2026-11-23T10:00:00Z'), ev('2026-11-23T10:00:07Z'), ev('2026-11-23T10:40:00Z'), ev('2026-11-23T10:41:00Z')];
    expect(wd.countIncidents(events, 300)).toBe(2);
    expect(wd.loadConfig({ WATCHDOG_NETFAIL_CLUSTER_SEC: '300' }).netfailClusterSec).toBe(300);
  });

  it('three separate outages still trip a threshold of 3 with clustering on', () => {
    const events = [ev('2026-11-23T10:00:00Z'), ev('2026-11-23T10:00:01Z'), ev('2026-11-23T10:20:00Z'), ev('2026-11-23T11:00:00Z')];
    expect(wd.countIncidents(events, 300)).toBe(3);
  });

  it('an event without a time is never merged into another incident', () => {
    expect(wd.countIncidents([{ at: null }, ev('2026-11-23T10:00:00Z')], 300)).toBe(2);
  });
});
