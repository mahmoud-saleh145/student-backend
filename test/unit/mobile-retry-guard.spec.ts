/**
 * S2-P1: a mobile retry while an operator pause is in place.
 *
 *   no pause         -> unchanged (anyone who can manage the course)
 *   FULL pause       -> nobody, MASTER included
 *   HISTORICAL hold  -> MASTER only
 *   unreadable flag  -> refused (fail closed), nothing queued
 *
 * Over the stateful doubles in support/pipeline-fakes: the real VideosService,
 * a fake database with compare-and-set semantics, a fake mobile queue and a
 * fake Redis holding the real pause flag key.
 */
import { SCRATCH_PAUSE_KEY } from '../../src/jobs/processors/scratch-guard';
import { mobileRetryVerdict } from '../../src/modules/videos/mobile-retry-policy';
import { mobileJobIdFor } from '../../src/modules/videos/pipeline-state';

import { ADMIN, STAFF, uploadedWorld, type World } from './support/pipeline-fakes';

const V = 'v_1';
const MASTER = { id: 'master_1', role: 'MASTER' } as never;
const ROLES = { TEACHER: STAFF, ADMIN, MASTER } as const;

/** A lecture that is live on Gumlet and whose mobile encode failed: the Batch 5 shape. */
function failedWorld(): World {
  return uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1), mobileStatus: 'FAILED', mobileJobId: 'mobile-hls:v_1:1794847868195' });
}

type Flag = 'none' | 'legacy-all' | 'all' | 'historical';
function setFlag(w: World, flag: Flag) {
  w.redis.store.delete(SCRATCH_PAUSE_KEY);
  const base = { reason: 'operator', by: 'op', at: '2026-11-16T20:03:04Z' };
  if (flag === 'legacy-all') w.redis.store.set(SCRATCH_PAUSE_KEY, base); // today's production flag: no scope
  if (flag === 'all') w.redis.store.set(SCRATCH_PAUSE_KEY, { ...base, scope: 'all' });
  if (flag === 'historical') w.redis.store.set(SCRATCH_PAUSE_KEY, { ...base, scope: 'historical' });
}
function breakRedis(w: World) {
  w.redis.getJsonOrThrow = (async () => {
    throw new Error('Connection is closed.');
  }) as never;
}
/** Everything a refused retry must leave untouched. */
function snapshot(w: World) {
  return { row: { ...w.db.get(V) }, jobs: w.mobileQueue.jobs.size, audits: w.audit.record.mock.calls.length };
}

describe('mobileRetryVerdict (the rule, pure)', () => {
  it.each([
    ['none', 'TEACHER', true], ['none', 'ADMIN', true], ['none', 'MASTER', true],
    ['all', 'TEACHER', false], ['all', 'ADMIN', false], ['all', 'MASTER', false],
    ['historical', 'TEACHER', false], ['historical', 'ADMIN', false], ['historical', 'MASTER', true],
  ] as const)('pause %s, role %s -> allowed %s', (pause, role, allowed) => {
    const state = pause === 'none' ? { paused: false, scope: 'all' as const } : { paused: true, scope: pause };
    expect(mobileRetryVerdict(state, role).allowed).toBe(allowed);
  });

  it('names the reason for a refusal', () => {
    expect(mobileRetryVerdict({ paused: true, scope: 'all' }, 'MASTER')).toEqual({ allowed: false, reason: 'full-pause' });
    expect(mobileRetryVerdict({ paused: true, scope: 'historical' }, 'ADMIN')).toEqual({ allowed: false, reason: 'historical-hold' });
  });
});

describe('retryMobileProcessing with no pause: unchanged', () => {
  it.each(Object.keys(ROLES))('%s may retry a FAILED lecture (new generation, trigger retry)', async (role) => {
    const w = failedWorld();
    const result = await w.videos.retryMobileProcessing(V, ROLES[role as keyof typeof ROLES]);
    expect(result).toMatchObject({ jobId: mobileJobIdFor(V, 1), enqueued: true });
    expect(w.mobileQueue.jobs.get(mobileJobIdFor(V, 1))).toMatchObject({ data: { trigger: 'retry' } });
  });
});

describe('retryMobileProcessing during a FULL pause: refused for everyone', () => {
  it.each([
    ['legacy-all', 'TEACHER'], ['legacy-all', 'ADMIN'], ['legacy-all', 'MASTER'],
    ['all', 'TEACHER'], ['all', 'ADMIN'], ['all', 'MASTER'],
  ] as const)('flag %s, %s -> 403 full-pause, nothing queued or written', async (flag, role) => {
    const w = failedWorld();
    setFlag(w, flag);
    const before = snapshot(w);
    await expect(w.videos.retryMobileProcessing(V, ROLES[role])).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'full-pause' },
    });
    expect(snapshot(w)).toEqual(before);
  });

  it('force (READY) and supersede (live job) by MASTER are refused too', async () => {
    const ready = uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1), mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 1), mobileGeneration: 1 });
    setFlag(ready, 'all');
    await expect(ready.videos.retryMobileProcessing(V, MASTER, { force: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(ready.mobileQueue.jobs.size).toBe(0);

    const live = uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1) });
    await live.videos.enqueueMobileTranscode({ id: V, sourceKey: 'source/videos/v_1/a.mp4' }, 'migration');
    setFlag(live, 'all');
    await expect(live.videos.retryMobileProcessing(V, MASTER, { supersede: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(live.mobileQueue.jobs.size).toBe(1);
    expect(live.db.get(V)).toMatchObject({ mobileGeneration: 1 });
  });
});

describe('retryMobileProcessing during a HISTORICAL hold: MASTER only', () => {
  it.each(['TEACHER', 'ADMIN'] as const)('%s -> 403 historical-hold, nothing queued or written', async (role) => {
    const w = failedWorld();
    setFlag(w, 'historical');
    const before = snapshot(w);
    await expect(w.videos.retryMobileProcessing(V, ROLES[role])).rejects.toMatchObject({
      code: 'FORBIDDEN',
      details: { reason: 'historical-hold' },
    });
    expect(snapshot(w)).toEqual(before);
  });

  it('MASTER -> a new generation with trigger retry, audited', async () => {
    const w = failedWorld();
    setFlag(w, 'historical');
    await expect(w.videos.retryMobileProcessing(V, MASTER)).resolves.toMatchObject({ jobId: mobileJobIdFor(V, 1), enqueued: true });
    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'QUEUED', mobileGeneration: 1, mobileTrigger: 'retry' });
    expect(w.audit.record).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'master_1', after: expect.objectContaining({ mobileRetry: true }) }));
  });

  it('MASTER may supersede a live job and force a READY one; ADMIN may not', async () => {
    const live = uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1) });
    await live.videos.enqueueMobileTranscode({ id: V, sourceKey: 'source/videos/v_1/a.mp4' }, 'migration');
    setFlag(live, 'historical');
    await expect(live.videos.retryMobileProcessing(V, ADMIN, { supersede: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(live.videos.retryMobileProcessing(V, MASTER, { supersede: true })).resolves.toMatchObject({ jobId: mobileJobIdFor(V, 2) });

    const ready = uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1), mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 1), mobileGeneration: 1 });
    setFlag(ready, 'historical');
    await expect(ready.videos.retryMobileProcessing(V, ADMIN, { force: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(ready.videos.retryMobileProcessing(V, MASTER, { force: true })).resolves.toMatchObject({ jobId: mobileJobIdFor(V, 2) });
  });

  it('the rule follows the flag: lifting the hold restores the teacher retry', async () => {
    const w = failedWorld();
    setFlag(w, 'historical');
    await expect(w.videos.retryMobileProcessing(V, STAFF)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    setFlag(w, 'none');
    await expect(w.videos.retryMobileProcessing(V, STAFF)).resolves.toMatchObject({ enqueued: true });
  });
});

describe('retryMobileProcessing when the pause flag cannot be read: fail closed', () => {
  it.each(Object.keys(ROLES))('%s -> 503 pause-unreadable, nothing queued or written', async (role) => {
    const w = failedWorld();
    breakRedis(w);
    const before = snapshot(w);
    await expect(w.videos.retryMobileProcessing(V, ROLES[role as keyof typeof ROLES])).rejects.toMatchObject({
      code: 'QUEUE_UNAVAILABLE',
      details: { reason: 'pause-unreadable' },
    });
    expect(snapshot(w)).toEqual(before);
  });
});

describe('ordering: course permission and existence come first', () => {
  it('a teacher who cannot manage the course gets that refusal; the flag is not read', async () => {
    const w = failedWorld();
    setFlag(w, 'historical');
    const read = jest.spyOn(w.redis, 'getJsonOrThrow');
    const access = (w.videos as unknown as { access: { assertCanManageCourse: jest.Mock } }).access;
    access.assertCanManageCourse.mockRejectedValueOnce(Object.assign(new Error('not your course'), { code: 'FORBIDDEN' }));
    await expect(w.videos.retryMobileProcessing(V, STAFF)).rejects.toThrow('not your course');
    expect(read).not.toHaveBeenCalled();
  });

  it('an unknown video is a 404 whatever the pause', async () => {
    const w = failedWorld();
    setFlag(w, 'all');
    await expect(w.videos.retryMobileProcessing('v_missing', MASTER)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('status().mobile.canRetry matches what the endpoint would do', () => {
  const canRetry = async (w: World, actor: never) => (await w.videos.status(V, actor)).mobile?.canRetry;

  it.each([
    ['none', 'TEACHER', true], ['none', 'ADMIN', true], ['none', 'MASTER', true],
    ['legacy-all', 'TEACHER', false], ['legacy-all', 'MASTER', false],
    ['all', 'TEACHER', false], ['all', 'ADMIN', false], ['all', 'MASTER', false],
    ['historical', 'TEACHER', false], ['historical', 'ADMIN', false], ['historical', 'MASTER', true],
  ] as const)('flag %s, %s -> canRetry %s (and the endpoint agrees)', async (flag, role, expected) => {
    const w = failedWorld();
    setFlag(w, flag);
    expect(await canRetry(w, ROLES[role])).toBe(expected);
    const outcome = await w.videos.retryMobileProcessing(V, ROLES[role]).then(() => true, () => false);
    expect(outcome).toBe(expected);
  });

  it('unreadable flag -> canRetry false; the rest of the status still answers', async () => {
    const w = failedWorld();
    breakRedis(w);
    const status = await w.videos.status(V, MASTER);
    expect(status.mobile?.canRetry).toBe(false);
    expect(status.gumlet).toBeDefined();
  });

  it('a READY or queued lecture does not read the flag at all (the panel polls those)', async () => {
    const ready = uploadedWorld({ status: 'READY', sourceSizeBytes: BigInt(1), mobileStatus: 'READY', mobileJobId: mobileJobIdFor(V, 1), mobileGeneration: 1 });
    const read = jest.spyOn(ready.redis, 'getJsonOrThrow');
    expect(await canRetry(ready, MASTER)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('concurrent requests', () => {
  it('many teacher retries at once during a hold: all refused, no job, no row change', async () => {
    const w = failedWorld();
    setFlag(w, 'historical');
    const before = snapshot(w);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => w.videos.retryMobileProcessing(V, STAFF)));
    expect(results.every((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'FORBIDDEN')).toBe(true);
    expect(snapshot(w)).toEqual(before);
  });

  it('MASTER retries at once during a hold: exactly one new job, the rest report it as already queued', async () => {
    const w = failedWorld();
    setFlag(w, 'historical');
    const results = await Promise.all(Array.from({ length: 5 }, () => w.videos.retryMobileProcessing(V, MASTER)));
    expect(w.mobileQueue.jobs.size).toBe(1);
    expect(new Set(results.map((r) => r.jobId))).toEqual(new Set([mobileJobIdFor(V, 1)]));
    expect(w.db.get(V)).toMatchObject({ mobileGeneration: 1, mobileStatus: 'QUEUED' });
  });

  it('teacher and MASTER together during a hold: only the MASTER request queues', async () => {
    const w = failedWorld();
    setFlag(w, 'historical');
    const [t, m] = await Promise.allSettled([w.videos.retryMobileProcessing(V, STAFF), w.videos.retryMobileProcessing(V, MASTER)]);
    expect(t.status).toBe('rejected');
    expect(m).toMatchObject({ status: 'fulfilled', value: { jobId: mobileJobIdFor(V, 1) } });
    expect(w.mobileQueue.jobs.size).toBe(1);
  });
});

describe('unchanged: Gumlet and course administration during a pause', () => {
  it('a teacher can still complete an upload (the Gumlet hand-off is queued) while mobile is fully paused', async () => {
    const w = uploadedWorld({}, { autoProcess: false });
    setFlag(w, 'all');
    await expect(w.videos.completeUpload(V, STAFF)).resolves.toBeDefined();
    expect(w.webQueue.jobs.size).toBe(1);
    expect(w.mobileQueue.jobs.size).toBe(0);
  });
});
