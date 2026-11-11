import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';

import { VIDEO_JOBS, type TranscodeJobData } from 'src/jobs/queue.constants';
import {
  GUMLET_INGEST_JOB_DEADLINE_MS,
  GumletIngestStalledError,
  settleWithin,
  VideoProcessor,
} from 'src/jobs/processors/video.processor';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => [] as string[]),
  readFile: jest.fn(async () => Buffer.alloc(0)),
  stat: jest.fn(async () => ({ size: 10 })),
  writeFile: jest.fn(async () => undefined),
}));

/**
 * THE INCIDENT THIS REPRODUCES (production, 2026-11-10 → 11)
 *
 * Job `transcode:cmwb2r0uv01u4f101wjdbegq9:…` logged "adopted by Gumlet … (status
 * pre-queued)" at 19:29:41 UTC and then nothing else: no result, no poll-budget
 * timeout, none of the database-retry warnings the poll loop prints. Its promise
 * never settled. The worker kept renewing the job's 30-minute lock, so BullMQ's
 * stalled check never reclaimed it, and with `concurrency: 1` the nine uploads
 * queued after it waited 11.5 hours until the worker was restarted by hand. The
 * video itself had been finished by the recovery sweep half an hour later.
 *
 * The fix must make that impossible without touching the healthy path: a hung
 * ingest frees the slot after a fixed deadline, the row is not stamped FAILED
 * (the asset may be fine), and BullMQ gets the error so its retry/sweep resume.
 */

function harness(processFromJob: jest.Mock) {
  const videos = {
    markProcessing: jest.fn(async () => true),
    markReady: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
  };
  const processor = new VideoProcessor(
    { putObject: jest.fn(), putFile: jest.fn(), downloadToFile: jest.fn() } as never,
    videos as never,
    { processFromJob } as never,
    {
      getOrThrow: () => ({ workDir: '/tmp/work', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', keyRoot: 'k', segmentSeconds: 4 }),
    } as never,
  );
  const job = {
    name: VIDEO_JOBS.transcode,
    id: 'transcode:v1:1',
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: { videoId: 'v1', sourceKey: 'key', lessonId: null, courseId: 'c1', ladder: [720], encrypt: true },
    updateProgress: jest.fn(async () => undefined),
  } as unknown as Job<TranscodeJobData>;
  return { processor, videos, job };
}

describe('a Gumlet ingest that never settles', () => {
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

  it('releases the queue slot after the deadline instead of holding it forever', async () => {
    const never = new Promise<never>(() => undefined);
    const t = harness(jest.fn(() => never));

    const outcome = t.processor.process(t.job).then(
      () => 'resolved',
      (e: unknown) => e,
    );
    // Just short of the deadline the job is still running...
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS - 1_000);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    // ...and at the deadline it gives the slot back with a specific error.
    await jest.advanceTimersByTimeAsync(2_000);
    const error = await outcome;
    expect(error).toBeInstanceOf(GumletIngestStalledError);
    expect((error as Error).message).toContain('v1');
    expect((error as Error).message).toContain('transcode:v1:1');
  });

  it('does not stamp the video FAILED: the asset may be healthy and the sweep resumes it', async () => {
    const t = harness(jest.fn(() => new Promise<never>(() => undefined)));
    const outcome = t.processor.process(t.job).catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(GUMLET_INGEST_JOB_DEADLINE_MS + 1_000);

    expect(await outcome).toBeInstanceOf(GumletIngestStalledError);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
    expect(t.videos.markReady).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('releasing the queue slot'));
  });

  it('sits well beyond the ingest poll budget, so a slow but healthy ingest is never cut off', () => {
    // processFromJob polls for at most 20 minutes; the deadline only catches a hang.
    expect(GUMLET_INGEST_JOB_DEADLINE_MS).toBeGreaterThanOrEqual(30 * 60_000);
  });

  it('leaves the healthy path untouched and leaks no timer', async () => {
    const t = harness(jest.fn(async () => ({ handled: true, status: 'ready', playable: true })));

    await expect(t.processor.process(t.job)).resolves.toEqual({
      videoId: 'v1',
      provider: 'gumlet',
      status: 'ready',
      playable: true,
    });
    expect(jest.getTimerCount()).toBe(0);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('still reports a real ingest failure as before (not as a stall)', async () => {
    const boom = new Error('Gumlet refused the asset');
    const t = harness(jest.fn().mockRejectedValue(boom));

    await expect(t.processor.process(t.job)).rejects.toBe(boom);
    expect(t.videos.markFailed).toHaveBeenCalledWith('v1', 'Gumlet refused the asset');
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('settleWithin', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes a value through and clears its timer', async () => {
    await expect(settleWithin(Promise.resolve(7), 1_000, 'x')).resolves.toBe(7);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('passes a rejection through unchanged and clears its timer', async () => {
    const e = new Error('original');
    await expect(settleWithin(Promise.reject(e), 1_000, 'x')).rejects.toBe(e);
    expect(jest.getTimerCount()).toBe(0);
  });
});
