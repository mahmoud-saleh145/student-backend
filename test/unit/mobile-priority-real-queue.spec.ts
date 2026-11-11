import { Logger } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';

import { MobileEncodeScheduler } from '../../src/jobs/processors/mobile-encode-scheduler';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { ScratchGuard } from '../../src/jobs/processors/scratch-guard';
import {
  MOBILE_JOB_PRIORITY,
  MOBILE_VIDEO_JOBS,
  QUEUE_NAMES,
  VIDEO_JOBS,
  type MobileTranscodeJobData,
} from '../../src/jobs/queue.constants';
import { RedisService } from '../../src/redis/redis.service';

/**
 * CONTROLLED TEST of "new uploads before historical mobile HLS work" on REAL
 * BullMQ queues and workers against a LOCAL Redis. Only ffmpeg and the database
 * writes are faked; the processor, the cross-queue scheduler, the encode slot,
 * the pause flag and BullMQ's own ordering are the production code.
 *
 * Runs only when PRIORITY_TEST_REDIS_URL points at a local Redis; every key
 * lives under a throw-away prefix that is removed afterwards.
 */
const REDIS_URL = process.env.PRIORITY_TEST_REDIS_URL;
const enabled = (() => {
  if (!REDIS_URL) return false;
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(REDIS_URL).hostname)) {
    throw new Error('PRIORITY_TEST_REDIS_URL must point at a LOCAL Redis');
  }
  return true;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 20_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

type Encode = { videoId: string; trigger: string; start: number; end?: number };

(enabled ? describe : describe.skip)('upload priority on real BullMQ queues (local Redis)', () => {
  const prefix = `edutest-prio-${Date.now()}`;
  const connection = (() => {
    const u = new URL(REDIS_URL ?? 'redis://localhost:6379');
    return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null, enableReadyCheck: false };
  })();
  const bull = { connection, prefix: `${prefix}:bull` };

  let redis: RedisService;
  let original: Queue;
  let mobile: Queue<MobileTranscodeJobData>;
  const workers: Worker[] = [];
  const encodes: Encode[] = [];
  let running = 0;
  let maxRunning = 0;
  /** When each original job was TAKEN by its worker (left the wait list) and finished. */
  const originalDone: Array<{ id: string; startedAt: number; at: number }> = [];
  /** How long the fake encode of a given video takes (default 150 ms). */
  const encodeMs = new Map<string, number>();

  /** A worker process: its own scheduler, guard and processor (like a second container). */
  function startMobileWorker(): Worker {
    const config = {
      getOrThrow: () => ({ workDir: `/tmp/${prefix}`, minFreeBytes: 0, diskCheckSeconds: 15 }),
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
      run: async ({ videoId }: { videoId: string }) => {
        const rec: Encode = { videoId, trigger: '', start: Date.now() };
        encodes.push(rec);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(encodeMs.get(videoId) ?? 150);
        running -= 1;
        rec.end = Date.now();
        return {
          probe: { durationSeconds: 1, width: 640, height: 360, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
          renditions: [],
          hlsPrefix: `hls/${videoId}/`,
          masterPlaylistKey: `hls/${videoId}/master.m3u8`,
          thumbnailKey: undefined,
          isEncrypted: true,
        };
      },
    };
    const videos = {
      markMobileProcessing: async () => true,
      markMobileReady: async () => undefined,
      markMobileFailed: async () => undefined,
      markMobileDeferred: async () => undefined,
    };
    const processor = new MobileVideoProcessor(transcoder as never, videos as never, config as never, guard, scheduler);
    (processor as unknown as { deferMs: Record<string, number> }).deferMs = { paused: 200, uploads: 200, disk: 200, slot: 200 };
    const w = new Worker(
      QUEUE_NAMES.mobileVideo,
      async (job: Job<MobileTranscodeJobData>, token?: string) => {
        const r = await processor.process(job, token);
        const last = encodes.filter((e) => e.videoId === job.data.videoId).at(-1);
        if (last) last.trigger = job.data.trigger;
        return r;
      },
      { ...bull, concurrency: 1 },
    );
    workers.push(w);
    return w;
  }

  function startOriginalWorker(ms = 300): Worker {
    const w = new Worker(
      QUEUE_NAMES.video,
      async (job: Job) => {
        const startedAt = Date.now();
        await sleep(ms);
        originalDone.push({ id: String(job.id), startedAt, at: Date.now() });
        return { ok: true };
      },
      { ...bull, concurrency: 1 },
    );
    workers.push(w);
    return w;
  }

  const addMobile = (videoId: string, trigger: MobileTranscodeJobData['trigger']) =>
    mobile.add(
      MOBILE_VIDEO_JOBS.transcode,
      { videoId, sourceKey: `source/${videoId}.mp4`, ladder: [360], encrypt: true, trigger },
      {
        jobId: `mobile-hls:${videoId}:${Date.now()}`,
        attempts: 2,
        removeOnComplete: false,
        ...(MOBILE_JOB_PRIORITY[trigger] ? { priority: MOBILE_JOB_PRIORITY[trigger] } : {}),
      },
    );
  const addUpload = (videoId: string, opts: Record<string, unknown> = {}) =>
    original.add(VIDEO_JOBS.transcode, { videoId }, { jobId: `transcode:${videoId}:${Date.now()}`, ...opts });
  const encodeOf = (videoId: string) => encodes.find((e) => e.videoId === videoId);

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    redis = new RedisService({ getOrThrow: () => ({ url: REDIS_URL, prefix }) } as never);
    await redis.onModuleInit();
    original = new Queue(QUEUE_NAMES.video, bull);
    mobile = new Queue(QUEUE_NAMES.mobileVideo, bull);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true)));
    await original.obliterate({ force: true });
    await mobile.obliterate({ force: true });
    await original.resume();
    await redis.delByPattern('*');
    encodes.length = 0;
    originalDone.length = 0;
    encodeMs.clear();
    running = 0;
    maxRunning = 0;
  });

  afterAll(async () => {
    await original.close();
    await mobile.close();
    await redis.delByPattern('*');
    await redis.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('a new upload goes first: historical HLS waits until the original queue has no fresh upload left', async () => {
    await addUpload('new_upload_A');
    await addMobile('hist_1', 'migration');
    await addMobile('hist_2', 'migration');
    await addMobile('new_upload_A', 'upload'); // the new upload's own mobile job

    startMobileWorker();
    // The upload's own mobile job is taken first (no priority beats prioritized)...
    await until(() => !!encodeOf('new_upload_A')?.end, 10_000, 'the upload mobile job');
    // ...and historical work does not start while the upload waits in the original queue.
    await sleep(1_500);
    expect(encodeOf('hist_1')).toBeUndefined();
    expect(encodeOf('hist_2')).toBeUndefined();

    startOriginalWorker(300);
    await until(() => !!encodeOf('hist_1')?.end && !!encodeOf('hist_2')?.end, 20_000, 'historical encodes');

    // The rule is about WAITING uploads: historical work starts only once the
    // upload has been taken by its worker (an active Gumlet ingest is polling).
    const uploadTaken = originalDone[0].startedAt;
    expect(encodeOf('hist_1')!.start).toBeGreaterThanOrEqual(uploadTaken);
    expect(encodeOf('hist_2')!.start).toBeGreaterThanOrEqual(uploadTaken);
    expect(encodes[0].videoId).toBe('new_upload_A');
    expect(maxRunning).toBe(1);
  }, 60_000);

  it('a running encode is never interrupted; only the NEXT historical job waits', async () => {
    encodeMs.set('hist_long', 1_500);
    await addMobile('hist_long', 'migration');
    await addMobile('hist_next', 'migration');
    startMobileWorker();
    await until(() => !!encodeOf('hist_long'), 10_000, 'first encode to start');

    await addUpload('new_upload_B'); // arrives mid-encode
    await until(() => !!encodeOf('hist_long')?.end, 10_000, 'running encode to finish');
    expect(encodeOf('hist_long')!.end! - encodeOf('hist_long')!.start).toBeGreaterThanOrEqual(1_400);

    await sleep(1_000);
    expect(encodeOf('hist_next')).toBeUndefined(); // waiting for the upload

    startOriginalWorker(200);
    await until(() => !!encodeOf('hist_next')?.end, 15_000, 'next historical encode');
    expect(encodeOf('hist_next')!.start).toBeGreaterThanOrEqual(originalDone[0].startedAt);
  }, 60_000);

  it('cannot starve: a delayed upload retry and a PAUSED original queue do not hold HLS back', async () => {
    await addUpload('retrying_upload', { delay: 60_000 }); // backoff after a failure
    await addMobile('hist_a', 'migration');
    startMobileWorker();
    await until(() => !!encodeOf('hist_a')?.end, 10_000, 'encode despite a delayed upload');

    await original.pause(); // operator paused the ORIGINAL pipeline
    await addUpload('upload_while_paused');
    await addMobile('hist_b', 'migration');
    await until(() => !!encodeOf('hist_b')?.end, 10_000, 'encode despite a paused original queue');
  }, 60_000);

  it('two worker processes never encode at the same time (one shared slot)', async () => {
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      encodeMs.set(id, 300);
      await addMobile(id, 'migration');
    }
    startMobileWorker();
    startMobileWorker(); // a second container on the same Redis
    await until(() => encodes.filter((e) => e.end).length === 5, 30_000, 'five encodes');
    expect(maxRunning).toBe(1);
    const sorted = [...encodes].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i += 1) expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end!);
  }, 60_000);

  it('the mobile pause flag stops new encodes without touching the original queue', async () => {
    await redis.setJsonPersistent('mobile:transcode:paused', { reason: 'test', by: 'test', at: new Date().toISOString() });
    await addMobile('new_upload_C', 'upload');
    startMobileWorker();
    startOriginalWorker(50);
    await addUpload('new_upload_C');

    await until(() => originalDone.length === 1, 10_000, 'original upload to process while mobile is paused');
    await sleep(800);
    expect(encodes).toHaveLength(0);

    await redis.del('mobile:transcode:paused');
    await until(() => !!encodeOf('new_upload_C')?.end, 10_000, 'mobile encode after resume');
  }, 60_000);
});
