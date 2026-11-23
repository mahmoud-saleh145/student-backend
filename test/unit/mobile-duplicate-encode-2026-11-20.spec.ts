import { Prisma } from '@prisma/client';
import { DelayedError } from 'bullmq';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => []),
}));

import {
  JOB,
  SOURCE,
  VIDEO,
  controllableTranscoder,
  delivery,
  jobData,
  processorFor,
  settle,
  world,
} from './helpers/mobile-claim-world';

/**
 * Regression suite: the duplicate mobile encode of 2026-11-20.
 *
 * Video cmwp0i2sx001rho01ap2is9gu, mobile job `p1g4`:
 *   - the laptop slept mid-encode (21:00:30-21:48:57Z), so the job's BullMQ
 *     lock expired and BullMQ handed the job out again;
 *   - the first run woke up, finished, and recorded mobile-READY (21:57:13Z);
 *   - four seconds later the SAME job id ran again, re-claimed the row
 *     (READY -> PROCESSING) and encoded the whole lecture a second time.
 *
 * The real VideosService (claim, finish, failure writes) and the real
 * MobileVideoProcessor run against one stateful in-memory row. Only ffmpeg/R2
 * (the transcoder), the encode slot and Redis are doubles.
 */


beforeAll(() => {
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

describe('REGRESSION cmwp0i2sx: a job re-delivered after its lock expired', () => {
  it('Worker A encodes through a standby and records READY; the re-delivered job does NOT encode again or touch READY', async () => {
    const w = world();
    const t = controllableTranscoder();
    const proc = processorFor(w.videos, t.transcoder);
    const shared = jobData();

    // Worker A claims and starts encoding.
    const a = proc.process(delivery(shared) as never, 'tok-A');
    await settle();
    expect(w.row.mobileStatus).toBe('PROCESSING');
    expect(t.transcoder.run).toHaveBeenCalledTimes(1);

    // The laptop sleeps; the lock expires; BullMQ will hand the job out again.
    // Worker A wakes up and completes.
    t.finish(0);
    await expect(a).resolves.toMatchObject({ renditions: 1 });
    expect(w.row.mobileStatus).toBe('READY');
    const readyAt = w.row.mobileProcessedAt;

    // The re-delivered job (the same job id) - what happened at 21:57:17Z.
    const b = await proc.process(delivery(shared) as never, 'tok-B');

    expect(b).toEqual({ videoId: VIDEO, skipped: true });
    expect(t.transcoder.run).toHaveBeenCalledTimes(1); // no second encode
    expect(w.row.mobileStatus).toBe('READY'); // never back to PROCESSING
    expect(w.row.mobileProcessedAt).toBe(readyAt);
    expect(w.readyWrites).toHaveLength(1);
  });

  it('Worker B picks the job up while A is still frozen: only ONE result is ever recorded, and the superseded attempt stops', async () => {
    const w = world();
    // Two worker processes, each with its own transcoder; ownership checked every 10 ms here.
    const tA = controllableTranscoder();
    const tB = controllableTranscoder();
    const procA = processorFor(w.videos, tA.transcoder, 10);
    const procB = processorFor(w.videos, tB.transcoder, 10);
    const shared = jobData();

    const a = procA.process(delivery(shared) as never, 'tok-A');
    await settle();
    const tokenA = w.row.mobileProcessingStartedAt as Date;

    // A's lock expired during the standby; B takes the job and re-claims the row.
    await new Promise((r) => setTimeout(r, 5));
    const b = procB.process(delivery(shared) as never, 'tok-B');
    await settle();
    expect((w.row.mobileProcessingStartedAt as Date).getTime()).not.toBe(tokenA.getTime());

    // A's ownership watch sees the newer claim and stops A without writing.
    await expect(a).resolves.toEqual({ videoId: VIDEO, skipped: true, superseded: true });
    expect(w.row.mobileStatus).toBe('PROCESSING');
    expect(w.readyWrites).toHaveLength(0);

    expect(tA.transcoder.abortSuperseded).toHaveBeenCalledWith('a newer attempt of this job re-claimed the video', expect.any(String));
    // B (the owner) finishes: READY exactly once.
    tB.finish(0);
    await expect(b).resolves.toMatchObject({ renditions: 1 });
    expect(w.row.mobileStatus).toBe('READY');
    expect(w.readyWrites).toHaveLength(1);
  });

  it('if the frozen A finishes before its watch notices, its result is discarded: the newer claim owns the row', async () => {
    const w = world();
    const tA = controllableTranscoder();
    const tB = controllableTranscoder();
    const procA = processorFor(w.videos, tA.transcoder);
    const procB = processorFor(w.videos, tB.transcoder);
    const shared = jobData();

    const a = procA.process(delivery(shared) as never, 'tok-A');
    await settle();
    await new Promise((r) => setTimeout(r, 5));
    const b = procB.process(delivery(shared) as never, 'tok-B');
    await settle();

    tA.finish(0); // A completes first, but no longer owns the row
    await expect(a).resolves.toEqual({ videoId: VIDEO, skipped: true });
    expect(w.readyWrites).toHaveLength(0);

    tB.finish(0);
    await expect(b).resolves.toMatchObject({ renditions: 1 });
    expect(w.readyWrites).toHaveLength(1);
  });

  it('a genuine worker restart (A is dead) still recovers: the same job re-claims and finishes', async () => {
    const w = world({ mobileStatus: 'PROCESSING', mobileProcessingStartedAt: new Date('2026-11-20T21:00:00Z') });
    const t = controllableTranscoder();
    const proc = processorFor(w.videos, t.transcoder);
    const b = proc.process(delivery(jobData()) as never, 'tok-B');
    await settle();
    t.finish(0);
    await expect(b).resolves.toMatchObject({ renditions: 1 });
    expect(w.row.mobileStatus).toBe('READY');
  });
});

describe('generations: an older job never overwrites a newer one', () => {
  it('a job finishing after a newer generation took the row records nothing', async () => {
    const w = world();
    const t = controllableTranscoder();
    const proc = processorFor(w.videos, t.transcoder);
    const old = proc.process(delivery(jobData()) as never, 'tok-A');
    await settle();

    // A staff supersede queues generation 5.
    Object.assign(w.row, { mobileStatus: 'QUEUED', mobileJobId: `mobile-hls:${VIDEO}:p1g5`, mobileGeneration: 5 });

    t.finish(0);
    await expect(old).resolves.toEqual({ videoId: VIDEO, skipped: true });
    expect(w.row.mobileStatus).toBe('QUEUED');
    expect(w.row.mobileJobId).toBe(`mobile-hls:${VIDEO}:p1g5`);
    expect(w.readyWrites).toHaveLength(0);
  });

  it('a stale failure, retry or deferral note never turns a READY ladder back', async () => {
    const readyAt = new Date('2026-11-20T21:57:13Z');
    const w = world({ mobileStatus: 'READY', mobileProcessedAt: readyAt });

    await w.videos.markMobileFailed(VIDEO, 'stale failure', { sourceKey: SOURCE, jobId: JOB });
    await w.videos.markMobileFailed(VIDEO, 'sweep failure'); // no owner given
    await w.videos.markMobileRetrying(VIDEO, JOB, 'stale', 1, 2);
    await w.videos.markMobileDeferred(VIDEO, 'Paused for disk space', { jobId: JOB });

    expect(w.row.mobileStatus).toBe('READY');
    expect(w.row.mobileProcessedAt).toBe(readyAt);
  });

  it('a failure from an attempt that lost its claim does not speak for the row', async () => {
    const w = world({ mobileStatus: 'PROCESSING', mobileProcessingStartedAt: new Date('2026-11-20T22:00:00Z') });
    await w.videos.markMobileFailed(VIDEO, 'old attempt failed', {
      sourceKey: SOURCE,
      jobId: JOB,
      claimedAt: new Date('2026-11-20T21:00:00Z'),
    });
    await w.videos.markMobileRetrying(VIDEO, JOB, 'old attempt', 1, 2, new Date('2026-11-20T21:00:00Z'));
    expect(w.row.mobileStatus).toBe('PROCESSING');
  });
});

describe('concurrent claims of the same generation', () => {
  it('two workers racing for the same job: at most one ladder is recorded', async () => {
    const w = world();
    const t1 = controllableTranscoder();
    const t2 = controllableTranscoder();
    const shared = jobData();
    // Both claim in the same tick: the claim pins the token it read, so only one wins.
    const p1 = processorFor(w.videos, t1.transcoder).process(delivery(shared) as never, 'tok-1');
    const p2 = processorFor(w.videos, t2.transcoder).process(delivery(shared) as never, 'tok-2');
    await settle();
    expect(t1.runs.length + t2.runs.length).toBe(1); // one encode
    for (const t of [t1, t2]) for (let i = 0; i < t.runs.length; i += 1) t.finish(i);
    const results = await Promise.all([p1, p2]);
    expect(results.filter((r) => (r as { skipped?: boolean }).skipped)).toHaveLength(1);
    expect(w.row.mobileStatus).toBe('READY');
    expect(w.readyWrites).toHaveLength(1);
  });

  it('two finishers of the same generation at once: the guarded finish records exactly one', async () => {
    const w = world({ mobileStatus: 'PROCESSING', mobileProcessingStartedAt: new Date('2026-11-20T21:00:00Z') });
    const token = w.row.mobileProcessingStartedAt as Date;
    const ladder = {
      durationSeconds: 750, width: 864, height: 480, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac',
      hlsPrefix: `hls/${VIDEO}/`, masterPlaylistKey: `hls/${VIDEO}/master.m3u8`, isEncrypted: true,
      renditions: [{ height: 480, width: 864, bitrateKbps: 1200, playlistKey: `hls/${VIDEO}/480p/index.m3u8` }],
    };
    const owner = { sourceKey: SOURCE, jobId: JOB, claimedAt: token };
    const [r1, r2] = await Promise.all([
      w.videos.markMobileReady(VIDEO, ladder, owner),
      w.videos.markMobileReady(VIDEO, ladder, owner),
    ]);
    expect(r1 && r2).toBe(true); // both see the generation recorded
    expect(w.readyWrites).toHaveLength(1); // but only one wrote it
  });

  it('a READY row is never claimed, whatever the job id', async () => {
    const w = world({ mobileStatus: 'READY', mobileProcessedAt: new Date('2026-11-20T21:57:13Z') });
    for (const job of [JOB, `mobile-hls:${VIDEO}:p1g3`, 'migration-123']) {
      await expect(w.videos.claimMobileProcessing(VIDEO, SOURCE, job)).resolves.toBeNull();
    }
    expect(w.row.mobileStatus).toBe('READY');
  });
});

describe('Redis interruptions and interrupted finalization', () => {
  it('Redis unreachable when remembering the result: the encode is still recorded', async () => {
    const w = world();
    const t = controllableTranscoder();
    const d = delivery(jobData());
    d.updateData.mockRejectedValue(new Error("Stream isn't writeable"));
    const p = processorFor(w.videos, t.transcoder).process(d as never, 'tok');
    await settle();
    t.finish(0);
    await expect(p).resolves.toMatchObject({ renditions: 1 });
    expect(w.row.mobileStatus).toBe('READY');
  });

  it('a finish write lost to a database outage: the re-run REUSES the encoded ladder instead of encoding again', async () => {
    const w = world();
    const t = controllableTranscoder();
    const proc = processorFor(w.videos, t.transcoder);
    const shared = jobData();
    const p1001 = () => new Prisma.PrismaClientKnownRequestError("Can't reach database server", { code: 'P1001', clientVersion: 't' });

    // Every in-place retry of the finish fails: the job is deferred (no attempt).
    let failing = true;
    (w.prisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      if (failing) throw p1001();
      return fn(w.prisma);
    });
    const first = proc.process(delivery(shared) as never, 'tok-1');
    await settle();
    t.finish(0);
    await expect(first).rejects.toBeInstanceOf(DelayedError);
    expect(w.row.mobileStatus).toBe('PROCESSING');
    expect(shared.data.encodedResult).toMatchObject({ jobId: JOB, sourceKey: SOURCE });

    // The database is back; the same job runs again.
    failing = false;
    await expect(proc.process(delivery(shared) as never, 'tok-2')).resolves.toMatchObject({ renditions: 1 });
    expect(t.transcoder.run).toHaveBeenCalledTimes(1); // reused, not re-encoded
    expect(w.row.mobileStatus).toBe('READY');
  });

  it('a finish whose commit lost its acknowledgement is applied once (the retry finds READY and rewrites nothing)', async () => {
    const w = world();
    const t = controllableTranscoder();
    // The first commit lands, then the acknowledgement is lost (P1017).
    let first = true;
    (w.prisma.$transaction as jest.Mock).mockImplementation(async (fn: (tx: unknown) => unknown) => {
      const out = await fn(w.prisma);
      if (first) {
        first = false;
        throw new Prisma.PrismaClientKnownRequestError('Server has closed the connection', { code: 'P1017', clientVersion: 't' });
      }
      return out;
    });
    const p = processorFor(w.videos, t.transcoder).process(delivery(jobData()) as never, 'tok');
    await settle();
    t.finish(0);
    await expect(p).resolves.toMatchObject({ renditions: 1 });
    expect(w.readyWrites).toHaveLength(1);
    expect(w.row.mobileStatus).toBe('READY');
  });
});
