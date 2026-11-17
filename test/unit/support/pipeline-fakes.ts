import { MobileVideoProcessor } from '../../../src/jobs/processors/mobile-video.processor';
import { VideoProcessor } from '../../../src/jobs/processors/video.processor';
import { CourseAccessService } from '../../../src/modules/courses/course-access.service';
import { NotificationsService } from '../../../src/modules/notifications/notifications.service';
import { NewVideoAnnouncer } from '../../../src/modules/videos/new-video-announcer.service';
import { LessonVideoService } from '../../../src/modules/videos/lesson-video.service';
import { VideosService } from '../../../src/modules/videos/videos.service';

/**
 * Stateful doubles for the video pipeline.
 *
 * The pipeline's guarantees are about ORDER and STATE - what is durable before
 * what, which process may write which field, what a second request finds. A
 * `jest.fn()` that returns `{ count: 1 }` cannot show any of that. So these
 * doubles keep real state: a table of rows that `where` clauses are actually
 * evaluated against, and a queue that really refuses a duplicate job id, the
 * way BullMQ does.
 *
 * The code under test is the REAL `VideosService`, `VideoProcessor` and
 * `MobileVideoProcessor`. Only what is outside the process is replaced:
 * Postgres, Redis/BullMQ, R2, Gumlet and ffmpeg.
 */

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown> & { id: string };

export interface FakeLesson {
  id: string;
  courseId: string;
  title: string;
  durationSeconds: number;
  status: string;
  deletedAt: Date | null;
  sectionId: string;
}

export interface FakeEnrollment {
  userId: string;
  courseId: string;
  state: string;
  /** The access window `CourseAccessService.decide()` evaluates live. */
  accessStartsAt: Date;
  accessEndsAt: Date | null;
  /** false = a section- or part-scoped enrolment, limited to `sectionGrants`. */
  coversAllSections: boolean;
  sectionGrants: { sectionId: string; codeId: string | null }[];
  user: { status: string; deletedAt: Date | null };
}

function matchesField(actual: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object' || expected instanceof Date) {
    if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
    return (actual ?? null) === (expected ?? null);
  }
  const cond = expected as Record<string, unknown>;
  if ('in' in cond) return (cond.in as unknown[]).includes(actual);
  if ('notIn' in cond) return !(cond.notIn as unknown[]).includes(actual);
  if ('not' in cond) return !matchesField(actual, cond.not);
  if ('lt' in cond) return actual instanceof Date && actual.getTime() < (cond.lt as Date).getTime();
  if ('gt' in cond) return actual instanceof Date && actual.getTime() > (cond.gt as Date).getTime();
  throw new Error(`pipeline-fakes: unsupported where operator ${JSON.stringify(expected)}`);
}

export function matches(row: Row, where: Record<string, unknown> | undefined): boolean {
  if (!where) return true;
  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(expected as Record<string, unknown>[]).some((branch) => matches(row, branch))) return false;
      continue;
    }
    if (key === 'AND') {
      if (!(expected as Record<string, unknown>[]).every((branch) => matches(row, branch))) return false;
      continue;
    }
    if (!matchesField(row[key], expected)) return false;
  }
  return true;
}

export function videoRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 'v_1',
    courseId: 'course_1',
    lessonId: 'lesson_1',
    status: 'UPLOADING',
    sourceKey: 'source/videos/v_1/a.mp4',
    sourceSizeBytes: null,
    sourceMimeType: 'video/mp4',
    drmProvider: 'gumlet',
    gumletAssetId: null,
    gumletStatus: null,
    gumletError: null,
    gumletUpdatedAt: null,
    drmVerifiedAt: null,
    processingJobId: null,
    processingError: null,
    processingStartedAt: null,
    processedAt: null,
    hlsPrefix: null,
    masterPlaylistKey: null,
    thumbnailKey: null,
    isEncrypted: false,
    encryptionKeyId: null,
    durationSeconds: 0,
    width: null,
    height: null,
    mobileStatus: 'NONE',
    mobileError: null,
    mobileJobId: null,
    mobileProcessingStartedAt: null,
    mobileProcessedAt: null,
    mobileRequestedAt: null,
    mobileEnqueuedAt: null,
    mobileGeneration: 0,
    mobileTrigger: null,
    newVideoAnnounceState: null,
    newVideoAnnounceStateAt: null,
    deletedAt: null,
    createdAt: new Date('2026-11-16T10:00:00Z'),
    updatedAt: new Date('2026-11-16T10:00:00Z'),
    renditions: [],
    captions: [],
    lesson: { id: 'lesson_1', title: 'Lecture 1', courseId: 'course_1' },
    lessonLinks: [{ lessonId: 'lesson_1' }],
    ...overrides,
  };
}

export class FakeDb {
  readonly rows = new Map<string, Row>();
  /** Every write, in order: which fields each one touched. */
  readonly writes: { id: string; fields: string[] }[] = [];
  /** Set to make every query reject (a database outage). */
  down = false;
  now = () => new Date();

  /** Lectures, by id: what the course list shows a duration from, and whether students can see them. */
  readonly lessons = new Map<string, FakeLesson>();
  /** Sections and courses, by id. Anything not listed is PUBLISHED. */
  readonly sections = new Map<string, { id: string; courseId: string; status: string; deletedAt: Date | null }>();
  readonly courses = new Map<string, { id: string; status: string; deletedAt: Date | null }>();
  /** Course enrolments, with the account each belongs to. */
  enrollments: FakeEnrollment[] = [];
  /** Bound devices, and the playback tickets issued to them. */
  devices: { id: string; userId: string; platform: string; status: string }[] = [];
  tickets: { deviceId: string; delivery: string }[] = [];
  /** Every notification row written, in order. */
  readonly notifications: Row[] = [];
  /** Set to make the notification insert fail (and only that). */
  notificationsDown = false;

  sectionOf(id: string) {
    return this.sections.get(id) ?? { id, courseId: 'course_1', status: 'PUBLISHED', deletedAt: null };
  }
  courseOf(id: string) {
    return this.courses.get(id) ?? { id, status: 'PUBLISHED', deletedAt: null };
  }

  /** A video row as a query with relations returns it: lesson (+section), course, counts. */
  private hydrate(row: Row): Row {
    const lesson = typeof row.lessonId === 'string' ? this.lessons.get(row.lessonId) : undefined;
    return {
      ...row,
      lesson: lesson ? { ...lesson, section: this.sectionOf(lesson.sectionId) } : row.lesson,
      course: this.courseOf(String(row.courseId)),
      _count: { renditions: ((row.renditions as unknown[]) ?? []).length },
    };
  }

  constructor(rows: Row[] = []) {
    for (const row of rows) {
      this.rows.set(row.id, row);
      for (const link of (row.lessonLinks as { lessonId: string }[] | undefined) ?? []) {
        if (!this.lessons.has(link.lessonId)) {
          this.lessons.set(link.lessonId, {
            id: link.lessonId,
            courseId: String(row.courseId),
            title: (row.lesson as { title?: string } | null)?.title ?? link.lessonId,
            durationSeconds: 0,
            status: 'PUBLISHED',
            deletedAt: null,
            sectionId: 'section_1',
          });
        }
      }
    }
  }

  get(id: string): Row {
    const row = this.rows.get(id);
    if (!row) throw new Error(`no row ${id}`);
    return row;
  }

  /** A copy of the named fields, for "this did not change" assertions. */
  snapshot(id: string, fields: string[]): Record<string, unknown> {
    const row = this.get(id);
    return Object.fromEntries(fields.map((f) => [f, row[f]]));
  }

  private guard(): void {
    if (this.down) throw Object.assign(new Error("Can't reach database server"), { code: 'P1001' });
  }

  private apply(row: Row, data: Record<string, unknown>): void {
    const fields: string[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (key === 'renditions') {
        const create = (value as { create?: unknown[] }).create;
        if (create) row.renditions = [...create];
        fields.push(key);
        continue;
      }
      row[key] = value;
      fields.push(key);
    }
    row.updatedAt = this.now();
    this.writes.push({ id: row.id, fields });
  }

  readonly video = {
    // Reads return SNAPSHOTS, as a database does: a caller that reads a row
    // and then writes to it must not see its own write in the copy it holds.
    findFirst: async (args: { where?: Record<string, unknown> }) => {
      this.guard();
      for (const row of this.rows.values()) if (matches(row, args.where)) return this.hydrate(row);
      return null;
    },
    findUniqueOrThrow: async (args: { where: { id: string } }) => {
      this.guard();
      return this.hydrate(this.get(args.where.id));
    },
    findUnique: async (args: { where: { id: string } }) => {
      this.guard();
      const row = this.rows.get(args.where.id);
      return row ? this.hydrate(row) : null;
    },
    findMany: async (args: { where?: Record<string, unknown>; take?: number }) => {
      this.guard();
      const found = [...this.rows.values()].filter((row) => matches(row, args.where)).map((row) => this.hydrate(row));
      return args.take ? found.slice(0, args.take) : found;
    },
    count: async (args: { where?: Record<string, unknown> }) => {
      this.guard();
      return [...this.rows.values()].filter((row) => matches(row, args.where)).length;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      this.guard();
      const row = this.get(args.where.id);
      this.apply(row, args.data);
      return { ...row };
    },
    updateMany: async (args: { where?: Record<string, unknown>; data: Record<string, unknown> }) => {
      this.guard();
      let count = 0;
      for (const row of this.rows.values()) {
        if (!matches(row, args.where)) continue;
        this.apply(row, args.data);
        count += 1;
      }
      return { count };
    },
  };

  readonly videoRendition = {
    deleteMany: async (args: { where: { videoId: string } }) => {
      this.guard();
      const row = this.rows.get(args.where.videoId);
      if (row) row.renditions = [];
      return { count: 0 };
    },
  };

  readonly lessonVideo = {
    findMany: async (args: { where?: { videoId?: string } } = {}) => {
      this.guard();
      const row = args.where?.videoId ? this.rows.get(args.where.videoId) : undefined;
      const links = (row?.lessonLinks as { lessonId: string }[] | undefined) ?? [];
      return links.map((link) => ({
        lessonId: link.lessonId,
        videoId: row!.id,
        lesson: { courseId: this.lessons.get(link.lessonId)?.courseId ?? String(row!.courseId) },
      }));
    },
  };
  readonly lesson = {
    updateMany: async (args: { where: { id: { in: string[] } }; data: { durationSeconds?: number } }) => {
      this.guard();
      let count = 0;
      for (const id of args.where.id.in) {
        const lesson = this.lessons.get(id);
        if (!lesson) continue;
        Object.assign(lesson, args.data);
        count += 1;
      }
      return { count };
    },
    findFirst: async (args: { where: { id: string } }) => {
      this.guard();
      const lesson = this.lessons.get(args.where.id);
      return lesson && !lesson.deletedAt ? { ...lesson } : null;
    },
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      this.guard();
      const lesson = this.lessons.get(args.where.id);
      if (!lesson) throw new Error(`no lesson ${args.where.id}`);
      // Prisma ignores `undefined`: only the fields that were given change.
      for (const [key, value] of Object.entries(args.data)) {
        if (value !== undefined) (lesson as unknown as Record<string, unknown>)[key] = value;
      }
      return { ...lesson };
    },
  };
  readonly course = {
    // CourseAccessService.resolve(): the course, unless it is deleted.
    findFirst: async (args: { where: { id: string } }) => {
      this.guard();
      const course = this.courseOf(args.where.id);
      return course.deletedAt ? null : { ...course, enrollmentMethods: [], isFree: false };
    },
  };
  readonly courseSection = {
    // Sections unlocked by a part the student holds: none in these tests.
    findMany: async () => {
      this.guard();
      return [];
    },
  };
  readonly accessCodeRedemption = {
    count: async () => {
      this.guard();
      return 0;
    },
  };
  readonly device = {
    findMany: async (args: { where: { userId: { in: string[] }; status: string } }) => {
      this.guard();
      return this.devices
        .filter((d) => args.where.userId.in.includes(d.userId) && d.status === args.where.status)
        .map((d) => ({ ...d }));
    },
  };
  readonly playbackTicket = {
    findMany: async (args: { where: { deviceId: { in: string[] }; delivery: string } }) => {
      this.guard();
      const seen = new Set<string>();
      return this.tickets
        .filter((t) => args.where.deviceId.in.includes(t.deviceId) && t.delivery === args.where.delivery)
        .filter((t) => (seen.has(t.deviceId) ? false : (seen.add(t.deviceId), true)))
        .map((t) => ({ deviceId: t.deviceId }));
    },
    updateMany: async () => ({ count: 0 }),
  };
  readonly enrollment = {
    // The one query `notifyCourseStudents` makes, evaluated for real: an
    // ACTIVE enrolment of an ACTIVE, undeleted account.
    findMany: async (args: {
      where: { courseId: string; state: string; user: { status: string; deletedAt: null } };
    }) => {
      this.guard();
      return this.enrollments
        .filter(
          (e) =>
            e.courseId === args.where.courseId &&
            e.state === args.where.state &&
            e.user.status === args.where.user.status &&
            e.user.deletedAt === null,
        )
        .map((e) => ({ userId: e.userId }));
    },
    // CourseAccessService: one student's enrolment on one course, whole.
    findUnique: async (args: { where: { userId_courseId: { userId: string; courseId: string } } }) => {
      this.guard();
      const key = args.where.userId_courseId;
      const found = this.enrollments.find((e) => e.userId === key.userId && e.courseId === key.courseId);
      return found ? { id: `enr_${found.userId}`, ...found } : null;
    },
  };
  readonly notification = {
    findMany: async (args: { where: { dedupeKey: { in: string[] } } }) => {
      this.guard();
      return this.notifications
        .filter((n) => args.where.dedupeKey.in.includes(n.dedupeKey as string))
        .map((n) => ({ dedupeKey: n.dedupeKey }));
    },
    // `dedupeKey` is UNIQUE in the database; `skipDuplicates` is what the
    // service relies on, so the fake enforces the same thing.
    createMany: async (args: { data: Row[]; skipDuplicates?: boolean }) => {
      this.guard();
      if (this.notificationsDown) throw new Error('notifications insert failed');
      let count = 0;
      for (const row of args.data) {
        const taken = row.dedupeKey && this.notifications.some((n) => n.dedupeKey === row.dedupeKey);
        if (taken) {
          if (!args.skipDuplicates) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
          continue;
        }
        this.notifications.push({ ...row });
        count += 1;
      }
      return { count };
    },
  };

  $transaction = async <T>(fn: (tx: FakeDb) => Promise<T>): Promise<T> => fn(this);
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------

export interface FakeJob {
  id: string;
  name: string;
  data: Record<string, unknown>;
  opts: Record<string, unknown>;
  state: 'waiting' | 'prioritized' | 'delayed' | 'active' | 'completed' | 'failed';
  attemptsMade: number;
  progress: number;
  timestamp: number;
}

/**
 * BullMQ's behaviour that the pipeline relies on, and nothing else:
 *   - `add` with an id that already exists is a no-op (same job returned);
 *   - a job with a priority waits in the prioritized set, behind plain ones;
 *   - when Redis is unreachable a command either rejects or never answers.
 */
export class FakeQueue {
  readonly jobs = new Map<string, FakeJob>();
  /** How many times `add` was CALLED (including no-ops and failures). */
  addCalls = 0;
  /** 'reject' = commands fail; 'hang' = commands never answer (BullMQ's real behaviour). */
  outage: null | 'reject' | 'hang' = null;

  constructor(readonly name: string) {}

  private gate<T>(work: () => T): Promise<T> {
    if (this.outage === 'reject') return Promise.reject(new Error('redis unavailable'));
    if (this.outage === 'hang') return new Promise<T>(() => undefined);
    return Promise.resolve().then(work);
  }

  add = (name: string, data: Record<string, unknown>, opts: Record<string, unknown> = {}) => {
    this.addCalls += 1;
    return this.gate(() => {
      const id = String(opts.jobId ?? `auto-${this.jobs.size + 1}`);
      const existing = this.jobs.get(id);
      if (existing) return this.handle(existing);
      const job: FakeJob = {
        id,
        name,
        data,
        opts,
        state: opts.priority ? 'prioritized' : 'waiting',
        attemptsMade: 0,
        progress: 0,
        timestamp: Date.now(),
      };
      this.jobs.set(id, job);
      return this.handle(job);
    });
  };

  getJob = (id: string) => this.gate(() => (this.jobs.has(id) ? this.handle(this.jobs.get(id)!) : undefined));

  getJobCounts = () =>
    this.gate(() => {
      const counts: Record<string, number> = {};
      for (const job of this.jobs.values()) counts[job.state] = (counts[job.state] ?? 0) + 1;
      return counts;
    });

  isPaused = async () => false;
  getJobs = async (states: string[]) => this.inState(...(states as FakeJob['state'][])).map((j) => this.handle(j));

  private handle(job: FakeJob) {
    return {
      id: job.id,
      name: job.name,
      data: job.data,
      opts: job.opts,
      timestamp: job.timestamp,
      getState: () => this.gate(() => (this.jobs.has(job.id) ? job.state : 'unknown')),
      remove: () => this.gate(() => void this.jobs.delete(job.id)),
    };
  }

  // --- test controls --------------------------------------------------------

  inState(...states: FakeJob['state'][]): FakeJob[] {
    return [...this.jobs.values()].filter((job) => states.includes(job.state));
  }

  /** Jobs that are still going to run or are running. */
  live(): FakeJob[] {
    return this.inState('waiting', 'prioritized', 'delayed', 'active');
  }

  /** What a worker would take next: the plain wait list before the prioritized set. */
  next(): FakeJob | null {
    return this.inState('waiting')[0] ?? this.inState('prioritized')[0] ?? null;
  }

  /** Redis lost the job (eviction, flush). */
  lose(id: string): void {
    this.jobs.delete(id);
  }
}

// ---------------------------------------------------------------------------
// The rest of the outside world
// ---------------------------------------------------------------------------

export class FakeStorage {
  /** key -> size. An absent key is an object that is not in the bucket. */
  readonly objects = new Map<string, number>();
  unreachable = false;

  objectSizeStrict = async (_bucket: string, key: string) => {
    if (this.unreachable) throw new Error('connect ETIMEDOUT');
    return this.objects.get(key) ?? null;
  };
  objectSize = async (_bucket: string, key: string) => this.objects.get(key) ?? null;
  exists = async (_bucket: string, key: string) => this.objects.has(key);
  pruneSupersededSources = async () => [];
  presignUpload = async () => ({ uploadUrl: 'https://uploads.example/put', requiredHeaders: {} });
}

export class FakeRedis {
  readonly store = new Map<string, unknown>();
  getJson = async <T>(key: string): Promise<T | null> => (this.store.get(key) as T | undefined) ?? null;
  setJson = async (key: string, value: unknown) => void this.store.set(key, value);
  setJsonPersistent = async (key: string, value: unknown) => void this.store.set(key, value);
  del = async (key: string) => void this.store.delete(key);
}

export const STAFF = { id: 'staff_1', role: 'TEACHER' } as never;
export const ADMIN = { id: 'admin_1', role: 'ADMIN' } as never;

export interface World {
  db: FakeDb;
  storage: FakeStorage;
  redis: FakeRedis;
  /** The original queue: Gumlet ingest jobs. */
  webQueue: FakeQueue;
  mobileQueue: FakeQueue;
  videos: VideosService;
  gumlet: { replaceFailedAsset: jest.Mock; sync: jest.Mock };
  audit: { record: jest.Mock };
  /** The push-delivery queue the real NotificationsService adds to. */
  pushQueue: FakeQueue;
  courses: { recountCourse: jest.Mock };
  /** The real access gate and the real announcer this process uses. */
  access: CourseAccessService;
  announcer: NewVideoAnnouncer;
  notifications: NotificationsService;
}

/**
 * One API process: a real VideosService over the given (possibly shared)
 * database, storage, Redis and queues. Calling it twice with the same parts
 * models two processes, or the same service after a restart.
 */
export function apiProcess(
  parts: Partial<Pick<World, 'db' | 'storage' | 'redis' | 'webQueue' | 'mobileQueue' | 'pushQueue'>> & {
    autoProcess?: boolean;
    withMobileQueue?: boolean;
    /** NEW_VIDEO_NOTIFICATIONS_ENABLED for this process (default on). */
    newVideoNotifications?: boolean;
  } = {},
): World {
  const db = parts.db ?? new FakeDb();
  const storage = parts.storage ?? new FakeStorage();
  const redis = parts.redis ?? new FakeRedis();
  const webQueue = parts.webQueue ?? new FakeQueue('video-processing');
  const mobileQueue = parts.mobileQueue ?? new FakeQueue('mobile-video-processing');
  const gumlet = {
    replaceFailedAsset: jest.fn(async (videoId: string) => {
      // What the real service does to the row: a fresh asset, nothing mobile.
      Object.assign(db.get(videoId), {
        gumletAssetId: 'asset_replacement',
        gumletStatus: 'queued',
        gumletError: null,
        status: 'PROCESSING',
      });
      return { assetId: 'asset_replacement', status: 'queued' };
    }),
    sync: jest.fn(async () => undefined),
  };
  const audit = { record: jest.fn(async () => undefined) };
  const config = {
    getOrThrow: () => ({
      ladder: [480, 720, 1080],
      encryptionEnabled: true,
      workDir: '/tmp/edu-transcode',
      mobile: { delivery: 'hls', gumletFallback: true, autoProcess: parts.autoProcess ?? true },
      newVideoNotifications: parts.newVideoNotifications ?? true,
      drm: {
        enabled: true,
        provider: 'gumlet',
        gumlet: { apiKey: 'test-key', workspaceId: 'ws', orgId: 'org', signSecret: 'test-sign-secret' },
      },
    }),
  };
  // The REAL notification and lecture-duration services over the same fake
  // database, so "who is told" and "which lecture shows which duration" are
  // decided by production code, not by a mock that agrees with the test.
  const pushQueue = parts.pushQueue ?? new FakeQueue('push-delivery');
  const courses = { recountCourse: jest.fn(async (_courseId: string) => undefined) };
  const notifications = new NotificationsService(db as never, pushQueue as never, { get: () => undefined } as never);
  const lessonVideos = new LessonVideoService(db as never, courses as never);
  // The REAL access gate (course state, access window, section-scoped
  // enrolments). Academic targeting needs the whole profile schema; a test
  // that is about it switches it on and answers `isTargetedToStudent` itself.
  const access = new CourseAccessService(db as never, {} as never, {} as never);
  access.targetingEnforced = false;
  const announcer = new NewVideoAnnouncer(db as never, notifications, access, config as never, redis as never);
  const videos = new VideosService(
    db as never,
    storage as never,
    { assertCanManageCourse: jest.fn(async () => undefined), assertTeacherCapability: jest.fn(async () => undefined) } as never,
    courses as never,
    notifications as never,
    audit as never,
    redis as never,
    webQueue as never,
    config as never,
    lessonVideos as never,
    gumlet as never,
    parts.withMobileQueue === false ? undefined : (mobileQueue as never),
    announcer,
  );
  return { db, storage, redis, webQueue, mobileQueue, videos, gumlet, audit, pushQueue, courses, access, announcer, notifications };
}

/** A confirmed upload sitting in the bucket, ready for `completeUpload`. */
export function uploadedWorld(overrides: Partial<Row> = {}, parts: Parameters<typeof apiProcess>[0] = {}): World {
  const row = videoRow(overrides);
  const world = apiProcess({ db: new FakeDb([row]), ...parts });
  if (row.sourceKey) world.storage.objects.set(row.sourceKey as string, 100_000_000);
  return world;
}

// ---------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------

const LADDER_RESULT = (videoId: string) => ({
  probe: { durationSeconds: 1800, width: 1920, height: 1080, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
  renditions: [
    { height: 480, width: 854, bitrateKbps: 900, playlistKey: `hls/${videoId}/480p/index.m3u8`, sizeBytes: 10 },
    { height: 720, width: 1280, bitrateKbps: 2300, playlistKey: `hls/${videoId}/720p/index.m3u8`, sizeBytes: 20 },
  ],
  hlsPrefix: `hls/${videoId}/`,
  masterPlaylistKey: `hls/${videoId}/master.m3u8`,
  thumbnailKey: undefined,
  isEncrypted: true,
});

/** BullMQ's `Job` as a processor sees it, backed by the fake queue's record. */
function jobFor(queue: FakeQueue, job: FakeJob) {
  return {
    id: job.id,
    name: job.name,
    data: job.data,
    opts: job.opts,
    get attemptsMade() {
      return job.attemptsMade;
    },
    updateProgress: async (pct: number) => void (job.progress = pct),
    moveToDelayed: async () => void (job.state = 'delayed'),
  } as never;
}

/**
 * The Docker worker's mobile side: the real MobileVideoProcessor with ffmpeg
 * replaced. `encode` decides what the encode does for a given video.
 */
export function mobileWorker(
  world: World,
  options: {
    encode?: (videoId: string) => Promise<void> | void;
    pause?: { paused: boolean; scope?: 'all' | 'historical'; reason?: string | null };
  } = {},
) {
  const transcoder = {
    preflight: async () => ({
      sourceMissing: false,
      sourceBytes: 100e6,
      budgetBytes: 2e9,
      assessment: { ok: true, freeBytes: 60e9, reservedByOthers: 0, minFreeBytes: 30e9, shortfallBytes: 0 },
    }),
    run: jest.fn(async (params: { videoId: string; onProgress?: (pct: number) => Promise<void> }) => {
      await params.onProgress?.(40);
      await options.encode?.(params.videoId);
      return LADDER_RESULT(params.videoId);
    }),
  };
  const guard = {
    pauseState: async () => ({
      paused: options.pause?.paused ?? false,
      reason: options.pause?.reason ?? null,
      by: null,
      at: null,
      scope: options.pause?.scope ?? 'all',
    }),
    noteActive: jest.fn(),
    noteProgress: jest.fn(),
    noteFinished: jest.fn(),
    noteDeferred: jest.fn(),
  };
  const scheduler = {
    uploadPressure: async () => ({ waiting: 0, ignoredStale: 0, originalQueuePaused: false }),
    acquireEncodeSlot: async () => ({ holder: 'laptop:1', release: async () => undefined }),
  };
  const processor = new MobileVideoProcessor(
    transcoder as never,
    world.videos as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
    guard as never,
    scheduler as never,
  );

  /**
   * Takes the next job and runs it to its end, as BullMQ would: a throw is a
   * failed attempt (retried while attempts remain), a DelayedError leaves the
   * job delayed, a return completes it.
   */
  async function runNext(): Promise<{ job: FakeJob; outcome: 'completed' | 'failed' | 'retry' | 'deferred' } | null> {
    const job = world.mobileQueue.next();
    if (!job) return null;
    job.state = 'active';
    try {
      await processor.process(jobFor(world.mobileQueue, job), 'token');
      job.state = 'completed';
      return { job, outcome: 'completed' };
    } catch (error) {
      if ((error as Error)?.name === 'DelayedError') return { job, outcome: 'deferred' };
      job.attemptsMade += 1;
      const attempts = Number(job.opts.attempts ?? 1);
      if (job.attemptsMade < attempts) {
        job.state = 'waiting';
        return { job, outcome: 'retry' };
      }
      job.state = 'failed';
      return { job, outcome: 'failed' };
    }
  }

  /** Starts the next job and returns before it finishes (for "the worker died mid-encode"). */
  function startNext(): FakeJob | null {
    const job = world.mobileQueue.next();
    if (job) job.state = 'active';
    return job;
  }

  return { processor, transcoder, runNext, startNext, claim: (job: FakeJob) => processor.process(jobFor(world.mobileQueue, job), 'token') };
}

/**
 * The Gumlet side of the worker: the real VideoProcessor, with Gumlet itself
 * replaced by `verdict`. Writes to the row exactly what GumletIngestService
 * writes: Gumlet fields and `status`, never anything mobile.
 */
export function gumletWorker(world: World, verdict: (videoId: string) => 'ready' | 'reject' | 'outage') {
  const ingest = {
    processFromJob: jest.fn(async (videoId: string) => {
      const outcome = verdict(videoId);
      if (outcome === 'outage') throw new Error('Gumlet API timeout');
      if (outcome === 'reject') {
        Object.assign(world.db.get(videoId), {
          gumletAssetId: 'asset_1',
          gumletStatus: 'errored',
          gumletError: 'Gumlet rejected the source: unsupported codec',
        });
        throw new Error('Gumlet rejected the source: unsupported codec');
      }
      Object.assign(world.db.get(videoId), {
        gumletAssetId: 'asset_1',
        gumletStatus: 'ready',
        gumletError: null,
        drmVerifiedAt: new Date(),
        status: 'READY',
        durationSeconds: 1800,
        processedAt: new Date(),
      });
      return { handled: true, status: 'ready', playable: true };
    }),
  };
  const processor = new VideoProcessor(
    {} as never,
    world.videos as never,
    ingest as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
  );

  async function runNext(): Promise<{ job: FakeJob; outcome: 'completed' | 'failed' | 'retry' } | null> {
    const job = world.webQueue.next();
    if (!job) return null;
    job.state = 'active';
    try {
      await processor.process(jobFor(world.webQueue, job));
      job.state = 'completed';
      return { job, outcome: 'completed' };
    } catch {
      job.attemptsMade += 1;
      if (job.attemptsMade < Number(job.opts.attempts ?? 1)) {
        job.state = 'waiting';
        return { job, outcome: 'retry' };
      }
      job.state = 'failed';
      return { job, outcome: 'failed' };
    }
  }

  /** Runs the job through every attempt it has. */
  async function drain(): Promise<void> {
    while (await runNext()) {
      /* until nothing is waiting */
    }
  }

  return { ingest, runNext, drain };
}

/** Fields each pipeline owns. A write outside its own set is a coupling. */
export const GUMLET_FIELDS = [
  'status',
  'gumletAssetId',
  'gumletStatus',
  'gumletError',
  'drmVerifiedAt',
  'processingJobId',
  'processingError',
  'processedAt',
];
export const MOBILE_FIELDS = [
  'mobileStatus',
  'mobileError',
  'mobileJobId',
  'mobileGeneration',
  'mobileRequestedAt',
  'mobileEnqueuedAt',
  'mobileTrigger',
  'mobileProcessingStartedAt',
  'mobileProcessedAt',
  'hlsPrefix',
  'masterPlaylistKey',
];
