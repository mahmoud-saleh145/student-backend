/**
 * What a lecture owes its students the moment it first becomes playable -
 * whichever pipeline got it there.
 *
 * Two things used to depend on ONE pipeline finishing:
 *
 *   1. THE DURATION. `Lesson.durationSeconds` (what the course list, the
 *      lecture row and the course total show) was written only by the Gumlet
 *      sync and the legacy transcode. A lecture whose Gumlet side failed played
 *      on mobile and was listed as "0m".
 *
 *   2. THE "NEW VIDEO" NOTIFICATION. It lived in `markReady()`, which only the
 *      legacy local transcode reaches; nothing on the Gumlet path, and nothing
 *      on the mobile path, sent it.
 *
 * The code under test is real: VideosService, MobileVideoProcessor,
 * GumletIngestService.sync, LessonVideoService, NotificationsService and the
 * NewVideoAnnouncer. Only Postgres, Redis, Gumlet and ffmpeg are replaced.
 */
import { NotificationsService } from '../../src/modules/notifications/notifications.service';
import { GumletIngestService } from '../../src/modules/videos/gumlet-ingest.service';
import { LessonVideoService } from '../../src/modules/videos/lesson-video.service';
import { ANNOUNCE_TIMEOUT_MS, NewVideoAnnouncer } from '../../src/modules/videos/new-video-announcer.service';
import {
  ADMIN,
  FakeDb,
  STAFF,
  apiProcess,
  mobileWorker,
  uploadedWorld,
  videoRow,
  type Row,
  type World,
} from './support/pipeline-fakes';

const V = 'v_1';

const activeStudent = (userId: string, courseId = 'course_1') => ({
  userId,
  courseId,
  state: 'ACTIVE',
  user: { status: 'ACTIVE', deletedAt: null as Date | null },
});

/** Three students who must be told, and three who must not. */
function enrol(world: World): void {
  world.db.enrollments = [
    activeStudent('student_1'),
    activeStudent('student_2'),
    activeStudent('student_3'),
    { ...activeStudent('expired'), state: 'EXPIRED' },
    { ...activeStudent('suspended'), user: { status: 'SUSPENDED', deletedAt: null } },
    { ...activeStudent('deleted'), user: { status: 'ACTIVE', deletedAt: new Date() } },
    activeStudent('other_course', 'course_9'),
  ];
}

const told = (world: World) => world.db.notifications.map((n) => n.userId as string).sort();
const lessonSeconds = (world: World, id = 'lesson_1') => world.db.lessons.get(id)?.durationSeconds;

/** A lecture whose upload was accepted; `gumlet` says how the Gumlet side stands. */
function lecture(gumlet: 'failed' | 'processing' | 'ready', overrides: Partial<Row> = {}, parts = {}): World {
  const byState = {
    failed: { status: 'FAILED', gumletAssetId: 'asset_1', gumletStatus: 'errored', gumletError: 'unsupported codec' },
    processing: { status: 'PROCESSING', gumletAssetId: 'asset_1', gumletStatus: 'processing' },
    ready: {
      status: 'READY',
      gumletAssetId: 'asset_1',
      gumletStatus: 'ready',
      durationSeconds: 1795,
      processedAt: new Date('2026-11-01T08:00:00Z'),
    },
  }[gumlet];
  const world = uploadedWorld(
    { sourceSizeBytes: BigInt(100_000_000), gumletWorkspaceId: 'ws', frameRate: null, ...byState, ...overrides },
    parts,
  );
  enrol(world);
  return world;
}

/** Queues the lecture for mobile and encodes it, as the worker does. */
async function encodeForMobile(world: World, trigger: 'upload' | 'migration' | 'retry' = 'upload', seconds = 1800) {
  await world.videos.enqueueMobileTranscode({ id: V, sourceKey: world.db.get(V).sourceKey as string }, trigger as never);
  const worker = mobileWorker(world);
  worker.transcoder.run.mockImplementation(async (params: { videoId: string }) => ({
    probe: { durationSeconds: seconds, width: 1920, height: 1080, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
    renditions: [{ height: 720, width: 1280, bitrateKbps: 2300, playlistKey: `hls/${params.videoId}/720p/index.m3u8`, sizeBytes: 20 }],
    hlsPrefix: `hls/${params.videoId}/`,
    masterPlaylistKey: `hls/${params.videoId}/master.m3u8`,
    thumbnailKey: undefined,
    isEncrypted: true,
  }));
  const ran = await worker.runNext();
  return { worker, ran };
}

/**
 * The REAL GumletIngestService over the world's database, with Gumlet itself
 * answering `asset`. Built the way VideosModule wires it: one announcer over
 * the same database and notification service.
 */
function gumletSide(world: World, asset: { status: string; durationSeconds?: number | null }, enabled = true) {
  const notifications = new NotificationsService(world.db as never, world.pushQueue as never, { get: () => undefined } as never);
  const announcer = new NewVideoAnnouncer(
    world.db as never,
    notifications,
    { getOrThrow: () => ({ newVideoNotifications: enabled }) } as never,
  );
  const service = new GumletIngestService(
    world.db as never,
    { isConfigured: true, exists: jest.fn(async () => true) } as never,
    {
      isAssetApiConfigured: () => true,
      isSigningConfigured: () => true,
      isAssetPlayable: (status: string) => status === 'ready',
      getAsset: jest.fn(async (assetId: string) => ({
        assetId,
        status: asset.status,
        progress: 100,
        playbackUrl: null,
        dashPlaybackUrl: null,
        error: asset.status === 'errored' ? 'unsupported codec' : null,
        errorCode: null,
        durationSeconds: asset.durationSeconds === undefined ? 1795 : asset.durationSeconds,
        width: 1920,
        height: 1080,
        frameRate: 25,
      })),
    } as never,
    { verify: jest.fn(async () => ({ playable: true, reason: 'OK', detail: '' })), isPlatformUsable: () => true } as never,
    { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: { workspaceId: 'ws' } } }) } as never,
    new LessonVideoService(world.db as never, world.courses as never),
    { record: jest.fn() } as never,
    announcer,
  );
  return { service, announcer };
}

// ---------------------------------------------------------------------------
describe('duration: a lecture that only the mobile pipeline finished is not listed as 0m', () => {
  it('Gumlet FAILED, mobile READY: the video, the lecture and the course total carry the measured duration', async () => {
    const w = lecture('failed');
    expect(lessonSeconds(w)).toBe(0);

    await encodeForMobile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', mobileStatus: 'READY', durationSeconds: 1800 });
    expect(lessonSeconds(w)).toBe(1800);
    expect(w.courses.recountCourse).toHaveBeenCalledWith('course_1');
  });

  it('reaches every lecture the video is attached to, and recounts each of their courses', async () => {
    const w = lecture('failed', { lessonLinks: [{ lessonId: 'lesson_1' }, { lessonId: 'lesson_reused' }] });
    w.db.lessons.get('lesson_reused')!.courseId = 'course_2';

    await encodeForMobile(w);

    expect(lessonSeconds(w)).toBe(1800);
    expect(lessonSeconds(w, 'lesson_reused')).toBe(1800);
    expect(w.courses.recountCourse.mock.calls.map((c) => c[0]).sort()).toEqual(['course_1', 'course_2']);
  });

  it('Gumlet still PROCESSING: the lecture shows its duration as soon as the mobile ladder is ready', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);
    expect(lessonSeconds(w)).toBe(1800);
  });

  it('leaves a duration Gumlet already supplied exactly as it is - video, lecture and course total', async () => {
    const w = lecture('ready');
    w.db.lessons.get('lesson_1')!.durationSeconds = 1795;

    await encodeForMobile(w, 'migration');

    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', durationSeconds: 1795 });
    expect(lessonSeconds(w)).toBe(1795);
    expect(w.courses.recountCourse).not.toHaveBeenCalled();
  });

  it('Gumlet finishing LATER still writes the provider figure over the mobile one, as it always has', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);
    expect(lessonSeconds(w)).toBe(1800);

    await gumletSide(w, { status: 'ready', durationSeconds: 1795 }).service.sync(V);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', durationSeconds: 1795 });
    expect(lessonSeconds(w)).toBe(1795);
  });

  it('a Gumlet sync that reports no duration cannot erase the one the mobile pipeline measured', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);

    await gumletSide(w, { status: 'ready', durationSeconds: null }).service.sync(V);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', durationSeconds: 1800 });
    expect(lessonSeconds(w)).toBe(1800);
  });

  it.each([0, -3, Number.NaN])('an unmeasured duration (%p) is unknown, never written as a duration', async (bad) => {
    const w = lecture('failed');
    w.db.lessons.get('lesson_1')!.durationSeconds = 600; // whatever the lecture showed before

    await encodeForMobile(w, 'upload', bad);

    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', durationSeconds: 0 });
    expect(lessonSeconds(w)).toBe(600);
  });

  it('a failure while copying the duration does not fail the job: the ladder stays READY and is not encoded again', async () => {
    const w = lecture('failed');
    w.db.lesson.updateMany = async () => {
      throw new Error('connection reset');
    };

    const { worker, ran } = await encodeForMobile(w);

    expect(ran?.outcome).toBe('completed');
    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(worker.transcoder.run).toHaveBeenCalledTimes(1);
    expect(w.mobileQueue.live()).toHaveLength(0);
  });

  it('replacing the file forgets the old file\'s duration, so the new recording is measured, not assumed', async () => {
    const w = lecture('ready', { mobileStatus: 'READY', hlsPrefix: 'hls/v_1/' });
    w.db.lessons.get('lesson_1')!.durationSeconds = 1795;
    Object.assign(w.db, {
      lesson: {
        findFirst: async () => ({
          id: 'lesson_1',
          courseId: 'course_1',
          video: { id: V, status: 'READY', deletedAt: null, hlsPrefix: 'hls/v_1/', drmProvider: 'gumlet', gumletAssetId: 'asset_1' },
          videoLinks: [{ videoId: V, video: { deletedAt: null } }],
        }),
        updateMany: w.db.lesson.updateMany,
      },
      lessonVideo: { count: async () => 0, upsert: async () => ({}), findMany: w.db.lessonVideo.findMany },
    });

    await w.videos.initUpload(
      { lessonId: 'lesson_1', filename: 'new.mp4', contentType: 'video/mp4', sizeBytes: 50_000_000 },
      ADMIN,
    );
    expect(w.db.get(V)).toMatchObject({ status: 'UPLOADING', durationSeconds: 0, newVideoAnnouncedAt: null });
    // The lecture keeps showing the old figure until something measures the new file.
    expect(lessonSeconds(w)).toBe(1795);

    // The new file is uploaded; Gumlet rejects it, the mobile ladder is built.
    const row = w.db.get(V);
    w.storage.objects.set(row.sourceKey as string, 50_000_000);
    await w.videos.completeUpload(V, STAFF);
    Object.assign(row, { status: 'FAILED' });
    const worker = mobileWorker(w);
    worker.transcoder.run.mockImplementation(async () => ({
      probe: { durationSeconds: 2400, width: 1280, height: 720, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
      renditions: [{ height: 720, width: 1280, bitrateKbps: 2300, playlistKey: 'hls/v_1/720p/index.m3u8', sizeBytes: 20 }],
      hlsPrefix: 'hls/v_1/',
      masterPlaylistKey: 'hls/v_1/master.m3u8',
      thumbnailKey: undefined,
      isEncrypted: true,
    }));
    await worker.runNext();

    expect(w.db.get(V)).toMatchObject({ mobileStatus: 'READY', durationSeconds: 2400 });
    expect(lessonSeconds(w)).toBe(2400);
  });
});

// ---------------------------------------------------------------------------
describe('"new video": the first pipeline to make a lecture playable tells the students, once', () => {
  it('Gumlet FAILED, mobile READY: the mobile pipeline announces it', async () => {
    const w = lecture('failed');

    await encodeForMobile(w);

    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
    expect(w.db.notifications[0]).toMatchObject({
      kind: 'NEW_VIDEO',
      title: 'New video available',
      body: 'Lecture 1 is ready to watch.',
      route: '/lesson/lesson_1',
    });
    expect(w.db.get(V).newVideoAnnouncedAt).toBeInstanceOf(Date);
    // One bulk push for the whole course, not one job per student.
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('keeps the original eligibility: only ACTIVE enrolments of ACTIVE, undeleted accounts in THIS course', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    for (const excluded of ['expired', 'suspended', 'deleted', 'other_course']) {
      expect(told(w)).not.toContain(excluded);
    }
  });

  it('Gumlet becomes READY first: the Gumlet side announces it (it never did before)', async () => {
    const w = lecture('processing');

    await gumletSide(w, { status: 'ready' }).service.sync(V);

    expect(w.db.get(V).status).toBe('READY');
    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
  });

  it('Gumlet first, mobile second: one notification each, not two', async () => {
    const w = lecture('processing');
    await gumletSide(w, { status: 'ready' }).service.sync(V);

    await encodeForMobile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('mobile first, Gumlet second: one notification each, not two', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);
    expect(told(w)).toHaveLength(3);

    await gumletSide(w, { status: 'ready' }).service.sync(V);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('both finish in the same instant, in two processes: the database claim lets exactly one through', async () => {
    const w = lecture('processing');
    const worker = gumletSide(w, { status: 'ready' }).announcer;
    const api = gumletSide(w, { status: 'ready' }).announcer;

    const outcomes = await Promise.all([
      worker.announce(V, 'mobile'),
      api.announce(V, 'gumlet'),
      worker.announce(V, 'mobile'),
    ]);

    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
  });

  it('syncing a lecture that already is READY announces nothing, however often it runs', async () => {
    // READY, and never recorded as announced: what a lecture finished by an
    // older build (or during a rollback) looks like.
    const w = lecture('ready', { newVideoAnnouncedAt: null });
    const gumlet = gumletSide(w, { status: 'ready' });

    await gumlet.service.sync(V);
    await gumlet.service.sync(V);
    await gumlet.service.sync(V);

    expect(told(w)).toEqual([]);
  });

  it('a Gumlet failure announces nothing', async () => {
    const w = lecture('processing');
    await gumletSide(w, { status: 'errored' }).service.sync(V);
    expect(w.db.get(V).status).toBe('FAILED');
    expect(told(w)).toEqual([]);
  });

  it('re-encoding or retrying a lecture that was announced announces nothing', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    expect(told(w)).toHaveLength(3);

    await w.videos.retryMobileProcessing(V, ADMIN, { force: true });
    await mobileWorker(w).runNext();

    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(told(w)).toHaveLength(3);
  });

  it('a lecture with no origin lesson is not announced, and not marked as announced', async () => {
    const w = lecture('failed', { lessonId: null, lesson: null });
    await encodeForMobile(w);
    expect(told(w)).toEqual([]);
    expect(w.db.get(V).newVideoAnnouncedAt).toBeNull();
  });

  it('a deleted video announces nothing', async () => {
    const w = lecture('failed');
    const { announcer } = gumletSide(w, { status: 'ready' });
    w.db.get(V).deletedAt = new Date();
    expect(await announcer.announce(V, 'mobile')).toBe('skipped');
    expect(told(w)).toEqual([]);
  });

  it('the legacy local transcode announces once per file, not once per run', async () => {
    const w = lecture('processing', { drmProvider: null });
    const result = {
      durationSeconds: 1800,
      width: 1920,
      height: 1080,
      hlsPrefix: 'hls/v_1/',
      masterPlaylistKey: 'hls/v_1/master.m3u8',
      isEncrypted: true,
      renditions: [],
    };
    // `markReady` writes with `include`; the fake returns the whole row, lesson included.
    await w.videos.markReady(V, result);
    await w.videos.markReady(V, result);

    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
  });
});

// ---------------------------------------------------------------------------
describe('"new video": old lectures stay quiet', () => {
  it('encoding an old Gumlet-READY lecture for mobile announces nothing - even one never recorded as announced', async () => {
    const w = lecture('ready', { newVideoAnnouncedAt: null });

    await encodeForMobile(w, 'migration');

    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(told(w)).toEqual([]);
    expect(w.pushQueue.jobs.size).toBe(0);
  });

  it('backfilling 200 old lectures sends no notification at all', async () => {
    const rows = Array.from({ length: 200 }, (_v, i) =>
      videoRow({
        id: `old_${i}`,
        lessonId: `lesson_${i}`,
        lesson: { id: `lesson_${i}`, title: `Lecture ${i}`, courseId: 'course_1' },
        lessonLinks: [{ lessonId: `lesson_${i}` }],
        sourceKey: `source/videos/old_${i}/a.mp4`,
        sourceSizeBytes: BigInt(100_000_000),
        status: 'READY',
        gumletAssetId: `asset_${i}`,
        gumletStatus: 'ready',
        durationSeconds: 1795,
        processedAt: new Date('2026-10-20T08:00:00Z'),
        // What the migration writes for a lecture that was already processed.
        newVideoAnnouncedAt: i % 2 === 0 ? new Date('2026-10-20T08:00:00Z') : null,
      }),
    );
    const w = apiProcess({ db: new FakeDb(rows) });
    enrol(w);
    for (const row of rows) w.storage.objects.set(row.sourceKey as string, 100_000_000);

    for (const row of rows) {
      await w.videos.enqueueMobileTranscode({ id: row.id, sourceKey: row.sourceKey as string }, 'migration' as never);
    }
    const worker = mobileWorker(w);
    while (await worker.runNext()) {
      /* the whole backlog */
    }

    expect([...w.db.rows.values()].every((r) => r.mobileStatus === 'READY')).toBe(true);
    expect(w.db.notifications).toHaveLength(0);
    expect(w.pushQueue.jobs.size).toBe(0);
  });

  it('an old lecture the migration marked is not announced when its Gumlet asset is repaired later', async () => {
    // Was playable for weeks on mobile; its Gumlet asset was deleted and is re-created now.
    const w = lecture('failed', {
      mobileStatus: 'READY',
      mobileProcessedAt: new Date('2026-10-20T08:00:00Z'),
      newVideoAnnouncedAt: new Date('2026-10-20T08:00:00Z'),
    });

    await gumletSide(w, { status: 'ready' }).service.sync(V);

    expect(w.db.get(V).status).toBe('READY');
    expect(told(w)).toEqual([]);
  });

  it('a replaced file IS new content: it is announced once when it becomes playable again', async () => {
    const w = lecture('failed', { newVideoAnnouncedAt: new Date('2026-10-20T08:00:00Z') });
    // What `initUpload` does to the row when the file is replaced (asserted in the duration suite).
    Object.assign(w.db.get(V), { newVideoAnnouncedAt: null, durationSeconds: 0, mobileStatus: 'NONE' });

    await encodeForMobile(w);
    await gumletSide(w, { status: 'ready' }).service.sync(V);

    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
  });
});

// ---------------------------------------------------------------------------
describe('"new video": failures and the switch', () => {
  it('a failed notification never fails the job: the ladder stays READY and is not encoded again', async () => {
    const w = lecture('failed');
    w.db.notificationsDown = true;

    const { worker, ran } = await encodeForMobile(w);

    expect(ran?.outcome).toBe('completed');
    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(worker.transcoder.run).toHaveBeenCalledTimes(1);
  });

  it('a notification that could not be written gives the claim back, so the other pipeline can still announce', async () => {
    const w = lecture('processing');
    w.db.notificationsDown = true;
    await encodeForMobile(w);
    expect(told(w)).toEqual([]);
    expect(w.db.get(V).newVideoAnnouncedAt).toBeNull();

    w.db.notificationsDown = false;
    await gumletSide(w, { status: 'ready' }).service.sync(V);

    expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
  });

  it('Redis not answering: the inbox notification is written once and the caller is released', async () => {
    jest.useFakeTimers();
    try {
      const w = lecture('failed');
      w.pushQueue.outage = 'hang'; // BullMQ's `add` never returns while Redis is unreachable
      const { announcer } = gumletSide(w, { status: 'ready' });

      const pending = announcer.announce(V, 'mobile');
      await jest.advanceTimersByTimeAsync(ANNOUNCE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toBe('sent');
      expect(told(w)).toEqual(['student_1', 'student_2', 'student_3']);
      // The claim is kept: a second attempt must not write the inbox rows again.
      expect(await announcer.announce(V, 'gumlet')).toBe('already');
      expect(told(w)).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a database outage during the announcement is swallowed', async () => {
    const w = lecture('failed');
    const { announcer } = gumletSide(w, { status: 'ready' });
    w.db.down = true;
    await expect(announcer.announce(V, 'mobile')).resolves.toBe('failed');
  });

  it('switched off: nothing is sent, and switching it back on does not announce what became playable meanwhile', async () => {
    const w = lecture('processing', {}, { newVideoNotifications: false });

    await encodeForMobile(w);
    expect(told(w)).toEqual([]);
    expect(w.db.get(V).newVideoAnnouncedAt).toBeInstanceOf(Date);

    // Switched back on; the Gumlet side finishes.
    await gumletSide(w, { status: 'ready' }, true).service.sync(V);
    expect(told(w)).toEqual([]);
  });
});
