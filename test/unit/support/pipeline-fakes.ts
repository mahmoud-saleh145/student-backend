import { MobileVideoProcessor } from '../../../src/jobs/processors/mobile-video.processor';
import { VideoProcessor } from '../../../src/jobs/processors/video.processor';
import { VideosService } from '../../../src/modules/videos/videos.service';

/**
 * Stateful doubles for the video pipeline.
 *
 * The pipeline's guarantees are about ORDER and STATE - what is durable before
 * what, which process may write which field, what a second request finds. A
 * `jest.fn()` that returns `{ count: 1 }` cannot show any of that. So these
 * doubles keep real state: a table of rows that `where` clauses are actually
 * evaluated against, and a queue that really refuses a duplicate job id, the
 * way BullMQ does.
 *
 * The code under test is the REAL `VideosService`, `VideoProcessor` and
 * `MobileVideoProcessor`. Only what is outside the process is replaced:
 * Postgres, Redis/BullMQ, R2, Gumlet and ffmpeg.
 */

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown> & { id: string };

function matchesField(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || expected instanceof Date) {
    if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
    return (actual ?? null) === (expected ?? null);
  }
  const cond = expected as Record<string, unknown>;
  if ('in' in cond) return (cond.in as unknown[]).includes(actual);
  if ('notIn' in cond) return !(cond.notIn as unknown[]).includes(actual);
  if ('not' in cond) return !matchesField(actual, cond.not);
  if ('lt' in cond) return actual instanceof Date && actual.getTime() < (cond.lt as Date).getTime();
  if ('gt' in cond) return actual instanceof Date && actual.getTime() > (cond.gt as Date).getTime();
  throw new Error(`pipeline-fakes: unsupported where operator ${JSON.stringify(expected)}`);
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(expected as Record<string, unknown>[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(expected as Record<string, unknown>[]).every((branch) => matches(row, branch))) return false;
      continue;
    }
    if (!matchesField(row[key], expected)) return false;
  }
  return true;
}

export function videoRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'v_1',
    courseId: 'course_1',
    lessonId: 'lesson_1',
    status: 'UPLOADING',
    sourceKey: 'source/videos/v_1/a.mp4',
    sourceSizeBytes: null,
    sourceMimeType: 'video/mp4',
    drmProvider: 'gumlet',
    gumletAssetId: null,
    gumletStatus: null,
    gumletError: null,
    gumletUpdatedAt: null,
    drmVerifiedAt: null,
    processingJobId: null,
    processingError: null,
    processingStartedAt: null,
    processedAt: null,
    hlsPrefix: null,
    masterPlaylistKey: null,
    thumbnailKey: null,
    isEncrypted: false,
    encryptionKeyId: null,
    durationSeconds: 0,
    width: null,
    height: null,
    mobileStatus: 'NONE',
    mobileError: null,
    mobileJobId: null,
    mobileProcessingStartedAt: null,
    mobileProcessedAt: null,
    mobileRequestedAt: null,
    mobileEnqueuedAt: null,
    mobileGeneration: 0,
    mobileTrigger: null,
    deletedAt: null,
    createdAt: new Date('2026-11-16T10:00:00Z'),
    updatedAt: new Date('2026-11-16T10:00:00Z'),
    renditions: [],
    captions: [],
    lesson: { id: 'lesson_1', title: 'Lecture 1', courseId: 'course_1' },
    lessonLinks: [{ lessonId: 'lesson_1' }],
    ...overrides,
  };
}

export class FakeDb {
  readonly rows = new Map<string, Row>();
  /** Every write, in order: which fields each one touched. */
  readonly writes: { id: string; fields: string[] }[] = [];
  /** Set to make every query reject (a database outage). */
  down = false;
  now = () => new Date();

  constructor(rows: Row[] = []) {
    for (const row of rows) this.rows.set(row.id, row);
  }

  get(id: string): Row {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  /** A copy of the named fields, for "this did not change" assertions. */
  snapshot(id: string, fields: string[]): Record<string, unknown> {
    const row = this.get(id);
    return Object.fromEntries(fields.map((f) => [f, row[f]]));
  }

  private guard(): void {
    if (this.down) throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
  }

  private apply(row: Row, data: Record<string, unknown>): void {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (key === 'renditions') {
        const create = (value as { create?: unknown[] }).create;
        if (create) row.renditions = [...create];
        fields.push(key);
        continue;
      }
      row[key] = value;
      fields.push(key);
    }
    row.updatedAt = this.now();
    this.writes.push({ id: row.id, fields });
  }

  readonly video = {
    // Reads return SNAPSHOTS, as a database does: a caller that reads a row
    // and then writes to it must not see its own write in the copy it holds.
    findFirst: async (args: { where?: Record<string, unknown> }) => {
      this.guard();
      for (const row of this.rows.values()) if (matches(row, args.where)) return { ...row };
      return null;
    },
    findUniqueOrThrow: async (args: { where: { id: string } }) => {
      this.guard();
      return { ...this.get(args.where.id) };
    },
    findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
      this.guard();
      const found = [...this.rows.values()].filter((row) => matches(row, args.where)).map((row) => ({ ...row }));
      return args.take ? found.slice(0, args.take) : found;
    },
    count: async (args: { where?: Record<string, unknown> }) => {
      this.guard();
      return [...this.rows.values()].filter((row) => matches(row, args.where)).length;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      this.guard();
      const row = this.get(args.where.id);
      this.apply(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      this.guard();
      let count = 0;
      for (const row of this.rows.values()) {
        if (!matches(row, args.where)) continue;
        this.apply(row, args.data);
        count += 1;
      }
      return { count };
    },
  };

  readonly videoRendition = {
    deleteMany: async (args: { where: { videoId: string } }) => {
      this.guard();
      const row = this.rows.get(args.where.videoId);
      if (row) row.renditions = [];
      return { count: 0 };
    },
  };

  readonly lessonVideo = {
    findMany: async () => [],
  };
  readonly lesson = {
    updateMany: async () => ({ count: 0 }),
  };

  $transaction = async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => fn(this);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  state: 'waiting' | 'prioritized' | 'delayed' | 'active' | 'completed' | 'failed';
  attemptsMade: number;
  progress: number;
  timestamp: number;
}

/**
 * BullMQ's behaviour that the pipeline relies on, and nothing else:
 *   - `add` with an id that already exists is a no-op (same job returned);
 *   - a job with a priority waits in the prioritized set, behind plain ones;
 *   - when Redis is unreachable a command either rejects or never answers.
 */
export class FakeQueue {
  readonly jobs = new Map<string, FakeJob>();
  /** How many times `add` was CALLED (including no-ops and failures). */
  addCalls = 0;
  /** 'reject' = commands fail; 'hang' = commands never answer (BullMQ's real behaviour). */
  outage: null | 'reject' | 'hang' = null;

  constructor(readonly name: string) {}

  private gate<T>(work: () => T): Promise<T> {
    if (this.outage === 'reject') return Promise.reject(new Error('redis unavailable'));
    if (this.outage === 'hang') return new Promise<T>(() => undefined);
    return Promise.resolve().then(work);
  }

  add = (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
    this.addCalls += 1;
    return this.gate(() => {
      const id = String(opts.jobId ?? `auto-${this.jobs.size + 1}`);
      const existing = this.jobs.get(id);
      if (existing) return this.handle(existing);
      const job: FakeJob = {
        id,
        name,
        data,
        opts,
        state: opts.priority ? 'prioritized' : 'waiting',
        attemptsMade: 0,
        progress: 0,
        timestamp: Date.now(),
      };
      this.jobs.set(id, job);
      return this.handle(job);
    });
  };

  getJob = (id: string) => this.gate(() => (this.jobs.has(id) ? this.handle(this.jobs.get(id)!) : undefined));

  getJobCounts = () =>
    this.gate(() => {
      const counts: Record<string, number> = {};
      for (const job of this.jobs.values()) counts[job.state] = (counts[job.state] ?? 0) + 1;
      return counts;
    });

  isPaused = async () => false;
  getJobs = async (states: string[]) => this.inState(...(states as FakeJob['state'][])).map((j) => this.handle(j));

  private handle(job: FakeJob) {
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      opts: job.opts,
      timestamp: job.timestamp,
      getState: () => this.gate(() => (this.jobs.has(job.id) ? job.state : 'unknown')),
      remove: () => this.gate(() => void this.jobs.delete(job.id)),
    };
  }

  // --- test controls --------------------------------------------------------

  inState(...states: FakeJob['state'][]): FakeJob[] {
    return [...this.jobs.values()].filter((job) => states.includes(job.state));
  }

  /** Jobs that are still going to run or are running. */
  live(): FakeJob[] {
    return this.inState('waiting', 'prioritized', 'delayed', 'active');
  }

  /** What a worker would take next: the plain wait list before the prioritized set. */
  next(): FakeJob | null {
    return this.inState('waiting')[0] ?? this.inState('prioritized')[0] ?? null;
  }

  /** Redis lost the job (eviction, flush). */
  lose(id: string): void {
    this.jobs.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The rest of the outside world
// ---------------------------------------------------------------------------

export class FakeStorage {
  /** key -> size. An absent key is an object that is not in the bucket. */
  readonly objects = new Map<string, number>();
  unreachable = false;

  objectSizeStrict = async (_bucket: string, key: string) => {
    if (this.unreachable) throw new Error('connect ETIMEDOUT');
    return this.objects.get(key) ?? null;
  };
  objectSize = async (_bucket: string, key: string) => this.objects.get(key) ?? null;
  exists = async (_bucket: string, key: string) => this.objects.has(key);
  pruneSupersededSources = async () => [];
  presignUpload = async () => ({ uploadUrl: 'https://uploads.example/put', requiredHeaders: {} });
}

export class FakeRedis {
  readonly store = new Map<string, unknown>();
  getJson = async <T>(key: string): Promise<T | null> => (this.store.get(key) as T | undefined) ?? null;
  setJson = async (key: string, value: unknown) => void this.store.set(key, value);
  setJsonPersistent = async (key: string, value: unknown) => void this.store.set(key, value);
  del = async (key: string) => void this.store.delete(key);
}

export const STAFF = { id: 'staff_1', role: 'TEACHER' } as never;
export const ADMIN = { id: 'admin_1', role: 'ADMIN' } as never;

export interface World {
  db: FakeDb;
  storage: FakeStorage;
  redis: FakeRedis;
  /** The original queue: Gumlet ingest jobs. */
  webQueue: FakeQueue;
  mobileQueue: FakeQueue;
  videos: VideosService;
  gumlet: { replaceFailedAsset: jest.Mock; sync: jest.Mock };
  audit: { record: jest.Mock };
}

/**
 * One API process: a real VideosService over the given (possibly shared)
 * database, storage, Redis and queues. Calling it twice with the same parts
 * models two processes, or the same service after a restart.
 */
export function apiProcess(
  parts: Partial<Pick<World, 'db' | 'storage' | 'redis' | 'webQueue' | 'mobileQueue'>> & {
    autoProcess?: boolean;
    withMobileQueue?: boolean;
  } = {},
): World {
  const db = parts.db ?? new FakeDb();
  const storage = parts.storage ?? new FakeStorage();
  const redis = parts.redis ?? new FakeRedis();
  const webQueue = parts.webQueue ?? new FakeQueue('video-processing');
  const mobileQueue = parts.mobileQueue ?? new FakeQueue('mobile-video-processing');
  const gumlet = {
    replaceFailedAsset: jest.fn(async (videoId: string) => {
      // What the real service does to the row: a fresh asset, nothing mobile.
      Object.assign(db.get(videoId), {
        gumletAssetId: 'asset_replacement',
        gumletStatus: 'queued',
        gumletError: null,
        status: 'PROCESSING',
      });
      return { assetId: 'asset_replacement', status: 'queued' };
    }),
    sync: jest.fn(async () => undefined),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const config = {
    getOrThrow: () => ({
      ladder: [480, 720, 1080],
      encryptionEnabled: true,
      workDir: '/tmp/edu-transcode',
      mobile: { delivery: 'hls', gumletFallback: true, autoProcess: parts.autoProcess ?? true },
      drm: {
        enabled: true,
        provider: 'gumlet',
        gumlet: { apiKey: 'test-key', workspaceId: 'ws', orgId: 'org', signSecret: 'test-sign-secret' },
      },
    }),
  };
  const videos = new VideosService(
    db as never,
    storage as never,
    { assertCanManageCourse: jest.fn(async () => undefined), assertTeacherCapability: jest.fn(async () => undefined) } as never,
    { recountCourse: jest.fn(async () => undefined) } as never,
    { notifyCourseStudents: jest.fn(async () => undefined) } as never,
    audit as never,
    redis as never,
    webQueue as never,
    config as never,
    {} as never,
    gumlet as never,
    parts.withMobileQueue === false ? undefined : (mobileQueue as never),
  );
  return { db, storage, redis, webQueue, mobileQueue, videos, gumlet, audit };
}

/** A confirmed upload sitting in the bucket, ready for `completeUpload`. */
export function uploadedWorld(overrides: Partial<Row> = {}, parts: Parameters<typeof apiProcess>[0] = {}): World {
  const row = videoRow(overrides);
  const world = apiProcess({ db: new FakeDb([row]), ...parts });
  if (row.sourceKey) world.storage.objects.set(row.sourceKey as string, 100_000_000);
  return world;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

const LADDER_RESULT = (videoId: string) => ({
  probe: { durationSeconds: 1800, width: 1920, height: 1080, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
  renditions: [
    { height: 480, width: 854, bitrateKbps: 900, playlistKey: `hls/${videoId}/480p/index.m3u8`, sizeBytes: 10 },
    { height: 720, width: 1280, bitrateKbps: 2300, playlistKey: `hls/${videoId}/720p/index.m3u8`, sizeBytes: 20 },
  ],
  hlsPrefix: `hls/${videoId}/`,
  masterPlaylistKey: `hls/${videoId}/master.m3u8`,
  thumbnailKey: undefined,
  isEncrypted: true,
});

/** BullMQ's `Job` as a processor sees it, backed by the fake queue's record. */
function jobFor(queue: FakeQueue, job: FakeJob) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    opts: job.opts,
    get attemptsMade() {
      return job.attemptsMade;
    },
    updateProgress: async (pct: number) => void (job.progress = pct),
    moveToDelayed: async () => void (job.state = 'delayed'),
  } as never;
}

/**
 * The Docker worker's mobile side: the real MobileVideoProcessor with ffmpeg
 * replaced. `encode` decides what the encode does for a given video.
 */
export function mobileWorker(
  world: World,
  options: {
    encode?: (videoId: string) => Promise<void> | void;
    pause?: { paused: boolean; scope?: 'all' | 'historical'; reason?: string | null };
  } = {},
) {
  const transcoder = {
    preflight: async () => ({
      sourceMissing: false,
      sourceBytes: 100e6,
      budgetBytes: 2e9,
      assessment: { ok: true, freeBytes: 60e9, reservedByOthers: 0, minFreeBytes: 30e9, shortfallBytes: 0 },
    }),
    run: jest.fn(async (params: { videoId: string; onProgress?: (pct: number) => Promise<void> }) => {
      await params.onProgress?.(40);
      await options.encode?.(params.videoId);
      return LADDER_RESULT(params.videoId);
    }),
  };
  const guard = {
    pauseState: async () => ({
      paused: options.pause?.paused ?? false,
      reason: options.pause?.reason ?? null,
      by: null,
      at: null,
      scope: options.pause?.scope ?? 'all',
    }),
    noteActive: jest.fn(),
    noteProgress: jest.fn(),
    noteFinished: jest.fn(),
    noteDeferred: jest.fn(),
  };
  const scheduler = {
    uploadPressure: async () => ({ waiting: 0, ignoredStale: 0, originalQueuePaused: false }),
    acquireEncodeSlot: async () => ({ holder: 'laptop:1', release: async () => undefined }),
  };
  const processor = new MobileVideoProcessor(
    transcoder as never,
    world.videos as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
    guard as never,
    scheduler as never,
  );

  /**
   * Takes the next job and runs it to its end, as BullMQ would: a throw is a
   * failed attempt (retried while attempts remain), a DelayedError leaves the
   * job delayed, a return completes it.
   */
  async function runNext(): Promise<{ job: FakeJob; outcome: 'completed' | 'failed' | 'retry' | 'deferred' } | null> {
    const job = world.mobileQueue.next();
    if (!job) return null;
    job.state = 'active';
    try {
      await processor.process(jobFor(world.mobileQueue, job), 'token');
      job.state = 'completed';
      return { job, outcome: 'completed' };
    } catch (error) {
      if ((error as Error)?.name === 'DelayedError') return { job, outcome: 'deferred' };
      job.attemptsMade += 1;
      const attempts = Number(job.opts.attempts ?? 1);
      if (job.attemptsMade < attempts) {
        job.state = 'waiting';
        return { job, outcome: 'retry' };
      }
      job.state = 'failed';
      return { job, outcome: 'failed' };
    }
  }

  /** Starts the next job and returns before it finishes (for "the worker died mid-encode"). */
  function startNext(): FakeJob | null {
    const job = world.mobileQueue.next();
    if (job) job.state = 'active';
    return job;
  }

  return { processor, transcoder, runNext, startNext, claim: (job: FakeJob) => processor.process(jobFor(world.mobileQueue, job), 'token') };
}

/**
 * The Gumlet side of the worker: the real VideoProcessor, with Gumlet itself
 * replaced by `verdict`. Writes to the row exactly what GumletIngestService
 * writes: Gumlet fields and `status`, never anything mobile.
 */
export function gumletWorker(world: World, verdict: (videoId: string) => 'ready' | 'reject' | 'outage') {
  const ingest = {
    processFromJob: jest.fn(async (videoId: string) => {
      const outcome = verdict(videoId);
      if (outcome === 'outage') throw new Error('Gumlet API timeout');
      if (outcome === 'reject') {
        Object.assign(world.db.get(videoId), {
          gumletAssetId: 'asset_1',
          gumletStatus: 'errored',
          gumletError: 'Gumlet rejected the source: unsupported codec',
        });
        throw new Error('Gumlet rejected the source: unsupported codec');
      }
      Object.assign(world.db.get(videoId), {
        gumletAssetId: 'asset_1',
        gumletStatus: 'ready',
        gumletError: null,
        drmVerifiedAt: new Date(),
        status: 'READY',
        durationSeconds: 1800,
        processedAt: new Date(),
      });
      return { handled: true, status: 'ready', playable: true };
    }),
  };
  const processor = new VideoProcessor(
    {} as never,
    world.videos as never,
    ingest as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
  );

  async function runNext(): Promise<{ job: FakeJob; outcome: 'completed' | 'failed' | 'retry' } | null> {
    const job = world.webQueue.next();
    if (!job) return null;
    job.state = 'active';
    try {
      await processor.process(jobFor(world.webQueue, job));
      job.state = 'completed';
      return { job, outcome: 'completed' };
    } catch {
      job.attemptsMade += 1;
      if (job.attemptsMade < Number(job.opts.attempts ?? 1)) {
        job.state = 'waiting';
        return { job, outcome: 'retry' };
      }
      job.state = 'failed';
      return { job, outcome: 'failed' };
    }
  }

  /** Runs the job through every attempt it has. */
  async function drain(): Promise<void> {
    while (await runNext()) {
      /* until nothing is waiting */
    }
  }

  return { ingest, runNext, drain };
}

/** Fields each pipeline owns. A write outside its own set is a coupling. */
export const GUMLET_FIELDS = [
  'status',
  'gumletAssetId',
  'gumletStatus',
  'gumletError',
  'drmVerifiedAt',
  'processingJobId',
  'processingError',
  'processedAt',
];
export const MOBILE_FIELDS = [
  'mobileStatus',
  'mobileError',
  'mobileJobId',
  'mobileGeneration',
  'mobileRequestedAt',
  'mobileEnqueuedAt',
  'mobileTrigger',
  'mobileProcessingStartedAt',
  'mobileProcessedAt',
  'hlsPrefix',
  'masterPlaylistKey',
];
