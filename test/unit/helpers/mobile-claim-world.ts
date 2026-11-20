/**
 * Shared by the mobile duplicate-encode regression tests (unit and real-queue):
 * the REAL VideosService and MobileVideoProcessor over one stateful in-memory
 * video row, with ffmpeg/R2, the encode slot and Redis as doubles.
 */
import { TranscodeSupersededError } from '../../../src/jobs/processors/hls-transcoder';
import { MobileVideoProcessor } from '../../../src/jobs/processors/mobile-video.processor';
import { MOBILE_VIDEO_JOBS } from '../../../src/jobs/queue.constants';
import { VideosService } from '../../../src/modules/videos/videos.service';

export const VIDEO = 'cmwp0i2sx001rho01ap2is9gu';
export const SOURCE = `source/videos/${VIDEO}/sheet-4-part-3.mp4`;
export const JOB = `mobile-hls:${VIDEO}:p1g4`;

export type Row = Record<string, unknown> & {
  id: string;
  sourceKey: string;
  mobileStatus: string;
  mobileJobId: string | null;
  mobileProcessingStartedAt: Date | null;
  mobileProcessedAt: Date | null;
  mobileRequestedAt: Date | null;
};

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return a === b;
}

/** Evaluates the `where` shapes VideosService uses for these writes. */
function matches(where: Record<string, unknown>, row: Row): boolean {
  return Object.entries(where).every(([k, cond]) => {
    if (k === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(c, row));
    if (k === 'deletedAt') return row.deletedAt == null;
    const v = row[k];
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; in?: unknown[] };
      if ('not' in c) return v !== c.not;
      if (c.in) return c.in.includes(v);
    }
    return sameValue(v, cond);
  });
}

export function world(initial: Partial<Row> = {}) {
  const row: Row = {
    id: VIDEO,
    sourceKey: SOURCE,
    status: 'READY',
    deletedAt: null,
    durationSeconds: 750,
    width: 864,
    height: 480,
    thumbnailKey: 't.jpg',
    mobileStatus: 'QUEUED',
    mobileJobId: JOB,
    mobileGeneration: 4,
    mobileRequestedAt: new Date('2026-11-20T20:30:16Z'),
    mobileProcessingStartedAt: null,
    mobileProcessedAt: null,
    ...initial,
  };
  const readyWrites: Date[] = [];
  let failNextFinish: (() => Error | null) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    video: {
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => (matches(where, row) ? { ...row } : null)),
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      updateMany: jest.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!matches(where, row)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const { renditions: _r, ...rest } = data;
        Object.assign(row, rest);
        if (rest.mobileStatus === 'READY') readyWrites.push(rest.mobileProcessedAt as Date);
        return { ...row };
      }),
    },
    videoRendition: { deleteMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => {
      const injected = failNextFinish?.();
      failNextFinish = null;
      if (injected) throw injected;
      return fn(prisma);
    }),
  };
  const announcer = { onFirstPlayable: jest.fn(async () => undefined), settle: jest.fn(async () => undefined) };
  const lessonVideos = { propagateDurationToAttachedLessons: jest.fn(async () => undefined) };
  const mobileQueue = { getJob: jest.fn(async () => null) };
  const videos = new VideosService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { record: jest.fn() } as never,
    { getJson: jest.fn(async () => null) } as never,
    {} as never,
    { getOrThrow: () => ({ ladder: [480], encryptionEnabled: true, mobile: { autoProcess: true } }) } as never,
    lessonVideos as never,
    {} as never,
    mobileQueue as never,
    announcer as never,
  );
  return {
    row,
    videos,
    prisma,
    readyWrites,
    failFinishOnce: (make: () => Error) => {
      failNextFinish = make;
    },
  };
}

/** A transcoder whose encode finishes only when the test says so (the "standby"). */
export function controllableTranscoder() {
  const runs: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
  const result = {
    probe: { durationSeconds: 750, width: 864, height: 480, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
    renditions: [{ height: 480, width: 864, bitrateKbps: 1200, playlistKey: `hls/${VIDEO}/480p/index.m3u8`, sizeBytes: 1 }],
    hlsPrefix: `hls/${VIDEO}/`,
    masterPlaylistKey: `hls/${VIDEO}/master.m3u8`,
    isEncrypted: true,
    encryptionKeyId: `derived:v2:r1:${VIDEO}`,
  };
  const transcoder = {
    preflight: jest.fn(async () => ({
      sourceMissing: false,
      sourceBytes: 1,
      budgetBytes: 1,
      assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 },
    })),
    run: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          runs.push({ resolve: () => resolve(result), reject });
        }),
    ),
    abortSuperseded: jest.fn((why: string) => runs.at(-1)?.reject(new TranscodeSupersededError(why))),
  };
  return { transcoder, runs, finish: (i: number) => runs[i]!.resolve() };
}

export function processorFor(videos: VideosService, transcoder: unknown, ownershipCheckMs = 60_000) {
  const guard = {
    pauseState: jest.fn(async () => ({ paused: true, scope: 'historical', reason: null, by: null, at: null })),
    noteActive: jest.fn(),
    noteProgress: jest.fn(),
    noteFinished: jest.fn(),
    noteDeferred: jest.fn(),
  };
  const scheduler = {
    uploadPressure: jest.fn(),
    acquireEncodeSlot: jest.fn(async () => ({ holder: 'h', release: jest.fn(async () => undefined) })),
  };
  const p = new MobileVideoProcessor(
    transcoder as never,
    videos,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
    guard as never,
    scheduler as never,
  );
  const tuning = p as unknown as { ownershipCheckMs: number; dbRetryDelaysMs: number[] };
  tuning.ownershipCheckMs = ownershipCheckMs;
  tuning.dbRetryDelaysMs = [1, 1];
  return p;
}

/**
 * The same BullMQ job delivered twice: both deliveries share the job's data
 * (Redis holds one copy), as a re-delivery after a lost lock does.
 */
export function delivery(shared: { data: Record<string, unknown> }) {
  return {
    id: JOB,
    name: MOBILE_VIDEO_JOBS.transcode,
    get data() {
      return shared.data;
    },
    attemptsMade: 0,
    opts: { attempts: 2 },
    updateData: jest.fn(async (d: Record<string, unknown>) => {
      shared.data = d;
    }),
    updateProgress: jest.fn(async () => undefined),
    moveToDelayed: jest.fn(async () => undefined),
  };
}

export const jobData = () => ({
  data: { videoId: VIDEO, sourceKey: SOURCE, ladder: [480], encrypt: true, trigger: 'upload', durationSeconds: 750 } as Record<string, unknown>,
});
export const settle = () => new Promise((r) => setTimeout(r, 0));
