import type { INestApplication } from '@nestjs/common';
import { CourseStatus, EnrollmentState, MobileVideoStatus, PrismaClient, UserRole } from '@prisma/client';

import {
  API,
  bootstrapTestApp,
  createCourse,
  createDevice,
  createUser,
  enroll,
  errorCode,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

/**
 * Free-preview content of a course that is not on offer, end to end.
 *
 * Four routes hand a lecture or its material to a student, and all four take
 * the "preview" exception of CourseAccessService.assertContentAccess:
 *
 *   GET  /lessons/:id                  - the direct lesson link
 *   GET  /lessons/by-video/:videoId    - the player's lookup
 *   POST /playback/videos/:id/ticket   - a playable grant
 *   GET  /attachments/:id/ticket       - a document download
 *
 * A HIDDEN (unlisted), DRAFT (withdrawn), SUSPENDED (paused) or deleted course
 * must not serve its preview lessons or documents to a student who holds no
 * entitlement - its lesson/attachment ids alone must open nothing, and the
 * refusal must not even confirm which course they belong to.
 *
 * What must keep working is pinned beside it: previews of a PUBLISHED course
 * for students who are not enrolled yet, and an enrolled student of a HIDDEN
 * course playing over the mobile HLS pipeline (the shape of the production
 * Smoke Test 2 lecture).
 *
 * The positive playback cases use the mobile HLS path on purpose: it needs no
 * external DRM provider, so the suite can observe a real ticket being minted
 * rather than only a refusal from a later gate.
 */
describe('preview content of courses that are not on offer', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => {
    ({ app, prisma } = await bootstrapTestApp());
  });

  afterAll(async () => {
    await shutdownTestApp();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  /**
   * One course in `status`, one section, two lectures: the first a free
   * preview (with a preview document), the second ordinary. Both videos carry
   * a READY mobile ladder so a bound phone that declares `hls-aes128` can be
   * handed a real HLS ticket. The student is signed in on a bound iPhone.
   */
  async function scenario(status: CourseStatus) {
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const student = await createUser(prisma, { role: UserRole.STUDENT });
    await createDevice(prisma, student.id, 'student-device');

    const course = await createCourse(prisma, {
      teacherId: teacher.id,
      status,
      sections: [{ title: 'Only section', lessons: 2 }],
    });
    const [previewLesson, lockedLesson] = course.sections[0]!.lessons;

    await prisma.lesson.update({ where: { id: previewLesson!.id }, data: { isPreview: true } });
    for (const l of [previewLesson!, lockedLesson!]) {
      await prisma.video.update({
        where: { id: l.video!.id },
        data: {
          mobileStatus: MobileVideoStatus.READY,
          renditions: {
            create: { height: 480, width: 854, bitrateKbps: 1096, playlistKey: `hls/${l.id}/480p/index.m3u8` },
          },
        },
      });
    }
    const previewDoc = await prisma.attachment.create({
      data: {
        courseId: course.id,
        lessonId: previewLesson!.id,
        title: 'Preview handout',
        objectKey: `attachments/${course.id}/preview-handout.pdf`,
        isPreview: true,
        isProtected: false,
        isDownloadable: true,
      },
    });

    const session = await login(app, student.phone, 'student-device');
    return { course, student, session, previewLesson: previewLesson!, lockedLesson: lockedLesson!, previewDoc };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const lessonDetail = (s: Scenario, lessonId: string) =>
    http(app).get(`${API}/lessons/${lessonId}`).set(s.session.headers);
  const byVideo = (s: Scenario, videoId: string) =>
    http(app).get(`${API}/lessons/by-video/${videoId}`).set(s.session.headers);
  const ticket = (s: Scenario, lesson: Scenario['previewLesson']) =>
    http(app)
      .post(`${API}/playback/videos/${lesson.video!.id}/ticket`)
      .set(s.session.headers)
      .send({ lessonId: lesson.id, capabilities: ['hls-aes128'] });
  const docTicket = (s: Scenario, attachmentId: string) =>
    http(app).get(`${API}/attachments/${attachmentId}/ticket`).set(s.session.headers);

  const ticketsFor = (userId: string) => prisma.playbackTicket.count({ where: { userId } });

  /** The ticket row the response points at was minted for the mobile HLS pipeline. */
  async function expectHlsTicket(res: { body: { data: { ticketId: string; manifestUrl: string } } }) {
    expect(res.body.data.ticketId).toEqual(expect.any(String));
    expect(res.body.data.manifestUrl).toContain(`/playback/manifest/${res.body.data.ticketId}/`);
    const row = await prisma.playbackTicket.findUniqueOrThrow({ where: { id: res.body.data.ticketId } });
    expect(row.delivery).toBe('hls');
  }

  /** All four routes refuse the preview lesson and its document; nothing leaks. */
  async function expectPreviewRefused(s: Scenario, code: string) {
    const responses = [
      await lessonDetail(s, s.previewLesson.id),
      await byVideo(s, s.previewLesson.video!.id),
      await ticket(s, s.previewLesson),
      await docTicket(s, s.previewDoc.id),
    ];
    for (const res of responses) {
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(errorCode(res.body)).toBe(code);
      const raw = JSON.stringify(res.body);
      // Nothing about the course or its content in the refusal.
      expect(raw).not.toContain(s.course.id);
      expect(raw).not.toContain(s.previewLesson.title);
      expect(raw).not.toContain('Preview handout');
      expect(raw).not.toMatch(/ticketId|manifestUrl|"url"/);
    }
    expect(await ticketsFor(s.student.id)).toBe(0);
  }

  describe('refuses a student with no enrolment', () => {
    it.each([CourseStatus.HIDDEN, CourseStatus.DRAFT, CourseStatus.SUSPENDED])(
      'in a %s course: lesson link, by-video, playback ticket and document ticket',
      async (status) => {
        const s = await scenario(status);
        await expectPreviewRefused(s, 'NOT_ENROLLED');
      },
    );

    it('in a deleted course whose lecture rows were left behind', async () => {
      const s = await scenario(CourseStatus.PUBLISHED);
      await prisma.course.update({ where: { id: s.course.id }, data: { deletedAt: new Date() } });

      for (const res of [
        await lessonDetail(s, s.previewLesson.id),
        await byVideo(s, s.previewLesson.video!.id),
        await ticket(s, s.previewLesson),
        await docTicket(s, s.previewDoc.id),
      ]) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(JSON.stringify(res.body)).not.toMatch(/ticketId|manifestUrl|"url"/);
      }
      expect(await ticketsFor(s.student.id)).toBe(0);
    });
  });

  describe('refuses a student whose enrolment does not entitle them', () => {
    it.each([
      ['REVOKED', { state: EnrollmentState.REVOKED }, 'NOT_ENROLLED'],
      ['EXPIRED', { state: EnrollmentState.EXPIRED }, 'ACCESS_EXPIRED'],
      ['PENDING_PAYMENT', { state: EnrollmentState.PENDING_PAYMENT }, 'PAYMENT_REQUIRED'],
    ] as const)('%s in a HIDDEN course', async (_label, overrides, code) => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enroll(prisma, s.student.id, s.course.id, overrides);

      for (const res of [
        await lessonDetail(s, s.previewLesson.id),
        await byVideo(s, s.previewLesson.video!.id),
        await ticket(s, s.previewLesson),
        await docTicket(s, s.previewDoc.id),
      ]) {
        expect(errorCode(res.body)).toBe(code);
      }
      expect(await ticketsFor(s.student.id)).toBe(0);
    });
  });

  describe('keeps what must keep working', () => {
    it('previews of a PUBLISHED course for a student who is not enrolled', async () => {
      const s = await scenario(CourseStatus.PUBLISHED);

      const detail = await lessonDetail(s, s.previewLesson.id).expect(200);
      expect(detail.body.data.id).toBe(s.previewLesson.id);
      const found = await byVideo(s, s.previewLesson.video!.id).expect(200);
      expect(found.body.data.id).toBe(s.previewLesson.id);

      await expectHlsTicket(await ticket(s, s.previewLesson).expect(200));
      expect(await ticketsFor(s.student.id)).toBe(1);

      const doc = await docTicket(s, s.previewDoc.id).expect(200);
      expect(doc.body.data.url).toContain(`uid=${s.student.id}`);

      // ...and still not the lecture that is not a preview.
      expect(errorCode((await lessonDetail(s, s.lockedLesson.id)).body)).toBe('NOT_ENROLLED');
    });

    it('an enrolled student of a HIDDEN course, preview or not, over mobile HLS (Smoke Test 2 shape)', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enroll(prisma, s.student.id, s.course.id);

      for (const lesson of [s.lockedLesson, s.previewLesson]) {
        await lessonDetail(s, lesson.id).expect(200);
        await byVideo(s, lesson.video!.id).expect(200);
        await expectHlsTicket(await ticket(s, lesson).expect(200));
      }
      await docTicket(s, s.previewDoc.id).expect(200);
      expect(await ticketsFor(s.student.id)).toBe(2);
    });

    // Changed by the hidden-course page fix: the course page of a HIDDEN course
    // now opens for the students "My courses" lists it for, and stays closed to
    // everyone else. Full coverage in hidden-course-page.e2e-spec.ts.
    it('the HIDDEN course page opens for its enrolled student, and stays closed to an outsider', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      const outsider = await http(app).get(`${API}/courses/${s.course.id}`).set(s.session.headers);
      expect(errorCode(outsider.body)).toBe('COURSE_NOT_AVAILABLE');

      await enroll(prisma, s.student.id, s.course.id);
      const res = await http(app).get(`${API}/courses/${s.course.id}`).set(s.session.headers).expect(200);
      expect(res.body.data.id).toBe(s.course.id);
    });
  });
});
