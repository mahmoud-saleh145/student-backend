import { Logger } from '@nestjs/common';
import { DelayedError, Queue, Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';

import { MobileEncodeScheduler } from '../../src/jobs/processors/mobile-encode-scheduler';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
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
    const failWith = new Map<string, string>();
    const encodeMs = new Map<string, number>();
    let deferrals = 0;
    let encodes = 0;

    function startMobileWorker(): Worker {
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
        markMobileReady: async () => undefined,
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
          try {
            return await processor.process(job, token);
          } catch (e) {
            if (e instanceof DelayedError) deferrals += 1;
            throw e;
          }
        },
        { ...bull, concurrency: 1 },
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
    const pause = () =>
      writePauseState(redis, true, 'operator', 'batch 5 paused', 'historical');
    const resume = () => writePauseState(redis, false, 'operator');

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
      await original.close();
      await mobile.close();
      await redis.delByPattern('*');
      await redis.onModuleDestroy();
      const left = await raw.keys(`${prefix}*`);
      if (left.length) await raw.del(...left);
      await raw.quit();
      jest.restoreAllMocks();
    });

    it('4 real failures, 8 paused jobs, thousands of real deferrals: no trip; resume runs all 8 with no re-pause; 3 new failures trip it', async () => {
      // 1. Four jobs fail their first attempt with network errors (as on 16 Nov).
      FAILED.forEach(([v, reason]) => failWith.set(v, reason));
      const failedJobs = await Promise.all(FAILED.map(([v]) => add(v)));
      startMobileWorker();
      await until(
        async () =>
          (await Promise.all(failedJobs.map((j) => mobile.getJob(j.id!)))).every(
            (j) => j?.attemptsMade === 1,
          ),
        30_000,
        'four first-attempt failures',
      );

      // 2. Processing is paused; the four fresh jobs are added; the retries come back early.
      await pause();
      const freshJobs = await Promise.all(FRESH.map((v) => add(v)));
      await mobile.promoteJobs();
      failWith.clear(); // nothing would fail now - nothing runs while paused anyway
      const encodesBefore = encodes;

      // 3. Thousands of real pause deferrals. The fixed watchdog starts part-way, like a
      //    deployment the day after; it ticks alongside the churn.
      await until(() => deferrals >= 500, 120_000, '500 deferrals');
      const { w, events, count } = watchdog();
      await w.tick();
      expect(count('netfail_baseline')).toBe(1);
      expect((events[0].data.events as string[]).length).toBe(4);
      let maxLegacy = 0;
      while (deferrals < 3_000) {
        await w.tick();
        maxLegacy = Math.max(maxLegacy, await legacyRecent());
        await sleep(100);
      }
      expect(encodes).toBe(encodesBefore); // nothing ran while paused
      expect(maxLegacy).toBeGreaterThanOrEqual(3); // the old rule would have tripped
      expect(count('threshold_network_failures')).toBe(0);
      expect(count('netfail_seen')).toBe(0);
      for (const j of failedJobs) {
        const job = await mobile.getJob(j.id!);
        expect(job?.attemptsMade).toBe(1); // deferrals never touched atm...
        expect(job?.failedReason).toMatch(/socket hang up|aborted/); // ...nor the old reason
      }

      // 4. RESUME: all eight run (the four retries succeed), no new failure, no re-pause.
      await resume();
      await until(
        async () => (await mobile.getJobCounts('completed')).completed === 8,
        60_000,
        'all 8 completed',
      );
      for (let i = 0; i < 5; i++) {
        await w.tick();
        await sleep(50);
      }
      expect(count('threshold_network_failures')).toBe(0);
      expect(count('PAUSED')).toBe(0);
      expect(await raw.get(`${prefix}:mobile:transcode:paused`)).toBeNull();
      expect(freshJobs).toHaveLength(4);

      // 5. Genuinely NEW network failures after the resume still trip the threshold.
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
      await w.tick();
      expect(count('netfail_seen')).toBe(1);
      expect(count('threshold_network_failures')).toBe(1);
      expect(
        (
          events.find((e) => e.event === 'threshold_network_failures')!.data
            .jobs as Array<{ src: string }>
        ).every((j) => j.src === 'finishedOn'),
      ).toBe(true);
      expect(count('PAUSED')).toBe(1);
      expect(
        JSON.parse((await raw.get(`${prefix}:mobile:transcode:paused`))!),
      ).toMatchObject({ by: 'safety-watchdog', scope: 'historical' });
      expect(fresh3).toHaveLength(3);
      // Further ticks on the same evidence never pause again.
      await resume();
      for (let i = 0; i < 3; i++) await w.tick();
      expect(count('threshold_network_failures')).toBe(1);
      expect(await raw.get(`${prefix}:mobile:transcode:paused`)).toBeNull();
    });
  },
);
