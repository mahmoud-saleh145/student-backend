import { Prisma } from '@prisma/client';
import { Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { tmpdir } from 'node:os';

import { VideoProcessor } from '../../src/jobs/processors/video.processor';
import { VIDEO_JOBS, type TranscodeJobData } from '../../src/jobs/queue.constants';
import type { WithTransientDeferral } from '../../src/jobs/transient-deferral';

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
