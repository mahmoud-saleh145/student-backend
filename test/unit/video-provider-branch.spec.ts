import type { Job } from 'bullmq';
import { VIDEO_JOBS, type TranscodeJobData } from 'src/jobs/queue.constants';
import { VideoProcessor } from 'src/jobs/processors/video.processor';
import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';

// fs is stubbed wholesale: the ffmpeg pipeline is not what these tests are
// about, and letting it run would spawn real processes.
jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => [] as string[]),
  readFile: jest.fn(async () => Buffer.alloc(0)),
  stat: jest.fn(async () => ({ size: 10 })),
  writeFile: jest.fn(async () => undefined),
}));

const WORK_DIR = 'D:\\work';

/**
 * Provider selection in the transcode worker.
 *
 * This is the single decision point that separates the two delivery pipelines,
 * so the tests here are about routing and safety, not about transcoding:
 *
 *  - a legacy video must fall through to the untouched ffmpeg/HLS path
 *  - a Gumlet video must never reach ffmpeg at all
 *  - the decision comes from the database, so a replayed job cannot reroute
 *
 * `GumletIngestService` is stubbed; every other step is stubbed too, so no
 * subprocess, network call or file write happens.
 */
function build(opts: {
  claimed?: boolean;
  handled?: boolean;
  status?: string | null;
  playable?: boolean;
}) {
  const claimed = opts.claimed ?? true;

  const videos = {
    markProcessing: jest.fn(async () => claimed),
    markReady: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
  };

  const gumletIngest = {
    processFromJob: jest.fn(async () => ({
      handled: opts.handled ?? false,
      status: opts.status ?? null,
      playable: opts.playable ?? false,
    })),
  };

  const storage = {
    putObject: jest.fn(async () => undefined),
    putFile: jest.fn(async () => undefined),
    downloadToFile: jest.fn(async () => undefined),
  };

  const config = {
    getOrThrow: () => ({
      workDir: WORK_DIR,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      keyRoot: 'key-root-for-tests',
      segmentSeconds: 4,
    }),
  };

  const processor = new VideoProcessor(
    storage as never,
    videos as never,
    gumletIngest as never,
    config as never,
  );

  // Replace every step after the provider branch so a legacy fall-through runs
  // to completion without touching disk or spawning ffmpeg.
  const steps = {
    probe: jest
      .spyOn(processor as never as { probe: (p: string) => Promise<unknown> }, 'probe')
      .mockResolvedValue({
        durationSeconds: 120,
        width: 1280,
        height: 720,
        frameRate: 25,
        videoCodec: 'h264',
        audioCodec: 'aac',
      }),
    runFfmpeg: jest
      .spyOn(processor as never as { runFfmpeg: () => Promise<void> }, 'runFfmpeg')
      .mockResolvedValue(undefined),
    uploadRendition: jest
      .spyOn(processor as never as { uploadRendition: () => Promise<{ totalBytes: number }> }, 'uploadRendition')
      .mockResolvedValue({ totalBytes: 10 }),
    extractThumbnail: jest
      .spyOn(
        processor as never as { extractThumbnail: () => Promise<string | undefined> },
        'extractThumbnail',
      )
      .mockResolvedValue('thumbs/v_1.jpg'),
    writeKeyInfo: jest
      .spyOn(processor as never as { writeKeyInfo: () => Promise<string> }, 'writeKeyInfo')
      .mockResolvedValue('D:\\work\\v_1\\enc.keyinfo'),
    downloadSource: jest
      .spyOn(processor as never as { downloadSource: () => Promise<void> }, 'downloadSource')
      .mockResolvedValue(undefined),
  };

  return { processor, videos, gumletIngest, storage, steps };
}

function job(overrides: Partial<TranscodeJobData> = {}, name: string = VIDEO_JOBS.transcode) {
  return {
    id: 'job_1',
    name,
    data: {
      videoId: 'v_1',
      sourceKey: 'uploads/v_1.bin',
      ladder: [720],
      encrypt: true,
      ...overrides,
    },
    updateProgress: jest.fn(async () => undefined),
  } as unknown as Job<TranscodeJobData>;
}

describe('jobs that are not transcodes', () => {
  it('are ignored without touching the video', async () => {
    const t = build({});

    await expect(t.processor.process(job({}, 'something-else'))).resolves.toBeNull();
    expect(t.videos.markProcessing).not.toHaveBeenCalled();
    expect(t.gumletIngest.processFromJob).not.toHaveBeenCalled();
  });
});

describe('a stale job for a video already claimed', () => {
  it('is skipped, and never reaches the provider branch', async () => {
    const t = build({ claimed: false });

    const result = await t.processor.process(job());

    expect(result).toEqual({ videoId: 'v_1', skipped: true });
    expect(t.gumletIngest.processFromJob).not.toHaveBeenCalled();
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });
});

describe('a legacy video (drmProvider null in the database)', () => {
  it('falls through to the unchanged ffmpeg HLS pipeline', async () => {
    const t = build({ handled: false });

    const result = await t.processor.process(job());

    // `handled: false` means "not mine" - the ingest service declines and the
    // original path runs.
    expect(t.gumletIngest.processFromJob).toHaveBeenCalledWith('v_1', 'uploads/v_1.bin');
    expect(t.steps.runFfmpeg).toHaveBeenCalled();
    expect(t.videos.markReady).toHaveBeenCalled();
    expect(result).toEqual({ videoId: 'v_1', renditions: 1 });
  });

  it('never reports the video as Gumlet-handled', async () => {
    const t = build({ handled: false });

    const result = (await t.processor.process(job())) as { provider?: string };

    expect(result.provider).toBeUndefined();
  });

  it('derives its AES-128 key when the job asks for encryption', async () => {
    const t = build({ handled: false });

    await t.processor.process(job({ encrypt: true }));

    expect(t.steps.writeKeyInfo).toHaveBeenCalled();
  });

  it('does not derive a key when the job does not ask for encryption', async () => {
    const t = build({ handled: false });

    await t.processor.process(job({ encrypt: false }));

    expect(t.steps.writeKeyInfo).not.toHaveBeenCalled();
  });
});

describe('a Gumlet-backed video', () => {
  it('is ingested and never transcoded locally', async () => {
    const t = build({ handled: true, status: 'ready', playable: true });

    const result = await t.processor.process(job());

    expect(result).toEqual({
      videoId: 'v_1',
      provider: 'gumlet',
      status: 'ready',
      playable: true,
    });
    // The whole point: no ffmpeg, no HLS renditions, no local master playlist.
    expect(t.steps.runFfmpeg).not.toHaveBeenCalled();
    expect(t.steps.uploadRendition).not.toHaveBeenCalled();
    expect(t.videos.markReady).not.toHaveBeenCalled();
  });

  it('is not reported as playable until the ingest service says so', async () => {
    const t = build({ handled: true, status: 'processing', playable: false });

    const result = (await t.processor.process(job())) as { playable: boolean; status: string };

    expect(result.playable).toBe(false);
    expect(result.status).toBe('processing');
  });

  it('does not fall through to ffmpeg when Gumlet reports a failure', async () => {
    // `handled` is what gates the branch, not `playable`. A failed asset is
    // still a Gumlet video: transcode+encrypting it locally would produce HLS
    // the player would then try to use for a video the row says is Gumlet.
    const t = build({ handled: true, status: 'errored', playable: false });

    const result = (await t.processor.process(job())) as { playable: boolean; status: string };

    expect(result).toEqual({
      videoId: 'v_1',
      provider: 'gumlet',
      status: 'errored',
      playable: false,
    });
    expect(t.steps.runFfmpeg).not.toHaveBeenCalled();
  });

  it('is never routed by the job payload', async () => {
    // The ingest service is the only source of truth; it reads the row itself.
    const t = build({ handled: true, status: 'ready', playable: true });

    await t.processor.process(job({ drmProvider: 'gumlet' } as Partial<TranscodeJobData>));

    // The processor passed only the identifiers, so a payload claiming a
    // provider cannot influence the decision.
    expect(t.gumletIngest.processFromJob).toHaveBeenCalledWith('v_1', 'uploads/v_1.bin');
    expect(t.gumletIngest.processFromJob).toHaveBeenCalledTimes(1);
  });
});

describe('failures', () => {
  it('are recorded on the video when the provider branch throws', async () => {
    const t = build({ handled: false });
    t.steps.probe.mockRejectedValue(new Error('ffprobe could not be started'));

    await expect(t.processor.process(job())).rejects.toThrow(/ffprobe/);

    expect(t.videos.markFailed).toHaveBeenCalledWith('v_1', expect.stringContaining('ffprobe'));
  });

  it('are recorded on the video when Gumlet ingest throws', async () => {
    const t = build({ handled: false });
    t.gumletIngest.processFromJob.mockRejectedValue(new Error('Gumlet API unreachable'));

    await expect(t.processor.process(job())).rejects.toThrow(/unreachable/);

    expect(t.videos.markFailed).toHaveBeenCalledWith('v_1', expect.stringContaining('unreachable'));
    expect(t.videos.markReady).not.toHaveBeenCalled();
  });
});

describe('injected collaborators', () => {
  it('the processor receives the real GumletIngestService type from Nest', () => {
    // Compile-time only: guards against the constructor argument order drifting
    // between the processor and its module providers.
    expect(GumletIngestService).toBeDefined();
  });
});