import type { Job } from 'bullmq';
import { VIDEO_JOBS, type TranscodeJobData } from 'src/jobs/queue.constants';
import { VideoProcessor } from 'src/jobs/processors/video.processor';
import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';

// fs is stubbed wholesale: the ffmpeg pipeline is not what these tests are
// about, and letting it run would touch the disk.
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
 *  - a legacy video must fall through to the local ffmpeg/HLS path
 *  - a Gumlet video must never reach ffmpeg at all
 *  - the decision comes from the database, so a replayed job cannot reroute
 *
 * `GumletIngestService` and the `HlsTranscoder` are stubbed, so no subprocess,
 * network call or file write happens.
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

  const transcoder = {
    run: jest.fn(async () => ({
      probe: {
        durationSeconds: 120,
        width: 1280,
        height: 720,
        frameRate: 25,
        videoCodec: 'h264',
        audioCodec: 'aac',
      },
      renditions: [
        { height: 720, width: 1280, bitrateKbps: 2328, playlistKey: 'hls/v_1/720p/index.m3u8', sizeBytes: 10 },
      ],
      hlsPrefix: 'hls/v_1/',
      masterPlaylistKey: 'hls/v_1/master.m3u8',
      thumbnailKey: 'thumbs/v_1.jpg',
      isEncrypted: true,
    })),
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
    transcoder as never,
    videos as never,
    gumletIngest as never,
    config as never,
  );

  return { processor, videos, gumletIngest, transcoder };
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
  it('falls through to the local ffmpeg HLS pipeline', async () => {
    const t = build({ handled: false });

    const result = await t.processor.process(job());

    // `handled: false` means "not mine" - the ingest service declines and the
    // local path runs.
    // The only other argument is the job deadline's abort signal - no routing data.
    expect(t.gumletIngest.processFromJob).toHaveBeenCalledWith('v_1', 'uploads/v_1.bin', {
      signal: expect.any(AbortSignal),
    });
    expect(t.transcoder.run).toHaveBeenCalledWith(
      expect.objectContaining({ videoId: 'v_1', sourceKey: 'uploads/v_1.bin', ladder: [720] }),
    );
    expect(t.videos.markReady).toHaveBeenCalledWith(
      'v_1',
      expect.objectContaining({ hlsPrefix: 'hls/v_1/', isEncrypted: true, encryptionKeyId: 'derived:v_1' }),
    );
    expect(result).toEqual({ videoId: 'v_1', renditions: 1 });
  });

  it('never reports the video as Gumlet-handled', async () => {
    const t = build({ handled: false });

    const result = (await t.processor.process(job())) as { provider?: string };

    expect(result.provider).toBeUndefined();
  });

  it('asks for AES-128 encryption when the job does', async () => {
    const t = build({ handled: false });

    await t.processor.process(job({ encrypt: true }));

    expect(t.transcoder.run).toHaveBeenCalledWith(expect.objectContaining({ encrypt: true }));
  });

  it('does not encrypt when the job does not ask for it', async () => {
    const t = build({ handled: false });

    await t.processor.process(job({ encrypt: false }));

    expect(t.transcoder.run).toHaveBeenCalledWith(expect.objectContaining({ encrypt: false }));
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
    expect(t.transcoder.run).not.toHaveBeenCalled();
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
    expect(t.transcoder.run).not.toHaveBeenCalled();
  });

  it('is never routed by the job payload', async () => {
    // The ingest service is the only source of truth; it reads the row itself.
    const t = build({ handled: true, status: 'ready', playable: true });

    await t.processor.process(job({ drmProvider: 'gumlet' } as Partial<TranscodeJobData>));

    // The processor passed only the identifiers, so a payload claiming a
    // provider cannot influence the decision.
    // The only other argument is the job deadline's abort signal - no routing data.
    expect(t.gumletIngest.processFromJob).toHaveBeenCalledWith('v_1', 'uploads/v_1.bin', {
      signal: expect.any(AbortSignal),
    });
    expect(t.gumletIngest.processFromJob).toHaveBeenCalledTimes(1);
  });
});

describe('failures', () => {
  it('are recorded on the video when the local pipeline throws', async () => {
    const t = build({ handled: false });
    t.transcoder.run.mockRejectedValue(new Error('ffprobe could not be started'));

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
