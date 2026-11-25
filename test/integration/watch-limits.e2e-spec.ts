import type { INestApplication } from '@nestjs/common';
import { EnrollmentMethod, EnrollmentState, PrismaClient, SectionGrantSource, UserRole } from '@prisma/client';

import { PlaybackService } from '../../src/modules/playback/playback.service';

import {
  API,
  bootstrapTestApp,
  createCourse,
  createUser,
  enroll,
  errorCode,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

/**
 * Video watch-limit management (dashboard "Manage Views" / "Reset All
 * Students' Views"), end to end against a real PostgreSQL.
 *
 * What is pinned here is what a mocked client cannot show: the counting SQL,
 * the per-(student, video) advisory lock under real concurrency, the
 * course-wide single-statement reset and its scope, and that nothing outside
 * `video_play_allowances` (and the audit log) is ever written.
 */
describe('video watch-limit management', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let playback: PlaybackService;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
    playback = app.get(PlaybackService);
  });

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  // ---------------------------------------------------------------------------
  // fixtures
  // ---------------------------------------------------------------------------

  async function staff(role: UserRole) {
    const user = await createUser(prisma, { role, fullName: `Test ${role}` });
    return { user, headers: (await login(app, user.phone, `device-${user.id}`)).headers };
  }

  async function world() {
    const admin = await staff(UserRole.ADMIN);
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const courseA = await createCourse(prisma, { teacherId: teacher.id });
    const courseB = await createCourse(prisma, {
      teacherId: teacher.id,
      sections: [{ title: 'Other course', lessons: 2 }],
    });
    const videosA = courseA.sections.flatMap((s) => s.lessons.map((l) => l.video!.id));
    const videosB = courseB.sections.flatMap((s) => s.lessons.map((l) => l.video!.id));
    return { admin, teacher, courseA, courseB, videosA, videosB };
  }

  /** `counted` plays that count (closed, watched 120 s) and `short` that do not. */
  async function plays(userId: string, videoId: string, counted: number, short = 0) {
    const existing = await prisma.videoPlay.count({ where: { userId, videoId } });
    let n = existing;
    for (let i = 0; i < counted; i += 1) {
      n += 1;
      await prisma.videoPlay.create({
        data: {
          userId,
          videoId,
          attemptNumber: n,
          watchedSeconds: 120,
          closedAt: new Date(),
          startedAt: new Date(Date.now() - 60_000),
        },
      });
    }
    for (let i = 0; i < short; i += 1) {
      n += 1;
      await prisma.videoPlay.create({
        data: { userId, videoId, attemptNumber: n, watchedSeconds: 5, closedAt: new Date(), startedAt: new Date(Date.now() - 60_000) },
      });
    }
  }

  const base = (courseId: string) => `${API}/admin/watch-limits/courses/${courseId}`;
  const overview = (h: Record<string, string>, courseId: string, userId: string) =>
    http(app).get(`${base(courseId)}/students/${userId}`).set(h);
  const change = (h: Record<string, string>, courseId: string, userId: string, videoId: string, body: object) =>
    http(app).post(`${base(courseId)}/students/${userId}/videos/${videoId}`).set(h).send(body);
  const bulk = (h: Record<string, string>, courseId: string, userId: string, body: object) =>
    http(app).post(`${base(courseId)}/students/${userId}/bulk`).set(h).send(body);
  const data = (res: { body: { data?: unknown } }) => (res.body.data ?? res.body) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const rowOf = async (h: Record<string, string>, courseId: string, userId: string, videoId: string) =>
    data(await overview(h, courseId, userId).expect(200)).videos.find((v: { videoId: string }) => v.videoId === videoId);
  const claim = (userId: string, videoId: string) =>
    (playback as unknown as { claimPlay: (u: object, v: string) => Promise<{ id: string }> }).claimPlay(
      { id: userId, role: UserRole.STUDENT, sessionId: null },
      videoId,
    );
  const studentAllowance = (userId: string, videoId: string) => playback.playAllowance(userId, videoId);

  /** Everything the feature must never touch, fingerprinted. */
  async function protectedState() {
    const rows = await prisma.$queryRaw<Array<{ t: string; h: string }>>`
      SELECT 'video_plays' t, md5(coalesce(string_agg(v::text, '|' ORDER BY v.id), '')) h FROM video_plays v
      UNION ALL SELECT 'enrollments', md5(coalesce(string_agg(e::text, '|' ORDER BY e.id), '')) FROM enrollments e
      UNION ALL SELECT 'grants', md5(coalesce(string_agg(g::text, '|' ORDER BY g.id), '')) FROM enrollment_section_grants g
      UNION ALL SELECT 'watch_progress', md5(coalesce(string_agg(w::text, '|' ORDER BY w.id), '')) FROM watch_progress w
      UNION ALL SELECT 'devices', md5(coalesce(string_agg(d::text, '|' ORDER BY d.id), '')) FROM devices d
      UNION ALL SELECT 'videos', md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) FROM videos x
      UNION ALL SELECT 'users', md5(coalesce(string_agg(u.id || u."passwordHash" || u.status, '|' ORDER BY u.id), '')) FROM users u`;
    return Object.fromEntries(rows.map((r) => [r.t, r.h]));
  }

  // ---------------------------------------------------------------------------
  // 1–3: reading the state
  // ---------------------------------------------------------------------------

  it('shows 0/3, 1/3 and 3/3 with allowed, used, remaining and status kept apart', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    await plays(s.id, videosA[1]!, 1, 4); // short plays never count
    await plays(s.id, videosA[2]!, 3);
    await plays(s.id, videosA[3]!, 2);

    const body = data(await overview(admin.headers, courseA.id, s.id).expect(200));
    const by = (id: string) => body.videos.find((v: { videoId: string }) => v.videoId === id);

    expect(by(videosA[0]!)).toMatchObject({ allowedPlays: 3, usedPlays: 0, remainingPlays: 3, status: 'AVAILABLE', customLimit: false });
    expect(by(videosA[1]!)).toMatchObject({ allowedPlays: 3, usedPlays: 1, remainingPlays: 2, status: 'AVAILABLE' });
    expect(by(videosA[3]!)).toMatchObject({ usedPlays: 2, remainingPlays: 1, status: 'NEARLY_EXHAUSTED' });
    expect(by(videosA[2]!)).toMatchObject({ allowedPlays: 3, usedPlays: 3, remainingPlays: 0, status: 'EXHAUSTED' });
    expect(body.summary).toMatchObject({ accessibleVideos: 6, watchedVideos: 3, exhaustedVideos: 1 });
    expect(body.student.id).toBe(s.id);
    expect(body.course.id).toBe(courseA.id);

    await expect(claim(s.id, videosA[2]!)).rejects.toMatchObject({ code: 'VIDEO_WATCH_LIMIT_REACHED' });
  });

  // ---------------------------------------------------------------------------
  // 4–6, 9: per-video actions
  // ---------------------------------------------------------------------------

  it('adds plays to a blocked video, and the student can play again at once', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    await plays(s.id, v, 3);

    const res = data(await change(admin.headers, courseA.id, s.id, v, { action: 'ADD_PLAYS', amount: 2 }).expect(200));
    expect(res.video).toMatchObject({ allowedPlays: 5, usedPlays: 3, remainingPlays: 2, customLimit: true });
    await expect(studentAllowance(s.id, v)).resolves.toEqual({ used: 3, limit: 5, remaining: 2 });

    await claim(s.id, v);
    await prisma.videoPlay.updateMany({ where: { userId: s.id, videoId: v, closedAt: null }, data: { closedAt: new Date(), watchedSeconds: 200 } });
    await claim(s.id, v);
    await prisma.videoPlay.updateMany({ where: { userId: s.id, videoId: v, closedAt: null }, data: { closedAt: new Date(), watchedSeconds: 200 } });
    await expect(claim(s.id, v)).rejects.toMatchObject({ code: 'VIDEO_WATCH_LIMIT_REACHED', details: { used: 5, limit: 5 } });
  });

  it('sets an exact number of remaining plays', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    await plays(s.id, v, 3);

    const five = data(await change(admin.headers, courseA.id, s.id, v, { action: 'SET_REMAINING', amount: 5 }).expect(200));
    expect(five.video).toMatchObject({ allowedPlays: 8, usedPlays: 3, remainingPlays: 5 });
    // Idempotent: the same request again changes nothing.
    const again = data(await change(admin.headers, courseA.id, s.id, v, { action: 'SET_REMAINING', amount: 5 }).expect(200));
    expect(again.affected).toBe(0);
    const zero = data(await change(admin.headers, courseA.id, s.id, v, { action: 'SET_REMAINING', amount: 0 }).expect(200));
    expect(zero.video).toMatchObject({ allowedPlays: 3, remainingPlays: 0, status: 'EXHAUSTED' });
  });

  it('resets one video to 0 used without deleting any play history, and keeps a custom limit', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const [v, other] = [videosA[0]!, videosA[1]!];
    await plays(s.id, v, 3, 2);
    await plays(s.id, other, 3);
    await change(admin.headers, courseA.id, s.id, v, { action: 'ADD_PLAYS', amount: 1 }).expect(200); // allowed 4

    const before = await prisma.videoPlay.count({ where: { userId: s.id } });
    const res = data(await change(admin.headers, courseA.id, s.id, v, { action: 'RESET_USED' }).expect(200));
    expect(res.video).toMatchObject({ allowedPlays: 4, usedPlays: 0, remainingPlays: 4, lifetimePlays: 3 });
    expect(await prisma.videoPlay.count({ where: { userId: s.id } })).toBe(before);
    expect(await rowOf(admin.headers, courseA.id, s.id, other)).toMatchObject({ usedPlays: 3, status: 'EXHAUSTED' });

    // The next play counts as 1 of 4 and keeps its attempt number after the old ones.
    const play = await claim(s.id, v);
    expect((await prisma.videoPlay.findUniqueOrThrow({ where: { id: play.id } })).attemptNumber).toBe(6);
    await expect(studentAllowance(s.id, v)).resolves.toEqual({ used: 1, limit: 4, remaining: 3 });
  });

  it('restores the default limit without touching consumption', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    await plays(s.id, v, 4);
    await change(admin.headers, courseA.id, s.id, v, { action: 'SET_REMAINING', amount: 2 }).expect(200);
    const res = data(await change(admin.headers, courseA.id, s.id, v, { action: 'RESTORE_DEFAULT' }).expect(200));
    expect(res.video).toMatchObject({ allowedPlays: 3, customLimit: false, usedPlays: 4, remainingPlays: 0 });
    expect(await prisma.videoPlayAllowance.count()).toBe(0);
  });

  it('validates amounts and actions', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    for (const body of [
      { action: 'ADD_PLAYS' },
      { action: 'ADD_PLAYS', amount: 0 },
      { action: 'ADD_PLAYS', amount: 101 },
      { action: 'SET_REMAINING', amount: -1 },
      { action: 'DELETE_HISTORY' },
    ]) {
      const res = await change(admin.headers, courseA.id, s.id, v, body);
      expect([400, 422]).toContain(res.status);
    }
    expect(await prisma.videoPlayAllowance.count()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // 7, 10: one student, one course
  // ---------------------------------------------------------------------------

  it('bulk-resets one student in one course only, leaving their other course and other students alone', async () => {
    const { admin, courseA, courseB, videosA, videosB } = await world();
    const s = await createUser(prisma);
    const other = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    await enroll(prisma, s.id, courseB.id);
    await enroll(prisma, other.id, courseA.id);
    for (const v of videosA) await plays(s.id, v, 3);
    await plays(s.id, videosB[0]!, 3);
    await plays(other.id, videosA[0]!, 3);

    const res = data(await bulk(admin.headers, courseA.id, s.id, { action: 'RESET_USED' }).expect(200));
    expect(res).toEqual({ targetVideos: 6, affectedVideos: 6 });
    const again = data(await bulk(admin.headers, courseA.id, s.id, { action: 'RESET_USED' }).expect(200));
    expect(again.affectedVideos).toBe(0);

    const a = data(await overview(admin.headers, courseA.id, s.id).expect(200));
    expect(a.videos.every((v: { usedPlays: number }) => v.usedPlays === 0)).toBe(true);
    expect(data(await overview(admin.headers, courseB.id, s.id).expect(200)).summary.exhaustedVideos).toBe(1);
    expect(await rowOf(admin.headers, courseA.id, other.id, videosA[0]!)).toMatchObject({ usedPlays: 3 });
  });

  it('bulk add and set apply to every accessible video of the course', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    await plays(s.id, videosA[0]!, 3);
    data(await bulk(admin.headers, courseA.id, s.id, { action: 'ADD_PLAYS', amount: 2 }).expect(200));
    let rows = data(await overview(admin.headers, courseA.id, s.id).expect(200)).videos;
    expect(rows.map((r: { remainingPlays: number }) => r.remainingPlays)).toEqual([2, 5, 5, 5, 5, 5]);
    data(await bulk(admin.headers, courseA.id, s.id, { action: 'SET_REMAINING', amount: 1 }).expect(200));
    rows = data(await overview(admin.headers, courseA.id, s.id).expect(200)).videos;
    expect(rows.every((r: { remainingPlays: number }) => r.remainingPlays === 1)).toBe(true);
    data(await bulk(admin.headers, courseA.id, s.id, { action: 'RESTORE_DEFAULT' }).expect(200));
    rows = data(await overview(admin.headers, courseA.id, s.id).expect(200)).videos;
    expect(rows.map((r: { allowedPlays: number }) => r.allowedPlays)).toEqual([3, 3, 3, 3, 3, 3]);
  });

  // ---------------------------------------------------------------------------
  // 11: partial entitlements
  // ---------------------------------------------------------------------------

  it('limits a section-scoped student to the sections they hold', async () => {
    const { admin, courseA } = await world();
    const s = await createUser(prisma);
    const enrollment = await enroll(prisma, s.id, courseA.id);
    const [open, closed] = [courseA.sections[0]!, courseA.sections[2]!];
    await prisma.enrollment.update({ where: { id: enrollment.id }, data: { coversAllSections: false } });
    await prisma.enrollmentSectionGrant.create({ data: { enrollmentId: enrollment.id, sectionId: open.id, source: SectionGrantSource.ADMIN } });

    const body = data(await overview(admin.headers, courseA.id, s.id).expect(200));
    expect(body.summary.accessibleVideos).toBe(open.lessons.length);
    const closedVideo = closed.lessons[0]!.video!.id;
    expect(body.videos.find((v: { videoId: string }) => v.videoId === closedVideo).status).toBe('NO_ACCESS');

    const refused = await change(admin.headers, courseA.id, s.id, closedVideo, { action: 'ADD_PLAYS', amount: 1 });
    expect(refused.status).toBe(409);
    const res = data(await bulk(admin.headers, courseA.id, s.id, { action: 'ADD_PLAYS', amount: 1 }).expect(200));
    expect(res.targetVideos).toBe(open.lessons.length);
    expect(await prisma.videoPlayAllowance.count({ where: { videoId: closedVideo } })).toBe(0);
  });

  it('refuses a student who is not enrolled and a video from another course', async () => {
    const { admin, courseA, videosA, videosB } = await world();
    const s = await createUser(prisma);
    expect((await overview(admin.headers, courseA.id, s.id)).status).toBe(404);
    await enroll(prisma, s.id, courseA.id);
    expect((await change(admin.headers, courseA.id, s.id, videosB[0]!, { action: 'RESET_USED' })).status).toBe(404);
    expect((await change(admin.headers, courseA.id, s.id, videosA[0]!, { action: 'RESET_USED' })).status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 8, 9: the whole course
  // ---------------------------------------------------------------------------

  it('previews, then resets every student of the course on that course only, idempotently', async () => {
    const { admin, courseA, courseB, videosA, videosB } = await world();
    const [s1, s2, s3, outsider] = await Promise.all([createUser(prisma), createUser(prisma), createUser(prisma), createUser(prisma)]);
    for (const s of [s1, s2, s3]) await enroll(prisma, s.id, courseA.id);
    await enroll(prisma, s1.id, courseB.id);
    await enroll(prisma, outsider.id, courseB.id);
    await plays(s1.id, videosA[0]!, 3);
    await plays(s1.id, videosA[1]!, 1, 3);
    await plays(s2.id, videosA[0]!, 2);
    await plays(s1.id, videosB[0]!, 3);
    await plays(outsider.id, videosB[0]!, 3);
    await change(admin.headers, courseA.id, s2.id, videosA[2]!, { action: 'ADD_PLAYS', amount: 4 }).expect(200);

    const preview = data(await http(app).get(`${base(courseA.id)}/reset-preview`).set(admin.headers).expect(200));
    expect(preview).toMatchObject({ enrolledStudents: 3, affectedStudents: 2, affectedVideos: 2, affectedPlayRecords: 6, customLimitsRestored: 0 });

    const refused = await http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({});
    expect([400, 422]).toContain(refused.status);

    const plays0 = await prisma.videoPlay.count();
    const done = data(await http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({ confirm: true }).expect(200));
    expect(done).toMatchObject({ affectedStudents: 2, affectedVideos: 2, affectedPlayRecords: 6 });
    expect(await prisma.videoPlay.count()).toBe(plays0);

    expect(await rowOf(admin.headers, courseA.id, s1.id, videosA[0]!)).toMatchObject({ usedPlays: 0, remainingPlays: 3 });
    expect(await rowOf(admin.headers, courseA.id, s2.id, videosA[2]!)).toMatchObject({ allowedPlays: 7, customLimit: true });
    expect(await rowOf(admin.headers, courseB.id, s1.id, videosB[0]!)).toMatchObject({ usedPlays: 3, status: 'EXHAUSTED' });
    expect(await rowOf(admin.headers, courseB.id, outsider.id, videosB[0]!)).toMatchObject({ usedPlays: 3 });

    const repeat = data(await http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({ confirm: true }).expect(200));
    expect(repeat).toMatchObject({ affectedStudents: 0, affectedPlayRecords: 0 });

    // Restoring the default is opt-in and drops the custom limit.
    const restore = data(
      await http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({ confirm: true, restoreDefault: true }).expect(200),
    );
    expect(restore.customLimitsRestored).toBe(1);
    expect(await rowOf(admin.headers, courseA.id, s2.id, videosA[2]!)).toMatchObject({ allowedPlays: 3, customLimit: false });

    const audits = await prisma.auditLog.findMany({ where: { entity: 'watch_limit', entityId: courseA.id } });
    expect(audits).toHaveLength(3);
    expect(audits[0]!.actorId).toBe(admin.user.id);
    expect(audits[0]!.after).toMatchObject({ adminId: admin.user.id, courseId: courseA.id, affectedRecords: 6 });
  });

  // ---------------------------------------------------------------------------
  // release gate: a video shared with another course is never changed
  // ---------------------------------------------------------------------------

  it('never changes a video that is also used in another course', async () => {
    const { admin, courseA, courseB, videosA } = await world();
    const shared = videosA[0]!;
    // Attach course A's first video to a lecture of course B as well.
    await prisma.lessonVideo.create({ data: { lessonId: courseB.sections[0]!.lessons[0]!.id, videoId: shared } });
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    await enroll(prisma, s.id, courseB.id);
    await plays(s.id, shared, 3);
    await plays(s.id, videosA[1]!, 3);

    const body = data(await overview(admin.headers, courseA.id, s.id).expect(200));
    expect(body.summary.sharedVideos).toBe(1);
    expect(body.videos.find((v: { videoId: string }) => v.videoId === shared).sharedCourses).toBe(1);

    const refused = await change(admin.headers, courseA.id, s.id, shared, { action: 'ADD_PLAYS', amount: 2 });
    expect(refused.status).toBe(409);
    expect(refused.body.error?.details?.reason ?? refused.body.details?.reason).toBe('SHARED_VIDEO');

    const res = data(await bulk(admin.headers, courseA.id, s.id, { action: 'RESET_USED' }).expect(200));
    expect(res.targetVideos).toBe(videosA.length - 1);

    const preview = data(await http(app).get(`${base(courseA.id)}/reset-preview`).set(admin.headers).expect(200));
    expect(preview).toMatchObject({ sharedVideos: 1, affectedVideos: 0 });
    await http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({ confirm: true, restoreDefault: true }).expect(200);

    expect(await prisma.videoPlayAllowance.count({ where: { videoId: shared } })).toBe(0);
    await expect(studentAllowance(s.id, shared)).resolves.toEqual({ used: 3, limit: 3, remaining: 0 });
  });

  // ---------------------------------------------------------------------------
  // 12: who may
  // ---------------------------------------------------------------------------

  it('refuses teachers and students on every endpoint', async () => {
    const { courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const teacher = await staff(UserRole.TEACHER);
    const student = { headers: (await login(app, s.phone, 'device-student')).headers };

    for (const who of [teacher, student]) {
      const calls = [
        overview(who.headers, courseA.id, s.id),
        change(who.headers, courseA.id, s.id, videosA[0]!, { action: 'ADD_PLAYS', amount: 5 }),
        bulk(who.headers, courseA.id, s.id, { action: 'RESET_USED' }),
        http(app).get(`${base(courseA.id)}/reset-preview`).set(who.headers),
        http(app).post(`${base(courseA.id)}/reset`).set(who.headers).send({ confirm: true }),
      ];
      for (const res of await Promise.all(calls)) {
        expect(res.status).toBe(403);
        expect(errorCode(res.body)).toBe('INSUFFICIENT_ROLE');
      }
    }
    expect(await prisma.videoPlayAllowance.count()).toBe(0);
    expect((await http(app).get(`${base(courseA.id)}/reset-preview`)).status).toBe(401);
  });

  it('lets a MASTER account manage limits too', async () => {
    const { courseA } = await world();
    const master = await staff(UserRole.MASTER);
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id, { state: EnrollmentState.EXPIRED, method: EnrollmentMethod.CODE });
    expect((await overview(master.headers, courseA.id, s.id)).status).toBe(200);
  });

  // ---------------------------------------------------------------------------
  // 13: concurrency
  // ---------------------------------------------------------------------------

  it('ten simultaneous claims at 2/3 produce exactly one new play', async () => {
    const { courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    await plays(s.id, v, 2);

    const results = await Promise.allSettled(Array.from({ length: 10 }, () => claim(s.id, v)));
    // One claim opens a play; the others resume that same open play or are
    // refused - none may create a second one.
    expect(await prisma.videoPlay.count({ where: { userId: s.id, videoId: v, closedAt: null } })).toBe(1);
    expect(results.some((r) => r.status === 'fulfilled')).toBe(true);
    await expect(studentAllowance(s.id, v)).resolves.toMatchObject({ used: 3, remaining: 0 });
  });

  it('five simultaneous "add 1" requests add exactly five plays', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    await plays(s.id, v, 3);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => change(admin.headers, courseA.id, s.id, v, { action: 'ADD_PLAYS', amount: 1 })),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await rowOf(admin.headers, courseA.id, s.id, v)).toMatchObject({ allowedPlays: 8, remainingPlays: 5 });
  });

  it('a reset racing a claim never loses or double-grants a play', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const v = videosA[0]!;
    await plays(s.id, v, 2);
    await Promise.allSettled([claim(s.id, v), change(admin.headers, courseA.id, s.id, v, { action: 'SET_REMAINING', amount: 2 })]);
    const row = await rowOf(admin.headers, courseA.id, s.id, v);
    // Whichever landed first, the admin's "2 left" is measured against the
    // count it saw under the lock: either 2 used → 4 allowed → (claim) 3 used,
    // 1 left; or 3 used → 5 allowed → 2 left.
    expect([1, 2]).toContain(row.remainingPlays);
    expect(row.allowedPlays - row.usedPlays).toBe(row.remainingPlays);
  });

  it('a course-wide reset racing live play claims neither double-counts nor loses history', async () => {
    const { admin, courseA, videosA } = await world();
    const students = await Promise.all([createUser(prisma), createUser(prisma), createUser(prisma)]);
    for (const s of students) {
      await enroll(prisma, s.id, courseA.id);
      await plays(s.id, videosA[0]!, 3);
      await plays(s.id, videosA[1]!, 2);
    }
    const rowsBefore = await prisma.videoPlay.count();

    // Every student taps videosA[1] (2/3 used) several times while the reset runs.
    const claims = students.flatMap((s) => Array.from({ length: 4 }, () => claim(s.id, videosA[1]!)));
    const reset = http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({ confirm: true });
    const [resetRes, ...claimResults] = await Promise.allSettled([reset, ...claims]);

    expect(resetRes.status).toBe('fulfilled');
    expect((resetRes as PromiseFulfilledResult<{ status: number }>).value.status).toBe(200);
    // Claims never fail: each student had a play left before and after the reset.
    const refusals = claimResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason as { code?: string; message?: string }).code ?? String(r.reason));
    expect(refusals).toEqual([]);

    for (const s of students) {
      // Concurrent taps collapse into one open play (resume), never more.
      expect(await prisma.videoPlay.count({ where: { userId: s.id, videoId: videosA[1]!, closedAt: null } })).toBe(1);
      // videosA[0] had no concurrent activity: fully reset.
      expect(await rowOf(admin.headers, courseA.id, s.id, videosA[0]!)).toMatchObject({ usedPlays: 0, remainingPlays: 3 });
      // The racing play counts if it started at/after the reset instant, not if before: 0 or 1, never 3.
      const row = await rowOf(admin.headers, courseA.id, s.id, videosA[1]!);
      expect([0, 1]).toContain(row.usedPlays);
      expect(row.lifetimePlays).toBe(3);
    }
    // No history row was removed; exactly one new play per student was added.
    expect(await prisma.videoPlay.count()).toBe(rowsBefore + students.length);
  });

  // ---------------------------------------------------------------------------
  // 15: what must never change
  // ---------------------------------------------------------------------------

  it('never writes play history, progress, enrolments, grants, devices, videos or credentials', async () => {
    const { admin, courseA, videosA } = await world();
    const s = await createUser(prisma);
    await enroll(prisma, s.id, courseA.id);
    const lesson = courseA.sections[0]!.lessons[0]!;
    await prisma.watchProgress.create({
      data: { userId: s.id, lessonId: lesson.id, courseId: courseA.id, positionSeconds: 321, watchedSeconds: 400, completed: true, completedAt: new Date() },
    });
    for (const v of videosA) await plays(s.id, v, 3, 1);

    const before = await protectedState();
    await change(admin.headers, courseA.id, s.id, videosA[0]!, { action: 'ADD_PLAYS', amount: 3 }).expect(200);
    await change(admin.headers, courseA.id, s.id, videosA[1]!, { action: 'SET_REMAINING', amount: 7 }).expect(200);
    await change(admin.headers, courseA.id, s.id, videosA[2]!, { action: 'RESET_USED' }).expect(200);
    await bulk(admin.headers, courseA.id, s.id, { action: 'RESTORE_DEFAULT' }).expect(200);
    await http(app).post(`${base(courseA.id)}/reset`).set(admin.headers).send({ confirm: true, restoreDefault: true }).expect(200);
    expect(await protectedState()).toEqual(before);

    const audit = await prisma.auditLog.findFirst({ where: { entity: 'watch_limit', note: 'WATCH_LIMIT_ADD_PLAYS' } });
    expect(audit?.after).toMatchObject({
      actionType: 'WATCH_LIMIT_ADD_PLAYS',
      adminId: admin.user.id,
      studentId: s.id,
      courseId: courseA.id,
      videoId: videosA[0],
      affectedRecords: 1,
    });
    expect(audit?.before).toMatchObject({ pairs: [{ allowedPlays: 3, usedPlays: 3, remainingPlays: 0 }] });
  });
});
