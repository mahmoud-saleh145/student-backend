import { TranscodeOutputError } from '../../src/jobs/processors/hls-transcoder';
import { mobileJobIdFor, uploadTranscodeJobIdFor } from '../../src/modules/videos/pipeline-state';
import { VideoPipelineReconciler } from '../../src/modules/videos/video-pipeline-reconciler.service';
import { QUEUE_OPERATION_TIMEOUT_MS, WAITING_FOR_QUEUE_NOTE } from '../../src/modules/videos/videos.service';

import {
  ADMIN,
  apiProcess,
  FakeDb,
  GUMLET_FIELDS,
  gumletWorker,
  MOBILE_FIELDS,
  mobileWorker,
  STAFF,
  uploadedWorld,
  videoRow,
} from './support/pipeline-fakes';

/**
 * THE TWO PROCESSING PIPELINES ARE INDEPENDENT
 * ============================================
 *
 * One uploaded lecture is processed twice, by two unrelated systems:
 *
 *   GUMLET   managed transcoding + DRM, for the web player
 *   MOBILE   our own ffmpeg ladder (AES-128 HLS on R2), for the native apps
 *
 * These tests pin the rule that neither may be a precondition of the other,
 * and that confirming an upload is a third, separate fact:
 *
 *   - the upload is ACCEPTED once the file is verified in storage, whatever
 *     the queue, Gumlet or the encoder are doing;
 *   - a Gumlet rejection does not stop the mobile ladder;
 *   - a missing, sleeping or failing encoder does not stop Gumlet;
 *   - the instruction to process survives Redis being down and the API
 *     restarting;
 *   - no request, retry or sweep produces a second job for the same work.
 *
 * Everything here runs the REAL VideosService and the REAL processors against
 * stateful doubles (test/unit/support/pipeline-fakes.ts). Each scenario letter
 * matches the acceptance scenario of the same letter.
 */

const V = 'v_1';
const SRC = 'source/videos/v_1/a.mp4';
const later = (ms: number) => new Date(Date.now() + ms);
const MIN = 60_000;

// ---------------------------------------------------------------------------
describe('Scenario A - normal upload', () => {
  it('queues both pipelines from one confirmed upload, and each completes on its own', async () => {
    const w = uploadedWorld();

    const result = await w.videos.completeUpload(V, STAFF);

    // One acceptance, three separate facts.
    expect(result).toMatchObject({
      status: 'QUEUED',
      upload: { state: 'VERIFIED', sizeBytes: 100_000_000 },
      gumlet: { queued: true },
      mobile: { status: 'QUEUED', queued: true, automatic: true },
    });
    expect(w.webQueue.live().map((j) => j.id)).toEqual([uploadTranscodeJobIdFor(V, SRC)]);
    expect(w.mobileQueue.live().map((j) => j.id)).toEqual([mobileJobIdFor(V, 1)]);
    // A new upload's mobile job carries no priority: it goes before the backlog.
    expect(w.mobileQueue.live()[0]).toMatchObject({ state: 'waiting', data: { trigger: 'upload', sourceKey: SRC } });

    await gumletWorker(w, () => 'ready').drain();
    expect(w.db.get(V)).toMatchObject({ status: 'READY', gumletStatus: 'ready', mobileStatus: 'QUEUED' });

    await mobileWorker(w).runNext();
    expect(w.db.get(V)).toMatchObject({
      status: 'READY',
      gumletStatus: 'ready',
      mobileStatus: 'READY',
      hlsPrefix: 'hls/v_1/',
      mobileError: null,
    });
    expect((w.db.get(V).renditions as unknown[]).length).toBe(2);
  });

  it('does not wait for either pipeline: the answer is given while both are still queued', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    expect(w.db.get(V)).toMatchObject({ status: 'QUEUED', mobileStatus: 'QUEUED', sourceSizeBytes: BigInt(100_000_000) });
  });

  it('records the mobile intent BEFORE the Gumlet job is attempted', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);

    const firstMobileWrite = w.db.writes.findIndex((write) => write.fields.includes('mobileRequestedAt'));
    const firstGumletWrite = w.db.writes.findIndex((write) => write.fields.includes('status'));
    expect(firstMobileWrite).toBeGreaterThanOrEqual(0);
    expect(firstMobileWrite).toBeLessThan(firstGumletWrite);
  });
});

// ---------------------------------------------------------------------------
describe('Scenario B - Gumlet rejects the video', () => {
  it('mobile is still queued, still processes, and ends READY beside a FAILED Gumlet', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);

    await gumletWorker(w, () => 'reject').drain();

    // Gumlet failed, in Gumlet's own fields...
    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', gumletStatus: 'errored' });
    // ...and the mobile intent is exactly where it was.
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileError: null, mobileJobId: mobileJobIdFor(V, 1) });
    expect(w.mobileQueue.live()).toHaveLength(1);

    await mobileWorker(w).runNext();

    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', mobileStatus: 'READY', hlsPrefix: 'hls/v_1/' });

    const status = await w.videos.status(V, STAFF);
    expect(status.source.state).toBe('VERIFIED');
    expect(status.gumlet).toMatchObject({ state: 'FAILED', canRetry: true });
    expect(status.gumlet.error).toContain('unsupported codec');
    expect(status.mobile).toMatchObject({ status: 'READY', renditions: 2, error: null, canRetry: false });
  });

  it('a Gumlet outage (API timeout) is equally irrelevant to the mobile job', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await gumletWorker(w, () => 'outage').drain();
    await mobileWorker(w).runNext();
    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', mobileStatus: 'READY' });
  });

  it('the Gumlet worker never writes a mobile field', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const before = w.db.snapshot(V, MOBILE_FIELDS);
    const writesBefore = w.db.writes.length;

    await gumletWorker(w, () => 'reject').drain();

    expect(w.db.snapshot(V, MOBILE_FIELDS)).toEqual(before);
    for (const write of w.db.writes.slice(writesBefore)) {
      expect(write.fields.filter((f) => f.startsWith('mobile'))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Scenario C - the Docker worker is offline', () => {
  it('Gumlet proceeds, the mobile job waits untouched, and it runs when a worker appears', async () => {
    const w = uploadedWorld();
    const result = await w.videos.completeUpload(V, STAFF);

    // No heartbeat: nobody is consuming. The upload is accepted all the same.
    expect(result).toMatchObject({ status: 'QUEUED', workerOnline: false, mobile: { status: 'QUEUED', queued: true } });

    await gumletWorker(w, () => 'ready').drain();
    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'QUEUED' });

    // Hours pass. The sweep and the reconciler both run; the job is live in
    // Redis, so neither duplicates it nor fails it.
    await w.videos.recoverStrandedMobileVideos(later(6 * 60 * MIN));
    await w.videos.reconcilePendingIntents();
    expect(w.mobileQueue.jobs.size).toBe(1);
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileGeneration: 1, mobileError: null });

    // The dashboard says QUEUED and that no encoder is online - not "processing".
    const waiting = await w.videos.status(V, STAFF);
    expect(waiting.mobile).toMatchObject({ status: 'QUEUED', queued: true, workerOnline: false, progress: null, active: false });

    // The laptop comes back.
    await mobileWorker(w).runNext();
    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
  });

  it('a mobile encode that is running does not delay or alter the Gumlet result', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const worker = mobileWorker(w);
    const job = worker.startNext()!;
    await w.videos.markMobileProcessing(V, SRC, job.id);

    await gumletWorker(w, () => 'ready').drain();

    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'PROCESSING' });
  });
});

// ---------------------------------------------------------------------------
describe('Scenario D - Redis is unavailable', () => {
  it('the upload still succeeds, both intents are durable, and one job each appears when Redis returns', async () => {
    const w = uploadedWorld();
    w.webQueue.outage = 'reject';
    w.mobileQueue.outage = 'reject';

    // Not an upload failure: the file is verified in storage.
    const result = await w.videos.completeUpload(V, STAFF);
    expect(result).toMatchObject({
      status: 'QUEUED',
      jobId: null,
      upload: { state: 'VERIFIED' },
      gumlet: { queued: false },
      mobile: { status: 'QUEUED', queued: false },
    });

    // The instructions are in the database, undelivered, and nothing is FAILED.
    expect(w.db.get(V)).toMatchObject({
      status: 'QUEUED',
      processingJobId: null,
      mobileStatus: 'QUEUED',
      mobileEnqueuedAt: null,
      mobileJobId: mobileJobIdFor(V, 1),
      mobileError: WAITING_FOR_QUEUE_NOTE,
    });
    expect(w.webQueue.jobs.size + w.mobileQueue.jobs.size).toBe(0);

    // Redis still down: the reconciler tries, delivers nothing, changes nothing.
    await expect(w.videos.reconcilePendingIntents()).resolves.toEqual({
      mobile: { pending: 1, queued: 0 },
      web: { pending: 1, queued: 0 },
    });
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileGeneration: 1, status: 'QUEUED' });

    // Redis is back.
    w.webQueue.outage = null;
    w.mobileQueue.outage = null;
    await expect(w.videos.reconcilePendingIntents()).resolves.toEqual({
      mobile: { pending: 1, queued: 1 },
      web: { pending: 1, queued: 1 },
    });
    expect(w.mobileQueue.live().map((j) => j.id)).toEqual([mobileJobIdFor(V, 1)]);
    expect(w.webQueue.live().map((j) => j.id)).toEqual([uploadTranscodeJobIdFor(V, SRC)]);
    expect(w.db.get(V)).toMatchObject({ processingJobId: uploadTranscodeJobIdFor(V, SRC), mobileError: null });
    expect(w.db.get(V).mobileEnqueuedAt).toBeInstanceOf(Date);
    // The upload keeps its place in front of historical work after the delay.
    expect(w.mobileQueue.live()[0]).toMatchObject({ state: 'waiting', data: { trigger: 'upload' } });

    // Further passes find nothing to do and touch nothing.
    await expect(w.videos.reconcilePendingIntents()).resolves.toEqual({
      mobile: { pending: 0, queued: 0 },
      web: { pending: 0, queued: 0 },
    });
    expect(w.mobileQueue.jobs.size).toBe(1);
    expect(w.webQueue.jobs.size).toBe(1);

    // And the work then completes normally, once.
    await gumletWorker(w, () => 'ready').drain();
    const mobile = mobileWorker(w);
    await mobile.runNext();
    expect(mobile.transcoder.run).toHaveBeenCalledTimes(1);
    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
  });

  it('a Redis that never answers cannot hang the upload request (BullMQ waits for ever by default)', async () => {
    jest.useFakeTimers();
    try {
      const w = uploadedWorld();
      w.webQueue.outage = 'hang';
      w.mobileQueue.outage = 'hang';

      const pending = w.videos.completeUpload(V, STAFF);
      // Two bounded queue operations in sequence, at most.
      await jest.advanceTimersByTimeAsync(QUEUE_OPERATION_TIMEOUT_MS * 3);
      const result = await pending;

      expect(result).toMatchObject({ status: 'QUEUED', gumlet: { queued: false }, mobile: { status: 'QUEUED', queued: false } });
      expect(w.db.get(V)).toMatchObject({ status: 'QUEUED', mobileStatus: 'QUEUED', mobileEnqueuedAt: null });
    } finally {
      jest.useRealTimers();
    }
  });

  it('the reconciler costs no Redis traffic when nothing is pending', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const calls = { web: w.webQueue.addCalls, mobile: w.mobileQueue.addCalls };
    const getJob = jest.spyOn(w.mobileQueue, 'getJob');
    const getWebJob = jest.spyOn(w.webQueue, 'getJob');

    await w.videos.reconcilePendingIntents();

    expect(getJob).not.toHaveBeenCalled();
    expect(getWebJob).not.toHaveBeenCalled();
    expect({ web: w.webQueue.addCalls, mobile: w.mobileQueue.addCalls }).toEqual(calls);
  });

  it('storage being unreachable is reported as such, never as "upload the file again"', async () => {
    const w = uploadedWorld();
    w.storage.unreachable = true;

    await expect(w.videos.completeUpload(V, STAFF)).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    // Nothing was accepted on a guess.
    expect(w.db.get(V)).toMatchObject({ status: 'UPLOADING', sourceSizeBytes: null, mobileStatus: 'NONE' });
  });
});

// ---------------------------------------------------------------------------
describe('Scenario E - the API stops between the database commit and the enqueue', () => {
  it('a new process finds the committed intents and creates the missing jobs', async () => {
    // Process 1 commits the acceptance, then dies before anything reaches Redis.
    const first = uploadedWorld();
    first.webQueue.outage = 'reject';
    first.mobileQueue.outage = 'reject';
    await first.videos.completeUpload(V, STAFF);
    expect(first.db.get(V)).toMatchObject({ status: 'QUEUED', processingJobId: null, mobileStatus: 'QUEUED', mobileEnqueuedAt: null });

    // Process 2: a fresh service over the same database and a healthy Redis.
    first.webQueue.outage = null;
    first.mobileQueue.outage = null;
    const second = apiProcess({ db: first.db, storage: first.storage, webQueue: first.webQueue, mobileQueue: first.mobileQueue });
    const reconciler = new VideoPipelineReconciler(second.videos);

    // The new process knows nothing in memory about the stranded intents...
    expect(second.videos.hasUndeliveredIntents()).toBe(false);
    // ...and finds them in the database on its boot scan.
    await expect(reconciler.tick()).resolves.toEqual({
      mobile: { pending: 1, queued: 1 },
      web: { pending: 1, queued: 1 },
    });

    expect(second.mobileQueue.live().map((j) => j.id)).toEqual([mobileJobIdFor(V, 1)]);
    expect(second.webQueue.live().map((j) => j.id)).toEqual([uploadTranscodeJobIdFor(V, SRC)]);
  });

  it('the reconciler survives a database outage and simply tries again next tick', async () => {
    const w = uploadedWorld();
    const reconciler = new VideoPipelineReconciler(w.videos);
    w.db.down = true;
    await expect(reconciler.tick()).resolves.toBeNull();
    w.db.down = false;
    await expect(reconciler.tick()).resolves.toEqual({ mobile: { pending: 0, queued: 0 }, web: { pending: 0, queued: 0 } });
  });

  it('two processes reconciling the same intent at the same moment produce one job', async () => {
    const first = uploadedWorld();
    first.webQueue.outage = 'reject';
    first.mobileQueue.outage = 'reject';
    await first.videos.completeUpload(V, STAFF);
    first.webQueue.outage = null;
    first.mobileQueue.outage = null;
    const second = apiProcess({ db: first.db, storage: first.storage, webQueue: first.webQueue, mobileQueue: first.mobileQueue });

    await Promise.all([
      first.videos.reconcilePendingIntents(),
      second.videos.reconcilePendingIntents(),
    ]);

    expect(first.mobileQueue.jobs.size).toBe(1);
    expect(first.webQueue.jobs.size).toBe(1);
    expect(first.db.get(V).mobileGeneration).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('Scenario F - the dashboard retries upload finalisation', () => {
  it('three simultaneous requests and two later ones: one video, one job per pipeline', async () => {
    const w = uploadedWorld();

    const burst = await Promise.all([
      w.videos.completeUpload(V, STAFF),
      w.videos.completeUpload(V, STAFF),
      w.videos.completeUpload(V, STAFF),
    ]);
    const again = await w.videos.completeUpload(V, STAFF);
    const andAgain = await w.videos.completeUpload(V, STAFF, 100_000_000);

    for (const result of [...burst, again, andAgain]) expect(result.status).toBe('QUEUED');
    expect(again).toMatchObject({ alreadyQueued: true, jobId: uploadTranscodeJobIdFor(V, SRC) });
    expect(w.db.rows.size).toBe(1);
    expect(w.webQueue.jobs.size).toBe(1);
    expect(w.mobileQueue.jobs.size).toBe(1);
    expect(w.db.get(V)).toMatchObject({ mobileGeneration: 1, mobileJobId: mobileJobIdFor(V, 1) });

    const mobile = mobileWorker(w);
    await mobile.runNext();
    expect(await mobile.runNext()).toBeNull();
    expect(mobile.transcoder.run).toHaveBeenCalledTimes(1);
  });

  it('finalising again after everything is READY starts nothing', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await gumletWorker(w, () => 'ready').drain();
    await mobileWorker(w).runNext();
    const jobs = { web: w.webQueue.addCalls, mobile: w.mobileQueue.addCalls };

    const result = await w.videos.completeUpload(V, STAFF);

    expect(result).toMatchObject({ status: 'READY', alreadyQueued: true, mobile: { status: 'READY' } });
    expect({ web: w.webQueue.addCalls, mobile: w.mobileQueue.addCalls }).toEqual(jobs);
    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY', mobileGeneration: 1 });
  });

  it('a retried finalisation REPAIRS a mobile enqueue that Redis refused the first time', async () => {
    const w = uploadedWorld();
    w.mobileQueue.outage = 'reject';
    await w.videos.completeUpload(V, STAFF);
    expect(w.mobileQueue.jobs.size).toBe(0);

    w.mobileQueue.outage = null;
    const retry = await w.videos.completeUpload(V, STAFF);

    expect(retry).toMatchObject({ alreadyQueued: true, mobile: { status: 'QUEUED', queued: true } });
    // The SAME intent's job, not a second intent.
    expect(w.mobileQueue.live().map((j) => j.id)).toEqual([mobileJobIdFor(V, 1)]);
    expect(w.db.get(V).mobileGeneration).toBe(1);
  });

  it('an incomplete source is never queued', async () => {
    const w = uploadedWorld();
    w.storage.objects.clear();

    await expect(w.videos.completeUpload(V, STAFF)).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
    w.storage.objects.set(SRC, 99);
    await expect(w.videos.completeUpload(V, STAFF, 100)).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });

    expect(w.webQueue.addCalls + w.mobileQueue.addCalls).toBe(0);
    expect(w.db.get(V)).toMatchObject({ status: 'UPLOADING', mobileStatus: 'NONE', mobileRequestedAt: null });
  });
});

// ---------------------------------------------------------------------------
describe('Scenario G - retrying one pipeline leaves the other alone', () => {
  it('Gumlet failed, mobile READY: "Retry Gumlet" does not touch the mobile ladder', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await gumletWorker(w, () => 'reject').drain();
    await mobileWorker(w).runNext();
    const mobileBefore = w.db.snapshot(V, [...MOBILE_FIELDS, 'renditions']);
    const mobileJobs = w.mobileQueue.addCalls;

    const result = await w.videos.retryProcessing(V, STAFF);

    expect(result).toMatchObject({ provider: 'gumlet', recovered: true });
    expect(w.gumlet.replaceFailedAsset).toHaveBeenCalledTimes(1);
    expect(w.db.snapshot(V, [...MOBILE_FIELDS, 'renditions'])).toEqual(mobileBefore);
    expect(w.mobileQueue.addCalls).toBe(mobileJobs);
    expect(w.db.get(V).mobileStatus).toBe('READY');
  });

  it('mobile failed, Gumlet READY: "Retry mobile" does not touch Gumlet', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await gumletWorker(w, () => 'ready').drain();
    const failing = mobileWorker(w, {
      encode: () => {
        throw new Error('ffmpeg exited with code 1');
      },
    });
    await failing.runNext();
    await failing.runNext();
    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'FAILED' });
    const gumletBefore = w.db.snapshot(V, GUMLET_FIELDS);
    const webJobs = w.webQueue.addCalls;

    const retry = await w.videos.retryMobileProcessing(V, STAFF);

    expect(retry).toMatchObject({ jobId: mobileJobIdFor(V, 2), alreadyQueued: false, enqueued: true });
    expect(w.db.snapshot(V, GUMLET_FIELDS)).toEqual(gumletBefore);
    expect(w.webQueue.addCalls).toBe(webJobs);

    // A second click while that job is queued is the same job, not another.
    const second = await w.videos.retryMobileProcessing(V, STAFF);
    expect(second).toMatchObject({ jobId: mobileJobIdFor(V, 2), alreadyQueued: true });
    expect(w.mobileQueue.live()).toHaveLength(1);

    await mobileWorker(w).runNext();
    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY', mobileGeneration: 2 });
    expect(w.db.snapshot(V, GUMLET_FIELDS)).toEqual(gumletBefore);
  });

  it('a READY mobile ladder is not re-encoded by a retry; only an administrator may force it', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await mobileWorker(w).runNext();
    const jobs = w.mobileQueue.addCalls;

    await expect(w.videos.retryMobileProcessing(V, STAFF)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(w.videos.retryMobileProcessing(V, STAFF, { force: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(w.mobileQueue.addCalls).toBe(jobs);
    expect(w.db.get(V).mobileStatus).toBe('READY');

    await expect(w.videos.retryMobileProcessing(V, ADMIN, { force: true })).resolves.toMatchObject({
      jobId: mobileJobIdFor(V, 2),
    });
  });

  it('retrying mobile needs no Gumlet asset at all', async () => {
    const w = uploadedWorld({ status: 'FAILED', sourceSizeBytes: BigInt(100_000_000), gumletAssetId: null });

    await expect(w.videos.retryMobileProcessing(V, STAFF)).resolves.toMatchObject({ enqueued: true });
    await mobileWorker(w).runNext();

    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', gumletAssetId: null, mobileStatus: 'READY' });
  });
});

// ---------------------------------------------------------------------------
describe('Scenario H - ffmpeg fails', () => {
  it('the state stays accurate, nothing partial is published, and a retry works', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await gumletWorker(w, () => 'ready').drain();
    const gumletBefore = w.db.snapshot(V, GUMLET_FIELDS);

    let broken = true;
    const worker = mobileWorker(w, {
      encode: () => {
        if (broken) throw new Error('ffmpeg exited with code 1: Invalid data found when processing input');
      },
    });

    // First attempt fails and the queue will retry it: the row says QUEUED
    // with the reason, NOT failed - a retry is pending and nothing is offered
    // that could start a second job beside it.
    expect((await worker.runNext())?.outcome).toBe('retry');
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED' });
    expect(String(w.db.get(V).mobileError)).toMatch(/Attempt 1 of 2 failed .*retried automatically/);
    expect((await w.videos.status(V, STAFF)).mobile).toMatchObject({ status: 'QUEUED', canRetry: false });
    await expect(w.videos.retryMobileProcessing(V, STAFF)).resolves.toMatchObject({ alreadyQueued: true });
    expect(w.mobileQueue.jobs.size).toBe(1);

    // The retry fails too. Now it is FAILED.
    expect((await worker.runNext())?.outcome).toBe('failed');

    const row = w.db.get(V);
    expect(row.mobileStatus).toBe('FAILED');
    expect(String(row.mobileError)).toContain('Invalid data found');
    // Not published: no playable ladder is described by the row.
    expect(row.hlsPrefix).toBeNull();
    expect(row.renditions).toEqual([]);
    expect(row.mobileProcessedAt).toBeNull();
    // And Gumlet was not disturbed.
    expect(w.db.snapshot(V, GUMLET_FIELDS)).toEqual(gumletBefore);

    const status = await w.videos.status(V, STAFF);
    expect(status.mobile).toMatchObject({ status: 'FAILED', canRetry: true, renditions: 0 });
    expect(status.gumlet.state).toBe('READY');

    broken = false;
    await w.videos.retryMobileProcessing(V, STAFF);
    expect((await worker.runNext())?.outcome).toBe('completed');
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', mobileError: null, hlsPrefix: 'hls/v_1/' });
    expect(w.db.snapshot(V, GUMLET_FIELDS)).toEqual(gumletBefore);
  });

  it('output that fails verification is reported as not published, never as READY', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const worker = mobileWorker(w, {
      encode: () => {
        throw new TranscodeOutputError('720p: segment seg_00042.ts is listed but missing or empty');
      },
    });

    await worker.runNext();
    await worker.runNext();

    expect(w.db.get(V).mobileStatus).toBe('FAILED');
    expect(String(w.db.get(V).mobileError)).toContain('Output failed verification and was not published');
    expect(w.db.get(V).hlsPrefix).toBeNull();
  });

  it('a failed RE-encode does not un-publish the Gumlet side or leave the old ladder claimed as READY', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await gumletWorker(w, () => 'ready').drain();
    await mobileWorker(w).runNext();
    await w.videos.retryMobileProcessing(V, ADMIN, { force: true });

    const failing = mobileWorker(w, {
      encode: () => {
        throw new Error('ffmpeg killed');
      },
    });
    await failing.runNext();
    await failing.runNext();

    expect(w.db.get(V)).toMatchObject({ status: 'READY', gumletStatus: 'ready', mobileStatus: 'FAILED' });
  });
});

// ---------------------------------------------------------------------------
describe('Scenario I - the worker restarts in the middle of an encode', () => {
  it('BullMQ hands the stalled job back and the restarted worker finishes the same job', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const worker = mobileWorker(w);

    // The worker claims the video and dies.
    const job = worker.startNext()!;
    await w.videos.markMobileProcessing(V, SRC, job.id);
    expect(w.db.get(V).mobileStatus).toBe('PROCESSING');

    // While the dead worker's lock is still held the job is `active`. The
    // sweep must not decide anything about a job that may still be running.
    await w.videos.recoverStrandedMobileVideos(later(60 * MIN));
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'PROCESSING', mobileGeneration: 1 });
    expect(w.mobileQueue.jobs.size).toBe(1);

    // The lock lapses; the stalled check returns the job to the queue.
    job.state = 'waiting';
    const outcome = await mobileWorker(w).runNext();

    expect(outcome).toMatchObject({ outcome: 'completed', job: { id: mobileJobIdFor(V, 1) } });
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', mobileGeneration: 1 });
  });

  it('a job that is gone for good is detected, and the video is re-queued instead of staying PROCESSING', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const worker = mobileWorker(w);
    const job = worker.startNext()!;
    await w.videos.markMobileProcessing(V, SRC, job.id);

    // BullMQ gave up on it ("job stalled more than allowable limit").
    job.state = 'failed';

    // Too soon to call it an orphan.
    await expect(w.videos.recoverStrandedMobileVideos(later(5 * MIN))).resolves.toEqual({ requeued: 0, failed: 0 });
    expect(w.db.get(V).mobileStatus).toBe('PROCESSING');

    // Twenty minutes on, with no live job behind it, it is one.
    await expect(w.videos.recoverStrandedMobileVideos(later(21 * MIN))).resolves.toEqual({ requeued: 1, failed: 1 });
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileGeneration: 2, mobileJobId: mobileJobIdFor(V, 2) });
    // An interrupted upload does not drop behind the historical backlog.
    expect(w.mobileQueue.live()).toMatchObject([{ id: mobileJobIdFor(V, 2), state: 'waiting', data: { trigger: 'upload' } }]);

    await mobileWorker(w).runNext();
    expect(w.db.get(V).mobileStatus).toBe('READY');
  });

  it('a job Redis lost while it was still queued is put back under the same identity', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    w.mobileQueue.lose(mobileJobIdFor(V, 1));

    await expect(w.videos.recoverStrandedMobileVideos(later(11 * MIN))).resolves.toEqual({ requeued: 1, failed: 0 });

    expect(w.mobileQueue.live().map((j) => j.id)).toEqual([mobileJobIdFor(V, 1)]);
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileGeneration: 1 });
  });

  it('the sweep decides nothing while Redis cannot be read', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const job = mobileWorker(w).startNext()!;
    await w.videos.markMobileProcessing(V, SRC, job.id);
    w.mobileQueue.outage = 'reject';

    await expect(w.videos.recoverStrandedMobileVideos(later(60 * MIN))).resolves.toEqual({ requeued: 0, failed: 0 });
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'PROCESSING', mobileGeneration: 1 });
  });

  it('two jobs for one video cannot both encode: the second steps aside', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    const stray = (await w.mobileQueue.add('mobile-hls', { videoId: V, sourceKey: SRC, ladder: [480], encrypt: true, trigger: 'retry' }, {
      jobId: 'mobile-hls:v_1:stray',
      attempts: 2,
    })) as { id: string };

    await expect(w.videos.markMobileProcessing(V, SRC, stray.id)).resolves.toBe(false);
    await expect(w.videos.markMobileProcessing(V, SRC, mobileJobIdFor(V, 1))).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('Scenario J - existing videos are not disturbed', () => {
  const library = () =>
    new FakeDb([
      // Gumlet READY, never processed for mobile: the bulk of the library.
      videoRow({ id: 'old_gumlet', sourceKey: 'source/videos/old_gumlet/a.mp4', status: 'READY', gumletStatus: 'ready', sourceSizeBytes: BigInt(5) }),
      // Fully migrated.
      videoRow({
        id: 'old_both',
        sourceKey: 'source/videos/old_both/a.mp4',
        status: 'READY',
        gumletStatus: 'ready',
        sourceSizeBytes: BigInt(5),
        mobileStatus: 'READY',
        hlsPrefix: 'hls/old_both/',
        mobileJobId: 'mobile-hls:old_both:1794331667404',
        renditions: [{ height: 720 }],
      }),
      // Queued by the build before this one: a clock-based job id, no intent
      // timestamps. Its job is parked in the delayed set behind a pause.
      videoRow({
        id: 'old_queued',
        sourceKey: 'source/videos/old_queued/a.mp4',
        status: 'READY',
        gumletStatus: 'ready',
        sourceSizeBytes: BigInt(5),
        mobileStatus: 'QUEUED',
        mobileJobId: 'mobile-hls:old_queued:1794847870655',
      }),
      // An upload that was abandoned: no file ever arrived.
      videoRow({ id: 'abandoned', sourceKey: 'source/videos/abandoned/a.mp4', status: 'UPLOADING' }),
    ]);

  it('neither the reconciler nor the sweep changes any of them or queues anything', async () => {
    const db = library();
    const w = apiProcess({ db });
    await w.mobileQueue.add('mobile-hls', { videoId: 'old_queued', trigger: 'migration' }, { jobId: 'mobile-hls:old_queued:1794847870655', priority: 10 });
    w.mobileQueue.jobs.get('mobile-hls:old_queued:1794847870655')!.state = 'delayed';
    const before = JSON.stringify([...db.rows.values()], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    const adds = w.mobileQueue.addCalls;

    await w.videos.reconcilePendingIntents();
    await w.videos.recoverStrandedMobileVideos(later(24 * 60 * MIN));
    await w.videos.recoverStrandedVideos(later(24 * 60 * MIN));

    expect(JSON.stringify([...db.rows.values()], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))).toBe(before);
    expect(w.mobileQueue.addCalls).toBe(adds);
    expect(w.webQueue.addCalls).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('deploying this build does not start encoding the back catalogue: only NEW acceptances create intents', async () => {
    const db = library();
    const w = apiProcess({ db });
    w.storage.objects.set('source/videos/old_gumlet/a.mp4', 5);

    // A stray finalisation call on a lecture that was finished long ago.
    const result = await w.videos.completeUpload('old_gumlet', STAFF);

    expect(result).toMatchObject({ status: 'READY', alreadyQueued: true, mobile: { status: 'NONE', queued: false } });
    expect(w.mobileQueue.addCalls).toBe(0);
    expect(db.get('old_gumlet')).toMatchObject({ mobileStatus: 'NONE', mobileGeneration: 0 });
  });

  it('the migration tool reports what it WOULD queue without touching anything (dry run)', async () => {
    const db = library();
    db.rows.set('gumlet_failed', videoRow({ id: 'gumlet_failed', sourceKey: 'source/videos/gumlet_failed/a.mp4', status: 'FAILED', sourceSizeBytes: BigInt(5) }));
    const w = apiProcess({ db });
    for (const id of ['old_gumlet', 'gumlet_failed']) w.storage.objects.set(`source/videos/${id}/a.mp4`, 5);

    const report = await w.videos.migrateLibraryToMobile({ dryRun: true, limit: 100, actorId: 'admin_1' });

    // A lecture Gumlet rejected is eligible: mobile does not need Gumlet's blessing.
    expect(report.wouldQueue.sort()).toEqual(['gumlet_failed', 'old_gumlet']);
    // The abandoned upload has no confirmed file and is not a candidate.
    expect(report.scanned).toBe(2);
    expect(w.mobileQueue.addCalls).toBe(0);
    expect(db.writes).toEqual([]);
  });

  it('a build without the mobile queue (or with auto-processing off) still accepts uploads', async () => {
    const off = uploadedWorld({}, { autoProcess: false });
    await expect(off.videos.completeUpload(V, STAFF)).resolves.toMatchObject({
      status: 'QUEUED',
      gumlet: { queued: true },
      mobile: { status: 'NONE', queued: false, automatic: false },
    });
    expect(off.mobileQueue.addCalls).toBe(0);

    const none = uploadedWorld({}, { withMobileQueue: false });
    await expect(none.videos.completeUpload(V, STAFF)).resolves.toMatchObject({ status: 'QUEUED', mobile: { automatic: false } });
  });
});

// ---------------------------------------------------------------------------
describe('Scenario K - what the dashboard is told', () => {
  it('reports the three states separately at every stage', async () => {
    const w = uploadedWorld();

    const beforeUpload = await w.videos.status(V, STAFF);
    expect(beforeUpload.source.state).toBe('UPLOADING');
    expect(beforeUpload.gumlet.state).toBe('WAITING_UPLOAD');
    expect(beforeUpload.mobile).toMatchObject({ status: 'NONE', canRetry: false });

    await w.videos.completeUpload(V, STAFF);
    const queued = await w.videos.status(V, STAFF);
    expect(queued.source).toEqual({ state: 'VERIFIED', sizeBytes: 100_000_000 });
    expect(queued.gumlet).toMatchObject({ state: 'PENDING', queued: true, canRetry: false });
    expect(queued.mobile).toMatchObject({ status: 'QUEUED', queued: true, attempts: 1, trigger: 'upload', canRetry: false });
    expect(typeof queued.mobile.requestedAt).toBe('string');
  });

  it('shows real progress while a worker is encoding, taken from the heartbeat', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    await w.videos.markMobileProcessing(V, SRC, mobileJobIdFor(V, 1));
    w.redis.store.set('worker:heartbeat', {
      at: new Date().toISOString(),
      ffmpeg: true,
      ffprobe: true,
      queues: 'all',
      activeJobs: [{ videoId: V, jobId: mobileJobIdFor(V, 1), startedAt: new Date().toISOString(), progress: 62 }],
      pause: { paused: false, reason: null, by: null, at: null, scope: 'all' },
    });

    const status = await w.videos.status(V, STAFF);

    expect(status.mobile).toMatchObject({ status: 'PROCESSING', progress: 62, active: true, workerOnline: true, paused: false });
    expect(typeof status.mobile.processingStartedAt).toBe('string');
  });

  it('says a queued video is waiting behind an operator pause; the reason is for administrators only', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    w.redis.store.set('mobile:transcode:paused', { reason: 'laptop off home Wi-Fi (SSID-1234)', by: 'op', at: '2026-11-16T20:03:04Z' });

    const teacher = await w.videos.status(V, STAFF);
    expect(teacher.mobile).toMatchObject({ status: 'QUEUED', paused: true, pauseReason: null });
    expect(JSON.stringify(teacher)).not.toContain('SSID-1234');

    const admin = await w.videos.status(V, ADMIN);
    expect(admin.mobile).toMatchObject({ paused: true, pauseReason: 'laptop off home Wi-Fi (SSID-1234)' });
  });

  it('a pause scoped to the backlog is not reported against a new upload', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);
    w.redis.store.set('mobile:transcode:paused', { reason: 'between batches', by: 'op', at: '2026-11-16T20:03:04Z', scope: 'historical' });

    expect((await w.videos.status(V, ADMIN)).mobile).toMatchObject({ status: 'QUEUED', paused: false });
  });

  it('never shows a URL or a credential from an encode error', async () => {
    const w = uploadedWorld({
      status: 'READY',
      sourceSizeBytes: BigInt(5),
      mobileStatus: 'FAILED',
      mobileError: 'GET https://account.r2.cloudflarestorage.com/edu-uploads/source/a.mp4?X-Amz-Signature=abc123 socket hang up',
    });

    const status = await w.videos.status(V, STAFF);

    expect(status.mobile.error).toContain('socket hang up');
    expect(status.mobile.error).not.toContain('r2.cloudflarestorage.com');
    expect(status.mobile.error).not.toContain('abc123');
  });

  it('offers each retry only where it applies, and never while a job exists', async () => {
    const cases: [Record<string, unknown>, { gumlet: boolean; mobile: boolean }][] = [
      [{ status: 'FAILED', mobileStatus: 'READY' }, { gumlet: true, mobile: false }],
      [{ status: 'READY', gumletStatus: 'ready', mobileStatus: 'FAILED' }, { gumlet: false, mobile: true }],
      [{ status: 'FAILED', mobileStatus: 'FAILED' }, { gumlet: true, mobile: true }],
      [{ status: 'READY', gumletStatus: 'ready', mobileStatus: 'NONE' }, { gumlet: false, mobile: true }],
      [{ status: 'READY', gumletStatus: 'ready', mobileStatus: 'QUEUED' }, { gumlet: false, mobile: false }],
      [{ status: 'READY', gumletStatus: 'ready', mobileStatus: 'PROCESSING' }, { gumlet: false, mobile: false }],
      [{ status: 'PROCESSING', gumletAssetId: 'a', gumletStatus: 'processing', mobileStatus: 'READY' }, { gumlet: false, mobile: false }],
    ];
    for (const [fields, expected] of cases) {
      const w = uploadedWorld({ sourceSizeBytes: BigInt(5), ...fields });
      const status = await w.videos.status(V, STAFF);
      expect({ gumlet: status.gumlet.canRetry, mobile: status.mobile.canRetry }).toEqual(expected);
    }
  });
});

// ---------------------------------------------------------------------------
describe('replacing the file of an existing lecture', () => {
  it('resets the mobile ladder with the Gumlet asset, so the old recording is never served for the new one', async () => {
    const w = uploadedWorld({
      status: 'READY',
      gumletAssetId: 'asset_old',
      gumletStatus: 'ready',
      sourceSizeBytes: BigInt(100_000_000),
      mobileStatus: 'READY',
      hlsPrefix: 'hls/v_1/',
      mobileJobId: mobileJobIdFor(V, 1),
      mobileGeneration: 1,
      mobileProcessedAt: new Date(),
      renditions: [{ height: 720 }],
    });
    Object.assign(w.db, {
      lesson: {
        findFirst: async () => ({
          id: 'lesson_1',
          courseId: 'course_1',
          video: { id: V, status: 'READY', deletedAt: null, hlsPrefix: 'hls/v_1/', drmProvider: 'gumlet', gumletAssetId: 'asset_old' },
          videoLinks: [{ videoId: V, video: { deletedAt: null } }],
        }),
        updateMany: async () => ({ count: 0 }),
      },
      lessonVideo: { count: async () => 0, upsert: async () => ({}), findMany: async () => [] },
    });

    const init = await w.videos.initUpload(
      { lessonId: 'lesson_1', filename: 'new.mp4', contentType: 'video/mp4', sizeBytes: 50_000_000 },
      ADMIN,
    );

    const row = w.db.get(V);
    expect(row).toMatchObject({
      status: 'UPLOADING',
      gumletAssetId: null,
      // The proof of upload described the OLD file.
      sourceSizeBytes: null,
      mobileStatus: 'NONE',
      mobileJobId: null,
      mobileProcessedAt: null,
      mobileRequestedAt: null,
    });
    expect(row.sourceKey).not.toBe(SRC);

    // A job still queued for the old source recognises itself as stale.
    await expect(w.videos.markMobileProcessing(V, SRC, mobileJobIdFor(V, 1))).resolves.toBe(false);

    // Confirming the new file records a fresh intent for it.
    w.storage.objects.set(row.sourceKey as string, 50_000_000);
    await w.videos.completeUpload(init.videoId, ADMIN);
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileGeneration: 2, mobileJobId: mobileJobIdFor(V, 2) });
    expect(w.mobileQueue.live()[0]).toMatchObject({ data: { sourceKey: row.sourceKey } });
  });
});

// ---------------------------------------------------------------------------
describe('operator pause', () => {
  it('a pause of everything holds a new upload; it stays QUEUED and is not failed', async () => {
    const w = uploadedWorld();
    await w.videos.completeUpload(V, STAFF);

    const outcome = await mobileWorker(w, { pause: { paused: true } }).runNext();

    expect(outcome?.outcome).toBe('deferred');
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileError: null });
    expect(w.mobileQueue.live()).toHaveLength(1);
  });

  it('a pause of the backlog lets a new upload through and holds historical work', async () => {
    const w = uploadedWorld();
    w.db.rows.set('old', videoRow({ id: 'old', sourceKey: 'source/videos/old/a.mp4', status: 'READY', sourceSizeBytes: BigInt(5) }));
    w.storage.objects.set('source/videos/old/a.mp4', 5);
    await w.videos.enqueueMobileTranscode({ id: 'old', sourceKey: 'source/videos/old/a.mp4' }, 'migration');
    await w.videos.completeUpload(V, STAFF);
    const worker = mobileWorker(w, { pause: { paused: true, scope: 'historical' } });

    // The upload is taken first (no priority) and is not held by the pause.
    expect(await worker.runNext()).toMatchObject({ outcome: 'completed', job: { data: { videoId: V } } });
    // The historical job is next, and it waits.
    expect(await worker.runNext()).toMatchObject({ outcome: 'deferred', job: { data: { videoId: 'old' } } });

    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(w.db.get('old').mobileStatus).toBe('QUEUED');
  });
});

// ---------------------------------------------------------------------------
describe('turning automatic mobile processing ON does not start the back catalogue', () => {
  /** The shape of the production library on 2026-11-16: 200 finished lectures never processed for mobile. */
  const backCatalogue = () => {
    const rows = Array.from({ length: 200 }, (_v, i) =>
      videoRow({
        id: `old_${i}`,
        lessonId: `lesson_old_${i}`,
        sourceKey: `source/videos/old_${i}/a.mp4`,
        sourceSizeBytes: BigInt(300_000_000),
        status: 'READY',
        gumletAssetId: `asset_${i}`,
        gumletStatus: 'ready',
        durationSeconds: 2800,
        createdAt: new Date('2026-10-20T10:00:00Z'),
        updatedAt: new Date('2026-10-20T11:00:00Z'),
      }),
    );
    // Plus what else is in the table today.
    rows.push(videoRow({ id: 'abandoned', sourceKey: 'source/videos/abandoned/a.mp4', status: 'UPLOADING' }));
    rows.push(
      videoRow({ id: 'archived', sourceKey: 'source/videos/archived/a.mp4', status: 'ARCHIVED', sourceSizeBytes: BigInt(1) }),
    );
    return rows;
  };
  const frozen = (db: FakeDb) => JSON.stringify([...db.rows.values()], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
  const withSources = (db: FakeDb) => {
    const w = apiProcess({ db, autoProcess: true });
    for (const row of db.rows.values()) w.storage.objects.set(row.sourceKey as string, 300_000_000);
    return w;
  };

  it('no timer, sweep or restart queues any of the 200: every automatic mechanism finds nothing to do', async () => {
    const db = new FakeDb(backCatalogue());
    const w = withSources(db);
    const before = frozen(db);

    // Everything that runs without a person asking for it, as on a fresh deploy
    // with the flag on, then again a day and a week later.
    const reconciler = new VideoPipelineReconciler(w.videos);
    await reconciler.tick();
    for (const ahead of [0, 24 * 60 * MIN, 7 * 24 * 60 * MIN]) {
      await w.videos.reconcilePendingIntents();
      await w.videos.recoverStrandedVideos(later(ahead));
      await w.videos.recoverStrandedMobileVideos(later(ahead));
    }

    expect(w.mobileQueue.addCalls).toBe(0);
    expect(w.webQueue.addCalls).toBe(0);
    expect(db.writes).toEqual([]);
    expect(frozen(db)).toBe(before);
  });

  it('a stray finalisation call on every old lecture queues none of them either', async () => {
    const db = new FakeDb(backCatalogue());
    const w = withSources(db);

    for (let i = 0; i < 200; i += 1) {
      await expect(w.videos.completeUpload(`old_${i}`, STAFF)).resolves.toMatchObject({
        status: 'READY',
        alreadyQueued: true,
        mobile: { status: 'NONE', queued: false },
      });
    }

    expect(w.mobileQueue.addCalls).toBe(0);
    expect([...db.rows.values()].filter((r) => r.mobileStatus !== 'NONE')).toEqual([]);
  });

  it('only a NEW upload is queued, and it runs before backlog work an operator queues explicitly', async () => {
    const db = new FakeDb(backCatalogue());
    db.rows.set(V, videoRow());
    const w = withSources(db);

    // The operator deliberately queues a batch of three old lectures...
    const batch = await w.videos.migrateLibraryToMobile({ dryRun: false, limit: 3, actorId: 'admin_1' });
    expect(batch.queued).toHaveLength(3);
    // ...and then a teacher uploads a new one.
    await w.videos.completeUpload(V, STAFF);

    expect(w.mobileQueue.jobs.size).toBe(4);
    expect([...db.rows.values()].filter((r) => r.mobileStatus === 'QUEUED')).toHaveLength(4);
    // The backlog is explicit, bounded and prioritised BEHIND uploads.
    expect(w.mobileQueue.inState('prioritized').map((j) => j.data.trigger)).toEqual(['migration', 'migration', 'migration']);
    expect(w.mobileQueue.inState('waiting').map((j) => j.data.videoId)).toEqual([V]);
    expect((await mobileWorker(w).runNext())?.job.data.videoId).toBe(V);
  });

  it('the migration tool is the only bulk path, and a dry run queues nothing', async () => {
    const db = new FakeDb(backCatalogue());
    const w = withSources(db);

    const report = await w.videos.migrateLibraryToMobile({ dryRun: true, limit: 500, actorId: 'admin_1' });

    expect(report.wouldQueue).toHaveLength(201); // 200 READY + the ARCHIVED one with a source
    expect(report.queued).toEqual([]);
    expect(w.mobileQueue.addCalls).toBe(0);
    expect(db.writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('the reconciler only works when there is a reason to', () => {
  it('an idle system is not scanned on the short timer, only at boot and on the slow background interval', async () => {
    const w = uploadedWorld();
    const scan = jest.spyOn(w.videos, 'reconcilePendingIntents');
    const reconciler = new VideoPipelineReconciler(w.videos);
    const t0 = Date.now();

    await reconciler.tick(); // the boot scan
    expect(scan).toHaveBeenCalledTimes(1);

    // Nineteen wake-ups over the next ten minutes: nothing is known to be pending.
    for (let i = 1; i < 20; i += 1) await expect(reconciler.wake(t0 + i * 30_000)).resolves.toBe(false);
    expect(scan).toHaveBeenCalledTimes(1);

    // The background interval elapses: one scan.
    await expect(reconciler.wake(t0 + reconciler.intervalSeconds * 1000 + 1_000)).resolves.toBe(true);
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('a delivery this process failed to make is retried on the short timer until it succeeds, then it goes quiet', async () => {
    const w = uploadedWorld();
    w.webQueue.outage = 'reject';
    w.mobileQueue.outage = 'reject';
    const reconciler = new VideoPipelineReconciler(w.videos);
    await reconciler.tick();
    expect(w.videos.hasUndeliveredIntents()).toBe(false);

    await w.videos.completeUpload(V, STAFF);
    expect(w.videos.hasUndeliveredIntents()).toBe(true);

    jest.useFakeTimers({ now: Date.now() + 2 * MIN });
    try {
      // Redis still down, past the grace period: the scan runs and the debt remains.
      await expect(reconciler.wake()).resolves.toBe(true);
      expect(w.videos.hasUndeliveredIntents()).toBe(true);

      // Redis returns: the very next wake delivers both jobs...
      w.webQueue.outage = null;
      w.mobileQueue.outage = null;
      await expect(reconciler.wake()).resolves.toBe(true);
      expect(w.videos.hasUndeliveredIntents()).toBe(false);
      expect(w.mobileQueue.jobs.size).toBe(1);
      expect(w.webQueue.jobs.size).toBe(1);

      // ...and the short timer stops touching the database.
      const scan = jest.spyOn(w.videos, 'reconcilePendingIntents');
      await expect(reconciler.wake(Date.now() + 30_000)).resolves.toBe(false);
      expect(scan).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('VIDEO_PIPELINE_RECONCILE_SECONDS: default ten minutes, a floor of one, and 0 switches it off', async () => {
    const { normalizeReconcileIntervalSeconds } = await import(
      '../../src/modules/videos/video-pipeline-reconciler.service'
    );
    expect(normalizeReconcileIntervalSeconds(undefined)).toBe(600);
    // Present but empty is "not set" - it must not switch the reconciler off.
    expect(normalizeReconcileIntervalSeconds('')).toBe(600);
    expect(normalizeReconcileIntervalSeconds('   ')).toBe(600);
    expect(normalizeReconcileIntervalSeconds('5')).toBe(60);
    expect(normalizeReconcileIntervalSeconds('900')).toBe(900);
    expect(normalizeReconcileIntervalSeconds('0')).toBe(0);
    expect(normalizeReconcileIntervalSeconds('nonsense')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('a worker without ffmpeg (Gumlet handled on an always-on host)', () => {
  const lightWorker = () => ({
    at: new Date().toISOString(),
    ffmpeg: false,
    ffprobe: false,
    queues: ['video-processing', 'push-delivery', 'maintenance', 'analytics'],
  });

  it('is not reported as "cannot transcode" for a Gumlet video, which it does not transcode', async () => {
    const w = uploadedWorld();
    w.redis.store.set('worker:heartbeat', lightWorker());

    const accepted = await w.videos.completeUpload(V, STAFF);
    expect(accepted).toMatchObject({ workerOnline: true, workerCanTranscode: null });

    const status = await w.videos.status(V, STAFF);
    expect(status).toMatchObject({ workerOnline: true, workerCanTranscode: null });
    // The mobile side asks a different question, of a different worker: none is online.
    expect(status.mobile).toMatchObject({ status: 'QUEUED', workerOnline: false });
  });

  it('is still reported for a legacy (ffmpeg-transcoded) video', async () => {
    const w = uploadedWorld({ drmProvider: null, status: 'QUEUED', sourceSizeBytes: BigInt(5) });
    w.redis.store.set('worker:heartbeat', lightWorker());
    expect(await w.videos.status(V, STAFF)).toMatchObject({ workerOnline: true, workerCanTranscode: false });
  });
});
