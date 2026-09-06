import type { INestApplication } from '@nestjs/common';
import {
  AccessDurationType,
  CourseStatus,
  DeviceStatus,
  EnrollmentMethod,
  EnrollmentState,
  PrismaClient,
  UserRole,
} from '@prisma/client';

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
 * Course access, join flow and protected playback, end to end.
 *
 * Spec §94 is the thesis of this file: the mobile app is not trusted. Each
 * test below asks the backend directly for something the app would normally
 * hide, and asserts the backend refuses on its own.
 */

describe('course access', () => {
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

  interface ScenarioOptions {
    courseStatus?: CourseStatus;
    price?: number | null;
    isFree?: boolean;
    accessDurationType?: AccessDurationType;
    accessDurationDays?: number | null;
  }

  async function scenario(options: ScenarioOptions = {}) {
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const student = await createUser(prisma, { role: UserRole.STUDENT });
    await createDevice(prisma, student.id, 'student-device');

    const course = await createCourse(prisma, {
      teacherId: teacher.id,
      status: options.courseStatus ?? CourseStatus.PUBLISHED,
      price: options.price === undefined ? 450 : options.price,
      isFree: options.isFree ?? false,
      accessDurationType: options.accessDurationType ?? AccessDurationType.LIFETIME,
      accessDurationDays: options.accessDurationDays ?? null,
    });

    const session = await login(app, student.phone, 'student-device');
    const firstVideo = course.sections[0]!.lessons[0]!.video!;

    return { teacher, student, course, session, firstVideo };
  }

  // ---------------------------------------------------------------------------
  // Dynamic structure
  // ---------------------------------------------------------------------------

  describe('dynamic sections (spec §17)', () => {
    it('returns exactly the structure configured, in order', async () => {
      const teacher = await createUser(prisma, { role: UserRole.TEACHER });
      const student = await createUser(prisma, { role: UserRole.STUDENT });
      await createDevice(prisma, student.id, 'd');

      const course = await createCourse(prisma, {
        teacherId: teacher.id,
        // Five sections, unevenly sized, with a mid-list "Midterm" — nothing
        // about this shape is inferable from a fixed template.
        sections: [
          { title: 'Unit 1', lessons: 2 },
          { title: 'Unit 2', lessons: 1 },
          { title: 'Midterm', lessons: 4 },
          { title: 'Unit 3', lessons: 1 },
          { title: 'Final Revision', lessons: 3 },
        ],
      });

      await enroll(prisma, student.id, course.id);
      const session = await login(app, student.phone, 'd');

      const response = await http(app)
        .get(`${API}/courses/${course.id}/sections`)
        .set(session.headers)
        .expect(200);

      const sections = response.body.data ?? response.body;

      expect(sections).toHaveLength(5);
      expect(sections.map((s: { title: string }) => s.title)).toEqual([
        'Unit 1',
        'Unit 2',
        'Midterm',
        'Unit 3',
        'Final Revision',
      ]);
      expect(sections[2].lessons).toHaveLength(4);
    });
  });

  // ---------------------------------------------------------------------------
  // Access states
  // ---------------------------------------------------------------------------

  describe('reports the access state the app renders', () => {
    it('NOT_ENROLLED before joining', async () => {
      const { course, session } = await scenario();

      const response = await http(app)
        .get(`${API}/courses/${course.id}`)
        .set(session.headers)
        .expect(200);

      const data = response.body.data ?? response.body;
      expect(data.access.state).toBe('NOT_ENROLLED');
    });

    it('ACTIVE after enrolling', async () => {
      const { course, student, session } = await scenario();
      await enroll(prisma, student.id, course.id);

      const response = await http(app)
        .get(`${API}/courses/${course.id}`)
        .set(session.headers)
        .expect(200);

      expect((response.body.data ?? response.body).access.state).toBe('ACTIVE');
    });

    it('EXPIRED once the window closes, even before the nightly sweep runs', async () => {
      const { course, student, session } = await scenario();

      // Stored state deliberately left ACTIVE — this is the state the sweep
      // has not yet corrected.
      await enroll(prisma, student.id, course.id, {
        state: EnrollmentState.ACTIVE,
        accessEndsAt: new Date(Date.now() - 60_000),
      });

      const response = await http(app)
        .get(`${API}/courses/${course.id}`)
        .set(session.headers)
        .expect(200);

      expect((response.body.data ?? response.body).access.state).toBe('EXPIRED');
    });

    it('ARCHIVED for an archived course', async () => {
      const { course, student, session } = await scenario();
      await enroll(prisma, student.id, course.id);
      await prisma.course.update({
        where: { id: course.id },
        data: { status: CourseStatus.ARCHIVED, archivedAt: new Date() },
      });

      const response = await http(app)
        .get(`${API}/courses/${course.id}`)
        .set(session.headers);

      const body = response.body.data ?? response.body;
      expect(body.access?.state ?? errorCode(response.body)).toMatch(
        /ARCHIVED|COURSE_ARCHIVED/,
      );
    });
  });

  describe('catalogue visibility', () => {
    it('hides draft courses from students', async () => {
      const { course, session } = await scenario({ courseStatus: CourseStatus.DRAFT });

      const list = await http(app)
        .get(`${API}/courses`)
        .set(session.headers)
        .expect(200);

      const items = (list.body.data ?? list.body).items ?? list.body.data;
      expect(
        (items as { id: string }[]).some((c) => c.id === course.id),
      ).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Protected playback — the core of the security requirement
  // ---------------------------------------------------------------------------

  describe('POST /playback/videos/:id/ticket', () => {
    it('issues a short-lived ticket to an enrolled student on a bound device', async () => {
      const { course, student, session, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id);

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({})
        .expect(201);

      const ticket = response.body.data ?? response.body;

      expect(ticket.ticketId).toBeTruthy();
      expect(ticket.manifestUrl).toBeTruthy();
      expect(ticket.ttlSeconds).toBeLessThanOrEqual(600);

      // The mark is composed server-side from the authenticated identity.
      expect(ticket.watermark.primary).toBe(student.fullName);
      expect(ticket.watermark.sessionTag).toBeTruthy();
    });

    it('never returns a permanent or direct media URL', async () => {
      // Spec §34/§35: no public URLs, no direct MP4, nothing that outlives the
      // grant. The ticket body is inspected as a whole, not field by field,
      // because a future addition could reintroduce one.
      const { course, student, session, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id);

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({});

      const body = JSON.stringify(response.body);

      expect(body).not.toMatch(/\.mp4/i);
      expect(body).not.toMatch(/r2\.cloudflarestorage\.com/i);
      expect(body).not.toContain('sourceKey');
    });

    it('refuses a student who is not enrolled', async () => {
      const { session, firstVideo } = await scenario();

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({});

      expect(errorCode(response.body)).toBe('NOT_ENROLLED');
    });

    it('refuses a student whose access expired', async () => {
      const { course, student, session, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id, {
        accessEndsAt: new Date(Date.now() - 1000),
      });

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({});

      expect(errorCode(response.body)).toBe('ACCESS_EXPIRED');
    });

    it('refuses an enrolled student on an unrecognised device', async () => {
      const { course, student, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id);

      // Sign in from a second handset — allowed — then request video.
      const other = await login(app, student.phone, 'a-different-device');

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(other.headers)
        .send({});

      expect(errorCode(response.body)).toBe('DEVICE_NOT_AUTHORIZED');
    });

    it('refuses when the device header is missing entirely', async () => {
      const { course, student, session, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id);

      const headers = { ...session.headers };
      delete headers['X-Device-Id'];

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(headers)
        .send({});

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it('refuses a revoked device', async () => {
      const { course, student, session, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id);
      await prisma.device.updateMany({
        where: { userId: student.id },
        data: { status: DeviceStatus.REVOKED, revokedAt: new Date() },
      });

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({});

      expect(errorCode(response.body)).toBe('DEVICE_NOT_AUTHORIZED');
    });

    it('refuses content from an archived course to an enrolled student', async () => {
      const { course, student, session, firstVideo } = await scenario();
      await enroll(prisma, student.id, course.id);
      await prisma.course.update({
        where: { id: course.id },
        data: { status: CourseStatus.ARCHIVED },
      });

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({});

      expect(errorCode(response.body)).toBe('COURSE_ARCHIVED');
    });

    it('refuses anonymous requests outright', async () => {
      const { firstVideo } = await scenario();

      const response = await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .send({});

      expect(response.status).toBe(401);
    });

    it('records a security event for each refusal', async () => {
      const { session, firstVideo, student } = await scenario();

      await http(app)
        .post(`${API}/playback/videos/${firstVideo.id}/ticket`)
        .set(session.headers)
        .send({});

      const events = await prisma.securityEvent.count({ where: { userId: student.id } });
      expect(events).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Join course
  // ---------------------------------------------------------------------------

  describe('POST /courses/:id/enroll', () => {
    it('enrols immediately into a free course', async () => {
      const { course, session, student } = await scenario({ price: null, isFree: true });
      await prisma.course.update({
        where: { id: course.id },
        data: { enrollmentMethods: [EnrollmentMethod.FREE], isFree: true },
      });

      const response = await http(app)
        .post(`${API}/courses/${course.id}/enroll`)
        .set(session.headers)
        .send({ method: 'FREE' });

      expect(response.status).toBeLessThan(300);

      const enrollment = await prisma.enrollment.findUnique({
        where: { userId_courseId: { userId: student.id, courseId: course.id } },
      });
      expect(enrollment?.state).toBe(EnrollmentState.ACTIVE);
    });

    it('does not grant access to a paid course without payment', async () => {
      const { course, session, student } = await scenario({ price: 450 });

      await http(app)
        .post(`${API}/courses/${course.id}/enroll`)
        .set(session.headers)
        .send({ method: 'PAYMENT' });

      const enrollment = await prisma.enrollment.findUnique({
        where: { userId_courseId: { userId: student.id, courseId: course.id } },
      });

      // Either no enrollment or a pending one — never ACTIVE.
      expect(enrollment?.state ?? EnrollmentState.PENDING_PAYMENT).not.toBe(
        EnrollmentState.ACTIVE,
      );
    });

    it('does not create a second enrollment row on a repeated join', async () => {
      const { course, session, student } = await scenario({ price: null, isFree: true });
      await prisma.course.update({
        where: { id: course.id },
        data: { enrollmentMethods: [EnrollmentMethod.FREE], isFree: true },
      });

      await http(app)
        .post(`${API}/courses/${course.id}/enroll`)
        .set(session.headers)
        .send({ method: 'FREE' });
      await http(app)
        .post(`${API}/courses/${course.id}/enroll`)
        .set(session.headers)
        .send({ method: 'FREE' });

      const count = await prisma.enrollment.count({
        where: { userId: student.id, courseId: course.id },
      });
      expect(count).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Role separation
  // ---------------------------------------------------------------------------

  describe('students cannot reach administrative endpoints', () => {
    it.each([
      ['GET', '/admin/users'],
      ['GET', '/analytics/overview'],
      ['GET', '/audit'],
      ['GET', '/master/overview'],
      ['GET', '/admin/codes'],
    ])('%s %s', async (method, path) => {
      const { session } = await scenario();

      const response = await (http(app) as never as Record<string, Function>)[
        method.toLowerCase()
      ](`${API}${path}`).set(session.headers);

      expect(response.status).toBeGreaterThanOrEqual(403);
    });
  });

  describe('teachers cannot reach another teacher’s course management', () => {
    it('refuses editing a course they are not assigned to', async () => {
      const owner = await createUser(prisma, { role: UserRole.TEACHER });
      const outsider = await createUser(prisma, { role: UserRole.TEACHER });
      const course = await createCourse(prisma, { teacherId: owner.id });

      const session = await login(app, outsider.phone, 'teacher-device');

      const response = await http(app)
        .patch(`${API}/admin/courses/${course.id}`)
        .set(session.headers)
        .send({ title: 'Hijacked' });

      expect(response.status).toBeGreaterThanOrEqual(403);
    });
  });
});
