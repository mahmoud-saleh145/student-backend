/**
 * Mobile HLS "safe pause" against a real PostgreSQL and a real BullMQ queue.
 *
 * The full application is booted (RUN_WORKERS=false: no processor runs), so
 * VideosService, its Prisma client, its AuditService and its mobile queue are
 * the production wiring. Only `StorageService.exists` is stubbed (it would ask
 * R2 whether the source object is there).
 *
 * Covered:
 *   - a staff retry of a FAILED row: new generation id, row QUEUED, audit row;
 *   - supersede of a QUEUED row whose job is live (delayed): new generation,
 *     the old job left in the queue; refused (409) when the row is PROCESSING
 *     or the old job is active, and refused (403) for a non-administrator;
 *   - the claim (`markMobileProcessing`) as a compare-and-set on real rows;
 *   - the pause / resume transitions on the real queue, including that resume
 *     promotes only PARKED jobs and leaves a short retry backoff alone;
 *   - none of it changes what a student sees, and no notification is created.
 *
 * Runner environment (in addition to what test/integration/setup.ts needs):
 *   DATABASE_URL   a disposable database whose name ends in `_test`
 *   REDIS_URL      a Redis this run may write to (redis:// or rediss://)
 *   REDIS_PREFIX   must contain "test": this file obliterates the mobile
 *                  queue under that prefix before every test.
 */
import { getQueueToken } from '@nestjs/bullmq';
import type { INestApplication } from '@nestjs/common';
import { MobileVideoStatus, NotificationKind, PrismaClient, UserRole } from '@prisma/client';
import { Queue, Worker } from 'bullmq';

import { MOBILE_PARK_MS } from '../../src/jobs/mobile-park';
import { readPauseState } from '../../src/jobs/processors/scratch-guard';
import {
  DEFAULT_JOB_OPTIONS,
  MOBILE_JOB_ATTEMPTS,
  MOBILE_JOB_PRIORITY,
  MOBILE_VIDEO_JOBS,
  QUEUE_NAMES,
  type MobileTranscodeJobData,
} from '../../src/jobs/queue.constants';
import { StorageService } from '../../src/modules/storage/storage.service';
import { mobileJobIdFor } from '../../src/modules/videos/pipeline-state';
import { VideosService } from '../../src/modules/videos/videos.service';
import { RedisService } from '../../src/redis/redis.service';

import { API, bootstrapTestApp, createCourse, createUser, enroll, errorCode, http, login, resetDatabase, shutdownTestApp } from './helpers';

const REDIS_PREFIX = process.env.REDIS_PREFIX ?? 'edu';
if (!/test/i.test(REDIS_PREFIX)) {
  throw new Error(
    `Refusing to run: REDIS_PREFIX "${REDIS_PREFIX}" does not contain "test". ` +
      'This file obliterates the mobile queue under that prefix.',
  );
}

/** BullMQ connection options for the runner's REDIS_URL (as JobsModule builds them). */
function bullConnection() {
  const u = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    tls: u.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };
}

describe('mobile safe pause (real Postgres + real BullMQ queue)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let videos: VideosService;
  let queue: Queue<MobileTranscodeJobData>;
  let redis: RedisService;
  let admin: { id: string; role: UserRole };
  let master: { id: string; role: UserRole };
  let teacher: { id: string; role: UserRole };
  let teacherPhone: string;
  let adminPhone: string;
  let masterPhone: string;
  let courseId: string;
  let videoIds: string[];

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    videos = app.get(VideosService);
    queue = app.get<Queue<MobileTranscodeJobData>>(getQueueToken(QUEUE_NAMES.mobileVideo));
    redis = app.get(RedisService);
    // The source object "is in R2" for every test here.
    jest.spyOn(app.get(StorageService), 'exists').mockResolvedValue(true);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true }).catch(() => undefined);
    await redis.del('mobile:transcode:paused');
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    await queue.obliterate({ force: true });
    if (await queue.isPaused()) await queue.resume();
    await redis.delOrThrow('mobile:transcode:paused');

    const t = await createUser(prisma, { role: UserRole.TEACHER });
    const a = await createUser(prisma, { role: UserRole.ADMIN });
    const m = await createUser(prisma, { role: UserRole.MASTER });
    const student = await createUser(prisma, { role: UserRole.STUDENT });
    teacher = { id: t.id, role: t.role };
    teacherPhone = t.phone;
    admin = { id: a.id, role: a.role };
    adminPhone = a.phone;
    master = { id: m.id, role: m.role };
    masterPhone = m.phone;
    const course = await createCourse(prisma, { teacherId: t.id });
    await enroll(prisma, student.id, course.id);
    courseId = course.id;
    videoIds = course.sections.flatMap((s) => s.lessons.map((l) => l.video!.id));
    // Production shape: web READY (Gumlet), with a stored source.
    for (const [i, id] of videoIds.entries()) {
      await prisma.video.update({
        where: { id },
        data: {
          sourceKey: `source/videos/${id}/a.mp4`,
          sourceSizeBytes: BigInt(300_000_000),
          drmProvider: 'gumlet',
          gumletAssetId: `asset_${i}`,
          gumletStatus: 'ready',
        },
      });
    }
  });

  // --- helpers ---------------------------------------------------------------

  const row = (id: string) => prisma.video.findUniqueOrThrow({ where: { id } });
  const sourceOf = async (id: string) => (await row(id)).sourceKey!;
  const setMobile = (id: string, data: Record<string, unknown>) => prisma.video.update({ where: { id }, data });
  const oldJobId = (id: string) => `mobile-hls:${id}:1794847870655`;

  /** A historical job as production has it, optionally delayed. */
  const addHistorical = async (videoId: string, jobId: string, extra: Record<string, unknown> = {}) =>
    queue.add(
      MOBILE_VIDEO_JOBS.transcode,
      { videoId, sourceKey: await sourceOf(videoId), ladder: [480, 720], encrypt: true, trigger: 'migration' },
      {
        ...DEFAULT_JOB_OPTIONS,
        attempts: MOBILE_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: 15_000 },
        priority: MOBILE_JOB_PRIORITY.migration,
        jobId,
        ...extra,
      },
    );

  /** Everything a student sees, and every row the mobile pipeline must not touch. */
  async function studentFacing() {
    const [vids, lessons, links, enrolments] = await Promise.all([
      prisma.video.findMany({
        where: { courseId },
        orderBy: { id: 'asc' },
        select: {
          id: true,
          status: true,
          lessonId: true,
          hlsPrefix: true,
          masterPlaylistKey: true,
          durationSeconds: true,
          drmProvider: true,
          gumletAssetId: true,
          gumletStatus: true,
          gumletError: true,
          drmVerifiedAt: true,
          isEncrypted: true,
        },
      }),
      prisma.lesson.findMany({ where: { courseId }, orderBy: { id: 'asc' } }),
      prisma.lessonVideo.findMany({ where: { lesson: { courseId } }, orderBy: [{ lessonId: 'asc' }, { videoId: 'asc' }] }),
      prisma.enrollment.findMany({ where: { courseId }, orderBy: { id: 'asc' } }),
    ]);
    return JSON.stringify({ vids, lessons, links, enrolments }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  const notificationCount = () => prisma.notification.count();

  // --- staff retry -----------------------------------------------------------

  it('a staff retry of a FAILED row: new generation id, row QUEUED, one job, an audit row', async () => {
    const id = videoIds[0];
    await setMobile(id, {
      mobileStatus: MobileVideoStatus.FAILED,
      mobileJobId: oldJobId(id),
      mobileGeneration: 0,
      mobileError: 'Attempt 2 of 2 failed (socket hang up)',
    });
    const before = await studentFacing();

    const result = await videos.retryMobileProcessing(id, teacher);

    expect(result).toMatchObject({ jobId: mobileJobIdFor(id, 1), alreadyQueued: false, enqueued: true });
    expect(result.jobId).toMatch(/:p\d+g1$/);
    expect(await row(id)).toMatchObject({
      mobileStatus: MobileVideoStatus.QUEUED,
      mobileJobId: mobileJobIdFor(id, 1),
      mobileGeneration: 1,
      mobileTrigger: 'retry',
      mobileError: null,
    });
    expect(await (await queue.getJob(mobileJobIdFor(id, 1)))!.getState()).toBe('waiting');
    const audit = await prisma.auditLog.findMany({ where: { entity: 'video', entityId: id } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorId: teacher.id, after: expect.objectContaining({ mobileRetry: true, jobId: mobileJobIdFor(id, 1) }) });
    expect(await studentFacing()).toBe(before);
    expect(await notificationCount()).toBe(0);
  });

  // --- supersede ---------------------------------------------------------------

  it('supersede of a QUEUED row whose job is live (delayed): new generation; the old job is left as it was', async () => {
    const id = videoIds[0];
    await setMobile(id, { mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: oldJobId(id), mobileGeneration: 0, mobileTrigger: 'migration' });
    await addHistorical(id, oldJobId(id), { delay: 60_000 });
    const oldBefore = (await queue.getJob(oldJobId(id)))!;
    const before = await studentFacing();

    // Without supersede the live job is kept.
    await expect(videos.retryMobileProcessing(id, admin)).resolves.toMatchObject({ jobId: oldJobId(id), alreadyQueued: true });

    await expect(videos.retryMobileProcessing(id, admin, { supersede: true })).resolves.toMatchObject({
      jobId: mobileJobIdFor(id, 1),
      alreadyQueued: false,
      enqueued: true,
    });
    expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: mobileJobIdFor(id, 1), mobileGeneration: 1 });
    const oldAfter = (await queue.getJob(oldJobId(id)))!;
    expect(await oldAfter.getState()).toBe('delayed');
    expect([oldAfter.data, oldAfter.opts, oldAfter.attemptsMade]).toEqual([oldBefore.data, oldBefore.opts, oldBefore.attemptsMade]);
    const audit = await prisma.auditLog.findMany({ where: { entity: 'video', entityId: id }, orderBy: { createdAt: 'asc' } });
    expect(audit.at(-1)!.after).toMatchObject({ supersede: true, supersededJobId: oldJobId(id) });
    expect(await studentFacing()).toBe(before);
  });

  it('supersede is refused (409) while the row is PROCESSING', async () => {
    const id = videoIds[0];
    await setMobile(id, { mobileStatus: MobileVideoStatus.PROCESSING, mobileJobId: oldJobId(id), mobileGeneration: 0 });
    await addHistorical(id, oldJobId(id), { delay: 60_000 });

    await expect(videos.retryMobileProcessing(id, admin, { supersede: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await row(id)).toMatchObject({ mobileJobId: oldJobId(id), mobileGeneration: 0 });
    expect(await queue.getJob(mobileJobIdFor(id, 1))).toBeUndefined();
  });

  it('supersede is refused (409) while the old job is ACTIVE', async () => {
    const id = videoIds[0];
    await setMobile(id, { mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: oldJobId(id), mobileGeneration: 0 });
    await addHistorical(id, oldJobId(id));
    // Take the job by hand, as a worker would: it becomes active.
    const taker = new Worker(QUEUE_NAMES.mobileVideo, null, { connection: bullConnection(), prefix: `${REDIS_PREFIX}:bull` });
    try {
      const job = await taker.getNextJob('test-token');
      expect(job?.id).toBe(oldJobId(id));
      expect(await job!.getState()).toBe('active');

      await expect(videos.retryMobileProcessing(id, admin, { supersede: true })).rejects.toMatchObject({ code: 'INVALID_STATE' });
      expect(await row(id)).toMatchObject({ mobileJobId: oldJobId(id), mobileGeneration: 0 });
      expect(await queue.getJob(mobileJobIdFor(id, 1))).toBeUndefined();
    } finally {
      await taker.close(true);
    }
  });

  it('supersede is refused (403) for a non-administrator, in the service and over HTTP', async () => {
    const id = videoIds[0];
    await setMobile(id, { mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: oldJobId(id), mobileGeneration: 0 });
    await addHistorical(id, oldJobId(id), { delay: 60_000 });

    await expect(videos.retryMobileProcessing(id, teacher, { supersede: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const { headers } = await login(app, teacherPhone, 'teacher-device');
    const res = await http(app).post(`${API}/videos/${id}/mobile/retry`).set(headers).send({ supersede: true });
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe('FORBIDDEN');
    expect(await row(id)).toMatchObject({ mobileJobId: oldJobId(id), mobileGeneration: 0 });
  });

  // --- S2-P1: who may retry while an operator pause is in place ----------------

  describe('retry guard during an operator pause (service and HTTP)', () => {
    const failed = async (id: string) =>
      setMobile(id, { mobileStatus: MobileVideoStatus.FAILED, mobileJobId: oldJobId(id), mobileGeneration: 0 });
    const retryHttp = async (phone: string, device: string, id: string, body: Record<string, unknown> = {}) => {
      const { headers } = await login(app, phone, device);
      return http(app).post(`${API}/videos/${id}/mobile/retry`).set(headers).send(body);
    };

    it('historical hold: teacher and admin get 403 over HTTP, the master gets the new job', async () => {
      const id = videoIds[0];
      await failed(id);
      await videos.setMobileProcessingPaused(true, admin, 'between batches', 'historical');
      const before = await studentFacing();

      for (const [phone, device] of [[teacherPhone, 'teacher-device'], [adminPhone, 'admin-device']] as const) {
        const res = await retryHttp(phone, device, id);
        expect(res.status).toBe(403);
        expect(errorCode(res.body)).toBe('FORBIDDEN');
      }
      expect(await row(id)).toMatchObject({ mobileJobId: oldJobId(id), mobileGeneration: 0 });
      expect(await queue.getJob(mobileJobIdFor(id, 1))).toBeUndefined();

      const ok = await retryHttp(masterPhone, 'master-device', id);
      expect([200, 201]).toContain(ok.status);
      expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: mobileJobIdFor(id, 1), mobileTrigger: 'retry' });
      expect((await queue.getJob(mobileJobIdFor(id, 1)))?.data.trigger).toBe('retry');
      expect(await studentFacing()).toBe(before);
    });

    it('full pause: even the master gets 403 over HTTP; nothing is queued', async () => {
      const id = videoIds[0];
      await failed(id);
      await videos.setMobileProcessingPaused(true, admin, 'metered', 'all');
      const res = await retryHttp(masterPhone, 'master-device', id);
      expect(res.status).toBe(403);
      expect(await row(id)).toMatchObject({ mobileJobId: oldJobId(id), mobileGeneration: 0 });
      expect(await queue.getJobCounts('waiting', 'prioritized', 'delayed', 'paused')).toEqual({ waiting: 0, prioritized: 0, delayed: 0, paused: 0 });
    });

    it('the status endpoint offers "Retry mobile" exactly when the endpoint would accept it', async () => {
      const id = videoIds[0];
      await failed(id);
      const canRetry = async (phone: string, device: string) => {
        const { headers } = await login(app, phone, device);
        const res = await http(app).get(`${API}/videos/${id}/status`).set(headers);
        expect(res.status).toBe(200);
        return (res.body.data ?? res.body).mobile.canRetry;
      };
      expect(await canRetry(teacherPhone, 'teacher-device')).toBe(true);
      await videos.setMobileProcessingPaused(true, admin, 'between batches', 'historical');
      expect(await canRetry(teacherPhone, 'teacher-device')).toBe(false);
      expect(await canRetry(masterPhone, 'master-device')).toBe(true);
      await videos.setMobileProcessingPaused(true, admin, 'metered', 'all');
      expect(await canRetry(masterPhone, 'master-device')).toBe(false);
    });

    it('concurrent master retries on real rows during a hold: one new generation, one job', async () => {
      const id = videoIds[0];
      await failed(id);
      await videos.setMobileProcessingPaused(true, admin, 'between batches', 'historical');
      const results = await Promise.allSettled(Array.from({ length: 5 }, () => videos.retryMobileProcessing(id, master)));
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      expect(await row(id)).toMatchObject({ mobileGeneration: 1, mobileJobId: mobileJobIdFor(id, 1) });
      expect(await queue.getJobCounts('waiting', 'prioritized', 'delayed')).toMatchObject({ waiting: 1, prioritized: 0, delayed: 0 });
    });

    it('lifting the pause restores the teacher retry', async () => {
      const id = videoIds[0];
      await failed(id);
      await videos.setMobileProcessingPaused(true, admin, 'between batches', 'historical');
      await expect(videos.retryMobileProcessing(id, teacher)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await videos.setMobileProcessingPaused(false, admin);
      await expect(videos.retryMobileProcessing(id, teacher)).resolves.toMatchObject({ jobId: mobileJobIdFor(id, 1) });
    });
  });

  // --- the claim ---------------------------------------------------------------

  describe('markMobileProcessing compare-and-set on real rows', () => {
    it('the owner claims its row', async () => {
      const id = videoIds[0];
      await setMobile(id, { mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: mobileJobIdFor(id, 3), mobileGeneration: 3 });
      await expect(videos.markMobileProcessing(id, await sourceOf(id), mobileJobIdFor(id, 3))).resolves.toBe(true);
      expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.PROCESSING, mobileJobId: mobileJobIdFor(id, 3) });
    });

    it('a non-owner steps aside while the owner is live in the queue', async () => {
      const id = videoIds[0];
      await setMobile(id, { mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: mobileJobIdFor(id, 2), mobileGeneration: 2 });
      await addHistorical(id, mobileJobIdFor(id, 2), { delay: 60_000 });
      await expect(videos.markMobileProcessing(id, await sourceOf(id), oldJobId(id))).resolves.toBe(false);
      expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: mobileJobIdFor(id, 2) });
    });

    it('a non-owner never claims a READY row', async () => {
      const id = videoIds[0];
      await setMobile(id, { mobileStatus: MobileVideoStatus.READY, mobileJobId: mobileJobIdFor(id, 2), mobileGeneration: 2 });
      await expect(videos.markMobileProcessing(id, await sourceOf(id), oldJobId(id))).resolves.toBe(false);
      expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.READY, mobileJobId: mobileJobIdFor(id, 2) });
    });

    it('a forced re-encode of a READY row: the new owner claims, the previous job does not', async () => {
      const id = videoIds[0];
      await setMobile(id, { mobileStatus: MobileVideoStatus.READY, mobileJobId: mobileJobIdFor(id, 1), mobileGeneration: 1 });
      await expect(videos.retryMobileProcessing(id, admin, { force: true })).resolves.toMatchObject({ jobId: mobileJobIdFor(id, 2) });
      expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: mobileJobIdFor(id, 2) });

      await expect(videos.markMobileProcessing(id, await sourceOf(id), mobileJobIdFor(id, 1))).resolves.toBe(false);
      await expect(videos.markMobileProcessing(id, await sourceOf(id), mobileJobIdFor(id, 2))).resolves.toBe(true);
      expect(await row(id)).toMatchObject({ mobileStatus: MobileVideoStatus.PROCESSING, mobileJobId: mobileJobIdFor(id, 2) });
    });

    it('two jobs racing for an unowned row: exactly one wins', async () => {
      const id = videoIds[0];
      await setMobile(id, { mobileStatus: MobileVideoStatus.FAILED, mobileJobId: oldJobId(id), mobileGeneration: 1 });
      const src = await sourceOf(id);
      const results = await Promise.all(['job_a', 'job_b', 'job_c'].map((j) => videos.markMobileProcessing(id, src, `mobile-hls:${id}:${j}`)));
      expect(results.filter(Boolean)).toHaveLength(1);
      expect((await row(id)).mobileStatus).toBe(MobileVideoStatus.PROCESSING);
    });
  });

  // --- the operator transitions on the real queue --------------------------------

  it('pause all, historical, resume: the queue and the flag move together; resume releases only PARKED jobs', async () => {
    const [parkedVideo, backoffVideo] = videoIds;
    const before = await studentFacing();
    // A parked historical job (due years from now) and a retry backoff (due in 30 s).
    await addHistorical(parkedVideo, oldJobId(parkedVideo), { delay: MOBILE_PARK_MS });
    await addHistorical(backoffVideo, oldJobId(backoffVideo), { delay: 30_000 });

    await expect(videos.setMobileProcessingPaused(true, admin, 'metered', 'all')).resolves.toMatchObject({
      paused: true,
      scope: 'all',
      queuePaused: true,
      queueControl: 'queue',
    });
    expect(await queue.isPaused()).toBe(true);
    expect(await readPauseState(redis, { strict: true })).toMatchObject({ paused: true, scope: 'all' });

    await expect(videos.setMobileProcessingPaused(true, admin, 'between batches', 'historical')).resolves.toMatchObject({
      scope: 'historical',
      queuePaused: false,
    });
    expect(await queue.isPaused()).toBe(false);
    expect(await readPauseState(redis, { strict: true })).toMatchObject({ paused: true, scope: 'historical' });

    await expect(videos.setMobileProcessingPaused(false, admin)).resolves.toMatchObject({
      paused: false,
      queuePaused: false,
      parkedPromoted: 1,
    });
    expect(await readPauseState(redis, { strict: true })).toMatchObject({ paused: false });
    expect(await queue.isPaused()).toBe(false);
    expect(await (await queue.getJob(oldJobId(parkedVideo)))!.getState()).toBe('prioritized');
    expect(await (await queue.getJob(oldJobId(backoffVideo)))!.getState()).toBe('delayed');

    const audit = await prisma.auditLog.findMany({ where: { entityId: 'mobile-pipeline' }, orderBy: { createdAt: 'asc' } });
    expect(audit.map((a) => a.after)).toEqual([
      expect.objectContaining({ paused: true, scope: 'all', queuePaused: true }),
      expect.objectContaining({ paused: true, scope: 'historical', queuePaused: false }),
      expect.objectContaining({ paused: false, queuePaused: false, parkedPromoted: 1 }),
    ]);
    expect(await studentFacing()).toBe(before);
  });

  it('nothing here changes what a student sees or creates a notification', async () => {
    const before = await studentFacing();
    const [a, b, c] = videoIds;
    await setMobile(a, { mobileStatus: MobileVideoStatus.FAILED, mobileJobId: oldJobId(a) });
    await setMobile(b, { mobileStatus: MobileVideoStatus.QUEUED, mobileJobId: oldJobId(b), mobileTrigger: 'migration' });
    await addHistorical(b, oldJobId(b), { delay: 60_000 });
    await setMobile(c, { mobileStatus: MobileVideoStatus.READY, mobileJobId: mobileJobIdFor(c, 1), mobileGeneration: 1 });

    // A full pause refuses every retry (S2-P1), the master's included...
    await videos.setMobileProcessingPaused(true, admin, 'x', 'all');
    await expect(videos.retryMobileProcessing(a, teacher)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(videos.retryMobileProcessing(b, master, { supersede: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(videos.retryMobileProcessing(c, master, { force: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    // ...and a historical hold lets only the master queue one.
    await videos.setMobileProcessingPaused(true, admin, 'y', 'historical');
    await expect(videos.retryMobileProcessing(a, teacher)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await videos.retryMobileProcessing(a, master);
    await videos.retryMobileProcessing(b, master, { supersede: true });
    await videos.retryMobileProcessing(c, master, { force: true });
    await videos.markMobileProcessing(c, await sourceOf(c), mobileJobIdFor(c, 2));
    await videos.setMobileProcessingPaused(false, admin);

    expect(await studentFacing()).toBe(before);
    expect(await prisma.notification.count({ where: { kind: NotificationKind.NEW_VIDEO } })).toBe(0);
    expect(await notificationCount()).toBe(0);
  });
});
