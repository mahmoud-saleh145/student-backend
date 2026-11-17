import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { ScratchGuard, writePauseState } from '../../src/jobs/processors/scratch-guard';
import { QUEUE_NAMES, type MobileTranscodeJobData, type TranscodeJobData } from '../../src/jobs/queue.constants';
import { mobileJobIdFor, uploadTranscodeJobIdFor } from '../../src/modules/videos/pipeline-state';
import { QUEUE_OPERATION_TIMEOUT_MS, VideosService } from '../../src/modules/videos/videos.service';
import { RedisService } from '../../src/redis/redis.service';

import { FakeDb, FakeRedis, FakeStorage, STAFF, videoRow } from './support/pipeline-fakes';

/**
 * THE SAME GUARANTEES, ON REAL BULLMQ
 *
 * The scenario suite (dual-pipeline-independence.spec.ts) uses an in-memory
 * queue that imitates the BullMQ behaviour the design leans on. This file
 * checks that BullMQ really behaves that way, against a real Redis:
 *
 *   - the deterministic job ids are ids BullMQ accepts;
 *   - adding an id that exists is one job, however many times it is added;
 *   - a job enqueued while NO worker is running waits, and is picked up when
 *     a worker starts (the encoding machine was off);
 *   - a job whose worker dies mid-encode is handed back by the stalled check
 *     and finished by the next worker;
 *   - a Redis that does not answer cannot hang an upload.
 *
 * Runs only when PIPELINE_TEST_REDIS_URL points at a LOCAL Redis. Every key is
 * under a prefix unique to the run and removed afterwards.
 */
const REDIS_URL = process.env.PIPELINE_TEST_REDIS_URL;
const enabled = (() => {
  if (!REDIS_URL) return false;
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(REDIS_URL).hostname)) {
    throw new Error('PIPELINE_TEST_REDIS_URL must point at a LOCAL Redis');
  }
  return true;
})();

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

(enabled ? describe : describe.skip)('dual pipeline on real BullMQ queues (local Redis)', () => {
  jest.setTimeout(90_000);

  const prefix = `edutest-dual-${Date.now()}`;
  const connection = (() => {
    const u = new URL(REDIS_URL ?? 'redis://localhost:6379');
    return { host: u.hostname, port: Number(u.port || 6379), maxRetriesPerRequest: null, enableReadyCheck: false };
  })();
  const bull = { connection, prefix: `${prefix}:bull` };

  let webQueue: Queue<TranscodeJobData>;
  let mobileQueue: Queue<MobileTranscodeJobData>;
  const workers: Worker[] = [];

  function world(rows: Parameters<typeof videoRow>[0][], queues?: { web?: Queue; mobile?: Queue }, sharedDb?: FakeDb) {
    const db = sharedDb ?? new FakeDb(rows.map((r) => videoRow(r)));
    const storage = new FakeStorage();
    for (const row of db.rows.values()) if (row.sourceKey) storage.objects.set(row.sourceKey as string, 1_000_000);
    const videos = new VideosService(
      db as never,
      storage as never,
      { assertCanManageCourse: async () => undefined, assertTeacherCapability: async () => undefined } as never,
      { recountCourse: async () => undefined } as never,
      { notifyCourseStudents: async () => undefined } as never,
      { record: async () => undefined } as never,
      new FakeRedis() as never,
      (queues?.web ?? webQueue) as never,
      {
        getOrThrow: () => ({
          ladder: [480, 720],
          encryptionEnabled: true,
          workDir: `/tmp/${prefix}`,
          mobile: { delivery: 'hls', gumletFallback: true, autoProcess: true },
          drm: { enabled: true, provider: 'gumlet', gumlet: {} },
        }),
      } as never,
      {} as never,
      { sync: async () => undefined } as never,
      (queues?.mobile ?? mobileQueue) as never,
    );
    return { db, storage, videos };
  }

  /** The encoding machine: a real BullMQ Worker around the real processor, ffmpeg replaced. */
  function startEncoder(
    videos: VideosService,
    encode: (videoId: string) => Promise<void> = async () => undefined,
    workerOptions: Record<string, unknown> = {},
    realGuard?: ScratchGuard,
  ): Worker {
    const transcoder = {
      preflight: async () => ({
        sourceMissing: false,
        sourceBytes: 1,
        budgetBytes: 1,
        assessment: { ok: true, freeBytes: 1e12, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 },
      }),
      run: async ({ videoId }: { videoId: string }) => {
        await encode(videoId);
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
    const guard = {
      pauseState: async () => ({ paused: false, reason: null, by: null, at: null, scope: 'all' }),
      noteActive: () => undefined,
      noteProgress: () => undefined,
      noteFinished: () => undefined,
      noteDeferred: () => undefined,
    };
    const scheduler = {
      uploadPressure: async () => ({ waiting: 0, ignoredStale: 0, originalQueuePaused: false }),
      acquireEncodeSlot: async () => ({ holder: 'test', release: async () => undefined }),
    };
    const processor = new MobileVideoProcessor(
      transcoder as never,
      videos as never,
      { getOrThrow: () => ({ workDir: `/tmp/${prefix}` }) } as never,
      (realGuard ?? guard) as never,
      scheduler as never,
    );
    // A deferred job comes back quickly, so the tests do not wait a minute per deferral.
    (processor as unknown as { deferMs: Record<string, number> }).deferMs = { paused: 250, uploads: 250, disk: 250, slot: 250 };
    const worker = new Worker(
      QUEUE_NAMES.mobileVideo,
      (job: Job<MobileTranscodeJobData>, token?: string) => processor.process(job, token),
      { ...bull, concurrency: 1, drainDelay: 1, stalledInterval: 500, ...workerOptions },
    );
    worker.on('error', () => undefined);
    workers.push(worker);
    return worker;
  }

  beforeAll(async () => {
    webQueue = new Queue(QUEUE_NAMES.video, bull);
    mobileQueue = new Queue(QUEUE_NAMES.mobileVideo, bull);
    await Promise.all([webQueue.waitUntilReady(), mobileQueue.waitUntilReady()]);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((w) => w.close(true).catch(() => undefined)));
    await webQueue.obliterate({ force: true }).catch(() => undefined);
    await mobileQueue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await Promise.all([webQueue.close(), mobileQueue.close()]);
  });

  it('BullMQ accepts the deterministic ids, and five finalisations of one upload are one job per queue', async () => {
    const id = 'cmwjqbkq100o9ks01hkf5j1vp';
    const sourceKey = `source/videos/${id}/lecture 12 (final).mp4`;
    const w = world([{ id, sourceKey }]);

    await Promise.all(Array.from({ length: 5 }, () => w.videos.completeUpload(id, STAFF)));
    await w.videos.completeUpload(id, STAFF);

    const web = await webQueue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed']);
    const mobile = await mobileQueue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed']);
    expect(web.map((j) => j.id)).toEqual([uploadTranscodeJobIdFor(id, sourceKey)]);
    expect(mobile.map((j) => j.id)).toEqual([mobileJobIdFor(id, 1)]);
    expect(await mobile[0]!.getState()).toBe('waiting');
    expect(mobile[0]!.data).toMatchObject({ videoId: id, sourceKey, trigger: 'upload' });
    expect(w.db.get(id)).toMatchObject({ status: 'QUEUED', mobileStatus: 'QUEUED', mobileGeneration: 1 });
    expect(w.db.get(id).mobileEnqueuedAt).toBeInstanceOf(Date);
  });

  it('a job queued while no worker is running waits in Redis and is processed when the encoder starts', async () => {
    const w = world([{ id: 'v_offline', sourceKey: 'source/videos/v_offline/a.mp4' }]);

    // The laptop is off. The upload is accepted and the job simply waits.
    await w.videos.completeUpload('v_offline', STAFF);
    await sleep(1500);
    expect(await (await mobileQueue.getJob(mobileJobIdFor('v_offline', 1)))!.getState()).toBe('waiting');
    expect(w.db.get('v_offline')).toMatchObject({ mobileStatus: 'QUEUED', mobileError: null });
    // The sweep, run in the meantime, sees a live job and leaves it alone.
    await expect(w.videos.recoverStrandedMobileVideos(new Date(Date.now() + 3600_000))).resolves.toEqual({ requeued: 0, failed: 0 });
    expect(await mobileQueue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });

    // The laptop comes back.
    startEncoder(w.videos);

    await until(() => w.db.get('v_offline').mobileStatus === 'READY', 'the queued video to be encoded');
    expect(w.db.get('v_offline')).toMatchObject({ mobileStatus: 'READY', hlsPrefix: 'hls/v_offline/', status: 'QUEUED' });
  });

  it('a worker that dies mid-encode: the stalled check hands the job back and the next worker finishes it', async () => {
    const w = world([{ id: 'v_crash', sourceKey: 'source/videos/v_crash/a.mp4' }]);
    await w.videos.completeUpload('v_crash', STAFF);

    // Worker A takes the job and never finishes (the machine went to sleep).
    let started = false;
    const dead = startEncoder(
      w.videos,
      async () => {
        started = true;
        await new Promise(() => undefined);
      },
      // The same stalled-check interval as every other worker of the queue:
      // BullMQ rate-limits that check with one shared key, so a worker with a
      // long interval would silence everybody's check for that long.
      { lockDuration: 1000, stalledInterval: 500 },
    );
    await until(() => started, 'worker A to start encoding');
    expect(w.db.get('v_crash').mobileStatus).toBe('PROCESSING');
    await dead.close(true);

    // Worker B: its stalled check finds the abandoned job once the lock lapses.
    let encodes = 0;
    startEncoder(w.videos, async () => void (encodes += 1), { lockDuration: 1000, stalledInterval: 500, maxStalledCount: 5 });

    await until(() => w.db.get('v_crash').mobileStatus === 'READY', 'the stalled job to be finished by worker B', 30_000);
    expect(encodes).toBe(1);
    // The SAME job: no new intent was needed.
    expect(w.db.get('v_crash')).toMatchObject({ mobileGeneration: 1, mobileJobId: mobileJobIdFor('v_crash', 1) });
  });

  it('finalising a FAILED video again re-queues it although a finished job with that id is still retained', async () => {
    const w = world([{ id: 'v_again', sourceKey: 'source/videos/v_again/a.mp4' }]);
    await w.videos.completeUpload('v_again', STAFF);
    const jobId = uploadTranscodeJobIdFor('v_again', 'source/videos/v_again/a.mp4');

    // The Gumlet side fails the job for good.
    const gumlet = new Worker(
      QUEUE_NAMES.video,
      async (): Promise<void> => {
        await w.videos.markFailed('v_again', 'Gumlet rejected the source');
        throw new UnrecoverableError('Gumlet rejected the source');
      },
      { ...bull, drainDelay: 1 },
    );
    gumlet.on('error', () => undefined);
    workers.push(gumlet);
    await until(async () => (await (await webQueue.getJob(jobId))?.getState()) === 'failed', 'the transcode job to fail');
    await gumlet.close();
    expect(w.db.get('v_again').status).toBe('FAILED');

    const result = await w.videos.completeUpload('v_again', STAFF);

    expect(result).toMatchObject({ status: 'QUEUED', jobId, gumlet: { queued: true } });
    expect(await (await webQueue.getJob(jobId))!.getState()).toBe('waiting');
    expect(await webQueue.getJobCounts('waiting', 'failed')).toMatchObject({ waiting: 1, failed: 0 });
  });

  it('a Redis that does not answer cannot hang the upload: it is accepted and delivered later', async () => {
    // Nothing listens on this port. BullMQ's connection retries for ever, so
    // without a bound `queue.add()` would simply never return.
    const dead = { connection: { host: '127.0.0.1', port: 6399, maxRetriesPerRequest: null, enableReadyCheck: false }, prefix: `${prefix}:bull` };
    const deadWeb = new Queue(QUEUE_NAMES.video, dead);
    const deadMobile = new Queue(QUEUE_NAMES.mobileVideo, dead);
    deadWeb.on('error', () => undefined);
    deadMobile.on('error', () => undefined);
    try {
      const w = world([{ id: 'v_noredis', sourceKey: 'source/videos/v_noredis/a.mp4' }], { web: deadWeb, mobile: deadMobile });

      const startedAt = Date.now();
      const result = await w.videos.completeUpload('v_noredis', STAFF);
      const elapsed = Date.now() - startedAt;

      expect(result).toMatchObject({
        status: 'QUEUED',
        upload: { state: 'VERIFIED' },
        gumlet: { queued: false },
        mobile: { status: 'QUEUED', queued: false },
      });
      expect(elapsed).toBeLessThan(QUEUE_OPERATION_TIMEOUT_MS * 3);
      expect(w.db.get('v_noredis')).toMatchObject({ status: 'QUEUED', processingJobId: null, mobileStatus: 'QUEUED', mobileEnqueuedAt: null });

      // Redis is reachable again (a process with a working connection): the
      // reconciler delivers both instructions, once.
      const recovered = world([], {});
      recovered.db.rows.set('v_noredis', w.db.get('v_noredis'));
      recovered.storage.objects.set('source/videos/v_noredis/a.mp4', 1_000_000);
      await expect(recovered.videos.reconcilePendingIntents()).resolves.toEqual({
        mobile: { pending: 1, queued: 1 },
        web: { pending: 1, queued: 1 },
      });
      await recovered.videos.reconcilePendingIntents();
      expect(await mobileQueue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
      expect(await webQueue.getJobCounts('waiting')).toMatchObject({ waiting: 1 });
    } finally {
      // These never connected; closing must not be allowed to wait on that.
      await Promise.race([
        Promise.all([deadWeb.close().catch(() => undefined), deadMobile.close().catch(() => undefined)]),
        sleep(2000),
      ]);
    }
  });

  // ---------------------------------------------------------------------------
  // Pre-release audit: cost, concurrency and the pause, measured on real Redis
  // ---------------------------------------------------------------------------

  /** Every command Redis executes for this run's prefix while `work` runs. */
  async function redisCommandsDuring(work: () => Promise<unknown>): Promise<string[]> {
    const tap = new IORedis({ host: connection.host, port: connection.port, maxRetriesPerRequest: null });
    const monitor = await tap.monitor();
    const seen: string[] = [];
    monitor.on('monitor', (_time: string, args: string[]) => {
      if (args.some((a) => typeof a === 'string' && a.includes(prefix))) seen.push(String(args[0]).toLowerCase());
    });
    await sleep(100);
    await work();
    await sleep(300);
    monitor.disconnect();
    tap.disconnect();
    return seen;
  }

  it('an idle reconcile scan issues ZERO Redis commands; a scan with work issues a handful', async () => {
    // A library at rest: finished videos, a queued one whose job is live.
    const w = world([
      { id: 'idle_ready', sourceKey: 'source/videos/idle_ready/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1), mobileStatus: 'READY' },
      { id: 'idle_none', sourceKey: 'source/videos/idle_none/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1) },
      { id: 'idle_new', sourceKey: 'source/videos/idle_new/a.mp4' },
    ]);
    await w.videos.completeUpload('idle_new', STAFF);

    const idle = await redisCommandsDuring(async () => {
      for (let i = 0; i < 10; i += 1) await w.videos.reconcilePendingIntents();
    });
    expect(idle).toEqual([]);

    // The same scan when one intent is genuinely undelivered.
    Object.assign(w.db.get('idle_none'), {
      mobileStatus: 'QUEUED',
      mobileGeneration: 1,
      mobileJobId: mobileJobIdFor('idle_none', 1),
      mobileRequestedAt: new Date(),
      mobileEnqueuedAt: null,
      mobileTrigger: 'retry',
    });
    const busy = await redisCommandsDuring(() => w.videos.reconcilePendingIntents());
    expect(busy.length).toBeGreaterThan(0);
    expect(busy.length).toBeLessThanOrEqual(20);
    expect(await (await mobileQueue.getJob(mobileJobIdFor('idle_none', 1)))!.getState()).toBe('waiting');

    // And what one accepted upload costs, for the record.
    const upload = world([{ id: 'cost_probe', sourceKey: 'source/videos/cost_probe/a.mp4' }]);
    const perUpload = await redisCommandsDuring(() => upload.videos.completeUpload('cost_probe', STAFF));
    const tally = (commands: string[]) =>
      Object.entries(commands.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {}))
        .map(([c, n]) => `${c}x${n}`)
        .join(' ');
    console.info(
      `[audit] redis commands - idle reconcile x10: ${idle.length} | reconcile with 1 pending: ${busy.length} (${tally(busy)}) | ` +
        `one accepted upload: ${perUpload.length} (${tally(perUpload)})`,
    );
    // Two job lookups and two adds (each a BullMQ script). Uploads are a few a day.
    expect(perUpload.length).toBeLessThan(40);
  });

  it('five instances reconciling the same six stranded intents at once produce six jobs per queue, not thirty', async () => {
    const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
    const first = world(
      ids.map((id) => ({
        id,
        sourceKey: `source/videos/${id}/a.mp4`,
        // Accepted, committed, never delivered: what a crash or an outage leaves.
        status: 'QUEUED',
        sourceSizeBytes: BigInt(1_000_000),
        processingJobId: null,
        mobileStatus: 'QUEUED',
        mobileGeneration: 1,
        mobileJobId: mobileJobIdFor(id, 1),
        mobileRequestedAt: new Date(Date.now() - 60_000),
        mobileEnqueuedAt: null,
        mobileTrigger: 'upload',
      })),
    );
    const instances = [first, ...Array.from({ length: 4 }, () => world([], undefined, first.db))];

    const reports = await Promise.all(instances.map((i) => i.videos.reconcilePendingIntents()));

    expect(reports).toHaveLength(5);
    const mobile = await mobileQueue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed']);
    const web = await webQueue.getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed', 'failed']);
    expect(mobile.map((j) => j.id).sort()).toEqual(ids.map((id) => mobileJobIdFor(id, 1)).sort());
    expect(web.map((j) => j.id).sort()).toEqual(ids.map((id) => uploadTranscodeJobIdFor(id, `source/videos/${id}/a.mp4`)).sort());
    for (const id of ids) {
      expect(first.db.get(id)).toMatchObject({
        mobileGeneration: 1,
        status: 'QUEUED',
        processingJobId: uploadTranscodeJobIdFor(id, `source/videos/${id}/a.mp4`),
      });
      expect(first.db.get(id).mobileEnqueuedAt).toBeInstanceOf(Date);
    }
    // Nothing left to do for anyone.
    for (const instance of instances) expect(instance.videos.hasUndeliveredIntents()).toBe(false);
  });

  it('the real pause flag: a backlog pause never holds a new upload; a full pause holds everything; resume releases', async () => {
    const redis = new RedisService({ getOrThrow: () => ({ url: REDIS_URL, prefix }) } as never);
    await redis.onModuleInit();
    try {
      const guard = new ScratchGuard(redis, { getOrThrow: () => ({ workDir: `/tmp/${prefix}`, minFreeBytes: 0, diskCheckSeconds: 15 }) } as never);
      const w = world([
        { id: 'old_lecture', sourceKey: 'source/videos/old_lecture/a.mp4', status: 'READY', sourceSizeBytes: BigInt(1_000_000) },
        { id: 'new_lecture', sourceKey: 'source/videos/new_lecture/a.mp4' },
        { id: 'next_lecture', sourceKey: 'source/videos/next_lecture/a.mp4' },
      ]);

      // The operator pauses the BACKLOG, as between batches.
      await writePauseState(redis, true, 'admin_1', 'between backlog batches', 'historical');
      await w.videos.enqueueMobileTranscode({ id: 'old_lecture', sourceKey: 'source/videos/old_lecture/a.mp4' }, 'migration');
      await w.videos.completeUpload('new_lecture', STAFF);
      const encoded: string[] = [];
      startEncoder(w.videos, async (videoId) => void encoded.push(videoId), {}, guard);

      await until(() => w.db.get('new_lecture').mobileStatus === 'READY', 'the new upload to be encoded during a backlog pause');
      await sleep(1200);
      // The backlog job is still in the queue (it is looked at and deferred
      // again every few hundred milliseconds here) and was never encoded.
      expect(w.db.get('old_lecture')).toMatchObject({ mobileStatus: 'QUEUED' });
      expect(encoded).toEqual(['new_lecture']);
      expect(['delayed', 'active', 'prioritized', 'waiting']).toContain(
        await (await mobileQueue.getJob(w.db.get('old_lecture').mobileJobId as string))!.getState(),
      );

      // A full pause (the metered-connection case) holds a new upload too - and says so truthfully.
      await writePauseState(redis, true, 'admin_1', 'laptop on a metered connection', 'all');
      await w.videos.completeUpload('next_lecture', STAFF);
      await sleep(1500);
      expect(w.db.get('next_lecture')).toMatchObject({ mobileStatus: 'QUEUED', mobileError: null });
      expect(encoded).toEqual(['new_lecture']);

      // Resume: both waiting jobs run, the upload first.
      await writePauseState(redis, false, 'admin_1');
      await until(
        () => w.db.get('next_lecture').mobileStatus === 'READY' && w.db.get('old_lecture').mobileStatus === 'READY',
        'both jobs to run after resume',
        30_000,
      );
      const done = (id: string) => (w.db.get(id).mobileProcessedAt as Date).getTime();
      expect(done('next_lecture')).toBeLessThanOrEqual(done('old_lecture'));
    } finally {
      await redis.delByPattern('*');
      await redis.onModuleDestroy();
    }
  });
});
