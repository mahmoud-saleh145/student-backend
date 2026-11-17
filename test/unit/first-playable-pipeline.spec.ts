/**
 * What a lecture owes its students once it can be watched - and when.
 *
 * Two things used to depend on ONE pipeline finishing:
 *
 *   1. THE DURATION. `Lesson.durationSeconds` (what the course total, the
 *      dashboard lecture row and a reused lecture show) was written only by the
 *      Gumlet sync and the legacy transcode. A lecture whose Gumlet side failed
 *      played on mobile and counted as zero.
 *
 *   2. THE "NEW VIDEO" NOTIFICATION. It lived in `markReady()`, which only the
 *      legacy local transcode reaches; nothing on the Gumlet path, and nothing
 *      on the mobile path, sent it.
 *
 * The notification's policy, which the second half of this file pins:
 *
 *   - only for a PUBLISHED lesson (section published, course being served);
 *     a draft's notification waits and goes out when the lesson is published;
 *   - only to students who can open the lecture, and only when it is playable
 *     where they would open it;
 *   - once per student per lecture, whichever pipeline finishes first, however
 *     often anything is retried, and never again when the file is replaced;
 *   - never for a lecture that was processed before this mechanism existed.
 *
 * The code under test is real: VideosService, MobileVideoProcessor,
 * GumletIngestService.sync, LessonsService.update, the reconciler,
 * LessonVideoService, NotificationsService, CourseAccessService and the
 * NewVideoAnnouncer. Only Postgres, Redis, Gumlet and ffmpeg are replaced.
 */
import { CoursesAdminService } from '../../src/modules/courses/courses.admin.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import { DevicesService, storedBuild } from '../../src/modules/devices/devices.service';
import { LessonsService } from '../../src/modules/lessons/lessons.service';
import { MOBILE_DELIVERY_OVERRIDE_KEY } from '../../src/modules/playback/mobile-delivery-override';
import { SectionsService } from '../../src/modules/sections/sections.service';
import { GumletIngestService } from '../../src/modules/videos/gumlet-ingest.service';
import { LessonVideoService } from '../../src/modules/videos/lesson-video.service';
import {
  ANNOUNCE_MOBILE_RECHECK_MS,
  ANNOUNCE_PUBLISH_BATCH,
  ANNOUNCE_STALE_CLAIM_MS,
  ANNOUNCE_TIMEOUT_MS,
  newVideoDedupeKey,
  parseBuild,
} from '../../src/modules/videos/new-video-announcer.service';
import { VideoPipelineReconciler } from '../../src/modules/videos/video-pipeline-reconciler.service';
import {
  ADMIN,
  FakeDb,
  STAFF,
  apiProcess,
  mobileWorker,
  uploadedWorld,
  videoRow,
  type FakeEnrollment,
  type Row,
  type World,
} from './support/pipeline-fakes';

const V = 'v_1';
const HOUR = 3_600_000;

const student = (userId: string, overrides: Partial<FakeEnrollment> = {}): FakeEnrollment => ({
  userId,
  courseId: 'course_1',
  state: 'ACTIVE',
  accessStartsAt: new Date(Date.now() - 30 * 24 * HOUR),
  accessEndsAt: null,
  coversAllSections: true,
  sectionGrants: [],
  user: { status: 'ACTIVE', deletedAt: null },
  ...overrides,
});

/** The students who may open lesson_1 (in section_1 of course_1)... */
const EVERYONE = ['student_1', 'student_2', 'student_3', 'student_4', 'this_section'];
/**
 * ...and, of those, the ones with a phone known to play the mobile stream:
 * student_1 by the build it signed in with (it has never played anything),
 * this_section because the app on it has declared HLS support itself.
 */
const APP_READY = ['student_1', 'this_section'];
/** The first Android build that plays mobile HLS, as configured in these tests. iOS: not configured. */
const MIN_BUILD = { android: 12, ios: null };

/** Five students who must be told, and everyone who must not. */
function enrol(world: World): void {
  world.db.enrollments = [
    student('student_1'),
    student('student_2'),
    student('student_3'),
    student('student_4'),
    // A section-scoped enrolment that includes this lecture's section.
    student('this_section', { coversAllSections: false, sectionGrants: [{ sectionId: 'section_1', codeId: null }] }),
    // --- not eligible -------------------------------------------------------
    student('other_section', { coversAllSections: false, sectionGrants: [{ sectionId: 'section_2', codeId: null }] }),
    student('expired_state', { state: 'EXPIRED' }),
    student('revoked', { state: 'REVOKED' }),
    student('pending_payment', { state: 'PENDING_PAYMENT' }),
    student('window_over', { accessEndsAt: new Date(Date.now() - HOUR) }),
    student('not_started', { accessStartsAt: new Date(Date.now() + HOUR) }),
    student('suspended', { user: { status: 'SUSPENDED', deletedAt: null } }),
    student('deleted', { user: { status: 'ACTIVE', deletedAt: new Date() } }),
    student('other_course', { courseId: 'course_9' }),
  ];
  world.db.devices = [
    // Signed in on an HLS-capable build. Has never requested a single ticket.
    { id: 'd1', userId: 'student_1', platform: 'android', status: 'ACTIVE', appBuild: '12' },
    // An older build, which has only ever been served Gumlet.
    { id: 'd2', userId: 'student_2', platform: 'Android', status: 'ACTIVE', appBuild: '10' },
    // A newer build that played HLS - on a phone that is no longer bound.
    { id: 'd2_old', userId: 'student_2', platform: 'android', status: 'REVOKED', appBuild: '14' },
    // A browser. Not the app, whatever it reports.
    { id: 'd3', userId: 'student_3', platform: 'web', status: 'ACTIVE', appBuild: '12' },
    // A phone that has not signed in since builds were recorded: unknown.
    { id: 'd5', userId: 'student_4', platform: 'android', status: 'ACTIVE', appBuild: null },
    // iOS has no minimum configured here, but this app has declared HLS support itself.
    { id: 'd4', userId: 'this_section', platform: ' iOS ', status: 'ACTIVE', appBuild: null },
  ];
  world.db.tickets = [
    { deviceId: 'd2', delivery: 'gumlet' },
    { deviceId: 'd2_old', delivery: 'hls' },
    { deviceId: 'd3', delivery: 'hls' },
    { deviceId: 'd5', delivery: 'gumlet' },
    { deviceId: 'd4', delivery: 'hls' },
  ];
}

const told = (world: World) => world.db.notifications.map((n) => n.userId as string).sort();
const state = (world: World, id = V) => world.db.get(id).newVideoAnnounceState;
const lessonSeconds = (world: World, id = 'lesson_1') => world.db.lessons.get(id)?.durationSeconds;
const bodyFor = (world: World, userId: string) => world.db.notifications.find((n) => n.userId === userId)?.body;

/** A lecture whose upload was accepted; `gumlet` says how the Gumlet side stands. */
function lecture(
  gumlet: 'failed' | 'processing' | 'ready',
  overrides: Partial<Row> = {},
  parts: Parameters<typeof apiProcess>[0] = {},
): World {
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
    { hlsMinBuild: MIN_BUILD, ...parts },
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
 * answering `asset`, wired to the process's announcer as VideosModule does.
 */
function gumletSide(world: World, asset: { status: string; durationSeconds?: number | null }) {
  return new GumletIngestService(
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
    world.announcer,
  );
}
const gumletBecomes = (world: World, status: 'ready' | 'errored' | 'processing') => gumletSide(world, { status }).sync(V);

/** The real lesson service: publishing a lesson is what releases a held-back notification. */
function lessons(world: World): LessonsService {
  return new LessonsService(
    world.db as never,
    { assertCanManageCourse: jest.fn(async () => undefined) } as never,
    world.courses as never,
    world.audit as never,
    world.announcer,
  );
}
const setLessonStatus = (world: World, status: string) =>
  lessons(world).update('lesson_1', { status }, ADMIN as never);

/** The reconciler's pass, as its timer runs it. */
const reconcile = (world: World) => new VideoPipelineReconciler(world.videos, world.announcer).tick();

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

    await gumletSide(w, { status: 'ready', durationSeconds: 1795 }).sync(V);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', durationSeconds: 1795 });
    expect(lessonSeconds(w)).toBe(1795);
  });

  it('a Gumlet sync that reports no duration cannot erase the one the mobile pipeline measured', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);

    await gumletSide(w, { status: 'ready', durationSeconds: null }).sync(V);

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
});

// ---------------------------------------------------------------------------
describe('published lessons only', () => {
  it('a published lecture becomes playable: every eligible student is told, once', async () => {
    const w = lecture('processing');

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(EVERYONE);
    expect(w.db.notifications[0]).toMatchObject({
      kind: 'NEW_VIDEO',
      title: 'New video available',
      body: 'Lecture 1 is ready to watch.',
      route: '/lesson/lesson_1',
      dedupeKey: newVideoDedupeKey(V, w.db.notifications[0].userId as string),
    });
    expect(state(w)).toBe('DONE');
    // One bulk push for the whole course, not one job per student.
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('a DRAFT lecture becomes playable: nobody is told, and the announcement stays owed', async () => {
    const w = lecture('processing');
    w.db.lessons.get('lesson_1')!.status = 'DRAFT';

    await gumletBecomes(w, 'ready');
    await encodeForMobile(w);
    await reconcile(w);
    await reconcile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
    expect(told(w)).toEqual([]);
    expect(w.pushQueue.jobs.size).toBe(0);
    expect(state(w)).toBe('PENDING');
  });

  it('the draft is published later: the notification goes out then, once', async () => {
    const w = lecture('processing');
    w.db.lessons.get('lesson_1')!.status = 'DRAFT';
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    await setLessonStatus(w, 'PUBLISHED');

    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('DONE');

    // Unpublishing and publishing again is not news.
    await setLessonStatus(w, 'DRAFT');
    await setLessonStatus(w, 'PUBLISHED');
    await reconcile(w);
    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('publishing a draft whose lecture is NOT playable yet tells nobody; it is announced when it becomes playable', async () => {
    const w = lecture('processing');
    w.db.lessons.get('lesson_1')!.status = 'DRAFT';

    await setLessonStatus(w, 'PUBLISHED');
    expect(told(w)).toEqual([]);

    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual(EVERYONE);
  });

  it('editing a published lesson (a rename) announces nothing', async () => {
    const w = lecture('ready', { newVideoAnnounceState: 'DONE', newVideoAnnounceStateAt: new Date() });
    await lessons(w).update('lesson_1', { title: 'Renamed' }, ADMIN as never);
    expect(told(w)).toEqual([]);
  });

  it('a lecture in an unpublished SECTION waits; the reconciler sends it once the section is published', async () => {
    const w = lecture('processing');
    w.db.sections.set('section_1', { id: 'section_1', courseId: 'course_1', status: 'DRAFT', deletedAt: null });

    await gumletBecomes(w, 'ready');
    await reconcile(w);
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');

    w.db.sections.get('section_1')!.status = 'PUBLISHED';
    await reconcile(w);
    expect(told(w)).toEqual(EVERYONE);
  });

  it.each(['DRAFT', 'SUSPENDED', 'ARCHIVED'])('a course that is %s is not being served: the announcement waits', async (status) => {
    const w = lecture('processing');
    w.db.courses.set('course_1', { id: 'course_1', status, deletedAt: null });

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');

    w.db.courses.get('course_1')!.status = 'PUBLISHED';
    await reconcile(w);
    expect(told(w)).toEqual(EVERYONE);
  });

  it('a HIDDEN (unlisted) course still serves its enrolled students, so they are told', async () => {
    const w = lecture('processing');
    w.db.courses.set('course_1', { id: 'course_1', status: 'HIDDEN', deletedAt: null });
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual(EVERYONE);
  });

  it('an archived or deleted lecture is not announced, and stops being owed', async () => {
    const archived = lecture('processing');
    archived.db.lessons.get('lesson_1')!.status = 'ARCHIVED';
    await gumletBecomes(archived, 'ready');
    expect(told(archived)).toEqual([]);
    expect(state(archived)).toBeNull();

    const orphan = lecture('processing', { lessonId: null, lesson: null });
    await gumletBecomes(orphan, 'ready');
    expect(told(orphan)).toEqual([]);
    expect(state(orphan)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('authorised, enrolled recipients only', () => {
  it('tells exactly the students the lesson endpoint would let in', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(EVERYONE);
    for (const excluded of [
      'other_section', // section-scoped enrolment that does not include this section
      'expired_state',
      'revoked',
      'pending_payment',
      'window_over', // ACTIVE on paper, access window ended
      'not_started', // ACTIVE on paper, access window not open yet
      'suspended',
      'deleted',
      'other_course',
    ]) {
      expect(told(w)).not.toContain(excluded);
    }
  });

  it('a student outside the course\'s academic targeting is not told', async () => {
    const w = lecture('processing');
    w.access.targetingEnforced = true;
    jest.spyOn(w.access, 'isTargetedToStudent').mockImplementation(async (userId: string) => userId !== 'student_2');

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(['student_1', 'student_3', 'student_4', 'this_section']);
  });

  it('a lecture reused in another course notifies only its own course', async () => {
    const w = lecture('processing', { lessonLinks: [{ lessonId: 'lesson_1' }, { lessonId: 'lesson_reused' }] });
    w.db.lessons.get('lesson_reused')!.courseId = 'course_9';

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(EVERYONE);
    expect(new Set(w.db.notifications.map((n) => n.route))).toEqual(new Set(['/lesson/lesson_1']));
  });

  it('a course with no eligible student is settled without a notification or a push', async () => {
    const w = lecture('processing');
    w.db.enrollments = [];
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);
    expect(w.pushQueue.jobs.size).toBe(0);
    expect(state(w)).toBe('DONE');
  });

  it('a database failure while checking access is a failure to retry, not "nobody is eligible"', async () => {
    const w = lecture('processing');
    const real = w.db.enrollment.findUnique;
    w.db.enrollment.findUnique = async () => {
      throw new Error('connection reset');
    };

    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');

    w.db.enrollment.findUnique = real;
    await reconcile(w);
    expect(told(w)).toEqual(EVERYONE);
  });
});

// ---------------------------------------------------------------------------
describe('playback availability: nobody is told about a lecture they cannot play', () => {
  it('mobile READY while Gumlet is still PROCESSING: nothing is sent yet', async () => {
    const w = lecture('processing');

    await encodeForMobile(w);
    await reconcile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'PROCESSING', mobileStatus: 'READY' });
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');
  });

  it('...then Gumlet becomes READY: one notification for every platform, to everyone', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(EVERYONE);
    expect(new Set(w.db.notifications.map((n) => n.body))).toEqual(new Set(['Lecture 1 is ready to watch.']));
    expect(state(w)).toBe('DONE');
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('...or Gumlet FAILS: only students whose phone already plays HLS are told, and told "in the mobile app"', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);

    await gumletBecomes(w, 'errored');

    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', mobileStatus: 'READY' });
    expect(told(w)).toEqual(APP_READY);
    expect(bodyFor(w, 'student_1')).toBe('Lecture 1 is now available to watch in the mobile app.');
    expect(w.db.notifications[0].bodyAr).toContain('تطبيق الهاتف');
    // student_2's phone is on an older build, student_3 has no phone, and
    // student_4's phone has not said what it runs.
    expect(state(w)).toBe('MOBILE');
  });

  it('the Gumlet job failing for good (markFailed) releases the same app-only announcement', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);
    expect(told(w)).toEqual([]);

    await w.videos.markFailed(V, 'Gumlet API timeout');

    expect(told(w)).toEqual(APP_READY);
  });

  it('Gumlet had already FAILED when the mobile ladder finished: the app-only announcement goes out at once', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    expect(told(w)).toEqual(APP_READY);
    expect(state(w)).toBe('MOBILE');
  });

  it('Gumlet is repaired afterwards: the students who were NOT told are told then; nobody is told twice', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    expect(told(w)).toEqual(APP_READY);

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(EVERYONE);
    expect(bodyFor(w, 'student_1')).toBe('Lecture 1 is now available to watch in the mobile app.');
    expect(bodyFor(w, 'student_2')).toBe('Lecture 1 is ready to watch.');
    expect(state(w)).toBe('DONE');
    // Two pushes, to two disjoint groups.
    const pushed = [...w.pushQueue.jobs.values()].map((j) => (j.data.userIds as string[]).slice().sort());
    expect(pushed).toEqual([APP_READY, ['student_2', 'student_3', 'student_4']]);
  });

  it('mobile HLS delivery switched to Gumlet and Gumlet FAILED: playable nowhere, so nobody is told', async () => {
    const w = lecture('failed');
    w.redis.store.set(MOBILE_DELIVERY_OVERRIDE_KEY, { delivery: 'gumlet' });

    await encodeForMobile(w);
    await reconcile(w);

    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');
  });

  it('Gumlet fallback off: a Gumlet-READY lecture waits for the app\'s own ladder before "every platform" is claimed', async () => {
    const w = lecture('processing');
    w.redis.store.set(MOBILE_DELIVERY_OVERRIDE_KEY, { delivery: 'hls', gumletFallback: false });

    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    await encodeForMobile(w);
    expect(told(w)).toEqual(EVERYONE);
  });

  it('processing fails on both sides: no notification, nothing owed', async () => {
    const w = lecture('processing');
    await w.videos.enqueueMobileTranscode({ id: V, sourceKey: w.db.get(V).sourceKey as string }, 'upload' as never);
    const worker = mobileWorker(w, {
      encode: () => {
        throw new Error('ffmpeg exited with code 1');
      },
    });
    while (await worker.runNext()) {
      /* every attempt */
    }
    await gumletBecomes(w, 'errored');
    await reconcile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'FAILED', mobileStatus: 'FAILED' });
    expect(told(w)).toEqual([]);
    expect(state(w)).toBeNull();
  });

  it('a Gumlet failure alone (mobile not finished) tells nobody', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'errored');
    expect(told(w)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('exactly one notification per student per lecture', () => {
  it('Gumlet first, mobile second: no duplicate', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'ready');
    await encodeForMobile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('mobile first, Gumlet second: no duplicate', async () => {
    const w = lecture('processing');
    await encodeForMobile(w);
    await gumletBecomes(w, 'ready');
    await reconcile(w);

    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('both completions land in the same instant, in two processes: the database claim lets one dispatch through', async () => {
    const w = lecture('ready', { mobileStatus: 'READY', hlsPrefix: 'hls/v_1/', renditions: [{ height: 720 }] });
    const worker = apiProcess({ db: w.db, redis: w.redis, pushQueue: w.pushQueue, hlsMinBuild: MIN_BUILD });

    const outcomes = await Promise.all([
      w.announcer.onFirstPlayable(V, 'gumlet'),
      worker.announcer.onFirstPlayable(V, 'mobile'),
      w.announcer.settle(V),
      worker.announcer.settle(V),
    ]);

    expect(outcomes.filter((o) => o === 'sent')).toHaveLength(1);
    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('re-syncing, re-encoding and retrying an announced lecture adds nothing', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'ready');
    await encodeForMobile(w);

    await gumletBecomes(w, 'ready');
    await gumletBecomes(w, 'ready');
    await w.videos.retryMobileProcessing(V, ADMIN, { force: true });
    await mobileWorker(w).runNext();
    await reconcile(w);

    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('the legacy local transcode announces once per lecture, not once per run', async () => {
    const w = lecture('processing', { drmProvider: null });
    const result = {
      durationSeconds: 1800,
      width: 1920,
      height: 1080,
      hlsPrefix: 'hls/v_1/',
      masterPlaylistKey: 'hls/v_1/master.m3u8',
      isEncrypted: true,
      renditions: [{ height: 720, width: 1280, bitrateKbps: 2300, playlistKey: 'hls/v_1/720p/index.m3u8' }],
    };
    await w.videos.markReady(V, result);
    await w.videos.markReady(V, result);

    expect(told(w)).toEqual(EVERYONE);
  });
});

// ---------------------------------------------------------------------------
describe('replacing the file of a lecture', () => {
  /** What the dashboard does: a new file for the same lesson. */
  async function replaceFile(w: World) {
    const lessonTable = w.db.lesson;
    const linkTable = w.db.lessonVideo;
    Object.assign(w.db, {
      lesson: {
        ...lessonTable,
        findFirst: async () => ({
          id: 'lesson_1',
          courseId: 'course_1',
          video: { id: V, status: w.db.get(V).status, deletedAt: null, hlsPrefix: 'hls/v_1/', drmProvider: 'gumlet', gumletAssetId: 'asset_1' },
          videoLinks: [{ videoId: V, video: { deletedAt: null } }],
        }),
      },
      lessonVideo: { ...linkTable, count: async () => 0, upsert: async () => ({}) },
    });
    await w.videos.initUpload(
      { lessonId: 'lesson_1', filename: 'new.mp4', contentType: 'video/mp4', sizeBytes: 50_000_000 },
      ADMIN,
    );
    Object.assign(w.db, { lesson: lessonTable, lessonVideo: linkTable });
    const row = w.db.get(V);
    w.storage.objects.set(row.sourceKey as string, 50_000_000);
    await w.videos.completeUpload(V, STAFF);
    // The worker picks the Gumlet job up.
    Object.assign(row, { status: 'PROCESSING', gumletAssetId: 'asset_2', gumletStatus: 'processing' });
  }

  it('an announced lecture is NOT announced again when its file is replaced', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'ready');
    await encodeForMobile(w);
    expect(told(w)).toEqual(EVERYONE);

    await replaceFile(w);
    expect(w.db.get(V)).toMatchObject({ durationSeconds: 0, mobileStatus: 'QUEUED', newVideoAnnounceState: 'DONE' });

    // The new file goes through both pipelines again.
    await gumletBecomes(w, 'ready');
    await mobileWorker(w).runNext();
    await reconcile(w);

    expect(w.db.get(V)).toMatchObject({ status: 'READY', mobileStatus: 'READY' });
    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('a historical lecture (marked by the migration) stays silent when its file is replaced', async () => {
    const w = lecture('ready', { newVideoAnnounceState: 'DONE', newVideoAnnounceStateAt: new Date('2026-10-20T08:00:00Z') });

    await replaceFile(w);
    await gumletBecomes(w, 'ready');
    await mobileWorker(w).runNext();

    expect(told(w)).toEqual([]);
  });

  it('a draft that was never announced, replaced before publishing, is still announced exactly once on publish', async () => {
    const w = lecture('processing');
    w.db.lessons.get('lesson_1')!.status = 'DRAFT';
    await gumletBecomes(w, 'ready');
    expect(state(w)).toBe('PENDING');

    await replaceFile(w);
    expect(state(w)).toBe('PENDING');
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    await setLessonStatus(w, 'PUBLISHED');
    expect(told(w)).toEqual(EVERYONE);
  });

  it('replacing the file forgets the old file\'s duration, so the new recording is measured, not assumed', async () => {
    const w = lecture('ready', { newVideoAnnounceState: 'DONE', newVideoAnnounceStateAt: new Date() });
    w.db.lessons.get('lesson_1')!.durationSeconds = 1795;

    await replaceFile(w);
    expect(w.db.get(V).durationSeconds).toBe(0);
    // The lecture keeps showing the old figure until something measures the new file.
    expect(lessonSeconds(w)).toBe(1795);

    // Gumlet rejects the new file; the mobile ladder is built.
    Object.assign(w.db.get(V), { status: 'FAILED' });
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
    expect(told(w)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('historical lectures stay quiet', () => {
  it('encoding an old Gumlet-READY lecture for mobile announces nothing - even one the migration never marked', async () => {
    const w = lecture('ready', { newVideoAnnounceState: null });

    await encodeForMobile(w, 'migration');
    await reconcile(w);

    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(told(w)).toEqual([]);
    expect(w.pushQueue.jobs.size).toBe(0);
    expect(state(w)).toBeNull();
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
        // Half as the migration leaves them, half as an older build would.
        newVideoAnnounceState: i % 2 === 0 ? 'DONE' : null,
        newVideoAnnounceStateAt: i % 2 === 0 ? new Date('2026-10-20T08:00:00Z') : null,
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
    const pass = await w.announcer.settleDue();

    expect([...w.db.rows.values()].every((r) => r.mobileStatus === 'READY')).toBe(true);
    expect(pass.examined).toBe(0);
    expect(w.db.notifications).toHaveLength(0);
    expect(w.pushQueue.jobs.size).toBe(0);
  });

  it('syncing a lecture that already is READY announces nothing, however often it runs', async () => {
    const w = lecture('ready', { newVideoAnnounceState: null });
    await gumletBecomes(w, 'ready');
    await gumletBecomes(w, 'ready');
    await reconcile(w);
    expect(told(w)).toEqual([]);
    expect(state(w)).toBeNull();
  });

  it('an old lecture the migration marked is not announced when its Gumlet asset is repaired later', async () => {
    // Playable for weeks on mobile; its Gumlet asset was deleted and is re-created now.
    const w = lecture('failed', {
      mobileStatus: 'READY',
      hlsPrefix: 'hls/v_1/',
      renditions: [{ height: 720 }],
      mobileProcessedAt: new Date('2026-10-20T08:00:00Z'),
      newVideoAnnounceState: 'DONE',
      newVideoAnnounceStateAt: new Date('2026-10-20T08:00:00Z'),
    });

    await gumletBecomes(w, 'ready');

    expect(w.db.get(V).status).toBe('READY');
    expect(told(w)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('a failed dispatch is retried safely', () => {
  it('the notification rows cannot be written: the job still completes, and the announcement stays owed', async () => {
    const w = lecture('failed');
    w.db.notificationsDown = true;

    const { worker, ran } = await encodeForMobile(w);

    expect(ran?.outcome).toBe('completed');
    expect(w.db.get(V).mobileStatus).toBe('READY');
    expect(worker.transcoder.run).toHaveBeenCalledTimes(1);
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');
    expect(w.announcer.needsAttention()).toBe(true);
  });

  it('...and the reconciler sends it on its next wake, once', async () => {
    const w = lecture('processing');
    w.db.notificationsDown = true;
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    const reconciler = new VideoPipelineReconciler(w.videos, w.announcer);
    w.db.notificationsDown = false;
    // Woken by the failure this process knows about, not by the background interval.
    await reconciler.tick();
    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('DONE');
    expect(w.announcer.needsAttention()).toBe(false);

    await reconciler.tick();
    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('a failure the process knows about wakes the reconciler early; with nothing owed it stays asleep', async () => {
    const w = lecture('processing');
    const reconciler = new VideoPipelineReconciler(w.videos, w.announcer);
    await reconciler.tick();
    expect(await reconciler.wake(Date.now() + 1000)).toBe(false);

    w.db.notificationsDown = true;
    await gumletBecomes(w, 'ready');
    w.db.notificationsDown = false;

    expect(await reconciler.wake(Date.now() + 1000)).toBe(true);
    expect(told(w)).toEqual(EVERYONE);
  });

  it('the rows were written but recording that failed: the retry writes nothing twice', async () => {
    const w = lecture('processing');
    const realUpdateMany = w.db.video.updateMany;
    let failedOnce = false;
    w.db.video.updateMany = async (args) => {
      if (args.data.newVideoAnnounceState === 'DONE' && !failedOnce) {
        failedOnce = true;
        throw new Error('connection reset');
      }
      return realUpdateMany(args);
    };

    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('PENDING');

    await reconcile(w);

    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('DONE');
    // The push went out with the first write; the retry had nothing new to push.
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('a process died holding the claim: another takes it over after it goes stale, and completes it without duplicates', async () => {
    const w = lecture('ready', {
      newVideoAnnounceState: 'SENDING',
      newVideoAnnounceStateAt: new Date(Date.now() - ANNOUNCE_STALE_CLAIM_MS - 1000),
    });
    // It had written two of the four rows when it died.
    for (const userId of ['student_1', 'student_2']) {
      w.db.notifications.push({ id: `n_${userId}`, userId, kind: 'NEW_VIDEO', body: 'Lecture 1 is ready to watch.', dedupeKey: newVideoDedupeKey(V, userId) });
    }

    await reconcile(w);

    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('DONE');
    const pushed = [...w.pushQueue.jobs.values()].flatMap((j) => j.data.userIds as string[]).sort();
    expect(pushed).toEqual(['student_3', 'student_4', 'this_section']);
  });

  it('a claim that is still fresh belongs to a live process: nobody else touches it', async () => {
    const w = lecture('ready', { newVideoAnnounceState: 'SENDING', newVideoAnnounceStateAt: new Date(Date.now() - 30_000) });

    expect(await w.announcer.settle(V)).toBe('waiting');
    await reconcile(w);

    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('SENDING');
  });

  it('Redis not answering: the rows are written once, the attempt is abandoned and retried; the PUSH is best effort', async () => {
    jest.useFakeTimers();
    try {
      const w = lecture('processing');
      w.pushQueue.outage = 'hang'; // BullMQ's `add` never returns while Redis is unreachable

      const pending = gumletBecomes(w, 'ready');
      await jest.advanceTimersByTimeAsync(ANNOUNCE_TIMEOUT_MS + 1);
      await pending;

      // Durable part: every student has the in-app notification, exactly once.
      expect(told(w)).toEqual(EVERYONE);
      expect(state(w)).toBe('PENDING');

      w.pushQueue.outage = null;
      const retry = reconcile(w);
      await jest.advanceTimersByTimeAsync(ANNOUNCE_TIMEOUT_MS + 1);
      await retry;

      expect(told(w)).toEqual(EVERYONE);
      expect(state(w)).toBe('DONE');
      // Best-effort part: the push that could not be queued is not re-sent by
      // the retry (the rows already exist). Never two pushes; here, none.
      expect(w.pushQueue.jobs.size).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a database outage during the announcement is swallowed and retried later', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'ready'); // sent
    const second = lecture('processing');
    await second.announcer.onFirstPlayable(V, 'gumlet'); // not READY yet: owed, waiting
    second.db.down = true;
    await expect(second.announcer.settle(V)).resolves.toBe('failed');
    await expect(second.announcer.settleForLesson('lesson_1')).resolves.toBeUndefined();
    expect(second.announcer.needsAttention()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('publication is the trigger: publishing a lesson, a section or a course sends at once', () => {
  const manage = { assertCanManageCourse: jest.fn(async () => undefined) };
  const sections = (w: World) =>
    new SectionsService(w.db as never, manage as never, w.courses as never, w.audit as never, w.announcer);
  const coursesAdmin = (w: World) =>
    new CoursesAdminService(
      w.db as never,
      w.courses as never,
      manage as never,
      w.audit as never,
      {} as never,
      {} as never,
      {} as never,
      w.announcer,
    );
  const draftSection = (w: World) =>
    w.db.sections.set('section_1', { id: 'section_1', courseId: 'course_1', status: 'DRAFT', deletedAt: null });
  const draftCourse = (w: World, status = 'DRAFT') =>
    w.db.courses.set('course_1', { id: 'course_1', status, deletedAt: null });

  /** `count` lectures of course_1, all playable and all still waiting to be announced. */
  function waitingLectures(count: number): World {
    const rows = Array.from({ length: count }, (_v, i) =>
      videoRow({
        id: `w_${i}`,
        lessonId: `lesson_${i}`,
        lesson: { id: `lesson_${i}`, title: `Lecture ${i}`, courseId: 'course_1' },
        lessonLinks: [{ lessonId: `lesson_${i}` }],
        sourceKey: `source/videos/w_${i}/a.mp4`,
        status: 'READY',
        gumletAssetId: `asset_${i}`,
        gumletStatus: 'ready',
        newVideoAnnounceState: 'PENDING',
        newVideoAnnounceStateAt: new Date(Date.now() - i * 1000),
      }),
    );
    const w = apiProcess({ db: new FakeDb(rows), hlsMinBuild: MIN_BUILD });
    enrol(w);
    return w;
  }
  const keys = (w: World) => w.db.notifications.map((n) => n.dedupeKey as string);

  it('publishing the SECTION sends inside that request - no reconciler pass involved', async () => {
    const w = lecture('processing');
    draftSection(w);
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    await sections(w).update('section_1', { status: 'PUBLISHED' as never }, ADMIN as never);

    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('DONE');
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('editing a published section (a rename) sends nothing and looks nothing up', async () => {
    const w = lecture('processing');
    await gumletBecomes(w, 'ready');
    const settle = jest.spyOn(w.announcer, 'settleForSection');

    await sections(w).update('section_1', { title: 'Renamed' }, ADMIN as never);

    expect(settle).not.toHaveBeenCalled();
    expect(told(w)).toEqual(EVERYONE);
  });

  it('publishing the COURSE sends inside that request', async () => {
    const w = lecture('processing');
    draftCourse(w);
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    await coursesAdmin(w).publish('course_1', ADMIN as never);

    expect(w.db.courseOf('course_1').status).toBe('PUBLISHED');
    expect(told(w)).toEqual(EVERYONE);
    expect(state(w)).toBe('DONE');
  });

  it.each(['DRAFT', 'SUSPENDED'])('a course going from %s to HIDDEN (unlisted) starts serving its students: sent at once', async (from) => {
    const w = lecture('processing');
    draftCourse(w, from);
    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual([]);

    await coursesAdmin(w).unpublish('course_1', ADMIN as never, 'HIDDEN');

    expect(told(w)).toEqual(EVERYONE);
  });

  it('a course that was already being served (PUBLISHED to HIDDEN, or taken down) triggers nothing', async () => {
    const w = lecture('processing');
    const settle = jest.spyOn(w.announcer, 'settleForCourse');
    await gumletBecomes(w, 'ready');

    await coursesAdmin(w).unpublish('course_1', ADMIN as never, 'HIDDEN');
    await coursesAdmin(w).unpublish('course_1', ADMIN as never, 'DRAFT');

    expect(settle).not.toHaveBeenCalled();
    expect(told(w)).toEqual(EVERYONE);
  });

  it('every lecture is still checked on its own: publishing the section does not release a DRAFT lesson', async () => {
    const w = waitingLectures(2);
    draftSection(w);
    w.db.lessons.get('lesson_1')!.status = 'DRAFT';

    await sections(w).update('section_1', { status: 'PUBLISHED' as never }, ADMIN as never);

    expect(new Set(w.db.notifications.map((n) => n.route))).toEqual(new Set(['/lesson/lesson_0']));
    expect(state(w, 'w_1')).toBe('PENDING');

    await new LessonsService(w.db as never, manage as never, w.courses as never, w.audit as never, w.announcer).update(
      'lesson_1',
      { status: 'PUBLISHED' },
      ADMIN as never,
    );
    expect(w.db.notifications.filter((n) => n.route === '/lesson/lesson_1').map((n) => n.userId).sort()).toEqual(EVERYONE);
  });

  it('publishing the lesson while its section is still a draft sends nothing; publishing the section then does', async () => {
    const w = lecture('processing');
    draftSection(w);
    w.db.lessons.get('lesson_1')!.status = 'DRAFT';
    await gumletBecomes(w, 'ready');

    await setLessonStatus(w, 'PUBLISHED');
    expect(told(w)).toEqual([]);

    await sections(w).update('section_1', { status: 'PUBLISHED' as never }, ADMIN as never);
    expect(told(w)).toEqual(EVERYONE);
  });

  it('a section with a release date in the future waits; the reconciler sends it once the date has passed', async () => {
    const w = lecture('processing');
    w.db.sections.set('section_1', {
      id: 'section_1',
      courseId: 'course_1',
      status: 'PUBLISHED',
      deletedAt: null,
      unlocksAt: new Date(Date.now() + 3_600_000),
    });

    await gumletBecomes(w, 'ready');
    await reconcile(w);
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('PENDING');

    w.db.sections.get('section_1')!.unlocksAt = new Date(Date.now() - 1000);
    await reconcile(w);
    expect(told(w)).toEqual(EVERYONE);
  });

  it('a free preview is not held by the release date or by section-scoped enrolments, as on the lesson endpoint', async () => {
    const w = lecture('processing');
    w.db.lessons.get('lesson_1')!.isPreview = true;
    w.db.sections.set('section_1', {
      id: 'section_1',
      courseId: 'course_1',
      status: 'PUBLISHED',
      deletedAt: null,
      unlocksAt: new Date(Date.now() + 3_600_000),
    });

    await gumletBecomes(w, 'ready');

    // Everyone with live access to the course, including the student whose
    // enrolment covers a different section.
    expect(told(w)).toEqual([...EVERYONE, 'other_section'].sort());
  });

  it('BULK: a course with 40 waiting lectures - a bounded batch in the request, the rest by the reconciler, no duplicates', async () => {
    const w = waitingLectures(40);
    draftCourse(w);
    const gate = jest.spyOn(w.access, 'assertContentAccess');

    await coursesAdmin(w).publish('course_1', ADMIN as never);

    // In the request: the batch, and no more.
    expect(w.db.notifications).toHaveLength(ANNOUNCE_PUBLISH_BATCH * EVERYONE.length);
    expect([...w.db.rows.values()].filter((r) => r.newVideoAnnounceState === 'DONE')).toHaveLength(ANNOUNCE_PUBLISH_BATCH);
    // The access gate was asked once per candidate student, not once per lecture.
    const candidates = w.db.enrollments.filter(
      (e) => e.courseId === 'course_1' && e.state === 'ACTIVE' && e.user.status === 'ACTIVE' && !e.user.deletedAt,
    ).length;
    expect(gate).toHaveBeenCalledTimes(candidates);
    // The rest is flagged, so the reconciler wakes for it without waiting for its background interval.
    expect(w.announcer.needsAttention()).toBe(true);

    const reconciler = new VideoPipelineReconciler(w.videos, w.announcer);
    await reconciler.tick();
    expect(await reconciler.wake(Date.now() + 1000)).toBe(false);

    expect(w.db.notifications).toHaveLength(40 * EVERYONE.length);
    expect(new Set(keys(w)).size).toBe(40 * EVERYONE.length);
    expect([...w.db.rows.values()].every((r) => r.newVideoAnnounceState === 'DONE')).toBe(true);
  });

  it('BULK: the request also stops when its time budget is spent', async () => {
    const w = waitingLectures(10);
    draftCourse(w);
    // Every look at the clock finds 700 ms gone: the 3 s budget ends after a few lectures.
    const realNow = Date.now.bind(Date);
    let skew = 0;
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => realNow() + (skew += 700));
    try {
      await coursesAdmin(w).publish('course_1', ADMIN as never);
    } finally {
      clock.mockRestore();
    }

    const inRequest = w.db.notifications.length / EVERYONE.length;
    expect(inRequest).toBeGreaterThan(0);
    expect(inRequest).toBeLessThan(10);
    expect(w.announcer.needsAttention()).toBe(true);

    await reconcile(w);
    expect(w.db.notifications).toHaveLength(10 * EVERYONE.length);
    expect(new Set(keys(w)).size).toBe(10 * EVERYONE.length);
  });

  it('a publish, the reconciler and a second process all at once: one notification per student', async () => {
    const w = lecture('processing');
    draftSection(w);
    await gumletBecomes(w, 'ready');
    const other = apiProcess({ db: w.db, redis: w.redis, pushQueue: w.pushQueue, hlsMinBuild: MIN_BUILD });
    // The section is published in the database by the time anyone looks.
    w.db.sections.get('section_1')!.status = 'DRAFT';

    await Promise.all([
      sections(w).update('section_1', { status: 'PUBLISHED' as never }, ADMIN as never),
      w.announcer.settleForSection('section_1'),
      other.announcer.settleDue(),
      reconcile(w),
    ]);
    await reconcile(w);

    expect(told(w)).toEqual(EVERYONE);
    expect(w.pushQueue.jobs.size).toBe(1);
  });

  it('nothing waiting in what was published: one query, and nothing else', async () => {
    const w = lecture('ready', { newVideoAnnounceState: 'DONE', newVideoAnnounceStateAt: new Date() });
    draftSection(w);
    const reads = jest.spyOn(w.db.video, 'findFirst');

    await sections(w).update('section_1', { status: 'PUBLISHED' as never }, ADMIN as never);

    expect(reads).not.toHaveBeenCalled();
    expect(told(w)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe('app-only eligibility: what the phone reports, not what the student has played', () => {
  const body = 'Lecture 1 is now available to watch in the mobile app.';

  it('a student who has never played anything is told: their phone signed in on an HLS-capable build', async () => {
    const w = lecture('failed');
    w.db.tickets = []; // nobody has ever requested a ticket of any kind

    await encodeForMobile(w);

    expect(told(w)).toEqual(['student_1']);
    expect(bodyFor(w, 'student_1')).toBe(body);
  });

  it('says where it can be watched, in the title and in the body, in both languages', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);

    expect(w.db.notifications[0]).toMatchObject({
      title: 'New video available in the mobile app',
      titleAr: 'فيديو جديد متاح في تطبيق الهاتف',
      body,
      bodyAr: 'Lecture 1 أصبح متاحًا للمشاهدة في تطبيق الهاتف.',
    });
  });

  it('a phone on a build older than the first HLS build is not told; nor is one whose build is unknown', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);

    expect(told(w)).not.toContain('student_2'); // build 10 < 12
    expect(told(w)).not.toContain('student_4'); // no build recorded, no declaration
  });

  it('a browser, a revoked phone and an account without a phone are not a compatible phone', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);

    // student_3: a web device reporting build 12. student_2: a REVOKED phone on build 14 that played HLS.
    expect(told(w)).toEqual(APP_READY);
  });

  it('an app that has itself declared HLS support counts, even with no minimum configured for its platform', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    expect(told(w)).toContain('this_section'); // iOS: no minimum; the app was issued an HLS ticket
  });

  it('with NO minimum build configured, no phone is vouched for by its build: only declared support counts', async () => {
    const w = lecture('failed', {}, { hlsMinBuild: { android: null, ios: null } });
    await encodeForMobile(w);
    expect(told(w)).toEqual(['this_section']);
    expect(state(w)).toBe('MOBILE');
  });

  it.each(['1.2.3', 'abc', '', '0', '-5'])('a build that is not a plain positive number (%p) is unknown, not assumed', async (build) => {
    const w = lecture('failed');
    w.db.devices.find((d) => d.id === 'd1')!.appBuild = build;
    await encodeForMobile(w);
    expect(told(w)).toEqual(['this_section']);
  });

  it('nobody compatible at all: nothing is sent, nobody is dismissed - the lecture stays owed to everyone', async () => {
    const w = lecture('failed', {}, { hlsMinBuild: { android: null, ios: null } });
    w.db.tickets = [];

    await encodeForMobile(w);
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('MOBILE');

    await gumletBecomes(w, 'ready');
    expect(told(w)).toEqual(EVERYONE);
  });

  it('a held-back student who signs in on a compatible build is told then - once, with the app wording', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    expect(told(w)).toEqual(APP_READY);
    // The app-only announcement went out an hour ago.
    const since = new Date(Date.now() - 3_600_000);
    w.db.get(V).newVideoAnnounceStateAt = since;

    // student_4 opens the updated app and signs in.
    w.db.devices.find((d) => d.id === 'd5')!.appBuild = '12';
    await reconcile(w);

    expect(told(w)).toEqual(['student_1', 'student_4', 'this_section']);
    expect(bodyFor(w, 'student_4')).toBe(body);
    expect(state(w)).toBe('MOBILE');
    // Looking again does not restart the days it is looked at.
    expect(w.db.get(V).newVideoAnnounceStateAt).toEqual(since);

    await reconcile(w);
    await reconcile(w);
    expect(told(w)).toEqual(['student_1', 'student_4', 'this_section']);
  });

  it('looking again with nobody new writes nothing at all', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    const writes = w.db.writes.length;
    const pushes = w.pushQueue.jobs.size;

    await reconcile(w);
    await reconcile(w);

    expect(w.db.writes.length).toBe(writes);
    expect(w.pushQueue.jobs.size).toBe(pushes);
    expect(told(w)).toEqual(APP_READY);
  });

  it('...and only for a few days: after that, the app-only announcement is closed', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    w.db.get(V).newVideoAnnounceStateAt = new Date(Date.now() - ANNOUNCE_MOBILE_RECHECK_MS - 60_000);

    w.db.devices.find((d) => d.id === 'd5')!.appBuild = '12';
    await reconcile(w);

    expect(told(w)).toEqual(APP_READY);
  });

  it('when Gumlet recovers, everyone who was held back is told, and nobody twice', async () => {
    const w = lecture('failed');
    await encodeForMobile(w);
    w.db.devices.find((d) => d.id === 'd5')!.appBuild = '12';
    await reconcile(w);

    await gumletBecomes(w, 'ready');

    expect(told(w)).toEqual(EVERYONE);
    expect(bodyFor(w, 'student_2')).toBe('Lecture 1 is ready to watch.');
    expect(bodyFor(w, 'student_4')).toBe(body);
    expect(state(w)).toBe('DONE');
  });

  it('the access gates still apply to a compatible phone', async () => {
    const w = lecture('failed');
    // A compatible phone belonging to a student whose access window has ended.
    w.db.devices.push({ id: 'd9', userId: 'window_over', platform: 'android', status: 'ACTIVE', appBuild: '20' });
    await encodeForMobile(w);
    expect(told(w)).toEqual(APP_READY);
  });

  it('build numbers are read strictly, and stored only if they look like one', () => {
    expect(parseBuild('12')).toBe(12);
    expect(parseBuild(' 12 ')).toBe(12);
    for (const bad of ['1.2.3', '12a', '', '0', '-1', null, undefined]) expect(parseBuild(bad)).toBeNull();

    expect(storedBuild('12')).toBe('12');
    expect(storedBuild('1.0.2.7')).toBe('1.0.2.7');
    for (const bad of ['', 'abc', '12; DROP TABLE', 'x'.repeat(40), null, undefined]) expect(storedBuild(bad)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('the build a phone reports is recorded when it signs in and when it refreshes its tokens', () => {
  const descriptor = (appBuild: string | null, deviceKey: string | null = 'phone-key-1') =>
    ({
      deviceKey,
      platform: 'android',
      model: 'Pixel 8',
      name: null,
      osVersion: '15',
      appVersion: '1.0.0',
      appBuild,
      integritySuspect: false,
    }) as never;

  /** The real DevicesService over one device row. */
  function devices(row: { id: string; userId: string; deviceKey: string; appBuild: string | null }) {
    const writes: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
    const prisma = {
      device: {
        updateMany: jest.fn(async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const where = args.where as { userId: string; deviceKey: string };
          const mine = where.userId === row.userId && where.deviceKey === row.deviceKey;
          const changed = row.appBuild === null || row.appBuild !== args.data.appBuild;
          if (!mine || !changed) return { count: 0 };
          writes.push(args);
          row.appBuild = args.data.appBuild as string;
          return { count: 1 };
        }),
      },
    };
    const service = Object.create(DevicesService.prototype) as DevicesService;
    Object.assign(service, { prisma });
    return { service, prisma, writes };
  }

  it('an app update is picked up on the next token refresh, without a new sign-in', async () => {
    const row = { id: 'd1', userId: 'student_1', deviceKey: 'phone-key-1', appBuild: '10' };
    const d = devices(row);

    await d.service.noteAppBuild('student_1', descriptor('12'));

    expect(row.appBuild).toBe('12');
    // The write names the caller's own device and nothing else.
    expect(d.writes[0].where).toMatchObject({ userId: 'student_1', deviceKey: 'phone-key-1' });
    expect(d.writes[0].data).toEqual({ appBuild: '12' });
  });

  it('a device that had never reported a build gets one', async () => {
    const row = { id: 'd1', userId: 'student_1', deviceKey: 'phone-key-1', appBuild: null };
    const d = devices(row);
    await d.service.noteAppBuild('student_1', descriptor('12'));
    expect(row.appBuild).toBe('12');
  });

  it('an unchanged build writes nothing', async () => {
    const row = { id: 'd1', userId: 'student_1', deviceKey: 'phone-key-1', appBuild: '12' };
    const d = devices(row);
    await d.service.noteAppBuild('student_1', descriptor('12'));
    expect(d.writes).toHaveLength(0);
  });

  it.each([null, '', 'abc', '12; DROP TABLE devices', 'x'.repeat(40)])('a missing or malformed build header (%p) is not stored and not even queried', async (bad) => {
    const row = { id: 'd1', userId: 'student_1', deviceKey: 'phone-key-1', appBuild: '10' };
    const d = devices(row);
    await d.service.noteAppBuild('student_1', descriptor(bad));
    expect(d.prisma.device.updateMany).not.toHaveBeenCalled();
    expect(row.appBuild).toBe('10');
  });

  it('a request without a device id, or for somebody else\'s device, changes nothing', async () => {
    const row = { id: 'd1', userId: 'student_1', deviceKey: 'phone-key-1', appBuild: '10' };
    const d = devices(row);
    await d.service.noteAppBuild('student_1', descriptor('12', null));
    await d.service.noteAppBuild('student_2', descriptor('12'));
    await d.service.noteAppBuild('student_1', descriptor('12', 'another-phone'));
    expect(row.appBuild).toBe('10');
  });

  it('never throws, whatever the database does', async () => {
    const d = devices({ id: 'd1', userId: 'student_1', deviceKey: 'phone-key-1', appBuild: '10' });
    d.prisma.device.updateMany.mockRejectedValueOnce(new Error('connection reset'));
    await expect(d.service.noteAppBuild('student_1', descriptor('12'))).resolves.toBeUndefined();
  });

  /** The real AuthService.refresh, with the token rotation itself replaced by its result. */
  function refreshWith(devicesDouble: unknown, rotation: () => Promise<unknown>) {
    const auth = Object.create(AuthService.prototype) as AuthService;
    Object.assign(auth, { devices: devicesDouble, rotateRefresh: jest.fn(rotation) });
    return auth;
  }
  const tokens = { user: { id: 'student_1' }, accessToken: 'a', refreshToken: 'r' };

  it('a successful token refresh reports the build the app is running', async () => {
    const noteAppBuild = jest.fn(async () => undefined);
    const auth = refreshWith({ noteAppBuild }, async () => tokens);

    const result = await auth.refresh('old-refresh-token', { device: descriptor('12') } as never);

    expect(result).toBe(tokens);
    expect(noteAppBuild).toHaveBeenCalledWith('student_1', expect.objectContaining({ appBuild: '12' }));
  });

  it('a failed token refresh reports nothing and fails exactly as before', async () => {
    const noteAppBuild = jest.fn(async () => undefined);
    const auth = refreshWith({ noteAppBuild }, async () => {
      throw new Error('SESSION_EXPIRED');
    });

    await expect(auth.refresh('bad', { device: descriptor('12') } as never)).rejects.toThrow('SESSION_EXPIRED');
    expect(noteAppBuild).not.toHaveBeenCalled();
  });

  it('recording the build can neither delay nor fail the refresh', async () => {
    const never = refreshWith({ noteAppBuild: () => new Promise(() => undefined) }, async () => tokens);
    await expect(never.refresh('t', { device: descriptor('12') } as never)).resolves.toBe(tokens);

    const rejects = refreshWith({ noteAppBuild: async () => Promise.reject(new Error('boom')) }, async () => tokens);
    await expect(rejects.refresh('t', { device: descriptor('12') } as never)).resolves.toBe(tokens);

    const throws = refreshWith(
      {
        noteAppBuild: () => {
          throw new Error('boom');
        },
      },
      async () => tokens,
    );
    await expect(throws.refresh('t', { device: descriptor('12') } as never)).resolves.toBe(tokens);

    // A double that predates the method (as many existing tests use).
    const missing = refreshWith({}, async () => tokens);
    await expect(missing.refresh('t', { device: descriptor('12') } as never)).resolves.toBe(tokens);
  });
});

// ---------------------------------------------------------------------------
describe('the switch', () => {
  it('off: nothing is sent, and switching it back on does not announce what became playable meanwhile', async () => {
    const w = lecture('processing', {}, { newVideoNotifications: false });

    await gumletBecomes(w, 'ready');
    await encodeForMobile(w);
    expect(told(w)).toEqual([]);
    expect(state(w)).toBe('DONE');

    // Another process, with the switch on, looks at the same database.
    const on = apiProcess({ db: w.db, redis: w.redis, pushQueue: w.pushQueue });
    await on.announcer.settleDue();
    await on.announcer.settle(V);
    expect(told(w)).toEqual([]);
  });
});
