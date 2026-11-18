import { WORKER_METADATA } from '@nestjs/bullmq/dist/bull.constants';
import { DelayedError, type Job } from 'bullmq';

import {
  BULLMQ_DELAYED_SCORE_FACTOR,
  countParkedJobs,
  dueTimeFromDelayedScore,
  listParkedJobIds,
  MOBILE_PARK_MS,
  MOBILE_PARKED_AFTER_MS,
  promoteParkedJobs,
} from '../../src/jobs/mobile-park';
import { DEFER_WHEN_PAUSED_MS, MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { ScratchGuard, type PauseState } from '../../src/jobs/processors/scratch-guard';
import { MOBILE_VIDEO_JOBS, type MobileTranscodeJobData } from '../../src/jobs/queue.constants';
import { mobileJobIdFor } from '../../src/modules/videos/pipeline-state';
import { VideosService } from '../../src/modules/videos/videos.service';

import { ADMIN, apiProcess, mobileWorker, STAFF, uploadedWorld, videoRow } from './support/pipeline-fakes';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => []),
}));

/**
 * SAFE PAUSE ("park and release") - the unit half.
 *
 * A held mobile job must not be TAKEN by the worker again and again: every
 * take is a moment in which a dropped connection costs it a stall or an
 * attempt. A full pause therefore pauses the BullMQ queue; a historical hold
 * parks each historical job (delayed for years) on its single take; resume
 * promotes exactly the parked jobs. The real-queue half is
 * mobile-safe-pause-real-queue.spec.ts.
 */

const YEAR = 365 * 24 * 3600_000;
const paused = (scope: 'all' | 'historical' = 'all', extra: Partial<PauseState> = {}): PauseState => ({
  paused: true,
  reason: 'test hold',
  by: 'op',
  at: '2026-11-18T00:00:00Z',
  scope,
  ...extra,
});
const NOT_PAUSED: PauseState = { paused: false, reason: null, by: null, at: null, scope: 'all' };

// ---------------------------------------------------------------------------
// The processor gate
// ---------------------------------------------------------------------------

function processorHarness(opts: { pause?: PauseState | Error; trigger?: MobileTranscodeJobData['trigger']; queuePaused?: boolean } = {}) {
  const calls: string[] = [];
  const queueState = { paused: opts.queuePaused ?? false };
  const queue = {
    isPaused: jest.fn(async () => {
      calls.push('isPaused');
      return queueState.paused;
    }),
    pause: jest.fn(async () => {
      calls.push('pause');
      queueState.paused = true;
    }),
    resume: jest.fn(async () => {
      calls.push('resume');
      queueState.paused = false;
    }),
  };
  const guard = {
    pauseState: jest.fn(async () => {
      if (opts.pause instanceof Error) throw opts.pause;
      return opts.pause ?? NOT_PAUSED;
    }),
    noteActive: jest.fn(),
    noteProgress: jest.fn(),
    noteFinished: jest.fn(),
    noteDeferred: jest.fn(),
  };
  const videos = {
    markMobileProcessing: jest.fn(async () => true),
    markMobileReady: jest.fn(async () => true),
    markMobileFailed: jest.fn(async () => undefined),
    markMobileRetrying: jest.fn(async () => undefined),
    markMobileDeferred: jest.fn(async () => undefined),
  };
  const transcoder = {
    preflight: jest.fn(async () => ({
      sourceMissing: false,
      sourceBytes: 1,
      budgetBytes: 1,
      assessment: { ok: true, freeBytes: 1e12, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 },
    })),
    run: jest.fn(async () => ({
      probe: { durationSeconds: 60, width: 640, height: 360, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
      renditions: [],
      hlsPrefix: 'hls/v_1/',
      masterPlaylistKey: 'hls/v_1/master.m3u8',
      thumbnailKey: undefined,
      isEncrypted: true,
    })),
  };
  const scheduler = {
    uploadPressure: jest.fn(async () => ({ waiting: 0, ignoredStale: 0, originalQueuePaused: false })),
    acquireEncodeSlot: jest.fn(async () => ({ holder: 'h', release: async () => undefined })),
  };
  const processor = new MobileVideoProcessor(
    transcoder as never,
    videos as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-safe-pause' }) } as never,
    guard as never,
    scheduler as never,
    queue as never,
  );
  const job = {
    id: 'mobile-hls:v_1:1794847870655',
    name: MOBILE_VIDEO_JOBS.transcode,
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: { videoId: 'v_1', sourceKey: 'source/videos/v_1.mp4', ladder: [360], encrypt: true, trigger: opts.trigger ?? 'migration' },
    updateProgress: jest.fn(async () => undefined),
    moveToDelayed: jest.fn(async (_ts: number, _token?: string) => {
      calls.push('moveToDelayed');
    }),
  } as unknown as Job<MobileTranscodeJobData> & { moveToDelayed: jest.Mock };
  return { processor, queue, queueState, guard, videos, transcoder, job, calls, scheduler };
}

describe('MobileVideoProcessor - operator holds', () => {
  it('FULL pause: pauses the BullMQ queue, then defers the job ONCE (no attempt used)', async () => {
    const t = processorHarness({ pause: paused('all'), trigger: 'upload' });
    const before = Date.now();

    await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);

    expect(t.queue.pause).toHaveBeenCalledTimes(1);
    // The queue is paused BEFORE the job goes back, so it is the last take.
    expect(t.calls).toEqual(['isPaused', 'pause', 'moveToDelayed']);
    const [due, token] = t.job.moveToDelayed.mock.calls[0];
    expect(token).toBe('tok');
    expect(due - before).toBeGreaterThanOrEqual(DEFER_WHEN_PAUSED_MS - 5);
    expect(due - before).toBeLessThan(DEFER_WHEN_PAUSED_MS + 5_000);
    expect(t.videos.markMobileProcessing).not.toHaveBeenCalled();
    expect(t.transcoder.run).not.toHaveBeenCalled();
  });

  it('FULL pause on a queue that is already paused: no second pause, still one defer', async () => {
    const t = processorHarness({ pause: paused('all'), queuePaused: true });
    await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(t.queue.pause).not.toHaveBeenCalled();
    expect(t.job.moveToDelayed).toHaveBeenCalledTimes(1);
  });

  it('FULL pause written by the watchdog (no scope field) is a full pause', async () => {
    // A real guard over a flag without `scope`, as an older watchdog writes it.
    const redis = { getJsonOrThrow: jest.fn(async () => ({ reason: 'auto-paused by safety watchdog', by: 'safety-watchdog', at: 'now' })) };
    const guard = new ScratchGuard(redis as never, { getOrThrow: () => ({}) } as never);
    await expect(guard.pauseState()).resolves.toMatchObject({ paused: true, scope: 'all' });
  });

  it('a queue that cannot be paused does not fail the job: it is deferred as before', async () => {
    const t = processorHarness({ pause: paused('all') });
    t.queue.pause.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(t.job.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
  });

  it('HISTORICAL hold: a historical job is PARKED (due >= 9 years out), the queue is not paused', async () => {
    for (const trigger of ['migration', 'recovery'] as const) {
      const t = processorHarness({ pause: paused('historical'), trigger });
      const before = Date.now();

      await expect(t.processor.process(t.job, 'tok')).rejects.toBeInstanceOf(DelayedError);

      const [due, token] = t.job.moveToDelayed.mock.calls[0];
      expect(token).toBe('tok');
      expect(due).toBeGreaterThanOrEqual(before + 9 * YEAR);
      expect(due).toBeGreaterThanOrEqual(before + MOBILE_PARK_MS - 5);
      expect(t.queue.pause).not.toHaveBeenCalled();
      expect(t.queue.isPaused).not.toHaveBeenCalled();
      expect(t.guard.noteDeferred).toHaveBeenCalledWith('v_1', 'parked (historical hold)');
      expect(t.scheduler.uploadPressure).not.toHaveBeenCalled();
      expect(t.transcoder.run).not.toHaveBeenCalled();
    }
  });

  it('HISTORICAL hold: an upload or a staff retry is not held and is encoded', async () => {
    for (const trigger of ['upload', 'retry'] as const) {
      const t = processorHarness({ pause: paused('historical'), trigger });
      await expect(t.processor.process(t.job, 'tok')).resolves.toEqual({ videoId: 'v_1', renditions: 0 });
      expect(t.job.moveToDelayed).not.toHaveBeenCalled();
    }
  });

  it('an UNREADABLE pause flag defers the job (DelayedError, no attempt used) instead of failing it', async () => {
    const t = processorHarness({ pause: new Error('Connection is closed.'), trigger: 'upload' });
    const before = Date.now();

    const outcome = await t.processor.process(t.job, 'tok').catch((e: unknown) => e);

    expect(outcome).toBeInstanceOf(DelayedError);
    const [due] = t.job.moveToDelayed.mock.calls[0];
    expect(due - before).toBeGreaterThanOrEqual(DEFER_WHEN_PAUSED_MS - 5);
    expect(due - before).toBeLessThan(2 * DEFER_WHEN_PAUSED_MS);
    expect(t.guard.noteDeferred).toHaveBeenCalledWith('v_1', 'pause state unreadable');
    expect(t.transcoder.run).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
    expect(t.videos.markMobileRetrying).not.toHaveBeenCalled();
  });

  it('not held: proceeds to the encode untouched by the pause machinery', async () => {
    const t = processorHarness({ pause: NOT_PAUSED, trigger: 'migration' });
    await expect(t.processor.process(t.job, 'tok')).resolves.toEqual({ videoId: 'v_1', renditions: 0 });
    expect(t.job.moveToDelayed).not.toHaveBeenCalled();
    expect(t.queue.pause).not.toHaveBeenCalled();
    expect(t.transcoder.run).toHaveBeenCalledTimes(1);
  });

  it('keeps a generous stalled budget for this worker only', () => {
    const options = Reflect.getMetadata(WORKER_METADATA, MobileVideoProcessor) as { maxStalledCount?: number };
    expect(options.maxStalledCount).toBeGreaterThanOrEqual(3);
  });
});

describe('MobileVideoProcessor - pause reconciler', () => {
  it('pauses a running queue when the flag holds everything', async () => {
    const t = processorHarness({ pause: paused('all') });
    await expect(t.processor.reconcileQueuePause()).resolves.toBe(true);
    expect(t.queue.pause).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the queue is already paused', async () => {
    const t = processorHarness({ pause: paused('all'), queuePaused: true });
    await expect(t.processor.reconcileQueuePause()).resolves.toBe(false);
    expect(t.queue.pause).not.toHaveBeenCalled();
  });

  it('NEVER resumes: not for a cleared flag, not for a historical hold', async () => {
    for (const pause of [NOT_PAUSED, paused('historical')]) {
      const t = processorHarness({ pause, queuePaused: true });
      await t.processor.reconcileQueuePause();
      expect(t.queue.resume).not.toHaveBeenCalled();
      expect(t.queue.pause).not.toHaveBeenCalled();
    }
  });

  it('ignores errors (unreadable flag, failing pause) and looks again later', async () => {
    const unreadable = processorHarness({ pause: new Error('ETIMEDOUT') });
    await expect(unreadable.processor.reconcileQueuePause()).resolves.toBe(false);
    expect(unreadable.queue.pause).not.toHaveBeenCalled();

    const failing = processorHarness({ pause: paused('all') });
    failing.queue.pause.mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(failing.processor.reconcileQueuePause()).resolves.toBe(false);
    await expect(failing.processor.reconcileQueuePause()).resolves.toBe(true);
  });

  it('runs at start and on every interval until the module is destroyed', async () => {
    jest.useFakeTimers();
    try {
      const t = processorHarness({ pause: NOT_PAUSED });
      t.processor.startPauseReconciler();
      await jest.advanceTimersByTimeAsync(0);
      expect(t.guard.pauseState).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(t.guard.pauseState).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(30_000);
      expect(t.guard.pauseState).toHaveBeenCalledTimes(3);
      t.processor.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(120_000);
      expect(t.guard.pauseState).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Parked jobs: recognised by the delayed-set score, released by promote
// ---------------------------------------------------------------------------

function delayedQueue(entries: Array<{ id: string; due: number }>, opts: { promoteFails?: Record<string, 'gone' | 'error'> } = {}) {
  const delayed = new Map(entries.map((e, i) => [e.id, e.due * BULLMQ_DELAYED_SCORE_FACTOR + (i % 4)]));
  const promoted: string[] = [];
  const client = {
    zrange: jest.fn(async () => [...delayed.entries()].flatMap(([id, score]) => [id, String(score)])),
    zscore: jest.fn(async (_k: string, id: string) => (delayed.has(id) ? String(delayed.get(id)) : null)),
  };
  const queue = {
    keys: { delayed: 'edu:bull:mobile-video-processing:delayed' },
    client: Promise.resolve(client),
    getJob: jest.fn(async (id: string) => ({
      id,
      promote: jest.fn(async () => {
        const failure = opts.promoteFails?.[id];
        if (failure === 'gone') {
          delayed.delete(id); // someone else promoted it first
          throw new Error(`Job ${id} is not in the delayed state. promote`);
        }
        if (failure === 'error') throw new Error('Connection is closed.');
        delayed.delete(id);
        promoted.push(id);
      }),
    })),
  };
  return { queue, promoted, delayed };
}

describe('parked jobs', () => {
  const now = Date.now();
  const entries = [
    { id: 'mobile-hls:a:1794847870655', due: now + MOBILE_PARK_MS }, // parked
    { id: 'mobile-hls:b:1794847870700', due: now - 1000 + MOBILE_PARK_MS }, // parked earlier
    { id: 'mobile-hls:c:p1g2', due: now + 60_000 }, // a 60 s deferral
    { id: 'mobile-hls:d:p1g1', due: now + 2 * 3600_000 }, // a retry backoff
    { id: 'mobile-hls:e:p1g1', due: now + MOBILE_PARKED_AFTER_MS - 60_000 }, // long, but not parked
  ];

  it('decodes BullMQ 5 delayed scores (due * 0x1000 + counter)', () => {
    expect(BULLMQ_DELAYED_SCORE_FACTOR).toBe(4096);
    const due = 1_794_847_870_655;
    for (const counter of [0, 1, 4095]) expect(dueTimeFromDelayedScore(due * 4096 + counter)).toBe(due);
  });

  it('lists only jobs due more than a year out', async () => {
    const { queue } = delayedQueue(entries);
    await expect(listParkedJobIds(queue as never, now)).resolves.toEqual(['mobile-hls:a:1794847870655', 'mobile-hls:b:1794847870700']);
    await expect(countParkedJobs(queue as never, now)).resolves.toBe(2);
  });

  it('promotes exactly the parked jobs and leaves deferrals and retry backoffs alone', async () => {
    const t = delayedQueue(entries);
    await expect(promoteParkedJobs(t.queue as never, now)).resolves.toEqual({
      promoted: ['mobile-hls:a:1794847870655', 'mobile-hls:b:1794847870700'],
      skipped: [],
    });
    expect([...t.delayed.keys()]).toEqual(['mobile-hls:c:p1g2', 'mobile-hls:d:p1g1', 'mobile-hls:e:p1g1']);
  });

  it('a job promoted by someone else meanwhile is skipped; a Redis error is thrown', async () => {
    const gone = delayedQueue(entries, { promoteFails: { 'mobile-hls:a:1794847870655': 'gone' } });
    await expect(promoteParkedJobs(gone.queue as never, now)).resolves.toEqual({
      promoted: ['mobile-hls:b:1794847870700'],
      skipped: ['mobile-hls:a:1794847870655'],
    });

    const broken = delayedQueue(entries, { promoteFails: { 'mobile-hls:a:1794847870655': 'error' } });
    await expect(promoteParkedJobs(broken.queue as never, now)).rejects.toThrow('Connection is closed.');
  });
});

// ---------------------------------------------------------------------------
// The operator transitions and their ORDER
// ---------------------------------------------------------------------------

function transitionHarness(opts: { queuePaused?: boolean; parked?: string[]; withQueue?: boolean; failOn?: string } = {}) {
  const log: string[] = [];
  const store = new Map<string, unknown>();
  const fail = (step: string) => {
    if (opts.failOn === step) throw new Error(`${step}: Connection is closed.`);
  };
  const redis = {
    getJson: async (k: string) => store.get(k) ?? null,
    getJsonOrThrow: async (k: string) => store.get(k) ?? null,
    setJsonPersistentOrThrow: async (k: string, v: { scope?: string }) => {
      fail('flag:set');
      log.push(`flag:set(${v.scope})`);
      store.set(k, v);
    },
    delOrThrow: async (k: string) => {
      fail('flag:del');
      log.push('flag:del');
      store.delete(k);
    },
  };
  const queueState = { paused: opts.queuePaused ?? false };
  const now = Date.now();
  const delayed = new Map<string, number>([
    ...(opts.parked ?? []).map((id) => [id, (now + MOBILE_PARK_MS) * 4096] as [string, number]),
    ['mobile-hls:backoff:p1g1', (now + 30_000) * 4096],
  ]);
  const mobileQueue = {
    isPaused: jest.fn(async () => {
      fail('isPaused');
      log.push('isPaused');
      return queueState.paused;
    }),
    pause: jest.fn(async () => {
      fail('pause');
      log.push('pause');
      queueState.paused = true;
    }),
    resume: jest.fn(async () => {
      fail('resume');
      log.push('resume');
      queueState.paused = false;
    }),
    keys: { delayed: 'edu:bull:mobile-video-processing:delayed' },
    get client() {
      return Promise.resolve({
        zrange: async () => {
          log.push('list-parked');
          return [...delayed.entries()].flatMap(([id, s]) => [id, String(s)]);
        },
        zscore: async (_k: string, id: string) => (delayed.has(id) ? String(delayed.get(id)) : null),
      });
    },
    getJob: jest.fn(async (id: string) => ({
      id,
      promote: async () => {
        fail('promote');
        log.push(`promote(${id})`);
        delayed.delete(id);
      },
    })),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const svc = new VideosService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    audit as never,
    redis as never,
    {} as never,
    { getOrThrow: () => ({ ladder: [360], encryptionEnabled: true, mobile: {} }) } as never,
    {} as never,
    {} as never,
    opts.withQueue === false ? undefined : (mobileQueue as never),
    {} as never,
  );
  return { svc, log, store, queueState, mobileQueue, audit, delayed };
}

const OP = { id: 'admin_1', role: 'ADMIN' as never };

describe('setMobileProcessingPaused - transitions in a safe order', () => {
  it('pause (all): 1. pause the queue  2. write the flag', async () => {
    const t = transitionHarness();
    await expect(t.svc.setMobileProcessingPaused(true, OP, 'metered connection')).resolves.toMatchObject({
      paused: true,
      scope: 'all',
      queuePaused: true,
      queueControl: 'queue',
    });
    expect(t.log).toEqual(['isPaused', 'pause', 'flag:set(all)']);
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ paused: true, scope: 'all', queuePaused: true }) }),
    );
  });

  it('pause (all) when the queue is already paused: only the flag (idempotent)', async () => {
    const t = transitionHarness({ queuePaused: true });
    await t.svc.setMobileProcessingPaused(true, OP);
    expect(t.log).toEqual(['isPaused', 'flag:set(all)']);
  });

  it('pause (all) that cannot pause the queue writes no flag and says so', async () => {
    const t = transitionHarness({ failOn: 'pause' });
    await expect(t.svc.setMobileProcessingPaused(true, OP)).rejects.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
    expect(t.store.size).toBe(0);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('pause (historical): 1. write the flag  2. resume the queue if it was paused (uploads run again)', async () => {
    const t = transitionHarness({ queuePaused: true });
    await expect(t.svc.setMobileProcessingPaused(true, OP, 'between batches', 'historical')).resolves.toMatchObject({
      paused: true,
      scope: 'historical',
      queuePaused: false,
    });
    expect(t.log).toEqual(['flag:set(historical)', 'isPaused', 'resume']);
  });

  it('pause (historical) with a flag write failure does not resume the queue', async () => {
    const t = transitionHarness({ queuePaused: true, failOn: 'flag:set' });
    await expect(t.svc.setMobileProcessingPaused(true, OP, 'x', 'historical')).rejects.toThrow();
    expect(t.queueState.paused).toBe(true);
    expect(t.mobileQueue.resume).not.toHaveBeenCalled();
  });

  it('resume: 1. delete the flag  2. promote every PARKED job (only those)  3. resume the queue', async () => {
    const t = transitionHarness({ queuePaused: true, parked: ['mobile-hls:a:1', 'mobile-hls:b:2'] });
    t.store.set('mobile:transcode:paused', { reason: 'x', by: 'op', at: 'now', scope: 'all' });

    await expect(t.svc.setMobileProcessingPaused(false, OP)).resolves.toMatchObject({
      paused: false,
      queuePaused: false,
      parkedPromoted: 2,
    });

    expect(t.log).toEqual([
      'flag:del',
      'list-parked',
      'promote(mobile-hls:a:1)',
      'promote(mobile-hls:b:2)',
      'isPaused',
      'resume',
    ]);
    // The retry backoff in the delayed set was not touched.
    expect([...t.delayed.keys()]).toEqual(['mobile-hls:backoff:p1g1']);
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ paused: false, parkedPromoted: 2, queuePaused: false }) }),
    );
  });

  it('resume whose release fails does NOT resume the queue; running it again converges', async () => {
    const t = transitionHarness({ queuePaused: true, parked: ['mobile-hls:a:1'], failOn: 'promote' });
    await expect(t.svc.setMobileProcessingPaused(false, OP)).rejects.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
    expect(t.queueState.paused).toBe(true);
    expect(t.mobileQueue.resume).not.toHaveBeenCalled();

    // Fixed; the same request again finishes the job.
    const again = transitionHarness({ queuePaused: true, parked: ['mobile-hls:a:1'] });
    await expect(again.svc.setMobileProcessingPaused(false, OP)).resolves.toMatchObject({ parkedPromoted: 1, queuePaused: false });
  });

  it('without a mobile queue on this process: flag only, as before, and the result says so', async () => {
    const t = transitionHarness({ withQueue: false });
    await expect(t.svc.setMobileProcessingPaused(true, OP)).resolves.toMatchObject({
      paused: true,
      queuePaused: null,
      queueControl: 'flag-only',
      note: expect.stringContaining('only the pause flag'),
    });
    expect(t.log).toEqual(['flag:set(all)']);
  });
});

// ---------------------------------------------------------------------------
// The claim: no duplicate encode of one video
// ---------------------------------------------------------------------------

const V = 'v_1';
const SRC = 'source/videos/v_1/a.mp4';

describe('markMobileProcessing - a job that does not own the row never re-encodes a READY video', () => {
  it('non-owner on a READY row: false, nothing written', async () => {
    const w = apiProcess({ withMobileQueue: true });
    w.db.rows.set(V, videoRow({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 2), sourceKey: SRC }));
    const writes = w.db.writes.length;
    await expect(w.videos.markMobileProcessing(V, SRC, 'mobile-hls:v_1:1794847870655')).resolves.toBe(false);
    expect(w.db.writes.length).toBe(writes);
    expect(w.db.get(V).mobileStatus).toBe('READY');
  });

  it('owner on its row proceeds', async () => {
    const w = apiProcess();
    w.db.rows.set(V, videoRow({ mobileStatus: 'QUEUED', mobileJobId: mobileJobIdFor(V, 3), sourceKey: SRC }));
    await expect(w.videos.markMobileProcessing(V, SRC, mobileJobIdFor(V, 3))).resolves.toBe(true);
    expect(w.db.get(V).mobileStatus).toBe('PROCESSING');
  });

  it('a row that turns READY between the read and the compare-and-set is not claimed by a non-owner', async () => {
    const w = apiProcess();
    w.db.rows.set(V, videoRow({ mobileStatus: 'FAILED', mobileJobId: mobileJobIdFor(V, 2), sourceKey: SRC }));
    const read = w.db.video.findFirst;
    w.db.video.findFirst = (async (args: never) => {
      const seen = await read(args);
      // The owner finishes right after the read.
      Object.assign(w.db.get(V), { mobileStatus: 'READY' });
      return seen;
    }) as never;
    await expect(w.videos.markMobileProcessing(V, SRC, 'mobile-hls:v_1:old')).resolves.toBe(false);
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 2) });
  });

  it('a FORCED re-encode of a READY video still runs: the intent (row) names the new job before the job exists', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await mobileWorker(w).runNext();
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 1) });

    // What the row said at the moment the job reached the queue.
    const add = w.mobileQueue.add;
    const rowAtAdd: Record<string, unknown>[] = [];
    w.mobileQueue.add = ((name: string, data: Record<string, unknown>, opts: Record<string, unknown>) => {
      rowAtAdd.push({ ...w.db.get(V), jobId: opts.jobId });
      return add(name, data, opts);
    }) as never;

    await expect(w.videos.retryMobileProcessing(V, ADMIN, { force: true })).resolves.toMatchObject({ jobId: mobileJobIdFor(V, 2) });
    expect(rowAtAdd).toEqual([expect.objectContaining({ mobileStatus: 'QUEUED', mobileJobId: mobileJobIdFor(V, 2), jobId: mobileJobIdFor(V, 2) })]);

    const encode = jest.fn();
    expect(await mobileWorker(w, { encode }).runNext()).toMatchObject({ outcome: 'completed' });
    expect(encode).toHaveBeenCalledTimes(1);
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 2) });
  });
});

// ---------------------------------------------------------------------------
// Supersede: an administrator replaces a worn live job with a fresh generation
// ---------------------------------------------------------------------------

describe('retryMobileProcessing - supersede', () => {
  /** A historical job that is live (prioritized) and worn: the production shape. */
  function wornJob() {
    const w = uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1) });
    return w;
  }

  it('only an administrator may supersede', async () => {
    const w = wornJob();
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: SRC }, 'migration');
    await expect(w.videos.retryMobileProcessing(V, STAFF, { supersede: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(w.mobileQueue.jobs.size).toBe(1);
  });

  it('without supersede a live job is kept (no duplicate); with it a NEW generation is queued, the old one left alone', async () => {
    const w = wornJob();
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: SRC }, 'migration');
    const old = mobileJobIdFor(V, 1);
    const oldBefore = { ...w.mobileQueue.jobs.get(old)! };

    await expect(w.videos.retryMobileProcessing(V, ADMIN)).resolves.toMatchObject({ jobId: old, alreadyQueued: true });

    await expect(w.videos.retryMobileProcessing(V, ADMIN, { supersede: true })).resolves.toMatchObject({
      jobId: mobileJobIdFor(V, 2),
      alreadyQueued: false,
      enqueued: true,
    });
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileJobId: mobileJobIdFor(V, 2), mobileGeneration: 2 });
    // The old job is untouched in the queue...
    expect(w.mobileQueue.jobs.get(old)).toEqual(oldBefore);
    // ...and the new one is a staff retry: fresh counters, ahead of historical work.
    expect(w.mobileQueue.jobs.get(mobileJobIdFor(V, 2))).toMatchObject({ state: 'waiting', attemptsMade: 0, data: { trigger: 'retry' } });
    expect(w.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ after: expect.objectContaining({ supersede: true, supersededJobId: old, jobId: mobileJobIdFor(V, 2) }) }),
    );
  });

  it('the old job steps aside while the new one is live, and after it finished (READY); one encode in total', async () => {
    const w = wornJob();
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: SRC }, 'migration');
    const old = mobileJobIdFor(V, 1);
    await w.videos.retryMobileProcessing(V, ADMIN, { supersede: true });
    const encode = jest.fn();
    const worker = mobileWorker(w, { encode });

    // The old job runs first (forced here): the row names the new, live job.
    await expect(worker.claim(w.mobileQueue.jobs.get(old)!)).resolves.toEqual({ videoId: V, skipped: true });
    // The new one encodes.
    expect(await worker.runNext()).toMatchObject({ outcome: 'completed', job: { id: mobileJobIdFor(V, 2) } });
    // The old one again, after the new one completed: READY under another id.
    await expect(worker.claim(w.mobileQueue.jobs.get(old)!)).resolves.toEqual({ videoId: V, skipped: true });

    expect(encode).toHaveBeenCalledTimes(1);
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 2) });
  });

  it('is refused while the row is PROCESSING (the old job may still write), even if its job is not active', async () => {
    const w = wornJob();
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: SRC }, 'migration');
    w.db.get(V).mobileStatus = 'PROCESSING'; // claimed; its worker died, the stalled check has not run yet
    await expect(w.videos.retryMobileProcessing(V, ADMIN, { supersede: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(w.mobileQueue.jobs.size).toBe(1);
  });

  it('loses to a claim that lands between its check and its write: no new job, the old one keeps the row', async () => {
    const w = wornJob();
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: SRC }, 'migration');
    const old = mobileJobIdFor(V, 1);
    const updateMany = w.db.video.updateMany;
    w.db.video.updateMany = (async (args: { data: Record<string, unknown> }) => {
      // The supersede's intent write: the old job's claim lands just before it.
      if (args.data.mobileGeneration === 2) Object.assign(w.db.get(V), { mobileStatus: 'PROCESSING' });
      return updateMany(args as never);
    }) as never;

    const result = await w.videos.retryMobileProcessing(V, ADMIN, { supersede: true });

    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'PROCESSING', mobileJobId: old, mobileGeneration: 1 });
    expect(result).toMatchObject({ alreadyQueued: true });
    expect(w.mobileQueue.jobs.size).toBe(1);
  });

  it('is refused while the old job is being encoded', async () => {
    const w = wornJob();
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: SRC }, 'migration');
    w.mobileQueue.jobs.get(mobileJobIdFor(V, 1))!.state = 'active';
    await expect(w.videos.retryMobileProcessing(V, ADMIN, { supersede: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(w.mobileQueue.jobs.size).toBe(1);
    expect(w.db.get(V).mobileJobId).toBe(mobileJobIdFor(V, 1));
  });
});

// ---------------------------------------------------------------------------
// End to end over the stateful doubles: hold, partial processing, release
// ---------------------------------------------------------------------------

describe('park and release, end to end (stateful doubles)', () => {
  it('historical hold parks the backlog on one take, uploads flow, resume releases each parked job once', async () => {
    const w = uploadedWorld();
    w.db.rows.set('old', videoRow({ id: 'old', sourceKey: 'source/videos/old/a.mp4', status: 'READY', sourceSizeBytes: BigInt(5) }));
    w.storage.objects.set('source/videos/old/a.mp4', 5);
    await w.videos.enqueueMobileTranscode({ id: 'old', sourceKey: 'source/videos/old/a.mp4' }, 'migration');

    await w.videos.setMobileProcessingPaused(true, ADMIN, 'between batches', 'historical');
    const encode = jest.fn();
    const worker = mobileWorker(w, { encode, pauseFromRedis: true });

    expect(await worker.runNext()).toMatchObject({ outcome: 'deferred', job: { data: { videoId: 'old' } } });
    const parked = w.mobileQueue.jobs.get(mobileJobIdFor('old', 1))!;
    expect(parked.state).toBe('delayed');
    expect(parked.dueAt! - Date.now()).toBeGreaterThan(9 * YEAR);
    expect(await worker.runNext()).toBeNull(); // nothing to take: it is parked

    await w.videos.completeUpload(V, STAFF);
    expect(await worker.runNext()).toMatchObject({ outcome: 'completed', job: { data: { videoId: V } } });
    expect(await worker.runNext()).toBeNull();

    await expect(w.videos.setMobileProcessingPaused(false, ADMIN)).resolves.toMatchObject({ parkedPromoted: 1, queuePaused: false });
    expect(await worker.runNext()).toMatchObject({ outcome: 'completed', job: { id: mobileJobIdFor('old', 1) } });
    expect(encode.mock.calls.map((c) => c[0])).toEqual([V, 'old']);
  });

  it('a full pause through the API takes nothing at all; resume lets everything run', async () => {
    const w = uploadedWorld();
    await w.videos.setMobileProcessingPaused(true, ADMIN, 'metered');
    await w.videos.completeUpload(V, STAFF);
    const worker = mobileWorker(w, { pauseFromRedis: true });
    expect(await worker.runNext()).toBeNull();
    await w.videos.setMobileProcessingPaused(false, ADMIN);
    expect(await worker.runNext()).toMatchObject({ outcome: 'completed' });
  });
});
