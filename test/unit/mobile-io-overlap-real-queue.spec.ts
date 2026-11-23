import { Logger } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';

import { MobileEncodeScheduler } from '../../src/jobs/processors/mobile-encode-scheduler';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { ScratchGuard } from '../../src/jobs/processors/scratch-guard';
import { MOBILE_VIDEO_JOBS, QUEUE_NAMES, type MobileTranscodeJobData } from '../../src/jobs/queue.constants';
import { RedisService } from '../../src/redis/redis.service';

/**
 * "2 jobs, 1 encode slot" on REAL BullMQ queues and the REAL encode-slot leases,
 * against a LOCAL Redis. Two worker "processes" (each its own processor,
 * scheduler and guard, as two containers would have), each with BullMQ
 * concurrency 2. Only ffmpeg/R2 (timed sleeps) and the database are faked.
 *
 * Runs only when IO_OVERLAP_TEST_REDIS_URL points at a local Redis; every key
 * is under a throwaway prefix that is deleted afterwards.
 */
const REDIS_URL = process.env.IO_OVERLAP_TEST_REDIS_URL;
const enabled = (() => {
  if (!REDIS_URL) return false;
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(REDIS_URL).hostname)) {
    throw new Error('IO_OVERLAP_TEST_REDIS_URL must point at a LOCAL Redis');
  }
  return true;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, ms = 30_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

type Phase = { videoId: string; jobId: string; what: 'encode' | 'upload'; start: number; end: number };

(enabled ? describe : describe.skip)('2 jobs / 1 encode slot on real BullMQ queues (local Redis)', () => {
  const prefix = `edutest-overlap-${Date.now()}`;
  const connection = (() => {
    const u = new URL(REDIS_URL ?? 'redis://localhost:6379');
    return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null, enableReadyCheck: false };
  })();
  const bull = { connection, prefix: `${prefix}:bull` };

  let redis: RedisService;
  let original: Queue;
  let mobile: Queue<MobileTranscodeJobData>;
  const workers: Worker[] = [];
  const phases: Phase[] = [];
  const ready: string[] = [];
  let encoding = 0;
  let maxEncoding = 0;
  const failOnce = new Set<string>();

  /** Phase timings of the fake ladder (ms). The benchmark swaps in the measured laptop profile. */
  const DEFAULT_PROFILE = { downloadMs: 60, encodeMs: [120, 120], uploadMs: [120, 120] };
  let profile = DEFAULT_PROFILE;

  function startProcess(jobConcurrency: number, slots = 1): Worker {
    const config = {
      getOrThrow: () => ({
        workDir: `/tmp/${prefix}`,
        minFreeBytes: 0,
        diskCheckSeconds: 15,
        mobileJobConcurrency: jobConcurrency,
        mobileEncodeSlots: slots,
        encodeSlotWaitMs: 60_000,
      }),
    };
    const guard = new ScratchGuard(redis, config as never);
    const scheduler = new MobileEncodeScheduler(original as never, redis);
    const transcoder = {
      preflight: async () => ({
        sourceMissing: false,
        sourceBytes: 1,
        budgetBytes: 1,
        assessment: { ok: true, freeBytes: 1e12, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 },
      }),
      abortSuperseded: () => undefined,
      run: async (p: { videoId: string; acquireEncodeSlot?: () => Promise<{ release(): Promise<void> }> }) => {
        await sleep(profile.downloadMs); // download
        for (let rung = 0; rung < profile.encodeMs.length; rung += 1) {
          const slot = await p.acquireEncodeSlot!();
          encoding += 1;
          maxEncoding = Math.max(maxEncoding, encoding);
          const e: Phase = { videoId: p.videoId, jobId: '', what: 'encode', start: Date.now(), end: 0 };
          try {
            await sleep(profile.encodeMs[rung]!);
          } finally {
            encoding -= 1;
            e.end = Date.now();
            phases.push(e);
            await slot.release();
          }
          if (failOnce.delete(p.videoId)) throw new Error('getaddrinfo ENOTFOUND r2 (simulated blip)');
          const u: Phase = { videoId: p.videoId, jobId: '', what: 'upload', start: Date.now(), end: 0 };
          await sleep(profile.uploadMs[rung]!);
          u.end = Date.now();
          phases.push(u);
        }
        return {
          probe: { durationSeconds: 1, width: 640, height: 360, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
          renditions: [],
          hlsPrefix: `hls/${p.videoId}/`,
          masterPlaylistKey: `hls/${p.videoId}/master.m3u8`,
          isEncrypted: true,
        };
      },
    };
    const videos = {
      async claimMobileProcessing() {
        return { claimedAt: new Date() };
      },
      mobileOwnership: async () => undefined,
      markMobileReady: async (videoId: string) => void ready.push(videoId),
      markMobileFailed: async () => undefined,
      markMobileRetrying: async () => undefined,
      markMobileDeferred: async () => undefined,
    };
    const processor = new MobileVideoProcessor(transcoder as never, videos as never, config as never, guard, scheduler, mobile);
    const internals = processor as unknown as { deferMs: Record<string, number>; encodeSlotPollMs: number };
    internals.deferMs = { paused: 200, uploads: 200, disk: 200, slot: 200 };
    internals.encodeSlotPollMs = 20;
    const w = new Worker(QUEUE_NAMES.mobileVideo, (job: Job<MobileTranscodeJobData>, token?: string) => processor.process(job as never, token), {
      ...bull,
      concurrency: 1,
    });
    // Exactly what the processor does at bootstrap with MOBILE_JOB_CONCURRENCY.
    Object.defineProperty(processor, 'worker', { get: () => w });
    processor.onApplicationBootstrap();
    w.on('error', () => undefined);
    workers.push(w);
    return w;
  }

  const add = (videoId: string, n = 1) =>
    mobile.add(
      MOBILE_VIDEO_JOBS.transcode,
      { videoId, sourceKey: `source/${videoId}.mp4`, ladder: [360], encrypt: true, trigger: 'retry' },
      { jobId: `mobile-hls:${videoId}:p1g${n}`, attempts: 2, backoff: { type: 'fixed', delay: 100 }, removeOnComplete: false },
    );

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    redis = new RedisService({ getOrThrow: () => ({ url: REDIS_URL, prefix }) } as never);
    await redis.onModuleInit();
    original = new Queue(QUEUE_NAMES.video, bull);
    mobile = new Queue(QUEUE_NAMES.mobileVideo, bull);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true)));
    await mobile.obliterate({ force: true });
    await redis.delByPattern('*');
    phases.length = 0;
    ready.length = 0;
    encoding = 0;
    maxEncoding = 0;
    failOnce.clear();
    profile = DEFAULT_PROFILE;
  });

  afterAll(async () => {
    await original.close();
    await mobile.close();
    await redis.delByPattern('*');
    await redis.onModuleDestroy();
    jest.restoreAllMocks();
  });

  async function runBatch(n: number): Promise<number> {
    const started = Date.now();
    for (let i = 0; i < n; i += 1) await add(`cmvbatch${i}`);
    await until(async () => (await mobile.getJobCounts('completed')).completed === n, 60_000, `${n} completed`);
    return Date.now() - started;
  }

  it('two processes x 2 jobs, 1 slot: never two encodes anywhere; every video READY exactly once; faster than 1 job', async () => {
    startProcess(1);
    const serial = await runBatch(4);
    expect(maxEncoding).toBe(1);
    await Promise.all(workers.splice(0).map((w) => w.close(true)));
    await mobile.obliterate({ force: true });
    ready.length = 0;
    phases.length = 0;
    maxEncoding = 0;

    startProcess(2);
    startProcess(2);
    const overlapped = await runBatch(4);

    expect(maxEncoding).toBe(1); // the slot is global: 4 jobs in flight, still one encode
    expect([...ready].sort()).toEqual(['cmvbatch0', 'cmvbatch1', 'cmvbatch2', 'cmvbatch3']); // once each
    const counts = await mobile.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed');
    expect(counts).toEqual({ wait: 0, active: 0, delayed: 0, failed: 0, completed: 4 });
    // Some upload of one video ran while another video encoded.
    const enc = phases.filter((p) => p.what === 'encode');
    const up = phases.filter((p) => p.what === 'upload');
    expect(up.some((u) => enc.some((e) => e.videoId !== u.videoId && e.start < u.end && u.start < e.end))).toBe(true);
    expect(overlapped).toBeLessThan(serial * 0.85);
  }, 120_000);

  it('a failed attempt (network blip after an encode) retries once and still finishes once; the slot is not leaked', async () => {
    startProcess(2);
    failOnce.add('cmvblip');
    await add('cmvblip');
    await add('cmvother');
    await until(async () => (await mobile.getJobCounts('completed')).completed === 2, 60_000, 'both completed');
    const blip = (await mobile.getJob('mobile-hls:cmvblip:p1g1'))!;
    // BullMQ 5 counts the successful attempt too: one failed + one successful = 2 of 2.
    expect(blip.attemptsMade).toBe(2);
    expect(blip.failedReason).toMatch(/ENOTFOUND/);
    expect(ready.filter((v) => v === 'cmvblip')).toHaveLength(1);
    expect(maxEncoding).toBe(1);
    expect(await redis.client.get(redis.key('mobile:transcode:slot'))).toBeNull(); // released
  }, 90_000);

  it('two generations of one video queued together in one process: never run side by side', async () => {
    startProcess(2);
    await add('cmvdup', 1);
    await add('cmvdup', 2);
    await until(async () => (await mobile.getJobCounts('completed')).completed === 2, 60_000, 'both generations completed');
    const encodes = phases.filter((p) => p.videoId === 'cmvdup' && p.what === 'encode').sort((a, b) => a.start - b.start);
    // 2 generations x 2 rungs, strictly one after another (no overlap of the same video)
    expect(encodes).toHaveLength(4);
    const runs = [encodes.slice(0, 2), encodes.slice(2)];
    expect(runs[1]![0]!.start).toBeGreaterThanOrEqual(runs[0]![1]!.end);
  }, 90_000);

  /**
   * BENCHMARK (opt-in: IO_OVERLAP_BENCH=1). The measured laptop profile of a
   * 1080p lecture (Chemistry A lesson 6, 2026-11-23: download 7.3 min, encode
   * ~28 min, upload ~15 min at ~0.34 MB/s), scaled 1 min = 10 ms, split per rung
   * by encode cost and output bytes (480p ~20/17 %, 720p ~30/30 %, 1080p ~50/53 %).
   * Encodes never overlap (1 slot), so CPU use is the same as today; only the
   * network phases overlap. A model of the laptop, not a hardware measurement.
   */
  (process.env.IO_OVERLAP_BENCH ? it : it.skip)('benchmark: 8 lectures, 1 job vs 2 jobs (1 slot)', async () => {
    profile = { downloadMs: 73, encodeMs: [56, 84, 140], uploadMs: [26, 45, 79] };
    const results: Record<string, number> = {};
    for (const [label, procs, conc] of [['1 job (today)', 1, 1], ['2 jobs, 1 slot', 1, 2], ['3 jobs, 1 slot', 1, 3]] as const) {
      for (let i = 0; i < procs; i += 1) startProcess(conc);
      results[label] = await runBatch(8);
      expect(maxEncoding).toBe(1);
      await Promise.all(workers.splice(0).map((w) => w.close(true)));
      await mobile.obliterate({ force: true });
      ready.length = 0;
      phases.length = 0;
      maxEncoding = 0;
    }
    const base = results['1 job (today)']!;
    const lines = Object.entries(results).map(
      ([k, ms]) => `${k}: ${ms} ms for 8 lectures = ${((8 * 600) / ms).toFixed(2)} lectures per simulated hour (1 h = 600 ms), x${(base / ms).toFixed(2)}`,
    );
    console.log(['IO_OVERLAP_BENCH', ...lines].join(String.fromCharCode(10)));
  }, 180_000);
});
