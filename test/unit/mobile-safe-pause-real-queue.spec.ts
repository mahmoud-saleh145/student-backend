import { Logger } from '@nestjs/common';
import { Job, Queue, UnrecoverableError, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { spawn } from 'node:child_process';
import net from 'node:net';

import { dueTimeFromDelayedScore, listParkedJobIds } from '../../src/jobs/mobile-park';
import { MobileEncodeScheduler } from '../../src/jobs/processors/mobile-encode-scheduler';
import { MOBILE_MAX_STALLED_COUNT, MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { readPauseState, SCRATCH_PAUSE_KEY, ScratchGuard, writePauseState } from '../../src/jobs/processors/scratch-guard';
import {
  DEFAULT_JOB_OPTIONS,
  MOBILE_JOB_ATTEMPTS,
  MOBILE_JOB_PRIORITY,
  MOBILE_VIDEO_JOBS,
  QUEUE_NAMES,
  type MobileTranscodeJobData,
  type PushJobData,
  type TranscodeJobData,
} from '../../src/jobs/queue.constants';
import { TRANSCODE_BACKOFF_BASE_MS, TRANSCODE_BACKOFF_JITTER } from '../../src/jobs/queue.tuning';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { NewVideoAnnouncer } from '../../src/modules/videos/new-video-announcer.service';
import { mobileJobIdFor } from '../../src/modules/videos/pipeline-state';
import { VideoPipelineReconciler } from '../../src/modules/videos/video-pipeline-reconciler.service';
import { VideosService } from '../../src/modules/videos/videos.service';
import { RedisService } from '../../src/redis/redis.service';

import { FakeDb, FakeStorage, videoRow } from './support/pipeline-fakes';

/**
 * SAFE PAUSE ON REAL BULLMQ 5.81.3.
 *
 * The real processor, the real ScratchGuard (pause flag), the real encode
 * scheduler and slot, the real VideosService transitions and claims, real
 * BullMQ queues and workers. Only ffmpeg (a 100 ms fake encode) and the
 * database (FakeDb) are replaced. Jobs are production-shaped: historical
 * `migration` jobs at priority 10, 2 attempts, exponential backoff, ids
 * `mobile-hls:<videoId>:<timestamp>`, two of them with an attempt already used
 * and one with a stall already counted, plus two failed jobs.
 *
 * ENVIRONMENT
 *   SAFE_PAUSE_TEST_REDIS_URL            the Redis to run against. Must be local, unless
 *   SAFE_PAUSE_TEST_ALLOW_REMOTE=disposable  is also set AND that database is EMPTY (DBSIZE 0)
 *                                        when the suite starts (a throw-away cloud DB). redis:// and
 *                                        rediss:// (TLS), with username/password, are supported.
 *                                        The proxy scenarios (S5, S8) are skipped on TLS.
 *   SAFE_PAUSE_TEST_PERSISTENT_REDIS_URL + SAFE_PAUSE_TEST_PERSISTENT_START_CMD
 *                                        S9 only: a LOCAL Redis with persistence on, and the shell
 *                                        command that starts it again on the same port and data dir.
 *                                        S9 shuts it down (SHUTDOWN SAVE) and restarts it.
 *
 * Every key is under a prefix unique to the test and deleted afterwards.
 */
const MAIN_URL = process.env.SAFE_PAUSE_TEST_REDIS_URL;
const PERSIST_URL = process.env.SAFE_PAUSE_TEST_PERSISTENT_REDIS_URL;
const PERSIST_START = process.env.SAFE_PAUSE_TEST_PERSISTENT_START_CMD;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const isLocal = (url: string) => LOCAL_HOSTS.includes(new URL(url).hostname);
const enabled = (() => {
  if (!MAIN_URL) return false;
  if (!isLocal(MAIN_URL) && process.env.SAFE_PAUSE_TEST_ALLOW_REMOTE !== 'disposable') {
    throw new Error(
      'SAFE_PAUSE_TEST_REDIS_URL must point at a LOCAL Redis (a remote one only with ' +
        'SAFE_PAUSE_TEST_ALLOW_REMOTE=disposable, and only when it is empty)',
    );
  }
  // A remote database is reached over TLS only: a plain redis:// URL would send the password in clear.
  if (!isLocal(MAIN_URL) && new URL(MAIN_URL).protocol !== 'rediss:') {
    throw new Error('a remote SAFE_PAUSE_TEST_REDIS_URL must use rediss:// (TLS); refusing plaintext');
  }
  if (PERSIST_URL && !isLocal(PERSIST_URL)) throw new Error('SAFE_PAUSE_TEST_PERSISTENT_REDIS_URL must be LOCAL');
  return true;
})();
const REMOTE = enabled && !isLocal(MAIN_URL!);
const TLS = enabled && new URL(MAIN_URL!).protocol === 'rediss:';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return Date.now() - start;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const YEAR = 365 * 24 * 3600_000;
const DEFER_MS = 200;
const ADMIN = { id: 'admin_1', role: 'ADMIN' as never };
const STAFF = { id: 'staff_1', role: 'TEACHER' as never };

/** ioredis/BullMQ options for a URL (redis:// or rediss://, user and password), optionally via a local proxy port. */
function connectionFor(url: string, viaPort?: number) {
  const u = new URL(url);
  return {
    host: viaPort ? '127.0.0.1' : u.hostname.replace(/^\[|\]$/g, ''),
    port: viaPort ?? Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}
/** The same URL with its host:port replaced by a local proxy port. */
function urlVia(url: string, port?: number): string {
  if (!port) return url;
  const u = new URL(url);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  return u.toString();
}

/** A TCP proxy that can drop every connection and refuse new ones for a while. */
class FlakyProxy {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  down = false;
  drops = 0;

  constructor(private readonly target: { host: string; port: number }) {}

  async listen(): Promise<number> {
    this.server = net.createServer((client) => {
      if (this.down) {
        client.destroy();
        return;
      }
      const upstream = net.connect(this.target.port, this.target.host);
      const pair = [client, upstream];
      const cleanup = () => {
        for (const s of pair) {
          s.destroy();
          this.sockets.delete(s);
        }
      };
      for (const s of pair) {
        this.sockets.add(s);
        s.on('error', cleanup);
        s.on('close', cleanup);
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as net.AddressInfo).port;
  }

  dropAll(): void {
    this.drops += 1;
    for (const s of [...this.sockets]) s.destroy();
    this.sockets.clear();
  }

  /** Cut: drop everything and refuse new connections until `restore()`. */
  cut(): void {
    this.down = true;
    this.dropAll();
  }

  restore(): void {
    this.down = false;
  }

  /** Every `everyMs`: drop all connections and refuse new ones for `downMs`. */
  chaos(everyMs: number, downMs: number): () => void {
    const timer = setInterval(() => {
      this.dropAll();
      this.down = true;
      setTimeout(() => (this.down = false), downMs);
    }, everyMs);
    return () => {
      clearInterval(timer);
      this.down = false;
    };
  }

  async close(): Promise<void> {
    this.dropAll();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

interface Snapshot {
  ats: number;
  atm: number;
  stc: number;
  data: string;
  opts: string;
  priority: string | undefined;
}

/** One Redis server and the API-side connections to it. */
interface Server {
  url: string;
  raw: IORedis;
  apiRedis: RedisService;
  webQueue: Queue<TranscodeJobData>;
  mobileQueue: Queue<MobileTranscodeJobData>;
  pushQueue: Queue<PushJobData>;
}

(enabled ? describe : describe.skip)('safe pause on real BullMQ queues', () => {
  jest.setTimeout(240_000);

  let seq = 0;
  let prefix = '';
  let bullPrefix = '';
  let srv: Server;
  let encodes: Array<{ videoId: string; jobId: string; trigger: string }>;
  const stops: Array<() => Promise<void>> = [];

  const target = () => {
    const c = connectionFor(srv.url);
    return { host: c.host, port: c.port };
  };
  const conn = (viaPort?: number) => connectionFor(srv.url, viaPort);
  const jobKey = (id: string) => `${bullPrefix}:${QUEUE_NAMES.mobileVideo}:${id}`;
  const pauseKey = () => `${prefix}:${SCRATCH_PAUSE_KEY}`;

  async function connect(url: string): Promise<Server> {
    const bull = { connection: connectionFor(url), prefix: bullPrefix };
    const s: Server = {
      url,
      raw: new IORedis(connectionFor(url)),
      apiRedis: new RedisService({ getOrThrow: () => ({ url, prefix }) } as never),
      webQueue: new Queue(QUEUE_NAMES.video, bull),
      mobileQueue: new Queue(QUEUE_NAMES.mobileVideo, bull),
      pushQueue: new Queue(QUEUE_NAMES.push, bull),
    };
    await s.apiRedis.onModuleInit();
    await Promise.all([s.webQueue.waitUntilReady(), s.mobileQueue.waitUntilReady(), s.pushQueue.waitUntilReady()]);
    return s;
  }

  async function disconnect(s: Server): Promise<void> {
    await Promise.all([s.webQueue.close(), s.mobileQueue.close(), s.pushQueue.close()]).catch(() => undefined);
    await s.apiRedis.onModuleDestroy();
    await s.raw.quit().catch(() => undefined);
  }

  async function stopAll(): Promise<void> {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => undefined);
  }

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    if (REMOTE) {
      // A remote database is used only when it is a disposable, EMPTY one.
      const probe = new IORedis(connectionFor(MAIN_URL!));
      try {
        const size = await probe.dbsize();
        if (size !== 0) throw new Error(`refusing to run against a remote Redis that is not empty (DBSIZE ${size})`);
      } finally {
        await probe.quit().catch(() => undefined);
      }
    }
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (REMOTE) {
      const probe = new IORedis(connectionFor(MAIN_URL!));
      try {
        expect(await probe.dbsize()).toBe(0);
      } finally {
        await probe.quit().catch(() => undefined);
      }
    }
  });

  beforeEach(async () => {
    seq += 1;
    prefix = `edutest-safepause-${Date.now()}-${seq}`;
    bullPrefix = `${prefix}:bull`;
    encodes = [];
    srv = await connect(MAIN_URL!);
  });

  afterEach(async () => {
    await stopAll();
    await srv.apiRedis.delByPattern('*');
    const left = await srv.raw.keys(`${prefix}*`);
    await disconnect(srv);
    expect(left).toEqual([]);
  });

  // --- the API process (VideosService over a fake database, real queues + Redis)

  function world(rows: Parameters<typeof videoRow>[0][], opts: { db?: FakeDb; realAnnouncer?: boolean } = {}) {
    const db = opts.db ?? new FakeDb(rows.map((r) => videoRow(r)));
    const storage = new FakeStorage();
    for (const row of db.rows.values()) if (row.sourceKey) storage.objects.set(row.sourceKey as string, 1_000_000);
    const config = {
      getOrThrow: () => ({
        ladder: [480, 720],
        encryptionEnabled: true,
        workDir: `/tmp/${prefix}`,
        mobile: { delivery: 'hls', gumletFallback: true, autoProcess: true, hlsMinBuild: { android: null, ios: null } },
        // Switched ON where the real announcer is used, so a regression would actually send.
        newVideoNotifications: opts.realAnnouncer === true,
        drm: { enabled: true, provider: 'gumlet', gumlet: {} },
      }),
    };
    // The REAL notification service (writing to the fake database and the
    // real push queue) and the REAL announcer, when asked for.
    const notifications = opts.realAnnouncer
      ? new NotificationsService(db as never, srv.pushQueue as never, { get: () => undefined } as never)
      : ({ notifyCourseStudents: async () => undefined } as unknown as NotificationsService);
    let announcer: NewVideoAnnouncer | undefined;
    if (opts.realAnnouncer) {
      const access = new CourseAccessService(db as never, {} as never, {} as never);
      access.targetingEnforced = false;
      announcer = new NewVideoAnnouncer(db as never, notifications, access, config as never, srv.apiRedis);
    }
    const videos = new VideosService(
      db as never,
      storage as never,
      { assertCanManageCourse: async () => undefined, assertTeacherCapability: async () => undefined } as never,
      { recountCourse: async () => undefined } as never,
      notifications as never,
      { record: async () => undefined } as never,
      srv.apiRedis as never,
      srv.webQueue as never,
      config as never,
      {} as never,
      { sync: async () => undefined } as never,
      srv.mobileQueue as never,
      announcer,
    );
    return { db, storage, videos, notifications, announcer };
  }
  type World = ReturnType<typeof world>;

  // --- the encoding machine (its own connections, optionally through a proxy)

  async function startWorker(
    w: World,
    opts: {
      /** Everything the worker opens goes through this proxy port. */
      port?: number;
      /** Only the app's own Redis client (RedisService: pause flag, slot) goes through this proxy port. */
      appRedisPort?: number;
      reconcileMs?: number;
      startReconciler?: boolean;
    } = {},
  ): Promise<{ stop: (force?: boolean) => Promise<void>; worker: Worker; processor: MobileVideoProcessor; workerRedis: RedisService }> {
    const appUrl = urlVia(srv.url, opts.appRedisPort ?? opts.port);
    const workerRedis = new RedisService({ getOrThrow: () => ({ url: appUrl, prefix }) } as never);
    await workerRedis.onModuleInit();
    const config = { getOrThrow: () => ({ workDir: `/tmp/${prefix}`, minFreeBytes: 0, diskCheckSeconds: 15 }) };
    const guard = new ScratchGuard(workerRedis, config as never);
    const workerWeb = new Queue<TranscodeJobData>(QUEUE_NAMES.video, { connection: conn(opts.port), prefix: bullPrefix });
    const workerMobile = new Queue<MobileTranscodeJobData>(QUEUE_NAMES.mobileVideo, { connection: conn(opts.port), prefix: bullPrefix });
    workerWeb.on('error', () => undefined);
    workerMobile.on('error', () => undefined);
    const scheduler = new MobileEncodeScheduler(workerWeb as never, workerRedis);
    let current: Job<MobileTranscodeJobData> | null = null;
    const transcoder = {
      preflight: async () => ({
        sourceMissing: false,
        sourceBytes: 1,
        budgetBytes: 1,
        assessment: { ok: true, freeBytes: 1e12, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 },
      }),
      run: async ({ videoId }: { videoId: string }) => {
        encodes.push({ videoId, jobId: String(current?.id), trigger: String(current?.data.trigger) });
        await sleep(100);
        return {
          probe: { durationSeconds: 60, width: 1280, height: 720, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
          renditions: [{ height: 720, width: 1280, bitrateKbps: 2300, playlistKey: `hls/${videoId}/720p/index.m3u8`, sizeBytes: 1 }],
          hlsPrefix: `hls/${videoId}/`,
          masterPlaylistKey: `hls/${videoId}/master.m3u8`,
          thumbnailKey: undefined,
          isEncrypted: true,
        };
      },
    };
    const processor = new MobileVideoProcessor(transcoder as never, w.videos, config as never, guard, scheduler, workerMobile);
    const internals = processor as unknown as { deferMs: Record<string, number>; pauseReconcileMs: number };
    internals.deferMs = { paused: DEFER_MS, uploads: DEFER_MS, disk: DEFER_MS, slot: DEFER_MS };
    internals.pauseReconcileMs = opts.reconcileMs ?? 60_000;
    if (opts.startReconciler) processor.startPauseReconciler();
    const worker = new Worker<MobileTranscodeJobData>(
      QUEUE_NAMES.mobileVideo,
      async (job, token) => {
        current = job;
        return processor.process(job, token);
      },
      {
        connection: conn(opts.port),
        prefix: bullPrefix,
        concurrency: 1,
        drainDelay: 1,
        lockDuration: 4_000,
        stalledInterval: 1_000,
        maxStalledCount: MOBILE_MAX_STALLED_COUNT,
      },
    );
    worker.on('error', () => undefined);
    let stopped = false;
    const stop = async (force = false) => {
      if (stopped) return;
      stopped = true;
      processor.onModuleDestroy();
      await worker.close(force).catch(() => undefined);
      await Promise.all([workerWeb.close(), workerMobile.close()]).catch(() => undefined);
      await workerRedis.onModuleDestroy();
    };
    stops.push(stop);
    await worker.waitUntilReady();
    return { stop, worker, processor, workerRedis };
  }

  // --- production-shaped jobs

  const historicalRows = (n = 6) =>
    Array.from({ length: n }, (_v, i) => {
      const id = `hist_${i + 1}`;
      return {
        id,
        lessonId: `lesson_${id}`,
        lessonLinks: [{ lessonId: `lesson_${id}` }],
        sourceKey: `source/videos/${id}/a.mp4`,
        sourceSizeBytes: BigInt(300_000_000),
        status: 'READY',
        durationSeconds: 2800,
        mobileStatus: 'QUEUED',
        mobileJobId: `mobile-hls:${id}:${1794847870655 + i}`,
        mobileGeneration: 0,
        mobileTrigger: 'migration',
        mobileEnqueuedAt: new Date('2026-11-16T20:00:00Z'),
      };
    });

  const productionOpts = (jobId: string, extra: Record<string, unknown> = {}) => ({
    ...DEFAULT_JOB_OPTIONS,
    attempts: MOBILE_JOB_ATTEMPTS,
    backoff: { type: 'exponential' as const, delay: TRANSCODE_BACKOFF_BASE_MS, jitter: TRANSCODE_BACKOFF_JITTER },
    jobId,
    priority: MOBILE_JOB_PRIORITY.migration,
    ...extra,
  });

  const jobData = (row: Record<string, unknown>) => ({
    videoId: String(row.id),
    sourceKey: String(row.sourceKey),
    ladder: [480, 720],
    encrypt: true,
    durationSeconds: 2800,
    trigger: 'migration' as const,
    requestedById: 'admin_1',
  });

  /** The six held historical jobs, as production has them (atm=1 on two, stc=1 on one). */
  async function seedHistorical(w: World, extra: Record<string, unknown> = {}): Promise<string[]> {
    const ids: string[] = [];
    for (const row of w.db.rows.values()) {
      if (!String(row.id).startsWith('hist_')) continue;
      const jobId = String(row.mobileJobId);
      await srv.mobileQueue.add(MOBILE_VIDEO_JOBS.transcode, jobData(row), productionOpts(jobId, extra));
      ids.push(jobId);
    }
    await srv.raw.hset(jobKey(ids[0]), 'atm', 1);
    await srv.raw.hset(jobKey(ids[1]), 'atm', 1);
    await srv.raw.hset(jobKey(ids[2]), 'stc', 1);
    return ids;
  }

  /** Fails the given jobs for good (the queue must hold nothing else that is due). */
  async function failJobs(count: number): Promise<void> {
    const failer = new Worker(
      QUEUE_NAMES.mobileVideo,
      async () => {
        throw new UnrecoverableError('Source object source/gone.mp4 is missing from storage');
      },
      { connection: conn(), prefix: bullPrefix, concurrency: 1, drainDelay: 1 },
    );
    failer.on('error', () => undefined);
    await until(async () => (await srv.mobileQueue.getFailedCount()) === count, `${count} failed jobs`);
    await failer.close();
  }

  /** Two jobs that failed for good before any of this (they must stay exactly as they are). */
  async function seedFailed(): Promise<string[]> {
    const ids = ['mobile-hls:failed_1:1794000000001', 'mobile-hls:failed_2:1794000000002'];
    for (const id of ids) {
      await srv.mobileQueue.add(
        MOBILE_VIDEO_JOBS.transcode,
        { videoId: id.split(':')[1], sourceKey: 'source/gone.mp4', ladder: [480], encrypt: true, trigger: 'migration' },
        productionOpts(id, { attempts: 1 }),
      );
    }
    await failJobs(2);
    return ids;
  }

  async function snap(id: string): Promise<Snapshot> {
    const h = await srv.raw.hgetall(jobKey(id));
    return {
      ats: Number(h.ats ?? 0),
      atm: Number(h.atm ?? 0),
      stc: Number(h.stc ?? 0),
      data: h.data,
      opts: h.opts,
      priority: h.priority,
    };
  }
  const snapAll = async (ids: string[]) => Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await snap(id)])));
  const stateOf = async (id: string) => (await srv.mobileQueue.getJob(id))!.getState();
  const parkedIds = async () => new Set(await listParkedJobIds(srv.mobileQueue));
  const delayedScores = async (ids: string[]) =>
    Object.fromEntries(
      await Promise.all(ids.map(async (id) => [id, await srv.raw.zscore(`${bullPrefix}:${QUEUE_NAMES.mobileVideo}:delayed`, id)])),
    );
  const encodesOf = (videoId: string) => encodes.filter((e) => e.videoId === videoId);
  const warnings = () => (Logger.prototype.warn as jest.Mock).mock.calls.map((c) => String(c[0]));

  /** From a full pause to a historical hold: every historical job parked after one take. */
  async function reachHistoricalHold(w: World, ids: string[], workerOpts: Parameters<typeof startWorker>[1] = {}) {
    await w.videos.setMobileProcessingPaused(true, ADMIN, 'laptop on a metered connection', 'all');
    const worker = await startWorker(w, workerOpts);
    await sleep(4 * DEFER_MS);
    const beforeHold = await snapAll(ids);
    await expect(w.videos.setMobileProcessingPaused(true, ADMIN, 'between backlog batches', 'historical')).resolves.toMatchObject({
      scope: 'historical',
      queuePaused: false,
    });
    await until(async () => {
      const parked = await parkedIds();
      return ids.every((id) => parked.has(id));
    }, 'every historical job to be parked', 30_000);
    return { worker, beforeHold };
  }

  /**
   * Production's state on 2026-11-18: a flag WITHOUT scope (written by the
   * old API / watchdog), the queue BullMQ-paused by hand, the six historical
   * jobs prioritized after ~1940 takes each, two failed jobs.
   */
  async function productionState(w: World): Promise<{ ids: string[]; failed: string[] }> {
    const failed = await seedFailed();
    const ids = await seedHistorical(w);
    for (const [i, id] of ids.entries()) await srv.raw.hset(jobKey(id), 'ats', 1938 + i);
    await srv.raw.set(pauseKey(), JSON.stringify({ reason: 'held after network failures', by: 'admin_1', at: '2026-11-17T09:00:00Z' }));
    await srv.mobileQueue.pause();
    return { ids, failed };
  }

  // -------------------------------------------------------------------------

  it('S1 full pause: no job is taken across many defer cycles, nor after a worker restart', async () => {
    const w = world(historicalRows());
    const failed = await seedFailed();
    const ids = await seedHistorical(w);
    const seeded = await snapAll([...ids, ...failed]);

    await expect(w.videos.setMobileProcessingPaused(true, ADMIN, 'metered', 'all')).resolves.toMatchObject({
      paused: true,
      queuePaused: true,
    });
    expect(await srv.mobileQueue.isPaused()).toBe(true);

    const first = await startWorker(w, { startReconciler: true, reconcileMs: 250 });
    await sleep(12 * DEFER_MS);
    expect(await snapAll([...ids, ...failed])).toEqual(seeded);

    await first.stop();
    await startWorker(w, { startReconciler: true, reconcileMs: 250 });
    await sleep(12 * DEFER_MS);

    expect(await snapAll([...ids, ...failed])).toEqual(seeded);
    expect(encodes).toEqual([]);
    for (const id of ids) expect(await stateOf(id)).toBe('prioritized');
    for (const id of failed) expect(await stateOf(id)).toBe('failed');
    expect(await srv.mobileQueue.isPaused()).toBe(true);
  });

  it('S2 a watchdog writes only the flag (no scope): the reconciler pauses the queue within one interval; at most one take per job', async () => {
    const w = world(historicalRows());
    // Not due yet when the flag is written, so only the reconciler can stop them.
    const ids = await seedHistorical(w, { delay: 2_000 });
    const seeded = await snapAll(ids);
    const first = await startWorker(w, { startReconciler: true, reconcileMs: 300 });
    await sleep(100);

    await srv.raw.set(
      pauseKey(),
      JSON.stringify({ reason: 'auto-paused by safety watchdog: 600 s outage', by: 'safety-watchdog', at: new Date().toISOString() }),
    );
    const tookMs = await until(() => srv.mobileQueue.isPaused(), 'the reconciler to pause the queue', 5_000);
    expect(tookMs).toBeLessThan(300 + 700);

    await sleep(2_500); // the jobs come due behind a paused queue
    let now = await snapAll(ids);
    for (const id of ids) {
      expect(now[id].ats).toBe(seeded[id].ats);
      expect({ ...now[id], ats: 0 }).toEqual({ ...seeded[id], ats: 0 });
    }
    expect(encodes).toEqual([]);

    // Someone resumes the queue behind the flag's back, on a worker whose
    // reconciler has not run yet: the first job taken pauses the queue again.
    await first.stop();
    await startWorker(w, { startReconciler: false });
    await srv.mobileQueue.resume();
    await until(() => srv.mobileQueue.isPaused(), 'the gate to pause the queue again', 10_000);
    await sleep(6 * DEFER_MS);

    now = await snapAll(ids);
    const takes = ids.map((id) => now[id].ats - seeded[id].ats);
    for (const t of takes) expect(t).toBeLessThanOrEqual(1);
    expect(takes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1);
    for (const id of ids) expect([now[id].atm, now[id].stc]).toEqual([seeded[id].atm, seeded[id].stc]);
    expect(encodes).toEqual([]);
  });

  it('S3 full -> historical: each historical job is taken once and parked; a later upload is encoded; parked jobs are not taken again', async () => {
    const rows = [...historicalRows(), { id: 'upload_1', sourceKey: 'source/videos/upload_1/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) }];
    const w = world(rows);
    const failed = await seedFailed();
    const ids = await seedHistorical(w);
    const seeded = await snapAll([...ids, ...failed]);

    const { beforeHold } = await reachHistoricalHold(w, ids);
    for (const id of ids) expect(beforeHold[id]).toEqual(seeded[id]); // nothing taken under the full pause

    const parked = await snapAll(ids);
    const scores = await delayedScores(ids);
    for (const id of ids) {
      expect(parked[id].ats).toBe(seeded[id].ats + 1); // exactly one take
      expect({ ...parked[id], ats: 0 }).toEqual({ ...seeded[id], ats: 0 }); // atm, stc, data, opts, priority unchanged
      expect(dueTimeFromDelayedScore(Number(scores[id]))).toBeGreaterThan(Date.now() + 9 * YEAR);
    }

    await w.videos.enqueueMobileTranscode({ id: 'upload_1', sourceKey: 'source/videos/upload_1/a.mp4' }, 'upload');
    await until(() => w.db.get('upload_1').mobileStatus === 'READY', 'the new upload to be encoded during the hold');
    await sleep(8 * DEFER_MS);

    expect(await snapAll(ids)).toEqual(parked); // not taken again
    expect(await parkedIds()).toEqual(new Set(ids));
    expect(encodes.map((e) => e.videoId)).toEqual(['upload_1']);
    expect(await snapAll(failed)).toEqual(Object.fromEntries(failed.map((id) => [id, seeded[id]])));
  });

  it('S4 release: resume promotes every parked job; each is encoded exactly once with its id, data and options intact', async () => {
    const w = world(historicalRows());
    const failed = await seedFailed();
    const ids = await seedHistorical(w);
    const seeded = await snapAll([...ids, ...failed]);
    await reachHistoricalHold(w, ids);

    await expect(w.videos.setMobileProcessingPaused(false, ADMIN)).resolves.toMatchObject({
      paused: false,
      queuePaused: false,
      parkedPromoted: 6,
    });
    await until(async () => (await Promise.all(ids.map(stateOf))).every((s) => s === 'completed'), 'every released job to finish', 30_000);

    for (const id of ids) {
      const job = (await srv.mobileQueue.getJob(id))!;
      expect(job.id).toBe(id);
      const now = await snap(id);
      expect([now.data, now.opts, now.priority]).toEqual([seeded[id].data, seeded[id].opts, seeded[id].priority]);
      expect(now.stc).toBe(seeded[id].stc);
      expect(job.returnvalue).toEqual({ videoId: job.data.videoId, renditions: 1 });
      expect(encodesOf(job.data.videoId)).toEqual([{ videoId: job.data.videoId, jobId: id, trigger: 'migration' }]);
      expect(w.db.get(job.data.videoId)).toMatchObject({ mobileStatus: 'READY', mobileJobId: id });
    }
    expect(encodes).toHaveLength(6);
    expect(await parkedIds()).toEqual(new Set());
    for (const id of failed) expect(await stateOf(id)).toBe('failed');
    expect(await snapAll(failed)).toEqual(Object.fromEntries(failed.map((id) => [id, seeded[id]])));
  });

  (TLS ? it.skip : it)('S5 Redis connection drops between the worker and Redis: held and parked jobs lose no attempt and no stall', async () => {
    const rows = [...historicalRows(), { id: 'upload_2', sourceKey: 'source/videos/upload_2/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) }];
    const w = world(rows);
    const ids = await seedHistorical(w);
    const seeded = await snapAll(ids);
    const proxy = new FlakyProxy(target());
    const port = await proxy.listen();
    stops.push(() => proxy.close());

    // (a) Under a FULL pause: several seconds of drops, nothing taken at all.
    await w.videos.setMobileProcessingPaused(true, ADMIN, 'metered', 'all');
    await startWorker(w, { port, startReconciler: true, reconcileMs: 250 });
    let stopChaos = proxy.chaos(400, 150);
    await sleep(4_000);
    stopChaos();
    await sleep(1_000);
    expect(await snapAll(ids)).toEqual(seeded);
    expect(encodes).toEqual([]);
    expect(await srv.mobileQueue.isPaused()).toBe(true);
    const dropsInFullPause = proxy.drops;

    // (b) Switching to a HISTORICAL hold while the connection keeps dropping.
    stopChaos = proxy.chaos(450, 150);
    await w.videos.setMobileProcessingPaused(true, ADMIN, 'between batches', 'historical');
    await until(async () => {
      const parked = await parkedIds();
      return ids.every((id) => parked.has(id));
    }, 'every historical job to be parked through the drops', 60_000);
    await w.videos.enqueueMobileTranscode({ id: 'upload_2', sourceKey: 'source/videos/upload_2/a.mp4' }, 'upload');
    await sleep(4_000);
    stopChaos();
    await until(() => w.db.get('upload_2').mobileStatus === 'READY', 'the upload to be encoded once the network settles', 30_000);
    await sleep(2_000);

    const after = await snapAll(ids);
    for (const id of ids) {
      expect(after[id].atm).toBe(seeded[id].atm); // no attempt used
      expect(after[id].stc).toBe(seeded[id].stc); // no stall counted
      expect([after[id].data, after[id].opts]).toEqual([seeded[id].data, seeded[id].opts]);
      expect(await stateOf(id)).toBe('delayed');
    }
    expect(await parkedIds()).toEqual(new Set(ids));
    expect(encodes.map((e) => e.videoId)).toEqual(['upload_2']);
    // For the report: how many takes the drops cost (1 per job is the ideal).
    const takes = Object.fromEntries(ids.map((id) => [id, after[id].ats - seeded[id].ats]));
    console.info(`S5: ${proxy.drops} drops (${dropsInFullPause} under the full pause); takes per parked job: ${JSON.stringify(takes)}`);
    expect(proxy.drops).toBeGreaterThan(10);
  });

  it('S6 no duplicate encodes: a superseded job steps aside, before and after its replacement ran', async () => {
    const row = (id: string, i: number) => ({
      id,
      sourceKey: `source/videos/${id}/a.mp4`,
      sourceSizeBytes: BigInt(1),
      status: 'READY',
      mobileStatus: 'QUEUED',
      mobileJobId: `mobile-hls:${id}:${1794847870700 + i}`,
      mobileGeneration: 0,
      mobileTrigger: 'migration',
      mobileEnqueuedAt: new Date(),
    });
    const w = world([row('dup_a', 1), row('dup_b', 2)]);
    for (const id of ['dup_a', 'dup_b']) {
      const r = w.db.get(id);
      await srv.mobileQueue.add(MOBILE_VIDEO_JOBS.transcode, jobData(r), productionOpts(String(r.mobileJobId)));
    }
    const oldA = String(w.db.get('dup_a').mobileJobId);
    const oldB = String(w.db.get('dup_b').mobileJobId);
    await srv.raw.hset(jobKey(oldA), 'atm', 1); // the worn one
    await srv.raw.hset(jobKey(oldB), 'stc', 1);

    await expect(w.videos.retryMobileProcessing('dup_a', ADMIN, { supersede: true })).resolves.toMatchObject({
      jobId: mobileJobIdFor('dup_a', 1),
      alreadyQueued: false,
    });
    await expect(w.videos.retryMobileProcessing('dup_b', ADMIN, { supersede: true })).resolves.toMatchObject({
      jobId: mobileJobIdFor('dup_b', 1),
    });
    // dup_b: the OLD job runs first (its replacement is moved behind it).
    await (await srv.mobileQueue.getJob(mobileJobIdFor('dup_b', 1)))!.changePriority({ priority: 20 });

    await startWorker(w);
    const done = (id: string) => async () => (await stateOf(id)) === 'completed';
    for (const id of [oldA, oldB, mobileJobIdFor('dup_a', 1), mobileJobIdFor('dup_b', 1)]) {
      await until(done(id), `job ${id} to finish`, 20_000);
    }

    expect((await srv.mobileQueue.getJob(oldA))!.returnvalue).toEqual({ videoId: 'dup_a', skipped: true });
    expect((await srv.mobileQueue.getJob(oldB))!.returnvalue).toEqual({ videoId: 'dup_b', skipped: true });
    expect(encodesOf('dup_a')).toEqual([{ videoId: 'dup_a', jobId: mobileJobIdFor('dup_a', 1), trigger: 'retry' }]);
    expect(encodesOf('dup_b')).toEqual([{ videoId: 'dup_b', jobId: mobileJobIdFor('dup_b', 1), trigger: 'retry' }]);
    expect(w.db.get('dup_a')).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor('dup_a', 1) });
    expect(w.db.get('dup_b')).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor('dup_b', 1) });
    const fresh = await snap(mobileJobIdFor('dup_a', 1));
    expect(fresh.stc).toBe(0);
  });

  it('S7 worker restart during partial processing: parked jobs stay parked, uploads keep flowing', async () => {
    const rows = [
      ...historicalRows(),
      { id: 'upload_3', sourceKey: 'source/videos/upload_3/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) },
      { id: 'upload_4', sourceKey: 'source/videos/upload_4/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) },
    ];
    const w = world(rows);
    const ids = await seedHistorical(w);
    const { worker } = await reachHistoricalHold(w, ids);
    await w.videos.enqueueMobileTranscode({ id: 'upload_3', sourceKey: 'source/videos/upload_3/a.mp4' }, 'upload');
    await until(() => w.db.get('upload_3').mobileStatus === 'READY', 'the first upload');
    const parked = await snapAll(ids);

    await worker.stop();
    await startWorker(w);
    await w.videos.enqueueMobileTranscode({ id: 'upload_4', sourceKey: 'source/videos/upload_4/a.mp4' }, 'upload');
    await until(() => w.db.get('upload_4').mobileStatus === 'READY', 'the upload after the restart');
    await sleep(8 * DEFER_MS);

    expect(await snapAll(ids)).toEqual(parked);
    expect(await parkedIds()).toEqual(new Set(ids));
    expect(encodes.map((e) => e.videoId)).toEqual(['upload_3', 'upload_4']);
    for (const id of ids) expect(w.db.get(id.split(':')[1])).toMatchObject({ mobileStatus: 'QUEUED' });
  });

  (TLS ? it.skip : it)('S8 fail-closed: the app Redis (pause flag) unreadable while BullMQ is healthy -> no encode, deferred, no attempt used', async () => {
    const w = world([
      { id: 'up_set', sourceKey: 'source/videos/up_set/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) },
      { id: 'up_absent', sourceKey: 'source/videos/up_absent/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) },
    ]);
    const proxy = new FlakyProxy(target());
    const port = await proxy.listen();
    stops.push(() => proxy.close());
    // ONLY the worker's RedisService (pause flag, encode slot) goes through the proxy; BullMQ is direct.
    const { workerRedis } = await startWorker(w, { appRedisPort: port });
    (Logger.prototype.warn as jest.Mock).mockClear();

    // (a) The flag IS set (a full pause), and the worker cannot read it.
    await srv.raw.set(pauseKey(), JSON.stringify({ reason: 'metered', by: 'admin_1', at: new Date().toISOString(), scope: 'all' }));
    proxy.cut();
    await w.videos.enqueueMobileTranscode({ id: 'up_set', sourceKey: 'source/videos/up_set/a.mp4' }, 'upload');
    const setJob = String(w.db.get('up_set').mobileJobId);
    await until(() => warnings().some((m) => m.includes('could not read the mobile pause flag')), 'a deferral for an unreadable flag', 20_000);
    await sleep(3_000);
    expect(encodes).toEqual([]);
    let s = await snap(setJob);
    expect([s.atm, s.stc]).toEqual([0, 0]);
    expect(['delayed', 'active', 'waiting']).toContain(await stateOf(setJob));
    expect(w.db.get('up_set')).toMatchObject({ mobileStatus: 'QUEUED' });

    // (b) The flag is ABSENT but just as unreadable: still no encode.
    await srv.raw.del(pauseKey());
    await w.videos.enqueueMobileTranscode({ id: 'up_absent', sourceKey: 'source/videos/up_absent/a.mp4' }, 'upload');
    const absentJob = String(w.db.get('up_absent').mobileJobId);
    await sleep(4_000);
    expect(encodes).toEqual([]);
    for (const id of [setJob, absentJob]) {
      s = await snap(id);
      expect([s.atm, s.stc]).toEqual([0, 0]);
    }

    // THE OLD BEHAVIOUR IS GONE: the lenient read the processor used before
    // this change answers "not paused" through the very same cut client, and
    // the old gate encoded on that answer. The strict read the gate uses now throws.
    await expect(readPauseState(workerRedis)).resolves.toMatchObject({ paused: false });
    await expect(readPauseState(workerRedis, { strict: true })).rejects.toThrow();

    // Connection back, flag absent: both are encoded, once each.
    proxy.restore();
    await until(
      () => w.db.get('up_set').mobileStatus === 'READY' && w.db.get('up_absent').mobileStatus === 'READY',
      'both uploads once the flag is readable again',
      40_000,
    );
    expect(encodesOf('up_set')).toHaveLength(1);
    expect(encodesOf('up_absent')).toHaveLength(1);
    for (const id of [setJob, absentJob]) expect((await snap(id)).stc).toBe(0);
    console.info(`S8: takes while the flag was unreadable: set=${(await snap(setJob)).ats - 1}, absent=${(await snap(absentJob)).ats - 1}`);
  });

  (PERSIST_URL && PERSIST_START ? it : it.skip)(
    'S9 persistence: parked jobs survive a Redis SHUTDOWN SAVE + restart unchanged, are not taken, and are released once each',
    async () => {
      const persistTarget = connectionFor(PERSIST_URL!);
      const listening = () =>
        new Promise<boolean>((resolve) => {
          const sock = net.connect(persistTarget.port, persistTarget.host);
          sock.once('connect', () => (sock.destroy(), resolve(true)));
          sock.once('error', () => resolve(false));
        });
      const startPersistent = async () => {
        spawn(PERSIST_START!, { shell: true, detached: true, stdio: 'ignore', windowsHide: true }).unref();
        await until(listening, 'the persistent Redis to start', 30_000);
        await sleep(500);
      };

      // This scenario runs on the PERSISTENT server (the main one is cleaned and left).
      await stopAll();
      await srv.apiRedis.delByPattern('*');
      expect(await srv.raw.keys(`${prefix}*`)).toEqual([]);
      await disconnect(srv);
      // A server started by an earlier run of this scenario may not have outlived that run.
      if (!(await listening())) await startPersistent();
      srv = await connect(PERSIST_URL!);
      const w = world(historicalRows());
      const failed = await seedFailed();
      const ids = await seedHistorical(w);
      await reachHistoricalHold(w, ids);
      await stopAll();
      const parked = await snapAll([...ids, ...failed]);
      const scores = await delayedScores(ids);

      // Shut the server down WITH a save, then start it again on the same data.
      await disconnect(srv);
      const killer = new IORedis({ ...connectionFor(PERSIST_URL!), retryStrategy: () => null, autoResendUnfulfilledCommands: false });
      await killer.call('SHUTDOWN', 'SAVE').catch(() => undefined);
      killer.disconnect();
      await until(async () => !(await listening()), 'the persistent Redis to stop', 20_000);
      await startPersistent();

      srv = await connect(PERSIST_URL!);
      expect(await snapAll([...ids, ...failed])).toEqual(parked);
      expect(await delayedScores(ids)).toEqual(scores);
      expect(await parkedIds()).toEqual(new Set(ids));
      for (const id of ids) {
        expect(dueTimeFromDelayedScore(Number(scores[id]))).toBeGreaterThan(Date.now() + 9 * YEAR);
        expect(await stateOf(id)).toBe('delayed');
      }
      expect(JSON.parse(String(await srv.raw.get(pauseKey())))).toMatchObject({ scope: 'historical' });

      // A worker started on the restarted server does not take them.
      const w2 = world([], { db: w.db });
      await startWorker(w2);
      await sleep(10 * DEFER_MS);
      expect(await snapAll([...ids, ...failed])).toEqual(parked);
      expect(encodes).toEqual([]);

      // Release: each encoded exactly once.
      await expect(w2.videos.setMobileProcessingPaused(false, ADMIN)).resolves.toMatchObject({ parkedPromoted: 6, queuePaused: false });
      await until(async () => (await Promise.all(ids.map(stateOf))).every((st) => st === 'completed'), 'every released job', 30_000);
      for (const id of ids) {
        const videoId = id.split(':')[1];
        expect(encodesOf(videoId)).toEqual([{ videoId, jobId: id, trigger: 'migration' }]);
      }
      expect(encodes).toHaveLength(6);
    },
  );

  it('S10 batch-5 recovery on real row states under a FULL pause: nothing taken until resume, then each video encoded exactly once, nobody notified', async () => {
    const base = (id: string, i: number, over: Record<string, unknown>) => ({
      id,
      lessonId: `lesson_${id}`,
      lessonLinks: [{ lessonId: `lesson_${id}` }],
      sourceKey: `source/videos/${id}/a.mp4`,
      sourceSizeBytes: BigInt(300_000_000),
      status: 'READY',
      gumletAssetId: `asset_${id}`,
      gumletStatus: 'ready',
      durationSeconds: 2800,
      mobileJobId: `mobile-hls:${id}:${1794900000000 + i}`,
      mobileGeneration: 0,
      mobileTrigger: 'migration',
      mobileEnqueuedAt: new Date('2026-11-16T20:00:00Z'),
      ...over,
    });
    const rows = [
      // Failed for good: atm 2 of 2, row FAILED.
      base('fail_1', 1, { mobileStatus: 'FAILED', mobileError: 'Attempt 2 of 2 failed (socket hang up)' }),
      base('fail_2', 2, { mobileStatus: 'FAILED', mobileError: 'Attempt 2 of 2 failed (ECONNRESET)' }),
      // First attempt failed (an older worker wrote FAILED at once); the retry is pending in the delayed set.
      base('half_1', 3, { mobileStatus: 'FAILED', mobileError: 'socket hang up' }),
      base('half_2', 4, { mobileStatus: 'FAILED', mobileError: 'ECONNRESET' }),
      // Held, one stall already counted, row QUEUED.
      base('stalled_1', 5, { mobileStatus: 'QUEUED' }),
      // Held and healthy.
      base('ok_1', 6, { mobileStatus: 'QUEUED' }),
      base('ok_2', 7, { mobileStatus: 'QUEUED' }),
      base('ok_3', 8, { mobileStatus: 'QUEUED' }),
    ];
    const w = world(rows, { realAnnouncer: true });
    const createOnce = jest.spyOn(w.notifications, 'createOnce');
    const onFirstPlayable = jest.spyOn(w.announcer!, 'onFirstPlayable');
    const settle = jest.spyOn(w.announcer!, 'settle');
    // The ORIGINAL job ids, captured now: the rows will name the new generation later.
    const originalIds = new Map(rows.map((r) => [r.id, r.mobileJobId]));
    const old = (id: string) => originalIds.get(id)!;

    for (const id of ['fail_1', 'fail_2']) {
      await srv.mobileQueue.add(MOBILE_VIDEO_JOBS.transcode, jobData(w.db.get(id)), productionOpts(old(id)));
    }
    await failJobs(2);
    for (const id of ['fail_1', 'fail_2']) await srv.raw.hset(jobKey(old(id)), 'atm', 2, 'ats', 2);
    for (const id of ['half_1', 'half_2']) {
      await srv.mobileQueue.add(MOBILE_VIDEO_JOBS.transcode, jobData(w.db.get(id)), productionOpts(old(id), { delay: 3_000 }));
      await srv.raw.hset(jobKey(old(id)), 'atm', 1, 'ats', 1);
    }
    for (const id of ['stalled_1', 'ok_1', 'ok_2', 'ok_3']) {
      await srv.mobileQueue.add(MOBILE_VIDEO_JOBS.transcode, jobData(w.db.get(id)), productionOpts(old(id)));
    }
    await srv.raw.hset(jobKey(old('stalled_1')), 'stc', 1);
    const oldIds = rows.map((r) => r.mobileJobId);
    const seeded = await snapAll(oldIds);
    const failedBefore = await Promise.all(['fail_1', 'fail_2'].map((id) => srv.raw.hgetall(jobKey(old(id)))));

    // FULL pause, worker running.
    await w.videos.setMobileProcessingPaused(true, ADMIN, 'batch 5 recovery', 'all');
    await startWorker(w, { startReconciler: true, reconcileMs: 250 });

    // Staff retry of the four FAILED rows; supersede of the stalled one.
    for (const id of ['fail_1', 'fail_2', 'half_1', 'half_2']) {
      await expect(w.videos.retryMobileProcessing(id, STAFF)).resolves.toMatchObject({ jobId: mobileJobIdFor(id, 1), alreadyQueued: false });
    }
    await expect(w.videos.retryMobileProcessing('stalled_1', ADMIN, { supersede: true })).resolves.toMatchObject({
      jobId: mobileJobIdFor('stalled_1', 1),
      alreadyQueued: false,
    });
    const newIds = ['fail_1', 'fail_2', 'half_1', 'half_2', 'stalled_1'].map((id) => mobileJobIdFor(id, 1));
    for (const id of newIds) expect(await srv.mobileQueue.getJob(id)).toBeTruthy();

    await sleep(4_000); // the half_* retries come due behind the paused queue
    expect(encodes).toEqual([]);
    const held = await snapAll([...oldIds, ...newIds]);
    for (const id of oldIds) expect(held[id]).toEqual(seeded[id]);
    for (const id of newIds) expect(held[id].ats).toBe(0);
    expect(await srv.mobileQueue.isPaused()).toBe(true);

    // Resume: every video is encoded exactly once.
    await expect(w.videos.setMobileProcessingPaused(false, ADMIN)).resolves.toMatchObject({ queuePaused: false, parkedPromoted: 0 });
    await until(() => rows.every((r) => w.db.get(r.id).mobileStatus === 'READY'), 'all eight videos READY', 40_000);
    const settled = async () =>
      (await Promise.all([...newIds, ...['half_1', 'half_2', 'stalled_1', 'ok_1', 'ok_2', 'ok_3'].map(old)].map(stateOf))).every(
        (st) => st === 'completed',
      );
    await until(settled, 'every live job (old and new) to finish', 40_000);

    for (const r of rows) expect(encodesOf(r.id)).toHaveLength(1);
    expect(encodes).toHaveLength(8);
    for (const id of ['fail_1', 'fail_2', 'half_1', 'half_2', 'stalled_1']) {
      expect(encodesOf(id)[0]).toMatchObject({ jobId: mobileJobIdFor(id, 1), trigger: 'retry' });
      expect(w.db.get(id)).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor(id, 1) });
    }
    for (const id of ['ok_1', 'ok_2', 'ok_3']) expect(encodesOf(id)[0]).toMatchObject({ jobId: old(id), trigger: 'migration' });
    // The superseded / overtaken old jobs stepped aside.
    for (const id of ['half_1', 'half_2', 'stalled_1']) {
      expect((await srv.mobileQueue.getJob(old(id)))!.returnvalue).toEqual({ videoId: id, skipped: true });
    }
    // The old FAILED job records are exactly as they were.
    expect(await Promise.all(['fail_1', 'fail_2'].map((id) => srv.raw.hgetall(jobKey(old(id)))))).toEqual(failedBefore);
    for (const id of ['fail_1', 'fail_2']) expect(await stateOf(old(id))).toBe('failed');

    // Nobody was told anything: these lectures were already playable on the web.
    const push = await srv.pushQueue.getJobCounts();
    expect(Object.values(push).reduce((a, b) => a + b, 0)).toBe(0);
    expect(createOnce).not.toHaveBeenCalled();
    expect(onFirstPlayable).not.toHaveBeenCalled();
    expect(w.db.notifications).toEqual([]);
    // markMobileReady settles (and finds nothing owed) for each web-READY lecture; that is the only announcer call.
    expect(settle).toHaveBeenCalledTimes(8);
    for (const r of rows) expect(w.db.get(r.id).newVideoAnnounceState ?? null).toBeNull();
  });

  it('C1 compatibility: NEW worker + OLD API (flag-only pause/resume) on production state -> nothing is ever taken', async () => {
    const w = world(historicalRows());
    const { ids, failed } = await productionState(w);
    const prod = await snapAll([...ids, ...failed]);
    const unchanged = async (what: string) => {
      await sleep(10 * DEFER_MS);
      expect({ what, jobs: await snapAll([...ids, ...failed]) }).toEqual({ what, jobs: prod });
      expect({ what, paused: await srv.mobileQueue.isPaused() }).toEqual({ what, paused: true });
      expect({ what, encodes }).toEqual({ what, encodes: [] });
    };

    let worker = await startWorker(w, { startReconciler: true, reconcileMs: 250 });
    await unchanged('new worker on production state');

    // The deployed API (eb0e29a) only writes/deletes the flag; it never touches the queue.
    await writePauseState(srv.apiRedis, false, 'admin_1');
    await unchanged('old-API resume (flag deleted)');

    await worker.stop();
    worker = await startWorker(w, { startReconciler: true, reconcileMs: 250 });
    await unchanged('worker restart after the old-API resume');

    await writePauseState(srv.apiRedis, true, 'admin_1', 'between batches', 'historical');
    await unchanged('old-API pause historical');

    await srv.raw.set(pauseKey(), JSON.stringify({ reason: 'pause again', by: 'admin_1', at: new Date().toISOString() }));
    await unchanged('old-API pause without scope');

    await worker.stop();
    await startWorker(w, { startReconciler: true, reconcileMs: 250 });
    await unchanged('worker restart at the end');
    for (const id of ids) expect(await stateOf(id)).toBe('prioritized');
  });

  it('C2 API after worker: constructing and booting the NEW API changes nothing on its own', async () => {
    const seedWorld = world(historicalRows());
    const { ids, failed } = await productionState(seedWorld);
    const prod = await snapAll([...ids, ...failed]);
    const flagBefore = await srv.raw.get(pauseKey());
    const spies = [
      jest.spyOn(srv.mobileQueue, 'pause'),
      jest.spyOn(srv.mobileQueue, 'resume'),
      jest.spyOn(srv.mobileQueue, 'add'),
      jest.spyOn(Job.prototype, 'promote'),
      jest.spyOn(srv.apiRedis, 'setJsonPersistent'),
      jest.spyOn(srv.apiRedis, 'setJsonPersistentOrThrow'),
      jest.spyOn(srv.apiRedis, 'del'),
      jest.spyOn(srv.apiRedis, 'delOrThrow'),
    ];
    try {
      // The API process comes up: a NEW VideosService and its reconciler, booted and scanning once.
      const api = world([], { db: seedWorld.db });
      const reconciler = new VideoPipelineReconciler(api.videos);
      reconciler.onApplicationBootstrap();
      await reconciler.tick();
      reconciler.onModuleDestroy();
      await sleep(500);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
      expect(await srv.raw.get(pauseKey())).toBe(flagBefore);
      expect(await srv.mobileQueue.isPaused()).toBe(true);
      expect(await snapAll([...ids, ...failed])).toEqual(prod);
      for (const id of ids) expect(await stateOf(id)).toBe('prioritized');
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
