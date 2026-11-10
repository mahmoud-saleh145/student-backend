import { Prisma } from '@prisma/client';
import { DelayedError, type Job } from 'bullmq';

import { TranscodeDiskPressureError, TranscodeEnvironmentError, TranscodeOutputError } from '../../src/jobs/processors/hls-transcoder';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { MOBILE_VIDEO_JOBS, type MobileTranscodeJobData } from '../../src/jobs/queue.constants';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => []),
}));
import { readdir, rm } from 'node:fs/promises';

/**
 * The mobile transcode job: claim → encode → record, with every failure mode
 * leaving the row in a state the dashboard can read and the sweep can resume.
 * `Video.status` and the Gumlet fields are never touched - only the
 * `markMobile*` methods are called.
 */
function build(
  opts: {
    claimed?: boolean;
    runError?: Error;
    paused?: boolean;
    preflight?: { ok: boolean; shortfallBytes?: number } | 'missing';
  } = {},
) {
  const videos = {
    markMobileProcessing: jest.fn(async () => opts.claimed ?? true),
    markMobileReady: jest.fn(async () => undefined),
    markMobileFailed: jest.fn(async () => undefined),
    markMobileDeferred: jest.fn(async () => undefined),
    markProcessing: jest.fn(),
    markReady: jest.fn(),
    markFailed: jest.fn(),
  };
  const transcoder = {
    preflight: jest.fn(async () =>
      opts.preflight === 'missing'
        ? { sourceMissing: true, sourceBytes: null, budgetBytes: 0, assessment: null }
        : {
            sourceMissing: false,
            sourceBytes: 100e6,
            budgetBytes: 2e9,
            assessment: {
              ok: opts.preflight?.ok ?? true,
              freeBytes: 30e9,
              reservedByOthers: 0,
              minFreeBytes: 25e9,
              shortfallBytes: opts.preflight?.shortfallBytes ?? 0,
            },
          },
    ),
    run: jest.fn(async () => {
      if (opts.runError) throw opts.runError;
      return {
        probe: { durationSeconds: 2654.4, width: 1920, height: 1080, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
        renditions: [
          { height: 360, width: 640, bitrateKbps: 664, playlistKey: 'hls/v_1/360p/index.m3u8', sizeBytes: 1 },
          { height: 720, width: 1280, bitrateKbps: 2328, playlistKey: 'hls/v_1/720p/index.m3u8', sizeBytes: 2 },
        ],
        hlsPrefix: 'hls/v_1/',
        masterPlaylistKey: 'hls/v_1/master.m3u8',
        thumbnailKey: 'thumbnails/videos/v_1.jpg',
        isEncrypted: true,
      };
    }),
  };
  const config = { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) };
  const guard = {
    pauseState: jest.fn(async () => ({ paused: opts.paused ?? false, reason: opts.paused ? 'test' : null, by: null, at: null })),
    noteActive: jest.fn(),
    noteProgress: jest.fn(),
    noteFinished: jest.fn(),
    noteDeferred: jest.fn(),
  };
  const processor = new MobileVideoProcessor(transcoder as never, videos as never, config as never, guard as never);
  const job = {
    id: 'mobile-hls:v_1:1',
    name: MOBILE_VIDEO_JOBS.transcode,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: {
      videoId: 'v_1',
      sourceKey: 'source/videos/v_1.mp4',
      ladder: [360, 720],
      encrypt: true,
      trigger: 'upload',
      durationSeconds: 2654,
    },
    updateProgress: jest.fn(async () => undefined),
    moveToDelayed: jest.fn(async () => undefined),
  } as unknown as Job<MobileTranscodeJobData>;
  return { processor, videos, transcoder, job, guard };
}

describe('MobileVideoProcessor', () => {
  it('claims, encodes in its own scratch directory, and records the ladder as mobile-READY', async () => {
    const t = build();

    await expect(t.processor.process(t.job)).resolves.toEqual({ videoId: 'v_1', renditions: 2 });

    expect(t.videos.markMobileProcessing).toHaveBeenCalledWith('v_1', 'source/videos/v_1.mp4', 'mobile-hls:v_1:1');
    expect(t.transcoder.run).toHaveBeenCalledWith(
      expect.objectContaining({
        videoId: 'v_1',
        sourceKey: 'source/videos/v_1.mp4',
        ladder: [360, 720],
        encrypt: true,
        workDir: expect.stringMatching(/mobile[\\/]v_1$/),
      }),
    );
    expect(t.videos.markMobileReady).toHaveBeenCalledWith(
      'v_1',
      expect.objectContaining({
        durationSeconds: 2654,
        hlsPrefix: 'hls/v_1/',
        isEncrypted: true,
        encryptionKeyId: 'derived:v_1',
        renditions: expect.arrayContaining([expect.objectContaining({ height: 720 })]),
      }),
    );
    // The primary pipeline's bookkeeping is never touched.
    expect(t.videos.markProcessing).not.toHaveBeenCalled();
    expect(t.videos.markReady).not.toHaveBeenCalled();
  });

  it('skips a stale job (deleted, re-uploaded or already READY video) without encoding', async () => {
    const t = build({ claimed: false });

    await expect(t.processor.process(t.job)).resolves.toEqual({ videoId: 'v_1', skipped: true });
    expect(t.transcoder.run).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
  });

  it('ignores jobs that are not mobile transcodes', async () => {
    const t = build();
    await expect(
      t.processor.process({ ...t.job, name: 'something-else' } as Job<MobileTranscodeJobData>),
    ).resolves.toBeNull();
    expect(t.videos.markMobileProcessing).not.toHaveBeenCalled();
  });

  it('records a genuine encode failure on the row and rethrows for the queue', async () => {
    const t = build({ runError: new Error('ffmpeg exited with 1: Invalid data found') });

    await expect(t.processor.process(t.job)).rejects.toThrow(/ffmpeg exited/);
    expect(t.videos.markMobileFailed).toHaveBeenCalledWith('v_1', expect.stringContaining('ffmpeg exited'));
  });

  it('describes a host problem (no scratch space, no ffmpeg) as retryable', async () => {
    const t = build({ runError: new TranscodeEnvironmentError('Not enough scratch space') });

    await expect(t.processor.process(t.job)).rejects.toThrow(/scratch/);
    expect(t.videos.markMobileFailed).toHaveBeenCalledWith(
      'v_1',
      expect.stringMatching(/could not run the encode .*scratch.*retried/),
    );
  });

  it('leaves the row alone on a database outage so the queue retry can finish the job', async () => {
    const outage = new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
      code: 'P1001',
      clientVersion: 'test',
    });
    const t = build({ runError: outage });

    await expect(t.processor.process(t.job)).rejects.toBe(outage);
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
  });

  it('records a rung that failed verification as not published, and rethrows', async () => {
    const t = build({ runError: new TranscodeOutputError('720p: rendition is 1200.0 s but the source is 2654.4 s') });

    await expect(t.processor.process(t.job)).rejects.toThrow(/rendition is/);
    expect(t.videos.markMobileReady).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).toHaveBeenCalledWith(
      'v_1',
      expect.stringMatching(/failed verification and was not published/),
    );
  });

  it('removes stale scratch left by an interrupted job when the worker boots', async () => {
    const t = build();
    (readdir as jest.Mock).mockResolvedValueOnce(['v_old', 'v_older']);

    await t.processor.onModuleInit();

    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/mobile[\\/]v_old$/), { recursive: true, force: true });
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/mobile[\\/]v_older$/), { recursive: true, force: true });
  });

  it('boots quietly when the scratch root does not exist yet', async () => {
    const t = build();
    (readdir as jest.Mock).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    (rm as jest.Mock).mockClear();

    await expect(t.processor.onModuleInit()).resolves.toBeUndefined();
    expect(rm).not.toHaveBeenCalled();
  });

  it('defers (no attempt used, row untouched) while the operator has paused mobile encodes', async () => {
    const t = build({ paused: true });

    await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(t.job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    expect(t.transcoder.run).not.toHaveBeenCalled();
    expect(t.videos.markMobileProcessing).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
  });

  it('defers before downloading anything when the scratch volume cannot hold the job and the reserve', async () => {
    const t = build({ preflight: { ok: false, shortfallBytes: 3e9 } });

    await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    const delay = (t.job.moveToDelayed as jest.Mock).mock.calls[0][0] as number;
    expect(delay - Date.now()).toBeGreaterThan(4 * 60_000);
    expect(t.transcoder.run).not.toHaveBeenCalled();
    expect(t.videos.markMobileProcessing).not.toHaveBeenCalled();
    expect(t.guard.noteDeferred).toHaveBeenCalledWith('v_1', expect.stringContaining('disk'));
  });

  it('lets the claim path report a missing source rather than deferring forever', async () => {
    const t = build({ preflight: 'missing', runError: new Error('Source object source/videos/v_1.mp4 is missing from storage') });

    await expect(t.processor.process(t.job, 'tok')).rejects.toThrow(/missing from storage/);
    expect(t.job.moveToDelayed).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).toHaveBeenCalledWith('v_1', expect.stringContaining('missing from storage'));
  });

  it('puts the row back to QUEUED and defers when the disk watchdog killed the encode', async () => {
    const t = build({ runError: new TranscodeDiskPressureError('ffmpeg was stopped: scratch volume below the 25.0 GB reserve') });

    await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(t.videos.markMobileDeferred).toHaveBeenCalledWith('v_1', expect.stringContaining('disk space'));
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
    expect(t.job.moveToDelayed).toHaveBeenCalled();
    expect(rm).toHaveBeenCalledWith(expect.stringMatching(/mobile[\\/]v_1$/), { recursive: true, force: true });
  });

  it('reports the running job to the heartbeat and clears it when done', async () => {
    const t = build();
    await t.processor.process(t.job);
    expect(t.guard.noteActive).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'v_1', jobId: 'mobile-hls:v_1:1' }));
    expect(t.guard.noteFinished).toHaveBeenCalledWith('v_1');
  });

  it('keeps the original error when recording the failure itself fails', async () => {
    const t = build({ runError: new Error('ffmpeg exited with 1') });
    t.videos.markMobileFailed.mockRejectedValueOnce(new Error('db down'));

    await expect(t.processor.process(t.job)).rejects.toThrow('ffmpeg exited with 1');
  });
});
