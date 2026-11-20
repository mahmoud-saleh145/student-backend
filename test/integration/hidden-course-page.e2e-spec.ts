import type { INestApplication } from '@nestjs/common';
import {
  CourseStatus,
  EnrollmentMethod,
  EnrollmentState,
  PartEntitlementSource,
  PartPricingModel,
  PrismaClient,
  SectionGrantSource,
  UserRole,
} from '@prisma/client';

import {
  API,
  bootstrapTestApp,
  createCourse,
  createDevice,
  createUser,
  errorCode,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

/**
 * The course page of a HIDDEN (unlisted) course, end to end.
 *
 * HIDDEN means "off the catalogue for new students, unchanged for those already
 * in" (CourseAccessService.decide). The lesson link, the player lookup and the
 * playback ticket have always followed that rule, but the course page, its
 * outline, its documents and its parts refused the course to every student -
 * enrolled ones included - while `GET /courses/mine` kept listing it. On a phone
 * that is a course in "My courses" that answers "this course is not currently
 * available" when tapped (production, 2026-11-19, Smoke Test 2).
 *
 * Two things are tested separately, on purpose:
 *
 *   VISIBILITY - may this student open the page at all? For a HIDDEN course:
 *   exactly the students "My courses" lists it for. Nobody else: not an
 *   outsider, not a signed-out visitor, not a revoked student.
 *
 *   CONTENT - what does the page unlock? Unchanged: the same decision the lesson
 *   and document gates apply, per enrolment state and per section scope. The
 *   page's `locked` flags must agree with those gates, so a student is never
 *   shown as open what the gate then refuses.
 *
 * Discovery and joining stay closed for a HIDDEN course; DRAFT and SUSPENDED
 * stay closed entirely.
 */
describe('the course page of a HIDDEN course', () => {
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
   * One course in `status`, priced, with two parts:
   *   section A (part 1): a free-preview lecture and an ordinary lecture
   *   section B (part 2): one ordinary lecture
   * and four documents: a course-wide handout, a section-B handout, a document
   * on the ordinary lecture of A, and a preview document on the preview lecture.
   * The student is signed in on a bound device.
   */
  async function scenario(status: CourseStatus) {
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const student = await createUser(prisma, { role: UserRole.STUDENT });
    await createDevice(prisma, student.id, 'student-device');

    const course = await createCourse(prisma, {
      teacherId: teacher.id,
      status,
      price: 100,
      enrollmentMethods: [EnrollmentMethod.CODE],
      sections: [
        { title: 'Section A', lessons: 2 },
        { title: 'Section B', lessons: 1 },
      ],
    });
    const [sectionA, sectionB] = course.sections;
    const [previewLesson, lessonA] = sectionA!.lessons;
    const [lessonB] = sectionB!.lessons;
    await prisma.lesson.update({ where: { id: previewLesson!.id }, data: { isPreview: true } });

    const part1 = await prisma.coursePart.create({
      data: {
        courseId: course.id,
        title: 'Part 1',
        sortOrder: 1,
        pricingModel: PartPricingModel.PERCENTAGE,
        pricePercent: 60,
        sections: { connect: { id: sectionA!.id } },
      },
    });
    const part2 = await prisma.coursePart.create({
      data: {
        courseId: course.id,
        title: 'Part 2',
        sortOrder: 2,
        pricingModel: PartPricingModel.PERCENTAGE,
        pricePercent: 40,
        sections: { connect: { id: sectionB!.id } },
      },
    });

    const doc = (data: { title: string; lessonId?: string; sectionId?: string; isPreview?: boolean }) =>
      prisma.attachment.create({
        data: {
          courseId: course.id,
          lessonId: data.lessonId ?? null,
          sectionId: data.sectionId ?? null,
          title: data.title,
          objectKey: `attachments/${course.id}/${data.title.replace(/\W+/g, '-')}.pdf`,
          isPreview: data.isPreview ?? false,
          isProtected: false,
          isDownloadable: true,
        },
      });
    const courseDoc = await doc({ title: 'Course handout' });
    const sectionBDoc = await doc({ title: 'Section B handout', sectionId: sectionB!.id });
    const lessonADoc = await doc({ title: 'Lesson A notes', lessonId: lessonA!.id });
    const previewDoc = await doc({ title: 'Preview notes', lessonId: previewLesson!.id, isPreview: true });

    const session = await login(app, student.phone, 'student-device');
    return {
      course,
      student,
      session,
      sectionA: sectionA!,
      sectionB: sectionB!,
      previewLesson: previewLesson!,
      lessonA: lessonA!,
      lessonB: lessonB!,
      part1,
      part2,
      courseDoc,
      sectionBDoc,
      lessonADoc,
      previewDoc,
    };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /** A whole-course enrolment in `state`. */
  const enrolWhole = (s: Scenario, state: EnrollmentState) =>
    prisma.enrollment.create({
      data: {
        userId: s.student.id,
        courseId: s.course.id,
        state,
        method: EnrollmentMethod.CODE,
        accessStartsAt: new Date(Date.now() - 60_000),
      },
    });

  /** What a part-1 card redemption leaves behind: section A only. */
  async function enrolPart1(s: Scenario) {
    await prisma.enrollment.create({
      data: {
        userId: s.student.id,
        courseId: s.course.id,
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: false,
        accessStartsAt: new Date(Date.now() - 60_000),
        sectionGrants: {
          create: [{ sectionId: s.sectionA.id, source: SectionGrantSource.CODE, partId: s.part1.id }],
        },
      },
    });
    await prisma.coursePartEntitlement.create({
      data: {
        userId: s.student.id,
        coursePartId: s.part1.id,
        courseId: s.course.id,
        source: PartEntitlementSource.CODE,
      },
    });
  }

  const as = (s: Scenario, path: string) => http(app).get(`${API}${path}`).set(s.session.headers);
  const page = (s: Scenario) => as(s, `/courses/${s.course.id}`);
  const outline = (s: Scenario) => as(s, `/courses/${s.course.id}/sections`);
  const documents = (s: Scenario) => as(s, `/courses/${s.course.id}/attachments`);
  const parts = (s: Scenario) => as(s, `/courses/${s.course.id}/parts`);
  const joinOptions = (s: Scenario) => as(s, `/courses/${s.course.id}/join-options`);
  const mine = (s: Scenario) => as(s, `/courses/mine`);
  const lessonLink = (s: Scenario, lessonId: string) => as(s, `/lessons/${lessonId}`);
  const docTicket = (s: Scenario, attachmentId: string) => as(s, `/attachments/${attachmentId}/ticket`);

  const ids = (body: { data: { items?: Array<{ id: string }> } | Array<{ id: string }> }) => {
    const data = body.data as { items?: Array<{ id: string }> } | Array<{ id: string }>;
    return (Array.isArray(data) ? data : (data.items ?? [])).map((c) => c.id);
  };

  type LessonView = { id: string; locked: boolean };
  type SectionView = { id: string; locked: boolean; lessons: LessonView[] };
  type DocView = { id: string; title: string; locked: boolean };

  const lessonsOf = (sections: SectionView[]) => new Map(sections.flatMap((x) => x.lessons).map((l) => [l.id, l.locked]));
  const sectionsOf = (sections: SectionView[]) => new Map(sections.map((x) => [x.id, x.locked]));
  const docsOf = (docs: DocView[]) => new Map(docs.map((d) => [d.id, d.locked]));

  /** Every route that renders the course page answers 200 and lists the whole structure. */
  async function expectPageOpens(s: Scenario) {
    const detail = await page(s);
    expect({ status: detail.status, code: errorCode(detail.body) }).toEqual({ status: 200, code: undefined });
    expect(detail.body.data.id).toBe(s.course.id);
    expect(detail.body.data.sections).toHaveLength(2);
    expect(detail.body.data.attachments).toHaveLength(4);

    const sections = await outline(s);
    expect(sections.status).toBe(200);
    expect(sections.body.data).toHaveLength(2);

    const docs = await documents(s);
    expect(docs.status).toBe(200);
    expect(docs.body.data).toHaveLength(4);

    const p = await parts(s);
    expect(p.status).toBe(200);
    expect(p.body.data.parts).toHaveLength(2);

    // The section accordion's and the lecture's own document lists.
    const sectionBDocs = await as(s, `/sections/${s.sectionB.id}/attachments`);
    expect(sectionBDocs.status).toBe(200);
    const lessonADocs = await as(s, `/lessons/${s.lessonA.id}/attachments`);
    expect(lessonADocs.status).toBe(200);
    const previewDocs = await as(s, `/lessons/${s.previewLesson.id}/attachments`);
    expect(previewDocs.status).toBe(200);

    // No document list ever carries where the file lives - only its metadata.
    for (const raw of [detail.body, docs.body, sectionBDocs.body, lessonADocs.body, previewDocs.body].map((b) => JSON.stringify(b))) {
      expect(raw).not.toMatch(/objectKey|"url"|attachments\//);
    }

    return {
      detail: detail.body.data,
      sections: sections.body.data as SectionView[],
      docs: docs.body.data as DocView[],
      parts: p.body.data,
      listed: [...sectionBDocs.body.data, ...lessonADocs.body.data, ...previewDocs.body.data] as DocView[],
    };
  }

  /** None of the page routes answers, and the refusal says nothing about the course. */
  async function expectPageRefused(
    s: Scenario,
    request: (path: string) => ReturnType<typeof as>,
    { signedIn = true }: { signedIn?: boolean } = {},
  ) {
    const paths = [`/courses/${s.course.id}`, `/courses/${s.course.id}/sections`, `/courses/${s.course.id}/attachments`];
    // The per-section and per-lecture document lists need a signed-in caller.
    if (signedIn) paths.push(`/sections/${s.sectionB.id}/attachments`, `/lessons/${s.lessonA.id}/attachments`);
    for (const path of paths) {
      const res = await request(path);
      expect({ path, status: res.status, code: errorCode(res.body) }).toEqual({ path, status: 404, code: 'COURSE_NOT_AVAILABLE' });
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain('Integration Test Course');
      expect(raw).not.toContain('Section A');
      expect(raw).not.toContain('handout');
    }
  }

  // -------------------------------------------------------------------------
  // VISIBILITY
  // -------------------------------------------------------------------------

  describe('visibility: the page opens for exactly the students "My courses" lists it for', () => {
    it.each([
      EnrollmentState.ACTIVE,
      EnrollmentState.EXPIRED,
      EnrollmentState.ARCHIVED,
      EnrollmentState.PENDING_APPROVAL,
      EnrollmentState.PENDING_PAYMENT,
    ])('a HIDDEN course with a %s enrolment is listed, and its page, outline, documents and parts open', async (state) => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enrolWhole(s, state);

      expect(ids((await mine(s).expect(200)).body)).toEqual([s.course.id]);
      await expectPageOpens(s);
    });

    it('a part-limited (section-scoped) enrolment in a HIDDEN course is listed and opens', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enrolPart1(s);

      expect(ids((await mine(s).expect(200)).body)).toEqual([s.course.id]);
      await expectPageOpens(s);
    });

    it('invariant: a course in "My courses" opens - unless the course itself is withdrawn or paused', async () => {
      // DRAFT and SUSPENDED stay listed (the student's enrolment is intact and
      // comes back on re-publishing) and stay closed: "not currently available"
      // is the true state of such a course. Every other status must open.
      const expected: Record<string, { httpStatus: number; code: string | undefined }> = {
        [CourseStatus.PUBLISHED]: { httpStatus: 200, code: undefined },
        [CourseStatus.HIDDEN]: { httpStatus: 200, code: undefined },
        [CourseStatus.ARCHIVED]: { httpStatus: 200, code: undefined },
        [CourseStatus.DRAFT]: { httpStatus: 404, code: 'COURSE_NOT_AVAILABLE' },
        [CourseStatus.SUSPENDED]: { httpStatus: 404, code: 'COURSE_NOT_AVAILABLE' },
      };
      for (const status of Object.keys(expected) as CourseStatus[]) {
        await resetDatabase(prisma);
        const s = await scenario(status);
        await enrolWhole(s, EnrollmentState.ACTIVE);
        expect(ids((await mine(s).expect(200)).body)).toEqual([s.course.id]);
        const res = await page(s);
        expect({ status, httpStatus: res.status, code: errorCode(res.body) }).toEqual({ status, ...expected[status] });
      }
    });

    it('a student with no enrolment is refused, and learns nothing about the course', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await expectPageRefused(s, (path) => as(s, path));
      expect(errorCode((await parts(s)).body)).toBe('NOT_FOUND');
    });

    it('a signed-out visitor is refused', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await expectPageRefused(s, (path) => http(app).get(`${API}${path}`), { signedIn: false });
    });

    it('a REVOKED student is refused (and the course is not in their "My courses")', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enrolWhole(s, EnrollmentState.REVOKED);
      expect(ids((await mine(s).expect(200)).body)).toEqual([]);
      await expectPageRefused(s, (path) => as(s, path));
      expect(errorCode((await parts(s)).body)).toBe('NOT_FOUND');
    });

    it("another student's enrolment opens nothing for this one", async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      const other = await createUser(prisma, { role: UserRole.STUDENT });
      await prisma.enrollment.create({
        data: { userId: other.id, courseId: s.course.id, state: EnrollmentState.ACTIVE, method: EnrollmentMethod.CODE },
      });
      await expectPageRefused(s, (path) => as(s, path));
    });

    it.each([CourseStatus.DRAFT, CourseStatus.SUSPENDED])(
      'a %s course stays closed even to its ACTIVE student (unchanged)',
      async (status) => {
        const s = await scenario(status);
        await enrolWhole(s, EnrollmentState.ACTIVE);
        await expectPageRefused(s, (path) => as(s, path));
        expect(errorCode((await parts(s)).body)).toBe('NOT_FOUND');
      },
    );
  });

  // -------------------------------------------------------------------------
  // CONTENT
  // -------------------------------------------------------------------------

  describe('content: opening the page grants nothing the gates do not', () => {
    it('ACTIVE whole-course enrolment: everything unlocked, and the gates agree', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enrolWhole(s, EnrollmentState.ACTIVE);

      const v = await expectPageOpens(s);
      expect(v.detail.access.state).toBe('ACTIVE');
      expect([...lessonsOf(v.detail.sections).values()]).toEqual([false, false, false]);
      expect([...docsOf(v.detail.attachments).values()].every((l) => l === false)).toBe(true);
      expect([...docsOf(v.listed).values()].every((l) => l === false)).toBe(true);
      expect(v.parts.parts.map((p: { owned: boolean }) => p.owned)).toEqual([true, true]);

      await lessonLink(s, s.lessonA.id).expect(200);
      await lessonLink(s, s.lessonB.id).expect(200);
      await docTicket(s, s.sectionBDoc.id).expect(200);
    });

    it.each([
      [EnrollmentState.EXPIRED, 'EXPIRED', 'ACCESS_EXPIRED'],
      [EnrollmentState.ARCHIVED, 'ARCHIVED', 'COURSE_ARCHIVED'],
      [EnrollmentState.PENDING_APPROVAL, 'PENDING_APPROVAL', 'ENROLLMENT_PENDING'],
      [EnrollmentState.PENDING_PAYMENT, 'PENDING_PAYMENT', 'PAYMENT_REQUIRED'],
    ] as const)(
      '%s enrolment: the page shows the state, everything is locked - previews included - and every gate refuses',
      async (state, accessState, code) => {
        const s = await scenario(CourseStatus.HIDDEN);
        await enrolWhole(s, state);

        const v = await expectPageOpens(s);
        expect(v.detail.access.state).toBe(accessState);

        // A HIDDEN course is not on offer: no join, renewal or payment button.
        expect(v.detail.access.availableMethods).toEqual([]);

        // The outline and the documents, from all three surfaces, are locked -
        // including the free preview, because the gates do not serve previews
        // of a course that is not PUBLISHED (PR #26).
        for (const sections of [v.detail.sections, v.sections]) {
          expect([...sectionsOf(sections).values()]).toEqual([true, true]);
          expect([...lessonsOf(sections).values()]).toEqual([true, true, true]);
        }
        for (const docs of [v.detail.attachments, v.docs]) {
          expect([...docsOf(docs).values()]).toEqual([true, true, true, true]);
        }
        expect([...docsOf(v.listed).values()]).toEqual([true, true, true]);
        // Parts: nothing owned, nothing offered for sale.
        for (const p of v.parts.parts as Array<{ owned: boolean; purchasable: boolean }>) {
          expect({ owned: p.owned, purchasable: p.purchasable }).toEqual({ owned: false, purchasable: false });
        }

        for (const lessonId of [s.previewLesson.id, s.lessonA.id, s.lessonB.id]) {
          expect(errorCode((await lessonLink(s, lessonId)).body)).toBe(code);
        }
        for (const docId of [s.previewDoc.id, s.lessonADoc.id, s.sectionBDoc.id, s.courseDoc.id]) {
          expect(errorCode((await docTicket(s, docId)).body)).toBe(code);
        }
        expect(await prisma.playbackTicket.count({ where: { userId: s.student.id } })).toBe(0);
      },
    );

    it.each([CourseStatus.HIDDEN, CourseStatus.PUBLISHED])(
      'part-limited enrolment in a %s course: only part 1 opens, on the page and at the gates',
      async (status) => {
        const s = await scenario(status);
        await enrolPart1(s);

        const v = await expectPageOpens(s);
        for (const sections of [v.detail.sections, v.sections]) {
          expect(sectionsOf(sections).get(s.sectionA.id)).toBe(false);
          expect(sectionsOf(sections).get(s.sectionB.id)).toBe(true);
          expect(lessonsOf(sections).get(s.lessonA.id)).toBe(false);
          expect(lessonsOf(sections).get(s.lessonB.id)).toBe(true);
        }
        for (const docs of [v.detail.attachments, v.docs]) {
          const locked = docsOf(docs);
          expect(locked.get(s.lessonADoc.id)).toBe(false); // part 1
          expect(locked.get(s.courseDoc.id)).toBe(false); // course-wide material belongs to no section
          expect(locked.get(s.sectionBDoc.id)).toBe(true); // part 2: the gate refuses it, so must the page
        }
        expect(docsOf(v.listed).get(s.lessonADoc.id)).toBe(false);
        expect(docsOf(v.listed).get(s.sectionBDoc.id)).toBe(true);
        const owned = new Map(
          (v.parts.parts as Array<{ id: string; owned: boolean; purchasable: boolean }>).map((p) => [p.id, p]),
        );
        expect(owned.get(s.part1.id)!.owned).toBe(true);
        expect(owned.get(s.part2.id)!.owned).toBe(false);
        // Part 2 is for sale only while the course is on offer.
        expect(owned.get(s.part2.id)!.purchasable).toBe(status === CourseStatus.PUBLISHED);

        await lessonLink(s, s.lessonA.id).expect(200);
        await docTicket(s, s.lessonADoc.id).expect(200);
        await docTicket(s, s.courseDoc.id).expect(200);
        expect(errorCode((await lessonLink(s, s.lessonB.id)).body)).toBe('NOT_ENROLLED');
        expect(errorCode((await docTicket(s, s.sectionBDoc.id)).body)).toBe('NOT_ENROLLED');
      },
    );

    it('PUBLISHED previews are unchanged: open on the page and at the gates for a student who is not enrolled', async () => {
      const s = await scenario(CourseStatus.PUBLISHED);

      const v = await expectPageOpens(s);
      expect(v.detail.access.state).toBe('NOT_ENROLLED');
      expect(lessonsOf(v.detail.sections).get(s.previewLesson.id)).toBe(false);
      expect(lessonsOf(v.detail.sections).get(s.lessonA.id)).toBe(true);
      expect(docsOf(v.detail.attachments).get(s.previewDoc.id)).toBe(false);
      expect(docsOf(v.detail.attachments).get(s.lessonADoc.id)).toBe(true);
      expect(docsOf(v.listed).get(s.previewDoc.id)).toBe(false);
      expect(docsOf(v.listed).get(s.lessonADoc.id)).toBe(true);

      await lessonLink(s, s.previewLesson.id).expect(200);
      await docTicket(s, s.previewDoc.id).expect(200);
      expect(errorCode((await lessonLink(s, s.lessonA.id)).body)).toBe('NOT_ENROLLED');
    });
  });

  // -------------------------------------------------------------------------
  // UNPUBLISHED MATERIAL
  // -------------------------------------------------------------------------

  describe('documents of an unpublished section or lecture are listed to no student', () => {
    it.each([CourseStatus.PUBLISHED, CourseStatus.HIDDEN])(
      'in a %s course, for its ACTIVE student, on every document list; staff still see them',
      async (status) => {
        const s = await scenario(status);
        await enrolWhole(s, EnrollmentState.ACTIVE);
        await prisma.courseSection.update({ where: { id: s.sectionB.id }, data: { status: 'DRAFT' } });
        await prisma.lesson.update({ where: { id: s.lessonA.id }, data: { status: 'DRAFT' } });

        const sectionList = await as(s, `/sections/${s.sectionB.id}/attachments`);
        expect({ status: sectionList.status, code: errorCode(sectionList.body) }).toEqual({ status: 404, code: 'NOT_FOUND' });
        expect(JSON.stringify(sectionList.body)).not.toContain('Section B handout');

        const lessonList = await as(s, `/lessons/${s.lessonA.id}/attachments`);
        expect({ status: lessonList.status, code: errorCode(lessonList.body) }).toEqual({ status: 404, code: 'NOT_FOUND' });
        expect(JSON.stringify(lessonList.body)).not.toContain('Lesson A notes');

        // The course-level lists already left them out; still true.
        for (const path of [`/courses/${s.course.id}`, `/courses/${s.course.id}/attachments`]) {
          const raw = JSON.stringify((await as(s, path).expect(200)).body);
          expect(raw).not.toContain('Section B handout');
          expect(raw).not.toContain('Lesson A notes');
          expect(raw).toContain('Course handout');
        }

        // A lecture inside an unpublished section is unpublished too.
        await prisma.lesson.update({ where: { id: s.lessonA.id }, data: { status: 'PUBLISHED' } });
        await prisma.courseSection.update({ where: { id: s.sectionA.id }, data: { status: 'DRAFT' } });
        expect((await as(s, `/lessons/${s.lessonA.id}/attachments`)).status).toBe(404);

        // Staff author these documents and keep seeing them.
        const admin = await createUser(prisma, { role: UserRole.ADMIN });
        await createDevice(prisma, admin.id, 'admin-device');
        const staff = await login(app, admin.phone, 'admin-device');
        const staffSection = await http(app).get(`${API}/sections/${s.sectionB.id}/attachments`).set(staff.headers).expect(200);
        expect(staffSection.body.data.map((d: DocView) => d.id)).toEqual([s.sectionBDoc.id]);
        const staffLesson = await http(app).get(`${API}/lessons/${s.lessonA.id}/attachments`).set(staff.headers).expect(200);
        expect(staffLesson.body.data.map((d: DocView) => d.id)).toEqual([s.lessonADoc.id]);
      },
    );
  });

  // -------------------------------------------------------------------------
  // DISCOVERY AND JOINING
  // -------------------------------------------------------------------------

  describe('a HIDDEN course stays off discovery and closed to new enrolment', () => {
    it('it is not in the catalogue, even for its own enrolled student', async () => {
      const s = await scenario(CourseStatus.HIDDEN);
      await enrolWhole(s, EnrollmentState.ACTIVE);
      expect(ids((await as(s, '/courses').expect(200)).body)).not.toContain(s.course.id);
      expect(ids((await http(app).get(`${API}/courses`).expect(200)).body)).not.toContain(s.course.id);
    });

    it.each([null, EnrollmentState.ACTIVE, EnrollmentState.EXPIRED])(
      'join options and enrolment are refused (enrolment: %s)',
      async (state) => {
        const s = await scenario(CourseStatus.HIDDEN);
        if (state) await enrolWhole(s, state);

        expect((await joinOptions(s)).status).toBe(404);
        const join = await http(app)
          .post(`${API}/courses/${s.course.id}/enroll`)
          .set(s.session.headers)
          .send({ method: EnrollmentMethod.CODE });
        expect(join.status).toBeGreaterThanOrEqual(400);
        expect(['COURSE_NOT_AVAILABLE', 'ALREADY_ENROLLED']).toContain(errorCode(join.body));
        expect(
          await prisma.enrollment.count({ where: { userId: s.student.id, courseId: s.course.id } }),
        ).toBe(state ? 1 : 0);
      },
    );
  });
});
