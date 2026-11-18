import { Logger } from '@nestjs/common';
import { DelayedError, Queue, Worker, type Job, type WorkerOptions } from 'bullmq';
import IORedis from 'ioredis';

import { ENCODE_SLOT_KEY, MobileEncodeScheduler } from '../../src/jobs/processors/mobile-encode-scheduler';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { countParkedJobs, promoteParkedJobs } from '../../src/jobs/mobile-park';
import { ScratchGuard, writePauseState } from '../../src/jobs/processors/scratch-guard';
import {
  MOBILE_JOB_PRIORITY,
  MOBILE_VIDEO_JOBS,
  QUEUE_NAMES,
  type MobileTranscodeJobData,
} from '../../src/jobs/queue.constants';
import { RedisService } from '../../src/redis/redis.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const wd = require('../../deploy/laptop-worker/watchdog/watchdog.js');

/**
 * The Batch 5 incident on REAL BullMQ queues with the REAL MobileVideoProcessor and the
 * REAL watchdog decision code, against a LOCAL Redis. Only ffmpeg and the database writes
 * are faked. The pause deferrals are the processor's own `job.moveToDelayed()` path - the
 * one that refreshed `processedOn` in production - and the failures are real BullMQ failed
 * attempts (`atm` + 1, retried through moveToDelayed).
 *
 * Runs only when WATCHDOG_TEST_REDIS_URL (or PRIORITY_TEST_REDIS_URL) points at a local
 * Redis; every key lives under a throw-away prefix that is removed afterwards.
 */
const REDIS_URL =
  process.env.WATCHDOG_TEST_REDIS_URL ?? process.env.PRIORITY_TEST_REDIS_URL;
const enabled = (() => {
  if (!REDIS_URL) return false;
  if (!['localhost', '127.0.0.1', '::1'].includes(new URL(REDIS_URL).hostname)) {
    throw new Error('WATCHDOG_TEST_REDIS_URL must point at a LOCAL Redis');
  }
  return true;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(
  check: () => Promise<boolean> | boolean,
  ms: number,
  what: string,
): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const FAILED: Array<[string, string]> = [
  ['cmva5bgod', 'socket hang up'],
  ['cmva607km', 'aborted'],
  ['cmvbbzo2k', 'aborted'],
  ['cmvbc937d', 'aborted'],
];
const FRESH = ['cmva6lw6a', 'cmvb9e833', 'cmvbcjqll', 'cmvcrhg5y'];

(enabled ? describe : describe.skip)(
  'watchdog failure ledger on real BullMQ (Batch 5 pattern, local Redis)',
  () => {
    jest.setTimeout(300_000);
    const prefix = `edutest-wd-${Date.now()}`;
    const connection = (() => {
      const u = new URL(REDIS_URL ?? 'redis://localhost:6379');
      return {
        host: u.hostname,
        port: Number(u.port || 6379),
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      };
    })();
    const bull = { connection, prefix: `${prefix}:bull` };

    let redis: RedisService;
    let raw: IORedis;
    let original: Queue;
    let mobile: Queue<MobileTranscodeJobData>;
    const workers: Worker[] = [];
    /** Queues a test opens besides the two above; closed in afterAll even when a test fails. */
    const extraQueues: Queue[] = [];
    const failWith = new Map<string, string>();
    const encodeMs = new Map<string, number>();
    /** Videos whose encode never returns (the host died mid-encode). */
    const hangs = new Set<string>();
    /** Successful mobile-READY writes per video: a duplicate successful encode would show here. */
    const ready = new Map<string, number>();
    let deferrals = 0;
    let encodes = 0;
    /** Every time a mobile worker TOOK a job (lock, attemptsStarted + 1), whatever it then did. */
    let takes = 0;

    function startMobileWorker(workerOpts: Partial<WorkerOptions> = {}): Worker {
      const config = {
        getOrThrow: () => ({
          workDir: `/tmp/${prefix}`,
          minFreeBytes: 0,
          diskCheckSeconds: 15,
        }),
      };
      const guard = new ScratchGuard(redis, config as never);
      const scheduler = new MobileEncodeScheduler(original as never, redis);
      const transcoder = {
        preflight: async () => ({
          sourceMissing: false,
          sourceBytes: 1,
          budgetBytes: 1,
          assessment: {
            ok: true,
            freeBytes: 1e12,
            reservedByOthers: 0,
            minFreeBytes: 0,
            shortfallBytes: 0,
          },
        }),
        run: async ({ videoId }: { videoId: string }) => {
          encodes += 1;
          if (hangs.has(videoId)) await new Promise(() => undefined); // never returns
          await sleep(encodeMs.get(videoId) ?? 20);
          const reason = failWith.get(videoId);
          if (reason) throw new Error(reason); // what a dropped R2 download looks like
          return {
            probe: {
              durationSeconds: 1,
              width: 640,
              height: 360,
              frameRate: 30,
              videoCodec: 'h264',
              audioCodec: 'aac',
            },
            renditions: [],
            hlsPrefix: `hls/${videoId}/`,
            masterPlaylistKey: `hls/${videoId}/master.m3u8`,
            thumbnailKey: undefined,
            isEncrypted: true,
          };
        },
      };
      const videos = {
        markMobileProcessing: async () => true,
        markMobileReady: async (videoId: string) => {
          ready.set(videoId, (ready.get(videoId) ?? 0) + 1);
        },
        markMobileFailed: async () => undefined,
        markMobileRetrying: async () => undefined,
        markMobileDeferred: async () => undefined,
      };
      const processor = new MobileVideoProcessor(
        transcoder as never,
        videos as never,
        config as never,
        guard,
        scheduler,
        // As in production (@InjectQueue): the safe-pause gate pauses this queue on a full pause.
        mobile,
      );
      // Production defers a paused job for 60 s; 1 ms produces the same Redis writes thousands of times faster.
      (processor as unknown as { deferMs: Record<string, number> }).deferMs = {
        paused: 1,
        uploads: 1,
        disk: 1,
        slot: 1,
      };
      const w = new Worker(
        QUEUE_NAMES.mobileVideo,
        async (job: Job<MobileTranscodeJobData>, token?: string) => {
          takes += 1;
          try {
            return await processor.process(job, token);
          } catch (e) {
            if (e instanceof DelayedError) deferrals += 1;
            throw e;
          }
        },
        // BullMQ rate-limits the stalled check with ONE shared key per queue (its TTL is the checking
        // worker's stalledInterval), so every mobile worker here uses the same short interval.
        { ...bull, concurrency: 1, lockDuration: 1_500, stalledInterval: 1_000, ...workerOpts },
      );
      workers.push(w);
      return w;
    }

    const add = (videoId: string, attempts = 2, backoffMs = 60_000) =>
      mobile.add(
        MOBILE_VIDEO_JOBS.transcode,
        {
          videoId,
          sourceKey: `source/${videoId}.mp4`,
          ladder: [360],
          encrypt: true,
          trigger: 'migration',
        },
        {
          jobId: `mobile-hls:${videoId}:${Date.now()}`,
          attempts,
          backoff: { type: 'fixed', delay: backoffMs },
          priority: MOBILE_JOB_PRIORITY.migration,
          removeOnComplete: false,
          removeOnFail: false,
        },
      );
    // The operator transitions, in exactly the order VideosService.setMobileProcessingPaused applies them
    // (that service is exercised end to end in mobile-safe-pause-real-queue / mobile-safe-pause.e2e).
    /** Full pause: the BullMQ queue first, then the flag. */
    const pauseAll = async () => {
      if (!(await mobile.isPaused())) await mobile.pause();
      await writePauseState(redis, true, 'operator', 'batch 5 paused', 'all', { strict: true });
    };
    /** Historical hold (Stage 2 partial processing): the flag first, then the queue resumed. */
    const holdHistorical = async () => {
      await writePauseState(redis, true, 'operator', 'backlog held', 'historical', { strict: true });
      if (await mobile.isPaused()) await mobile.resume();
    };
    /** Resume: delete the flag, release exactly the parked jobs, then resume the queue. */
    const resumeAll = async () => {
      await writePauseState(redis, false, 'operator', undefined, undefined, { strict: true });
      await promoteParkedJobs(mobile);
      if (await mobile.isPaused()) await mobile.resume();
    };
    /** attempts made, stall counter, attempts started (takes) and last take, per job. */
    const counters = async (ids: string[]) => {
      const out: Record<string, { atm: string | null; stc: string | null; ats: string | null; processedOn: string | null }> = {};
      for (const id of ids) {
        const [atm, stc, ats, processedOn] = await raw.hmget(MQ() + id, 'atm', 'stc', 'ats', 'processedOn');
        out[id] = { atm, stc, ats, processedOn };
      }
      return out;
    };

    function watchdog() {
      const events: Array<{ event: string; data: Record<string, unknown> }> = [];
      const ok = async () => undefined;
      const cfg = { ...wd.loadConfig({}), prefix };
      const w = wd.createWatchdog({
        redis: raw,
        cfg,
        log: (event: string, data = {}) => events.push({ event, data }),
        probes: { redis: ok, db: ok, r2: ok },
      });
      return {
        w,
        events,
        count: (e: string) => events.filter((x) => x.event === e).length,
      };
    }
    const MQ = () => wd.keysFor(prefix).MQ as string;
    async function legacyRecent(): Promise<number> {
      let n = 0;
      const ids = new Set<string>();
      for (const z of ['failed', 'delayed', 'prioritized'])
        for (const id of await raw.zrange(MQ() + z, 0, -1)) ids.add(id);
      for (const id of await raw.lrange(MQ() + 'wait', 0, -1)) ids.add(id);
      for (const id of ids) {
        const [reason, finishedOn, processedOn] = await raw.hmget(
          MQ() + id,
          'failedReason',
          'finishedOn',
          'processedOn',
        );
        if (
          reason &&
          wd.NETWORK_FAILURE.test(reason) &&
          Number(finishedOn || processedOn || 0) >= Date.now() - 120 * 60_000
        )
          n += 1;
      }
      return n;
    }

    beforeAll(async () => {
      jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      redis = new RedisService({
        getOrThrow: () => ({ url: REDIS_URL, prefix }),
      } as never);
      await redis.onModuleInit();
      raw = new IORedis(REDIS_URL!, { maxRetriesPerRequest: 2 });
      original = new Queue(QUEUE_NAMES.video, bull);
      mobile = new Queue(QUEUE_NAMES.mobileVideo, bull);
    });

    afterAll(async () => {
      await Promise.all(workers.splice(0).map((w) => w.close(true)));
      await original.obliterate({ force: true }).catch(() => undefined);
      await mobile.obliterate({ force: true }).catch(() => undefined);
      await Promise.all(extraQueues.splice(0).map((q) => q.close().catch(() => undefined)));
      await original.close();
      await mobile.close();
      await redis.delByPattern('*');
      await redis.onModuleDestroy();
      const left = await raw.keys(`${prefix}*`);
      if (left.length) await raw.del(...left);
      await raw.quit();
      jest.restoreAllMocks();
    });

    it('4 real failures, 8 held jobs: a full pause takes nothing (no deferral, no counter used) across worker and watchdog restarts and never trips the watchdog; a historical hold parks each job once; other queues keep running; resume runs all 8 with no re-pause; a real stall is still detected; 3 new failures trip it', async () => {
      // 1. Four jobs fail their first attempt with network errors (as on 16 Nov).
      FAILED.forEach(([v, reason]) => failWith.set(v, reason));
      const failedJobs = await Promise.all(FAILED.map(([v]) => add(v)));
      let mobileWorker = startMobileWorker();
      await until(
        async () =>
          (await Promise.all(failedJobs.map((j) => mobile.getJob(j.id!)))).every(
            (j) => j?.attemptsMade === 1,
          ),
        30_000,
        'four first-attempt failures',
      );

      // 2. FULL pause (the API's order: queue, then flag). The four fresh jobs are added; the
      //    retries come back early - into the PAUSED queue, where no worker takes them.
      await pauseAll();
      const freshJobs = await Promise.all(FRESH.map((v) => add(v)));
      await mobile.promoteJobs();
      failWith.clear(); // nothing would fail now - nothing runs while paused anyway
      const held = [...failedJobs, ...freshJobs].map((j) => j.id!);
      const takesBefore = takes;
      const deferralsBefore = deferrals;
      const encodesBefore = encodes;
      const pausedSnapshot = await counters(held);

      // The fixed watchdog starts part-way, like a deployment the day after.
      const instances = [watchdog()];
      let wdog = instances[0];
      const total = (e: string) => instances.reduce((n, i) => n + i.count(e), 0);
      await wdog.w.tick();
      expect(wdog.count('netfail_baseline')).toBe(1);
      expect((wdog.events[0].data.events as string[]).length).toBe(4);

      // Gumlet ingest, push and maintenance queues keep working while the mobile queue is paused.
      const others = [QUEUE_NAMES.video, QUEUE_NAMES.push, QUEUE_NAMES.maintenance].map((name) => {
        const q = new Queue(name, bull);
        extraQueues.push(q);
        const done: string[] = [];
        workers.push(new Worker(name, async (job) => { done.push(String(job.id)); return 'ok'; }, { ...bull, concurrency: 1 }));
        return { name, q, done };
      });
      for (const o of others) await o.q.add('probe', { during: 'mobile full pause' }, { jobId: `probe-${o.name}` });

      // Many watchdog ticks across a WORKER restart and a WATCHDOG restart, with time passing
      // (the 1 ms deferral that used to churn would have fired thousands of times).
      for (let i = 0; i < 40; i++) {
        if (i === 12) {
          await mobileWorker.close();
          mobileWorker = startMobileWorker(); // worker restart
        }
        if (i === 24) {
          wdog = watchdog(); // watchdog restart: a fresh process, same Redis ledger
          instances.push(wdog);
        }
        await wdog.w.tick();
        await sleep(100);
      }
      await until(async () => others.every((o) => o.done.length === 1), 20_000, 'the other queues to process their job');
      // Under a BullMQ pause the held jobs wait in the queue itself (BullMQ 5.81.3: the `paused` list for
      // promoted jobs, `prioritized` for jobs promoted by a worker) - state "waiting"/"prioritized", never
      // taken. (The old watchdog rule does not scan the `paused` list, so it is asserted in step 3 instead.)
      for (const id of held) {
        expect(['waiting', 'prioritized']).toContain(await (await mobile.getJob(id))!.getState());
      }
      expect(takes).toBe(takesBefore); // paused jobs are never taken...
      expect(deferrals).toBe(deferralsBefore); // ...so never deferred
      expect(encodes).toBe(encodesBefore); // nothing ran while paused
      expect(await counters(held)).toEqual(pausedSnapshot); // atm, stc, ats, processedOn unchanged
      expect(await mobile.isPaused()).toBe(true); // the pause survived both restarts
      expect(JSON.parse((await raw.get(`${prefix}:mobile:transcode:paused`))!)).toMatchObject({ scope: 'all' });
      expect(total('threshold_network_failures')).toBe(0);
      expect(total('netfail_seen')).toBe(0);
      expect(total('PAUSED')).toBe(0);
      for (const j of failedJobs) {
        const job = await mobile.getJob(j.id!);
        expect(job?.attemptsMade).toBe(1); // no retry used...
        expect(job?.failedReason).toMatch(/socket hang up|aborted/); // ...and the original reason kept
      }

      // 3. HISTORICAL hold (Stage 2 partial processing): each held job is taken ONCE and parked;
      //    then none is taken again however long the hold lasts.
      await holdHistorical();
      await until(async () => (await countParkedJobs(mobile)) === 8, 20_000, 'all 8 parked');
      expect(takes - takesBefore).toBe(8);
      expect(deferrals - deferralsBefore).toBe(8);
      const takesParked = takes;
      const parkedSnapshot = await counters(held);
      for (const id of held) {
        expect(parkedSnapshot[id].atm).toBe(pausedSnapshot[id].atm); // parking uses no attempt
        expect(parkedSnapshot[id].stc).toBe(pausedSnapshot[id].stc); // nor a stall
      }
      // Parking took each job once and so refreshed its processedOn - the very thing that made the four
      // OLD failures look recent in production. The old processedOn rule now sees them (parked jobs are in
      // `delayed`, which it scans) and would trip; the ledger must not.
      let maxLegacy = 0;
      for (let i = 0; i < 20; i++) {
        await wdog.w.tick();
        maxLegacy = Math.max(maxLegacy, await legacyRecent());
        await sleep(100);
      }
      expect(maxLegacy).toBeGreaterThanOrEqual(3); // the old rule would have tripped on these 4
      expect(takes).toBe(takesParked);
      expect(encodes).toBe(encodesBefore);
      expect(await counters(held)).toEqual(parkedSnapshot);
      expect(total('threshold_network_failures')).toBe(0); // the ledger does not
      expect(total('netfail_seen')).toBe(0);
      expect(total('PAUSED')).toBe(0);

      // 4. RESUME (the API's order): all eight run once, no new failure, no re-pause.
      await resumeAll();
      await until(
        async () => (await mobile.getJobCounts('completed')).completed === 8,
        60_000,
        'all 8 completed',
      );
      for (let i = 0; i < 5; i++) {
        await wdog.w.tick();
        await sleep(50);
      }
      expect(total('threshold_network_failures')).toBe(0);
      expect(total('PAUSED')).toBe(0);
      expect(await raw.get(`${prefix}:mobile:transcode:paused`)).toBeNull();
      expect(freshJobs).toHaveLength(4);

      // 5. A REAL stall is still detected and recovered: the worker holding an encode dies mid-encode
      //    (its encode never returns, its lock lapses); BullMQ's stall check on the next worker hands the
      //    job back (stalled counter + 1, no attempt used) and it completes exactly once.
      await mobileWorker.close();
      hangs.add('stall_me');
      const dying = startMobileWorker();
      const stallJob = await add('stall_me');
      await until(async () => (await mobile.getActiveCount()) === 1, 10_000, 'stall_me running');
      await dying.close(true); // the host is gone: no lock renewal, the encode never finishes
      // A dead host also stops renewing the cross-process encode slot, which then expires on its own
      // (120 s TTL). Its holder here lives on inside this test process, so the expiry is applied now -
      // the same time compression as the short lock duration above.
      await raw.del(redis.key(ENCODE_SLOT_KEY));
      hangs.delete('stall_me'); // the next worker's encode of it succeeds
      mobileWorker = startMobileWorker();
      await until(async () => (await raw.hget(MQ() + stallJob.id!, 'stc')) === '1', 30_000, 'the stall to be detected');
      await until(async () => (await mobile.getJob(stallJob.id!))?.finishedOn !== undefined, 30_000, 'stall_me completed after the stall');
      const recovered = await mobile.getJob(stallJob.id!);
      expect(await recovered!.getState()).toBe('completed');
      expect(recovered!.attemptsMade).toBe(1); // the completed attempt; the stall itself used none
      expect(ready.get('stall_me')).toBe(1); // exactly one successful encode - the dead attempt never wrote READY
      expect(total('PAUSED')).toBe(0); // a stall is not a network failure for the watchdog

      // 6. Genuinely NEW network failures after the resume still trip the threshold.
      ['new_a', 'new_b', 'new_c'].forEach((v) => failWith.set(v, 'aborted'));
      const fresh3 = await Promise.all(['new_a', 'new_b', 'new_c'].map((v) => add(v, 1))); // last attempt: terminal
      await until(
        async () => (await mobile.getJobCounts('failed')).failed === 3,
        30_000,
        'three new failures',
      );
      // Historical work still in flight, so a pause is warranted (with nothing queued the
      // watchdog deliberately logs pause_skipped_no_historical_work instead).
      encodeMs.set('next_in_line', 15_000);
      await add('next_in_line');
      await until(
        async () => (await mobile.getActiveCount()) === 1,
        10_000,
        'the next historical job running',
      );
      await wdog.w.tick();
      expect(wdog.count('netfail_seen')).toBe(1);
      expect(wdog.count('threshold_network_failures')).toBe(1);
      expect(
        (
          wdog.events.find((e) => e.event === 'threshold_network_failures')!.data
            .jobs as Array<{ src: string }>
        ).every((j) => j.src === 'finishedOn'),
      ).toBe(true);
      expect(wdog.count('PAUSED')).toBe(1);
      expect(
        JSON.parse((await raw.get(`${prefix}:mobile:transcode:paused`))!),
      ).toMatchObject({ by: 'safety-watchdog', scope: 'historical' });
      expect(fresh3).toHaveLength(3);
      // Further ticks on the same evidence never pause again.
      await resumeAll();
      for (let i = 0; i < 3; i++) await wdog.w.tick();
      expect(wdog.count('threshold_network_failures')).toBe(1);
      expect(await raw.get(`${prefix}:mobile:transcode:paused`)).toBeNull();
    });
  },
);
