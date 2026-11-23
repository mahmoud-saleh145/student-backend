import { Prisma } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { tmpdir } from 'node:os';

import { VideoProcessor } from '../../src/jobs/processors/video.processor';
import { MOBILE_VIDEO_JOBS, VIDEO_JOBS, type TranscodeJobData } from '../../src/jobs/queue.constants';
import type { WithTransientDeferral } from '../../src/jobs/transient-deferral';
import { MOBILE_MAX_STALLED_COUNT } from '../../src/jobs/processors/mobile-video.processor';
import { JOB, controllableTranscoder, jobData, processorFor, world } from './helpers/mobile-claim-world';

/**
 * REAL BullMQ against a LOCAL Redis: a database outage, then a worker crash
 * mid-job and a restart, with the real VideoProcessor.
 *
 * Opt-in, local only:
 *   PIPELINE_RELIABILITY_TEST_REDIS_URL=redis://127.0.0.1:6379 npx jest pipeline-reliability-real-queue
 * Uses its own random key prefix and removes it afterwards; never touches
 * any other key. Refuses a non-local host.
 */
const URL_ = process.env.PIPELINE_RELIABILITY_TEST_REDIS_URL;
const isLocal = (u: string) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(new URL(u).hostname);
const describeReal = URL_ && isLocal(URL_) ? describe : describe.skip;

const VIDEO = 'cmwp0i2sx001rho01ap2is9gu';
const p1001 = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 'test' });

async function until(what: string, check: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

describeReal('real queue: outage deferral, crash and restart (no lost or duplicate job)', () => {
  jest.setTimeout(60_000);
  const prefix = `pipeline-reliability-test-${process.pid}-${Date.now()}`;
  let connection: IORedis;
  let queue: Queue<TranscodeJobData & WithTransientDeferral>;
  const workers: Worker[] = [];
  const connections: IORedis[] = [];

  beforeAll(() => {
    connection = new IORedis(URL_!, { maxRetriesPerRequest: null });
    queue = new Queue('video-processing', { connection, prefix });
  });

  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
    connections.forEach((c) => c.disconnect());
    await queue.obliterate({ force: true }).catch(() => undefined);
    // Belt and braces: remove anything left under this test's own prefix only.
    const keys = await connection.keys(`${prefix}:*`);
    if (keys.length) await connection.del(...keys);
    await queue.close();
    connection.disconnect();
  });

  const track = (c: IORedis) => {
    connections.push(c);
    return c;
  };

  function startWorker(processFromJob: jest.Mock) {
    const videos = { markProcessing: jest.fn(async () => true), markFailed: jest.fn(async () => true), markReady: jest.fn() };
    const processor = new VideoProcessor(
      { run: jest.fn() } as never,
      videos as never,
      { processFromJob } as never,
      { getOrThrow: () => ({ workDir: tmpdir() }) } as never,
    );
    const worker = new Worker(
      'video-processing',
      (job: Job, token?: string) => processor.process(job as never, token),
      { connection: track(new IORedis(URL_!, { maxRetriesPerRequest: null })), prefix, concurrency: 1, lockDuration: 2_000, stalledInterval: 1_000, maxStalledCount: 5 },
    );
    workers.push(worker);
    return { worker, videos };
  }

  it('8/9. defers through the outage with attempts untouched, survives a crash, completes exactly once', async () => {
    const job = await queue.add(
      VIDEO_JOBS.transcode,
      { videoId: VIDEO, sourceKey: 'source/videos/x.mp4', lessonId: null, ladder: [480], encrypt: true } as TranscodeJobData,
      { jobId: `transcode:${VIDEO}:test`, attempts: 2, backoff: { type: 'exponential', delay: 15_000 } },
    );

    // --- the database is unreachable: every run defers, no attempt is used ---
    const down = jest.fn().mockRejectedValue(p1001());
    const w1 = startWorker(down);
    for (let run = 1; run <= 3; run += 1) {
      await until(`deferral ${run}`, async () => (await queue.getJob(job.id!))?.data.transientDeferral?.count === run && (await queue.getJobState(job.id!)) === 'delayed');
      const j = (await queue.getJob(job.id!))!;
      expect(j.attemptsMade).toBe(0);
      expect(await j.getState()).toBe('delayed');
      // Stand in for the passing of time: bring the deferred job forward.
      if (run < 3) await j.promote();
    }
    expect(w1.videos.markFailed).not.toHaveBeenCalled();
    await w1.worker.close();

    // --- the database is back; the worker CRASHES mid-job -------------------
    let releaseHung: (() => void) | undefined;
    const hung = jest.fn(() => new Promise((resolve) => { releaseHung = () => resolve({ handled: true, status: 'ready', playable: true }); }));
    const w2 = startWorker(hung);
    await (await queue.getJob(job.id!))!.promote();
    await until('active on the first worker', async () => (await queue.getJobState(job.id!)) === 'active' && hung.mock.calls.length === 1);
    await w2.worker.close(true); // force: no lock release, like a killed container

    // --- a new worker starts: the stalled job is recovered, once ------------
    const ok = jest.fn(async () => ({ handled: true, status: 'ready', playable: true }));
    startWorker(ok);
    await until('completed after restart', async () => (await queue.getJobState(job.id!)) === 'completed');

    const finished = (await queue.getJob(job.id!))!;
    expect(ok).toHaveBeenCalledTimes(1);
    expect(finished.returnvalue).toMatchObject({ provider: 'gumlet', playable: true });
    // No second job was ever created for this video, and nothing failed.
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed', 'prioritized');
    expect(counts).toEqual({ wait: 0, active: 0, delayed: 0, failed: 0, completed: 1, prioritized: 0 });
    releaseHung?.();
  });
});

describeReal('real queue: the duplicate mobile encode of 2026-11-20 (lock expired during standby)', () => {
  jest.setTimeout(60_000);
  const prefix = `pipeline-reliability-mobile-test-${process.pid}-${Date.now()}`;
  const connections: IORedis[] = [];
  const conn = () => {
    const c = new IORedis(URL_!, { maxRetriesPerRequest: null });
    connections.push(c);
    return c;
  };
  let queue: Queue;
  let worker: Worker | undefined;

  beforeAll(() => {
    queue = new Queue('mobile-video-processing', { connection: conn(), prefix });
  });

  afterAll(async () => {
    await worker?.close(true).catch(() => undefined);
    await queue.obliterate({ force: true }).catch(() => undefined);
    const keys = await connections[0]!.keys(`${prefix}:*`);
    if (keys.length) await connections[0]!.del(...keys);
    await queue.close();
    connections.forEach((c) => c.disconnect());
  });

  it('A encodes while its lock expires, records READY; BullMQ re-delivers the job; it completes WITHOUT a second encode', async () => {
    const w = world();
    const t = controllableTranscoder();
    const proc = processorFor(w.videos, t.transcoder);

    // skipLockRenewal: the lock is never renewed, as on a laptop in standby,
    // so it expires (1 s) while the encode is still running.
    worker = new Worker('mobile-video-processing', (job: Job, token?: string) => proc.process(job as never, token), {
      connection: conn(),
      prefix,
      concurrency: 1,
      lockDuration: 1_000,
      stalledInterval: 500,
      maxStalledCount: 5,
      skipLockRenewal: true,
    });
    worker.on('error', () => undefined); // "Missing lock" when A finishes is expected

    const job = await queue.add(MOBILE_VIDEO_JOBS.transcode, jobData().data, { jobId: JOB, attempts: 2 });

    await until('A is encoding', async () => t.transcoder.run.mock.calls.length === 1);
    // The "standby": wait until BullMQ has declared the job stalled and put it back.
    await until('lock expired and the job handed out again', async () => (await queue.getJobState(job.id!)) === 'waiting');

    // A wakes up and finishes: READY is recorded once.
    t.finish(0);

    await until('the re-delivered job completed', async () => (await queue.getJobState(job.id!)) === 'completed');
    const done = (await queue.getJob(job.id!))!;
    expect(done.returnvalue).toEqual({ videoId: VIDEO, skipped: true }); // the re-delivery stepped aside
    expect(t.transcoder.run).toHaveBeenCalledTimes(1); // ONE encode
    expect(w.row.mobileStatus).toBe('READY');
    expect(w.readyWrites).toHaveLength(1);
    const counts = await queue.getJobCounts('wait', 'active', 'delayed', 'failed', 'completed', 'prioritized');
    expect(counts).toEqual({ wait: 0, active: 0, delayed: 0, failed: 0, completed: 1, prioritized: 0 });
  });
});

describeReal('real queue: a laptop restarted three times mid-encode resumes from rung checkpoints', () => {
  jest.setTimeout(90_000);
  const prefix = `resumable-test-${process.pid}-${Date.now()}`;
  const connections: IORedis[] = [];
  const conn = () => {
    const c = new IORedis(URL_!, { maxRetriesPerRequest: null });
    connections.push(c);
    return c;
  };
  let queue: Queue;
  const workers: Worker[] = [];

  beforeAll(() => {
    queue = new Queue('mobile-video-processing', { connection: conn(), prefix });
  });
  afterAll(async () => {
    await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
    await queue.obliterate({ force: true }).catch(() => undefined);
    const keys = await connections[0]!.keys(`${prefix}:*`);
    if (keys.length) await connections[0]!.del(...keys);
    await queue.close();
    connections.forEach((c) => c.disconnect());
  });

  it('each restart re-encodes only unfinished rungs; one completion; the held job is untouched', async () => {
    const w = world();
    const tiers = [480, 720, 1080];
    const encodes: number[] = [];
    let crashAfter = 1; // the "laptop" dies after this many NEW rungs in a run
    const transcoder = {
      preflight: async () => ({ sourceMissing: false, sourceBytes: 1, budgetBytes: 1, assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 } }),
      abortSuperseded: () => undefined,
      run: async (p: { completedRungs?: Array<{ tier: number }>; onRungCompleted?: (r: unknown) => Promise<void> }) => {
        let fresh = 0;
        for (const tier of tiers) {
          if (p.completedRungs?.some((r) => r.tier === tier)) continue;
          encodes.push(tier);
          await p.onRungCompleted?.({ tier, width: tier * 2, height: tier, bitrateKbps: 1, playlistKey: `hls/${VIDEO}/${tier}p/index.m3u8`, sizeBytes: 1, keyVersion: 'v2', encryptionKeyId: 'k', at: new Date().toISOString() });
          fresh += 1;
          if (crashAfter > 0 && fresh >= crashAfter) await new Promise(() => undefined); // power cut: never returns
        }
        return {
          probe: { durationSeconds: 60, width: 2160, height: 1080, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
          renditions: tiers.map((t) => ({ height: t, width: t * 2, bitrateKbps: 1, playlistKey: `hls/${VIDEO}/${t}p/index.m3u8`, sizeBytes: 1 })),
          hlsPrefix: `hls/${VIDEO}/`,
          masterPlaylistKey: `hls/${VIDEO}/master.m3u8`,
          isEncrypted: true,
          encryptionKeyId: 'k',
        };
      },
    };
    const startWorker = () => {
      // A restart is a NEW process: fresh processor state (the in-process
      // per-video guard of the run that "lost power" died with it).
      const proc = processorFor(w.videos, transcoder);
      const worker = new Worker('mobile-video-processing', (job: Job, token?: string) => proc.process(job as never, token), {
        connection: conn(), prefix, concurrency: 1, lockDuration: 1_000, stalledInterval: 500, maxStalledCount: MOBILE_MAX_STALLED_COUNT,
      });
      worker.on('error', () => undefined);
      workers.push(worker);
      return worker;
    };

    // A historically HELD job (parked ten years out), which must never move.
    const held = await queue.add(MOBILE_VIDEO_JOBS.transcode, { videoId: 'cmvheld000', sourceKey: 'source/held.mp4', ladder: [480], encrypt: true, trigger: 'migration' }, { jobId: 'mobile-hls:cmvheld000:1', delay: 10 * 365 * 24 * 3600_000 });
    const job = await queue.add(MOBILE_VIDEO_JOBS.transcode, jobData().data, { jobId: JOB, attempts: 2 });

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      crashAfter = cycle < 3 ? 1 : 0; // runs 1 and 2 die after one new rung; run 3 finishes
      const worker = startWorker();
      if (cycle < 3) {
        await until(`rung ${cycle} encoded`, async () => encodes.length === cycle);
        await worker.close(true); // shutdown: no completion, lock left to expire
      }
    }
    await until('completed after the third start', async () => (await queue.getJobState(job.id!)) === 'completed', 40_000);

    expect(encodes).toEqual([480, 720, 1080]); // every rung encoded exactly once
    const done = (await queue.getJob(job.id!))!;
    expect(done.attemptsMade).toBeLessThanOrEqual(1);
    expect(w.row.mobileStatus).toBe('READY');
    expect(w.readyWrites).toHaveLength(1);
    const h = (await queue.getJob(held.id!))!;
    expect(await h.getState()).toBe('delayed');
    expect(h.attemptsMade).toBe(0);
    const counts = await queue.getJobCounts('wait', 'active', 'failed', 'completed');
    expect(counts).toEqual({ wait: 0, active: 0, failed: 0, completed: 1 });
  });
});
