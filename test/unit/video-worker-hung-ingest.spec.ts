import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UnrecoverableError, type Job } from 'bullmq';

import { databaseOperationTimeout } from 'src/database/bounded-operations';
import { VIDEO_JOBS, type TranscodeJobData } from 'src/jobs/queue.constants';
import {
  GUMLET_INGEST_JOB_DEADLINE_MS,
  GumletIngestStalledError,
  settleWithin,
  VideoProcessor,
} from 'src/jobs/processors/video.processor';
import { GumletCreationOutcomeUnknownError } from 'src/modules/playback/gumlet-drm.service';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => [] as string[]),
  readFile: jest.fn(async () => Buffer.alloc(0)),
  stat: jest.fn(async () => ({ size: 10 })),
  writeFile: jest.fn(async () => undefined),
}));

/**
 * THE INCIDENT THIS REPRODUCES (production, 2026-11-10 → 11, twice)
 *
 * Job `transcode:cmwb2r0uv01u4f101wjdbegq9:…` logged "adopted by Gumlet … (status
 * pre-queued)" and then nothing else: no result, no poll-budget timeout, none of
 * the database-retry warnings. Its promise never settled. The worker kept
 * renewing the job's 30-minute lock, so BullMQ's stalled check never reclaimed
 * it, and with `concurrency: 1` the uploads queued after it waited 11.5 hours.
 * The next morning job `transcode:cmwb6uq9x…` did exactly the same thing, right
 * after a Neon connection drop.
 *
 * The cause is a Prisma query on a silently dead connection (see
 * prisma-dead-connection.spec.ts). This file covers the worker's backstop:
 *   - a hung ingest frees the slot at a fixed deadline;
 *   - the ingest is aborted, so if it ever resumes it cannot write;
 *   - the job is NOT retried automatically (a retry is the one path that could
 *     create a second billable Gumlet asset);
 *   - the row is not stamped FAILED (the asset may be fine; the sweep resumes it).
 */

function harness(processFromJob: jest.Mock) {
  const videos = {
    markProcessing: jest.fn(async () => true),
    markReady: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => true),
  };
  const processor = new VideoProcessor(
    { run: jest.fn() } as never,
    videos as never,
    { processFromJob } as never,
    {
      getOrThrow: () => ({ workDir: '/tmp/work', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', keyRoot: 'k', segmentSeconds: 4 }),
    } as never,
  );
  return { processor, videos };
}

function job(videoId = 'v1', attemptsMade = 0): Job<TranscodeJobData> {
  return {
    name: VIDEO_JOBS.transcode,
    id: `transcode:${videoId}:1`,
    attemptsMade,
    opts: { attempts: 2 },
    data: { videoId, sourceKey: 'key', lessonId: null, courseId: 'c1', ladder: [720], encrypt: true },
    updateProgress: jest.fn(async () => undefined),
  } as unknown as Job<TranscodeJobData>;
}

/** The signal the processor handed to processFromJob on its n-th call. */
function signalOf(processFromJob: jest.Mock, call = 0): AbortSignal {
  return (processFromJob.mock.calls[call][2] as { signal: AbortSignal }).signal;
}

describe('job deadline expiry (a Gumlet ingest that never settles)', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    jest.useFakeTimers();
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('releases the queue slot at the deadline instead of holding it forever', async () => {
    const processFromJob = jest.fn(() => new Promise<never>(() => undefined));
    const t = harness(processFromJob);

    const outcome = t.processor.process(job()).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    // Just short of the deadline the job is still running...
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS - 1_000);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(signalOf(processFromJob).aborted).toBe(false);

    // ...and at the deadline it gives the slot back.
    await jest.advanceTimersByTimeAsync(2_000);
    const error = await outcome;
    expect((error as Error).message).toContain('v1');
    expect((error as Error).message).toContain('transcode:v1:1');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('ends the job WITHOUT an automatic retry, so a hang cannot lead to a second asset', async () => {
    const t = harness(jest.fn(() => new Promise<never>(() => undefined)));
    const outcome = t.processor.process(job()).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);

    // BullMQ moves an UnrecoverableError straight to `failed`, whatever `attempts` says.
    expect(await outcome).toBeInstanceOf(UnrecoverableError);
  });

  it('aborts the ingest, so the abandoned call stops writing', async () => {
    const processFromJob = jest.fn(() => new Promise<never>(() => undefined));
    const t = harness(processFromJob);
    const outcome = t.processor.process(job()).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);
    await outcome;

    expect(signalOf(processFromJob).aborted).toBe(true);
  });

  it('does not stamp the video FAILED: the asset may be healthy and the sweep resumes it', async () => {
    const t = harness(jest.fn(() => new Promise<never>(() => undefined)));
    const outcome = t.processor.process(job()).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);
    await outcome;

    expect(t.videos.markFailed).not.toHaveBeenCalled();
    expect(t.videos.markReady).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('without an automatic retry'));
  });

  it('sits well beyond the ingest poll budget, so a slow but healthy ingest is never cut off', () => {
    // processFromJob polls for at most 20 minutes; the deadline only catches a hang.
    expect(GUMLET_INGEST_JOB_DEADLINE_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });
});

describe('late promise resolution after the deadline', () => {
  let unhandled: unknown[];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  beforeEach(() => {
    unhandled = [];
    process.on('unhandledRejection', onUnhandled);
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.off('unhandledRejection', onUnhandled);
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a late SUCCESS changes nothing: the job already failed and nothing is marked', async () => {
    let finish!: (v: unknown) => void;
    const t = harness(jest.fn(() => new Promise((r) => (finish = r))));
    const outcome = t.processor.process(job()).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);
    expect(await outcome).toBeInstanceOf(UnrecoverableError);

    finish({ handled: true, status: 'ready', playable: true });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(t.videos.markReady).not.toHaveBeenCalled();
    expect(t.videos.markFailed).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });

  it('a late FAILURE is absorbed: no unhandled rejection, no FAILED stamp', async () => {
    let fail!: (e: unknown) => void;
    const t = harness(jest.fn(() => new Promise((_, r) => (fail = r))));
    const outcome = t.processor.process(job()).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);
    expect(await outcome).toBeInstanceOf(UnrecoverableError);

    // What an abandoned ingest throws when it next checks its signal, or the
    // bounded P1008 its hung query finally produces.
    fail(databaseOperationTimeout('Video.findFirst', 60_000));
    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(t.videos.markFailed).not.toHaveBeenCalled();
    expect(unhandled).toEqual([]);
  });
});

describe('the healthy path and ordinary failures are unchanged', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('leaves the healthy path untouched and leaks no timer', async () => {
    const processFromJob = jest.fn(async () => ({ handled: true, status: 'ready', playable: true }));
    const t = harness(processFromJob);

    await expect(t.processor.process(job())).resolves.toEqual({
      videoId: 'v1',
      provider: 'gumlet',
      status: 'ready',
      playable: true,
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(signalOf(processFromJob).aborted).toBe(false);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('still reports a real ingest failure as before (not as a stall)', async () => {
    const boom = new Error('Gumlet refused the asset');
    const t = harness(jest.fn().mockRejectedValue(boom));

    await expect(t.processor.process(job())).rejects.toBe(boom);
    expect(t.videos.markFailed).toHaveBeenCalledWith('v1', 'Gumlet refused the asset');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('a bounded database timeout (P1008) is a retryable outage, not a verdict', async () => {
    const timeout = databaseOperationTimeout('Video.findFirst', 60_000);
    const t = harness(jest.fn().mockRejectedValue(timeout));

    const error = await t.processor.process(job()).catch((e: unknown) => e);

    // Re-thrown as itself (BullMQ retries it with backoff), never as Unrecoverable.
    expect(error).toBe(timeout);
    expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });
});

describe('a Gumlet create request whose answer never arrived', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('is not retried automatically, and the row says which Gumlet tag to check first', async () => {
    const unknown = new GumletCreationOutcomeUnknownError(['edu-video:v1'], 'TimeoutError');
    const t = harness(jest.fn().mockRejectedValue(unknown));

    const error = await t.processor.process(job()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect(t.videos.markFailed).toHaveBeenCalledWith('v1', expect.stringContaining('edu-video:v1'));
    expect(t.videos.markFailed).toHaveBeenCalledWith('v1', expect.stringContaining('check Gumlet before retrying'));
  });
});

describe('the queue continues after a failure (concurrency 1)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('a hung job, then a database blip, then healthy jobs: every later job runs', async () => {
    // One worker slot: each job starts only once the previous one settled.
    const processFromJob = jest
      .fn()
      .mockImplementationOnce(() => new Promise<never>(() => undefined)) // hangs
      .mockRejectedValueOnce(databaseOperationTimeout('Video.findFirst', 60_000)) // blip
      .mockResolvedValue({ handled: true, status: 'ready', playable: true });
    const t = harness(processFromJob);

    const first = t.processor.process(job('v1')).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);
    expect(await first).toBeInstanceOf(UnrecoverableError);

    expect(await t.processor.process(job('v2')).catch((e: unknown) => e)).toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
    await expect(t.processor.process(job('v3'))).resolves.toMatchObject({ videoId: 'v3', playable: true });
    await expect(t.processor.process(job('v4'))).resolves.toMatchObject({ videoId: 'v4', playable: true });
    expect(jest.getTimerCount()).toBe(0);
  }, 30_000);
});

describe('settleWithin', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes a value through, clears its timer and never calls onTimeout', async () => {
    const onTimeout = jest.fn();
    await expect(settleWithin(Promise.resolve(7), 1_000, 'x', onTimeout)).resolves.toBe(7);
    expect(jest.getTimerCount()).toBe(0);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it('passes a rejection through unchanged and clears its timer', async () => {
    const e = new Error('original');
    await expect(settleWithin(Promise.reject(e), 1_000, 'x')).rejects.toBe(e);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('calls onTimeout before rejecting with GumletIngestStalledError', async () => {
    const order: string[] = [];
    const raced = settleWithin(new Promise<never>(() => undefined), 1_000, 'stalled', () =>
      order.push('onTimeout'),
    ).catch((e: unknown) => {
      order.push('rejected');
      return e;
    });
    await jest.advanceTimersByTimeAsync(1_000);

    expect(await raced).toBeInstanceOf(GumletIngestStalledError);
    expect(order).toEqual(['onTimeout', 'rejected']);
  });
});
