// A media origin so attachment tickets can be signed in this suite. Set before
// the app boots; `??=` keeps a real value from the environment if one is set.
process.env.MEDIA_CDN_BASE_URL ??= 'https://media.example.test/';

import type { INestApplication } from '@nestjs/common';
import {
  CodeStatus,
  CodeTargetType,
  ContentStatus,
  EnrollmentMethod,
  EnrollmentState,
  PartEntitlementSource,
  PartPricingModel,
  PrismaClient,
  SectionGrantSource,
  SecurityEventType,
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
 * What a student may open must match what they bought — live, at EVERY gate.
 *
 * Two production incidents on the same course (Chemistry (B), 2026-11-02): a
 * second lecturer's Pre-Mid section was created after the course's cards had
 * been sold and assigned to "Part 1 — Before Mid" in the dashboard.
 *
 *   * Part 1 holders held an entitlement for the part, but their section
 *     grants were frozen at redemption, so the new section was refused.
 *   * Whole-course card buyers were worse off: a COURSE card used to redeem
 *     as the section snapshot frozen onto it at generation, so a "whole
 *     course" buyer was really a section-scoped enrollment and never
 *     received a section added after the card was printed.
 *
 * In both cases the apps worded the refusal (`NOT_ENROLLED`) as "Join the
 * course to access this content", which read to students as "you are not
 * subscribed" although they were.
 *
 * Seeing a section title proves nothing, so this file drives the whole
 * authorization flow over HTTP against a real database, for every kind of
 * student the access engine distinguishes:
 *
 *   partHolder     bought Part 1 before the new section existed
 *   courseCard     bought the whole course with a card, under the old snapshot
 *                  rule (coversAllSections = false, grants for the sections
 *                  that existed then, a redemption record for the card)
 *   forged         a grant row that CITES a course card the student never
 *                  redeemed — must widen nothing
 *   fullCourse     whole-course enrollment (coversAllSections = true)
 *   part2Holder    bought Part 2 only (part card)
 *   sectionHolder  one section card for the original Pre-Mid section, no part
 *   expiredHolder  Part 1 entitlement, but the enrollment's access window lapsed
 *   stranger       no enrollment at all
 *   newBuyer       redeems a whole-course card through the real route today
 *
 * and for every gate: course detail, section listing, parts view, lesson
 * detail, playback ticket, lesson-scoped and section-scoped attachment tickets.
 */
describe('course parts: live section membership', () => {
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

  const DAY = 86_400_000;

  async function student(deviceKey: string) {
    const user = await createUser(prisma, { role: UserRole.STUDENT });
    await createDevice(prisma, user.id, deviceKey);
    return { user, deviceKey };
  }

  /**
   * Two parts, 60/40. Part 1 holds the Pre-Mid section, Part 2 the Post-Mid
   * one. A third "Pre-Mid (second lecturer)" section exists but is not yet in
   * any part — that is the section the admin will add to Part 1.
   */
  async function scenario() {
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const admin = await createUser(prisma, { role: UserRole.ADMIN });
    await createDevice(prisma, admin.id, 'admin-device');

    const partHolder = await student('holder-device');
    const courseCard = await student('coursecard-device');
    const forged = await student('forged-device');
    const fullCourse = await student('full-device');
    const part2Holder = await student('part2-device');
    const sectionHolder = await student('section-device');
    const expiredHolder = await student('expired-device');
    const stranger = await student('stranger-device');
    const newBuyer = await student('newbuyer-device');

    const course = await createCourse(prisma, {
      teacherId: teacher.id,
      price: 1000,
      enrollmentMethods: [EnrollmentMethod.CODE],
      sections: [
        { title: 'قبل الميد', lessons: 2 },
        { title: 'بعد الميد', lessons: 2 },
        { title: 'قبل الميد م/احمد العوضي', lessons: 3 },
      ],
    });
    const [preMid, postMid, preMidSecond] = course.sections;

    const part1 = await prisma.coursePart.create({
      data: {
        courseId: course.id,
        title: 'Part 1 — Before Mid + Revision',
        sortOrder: 1,
        pricingModel: PartPricingModel.PERCENTAGE,
        pricePercent: 60,
        sections: { connect: { id: preMid!.id } },
      },
    });
    const part2 = await prisma.coursePart.create({
      data: {
        courseId: course.id,
        title: 'Part 2 — After Mid + Revision',
        sortOrder: 2,
        pricingModel: PartPricingModel.PERCENTAGE,
        pricePercent: 40,
        sections: { connect: { id: postMid!.id } },
      },
    });

    // The cards. Every snapshot predates the third section, exactly as the
    // cards sold on production did.
    const card = (data: {
      code: string;
      targetType: CodeTargetType;
      sectionId?: string;
      coursePartId?: string;
      grantedSectionIds: string[];
      status?: CodeStatus;
      redemptionCount?: number;
      expiresAt?: Date;
    }) =>
      prisma.accessCode.create({
        data: {
          code: data.code,
          courseId: course.id,
          targetType: data.targetType,
          sectionId: data.sectionId ?? null,
          coursePartId: data.coursePartId ?? null,
          grantedSectionIds: data.grantedSectionIds,
          grantedCourseIds: [course.id],
          maxRedemptions: 1,
          redemptionCount: data.redemptionCount ?? 1,
          status: data.status ?? CodeStatus.EXHAUSTED,
          expiresAt: data.expiresAt ?? null,
        },
      });
    const oldSnapshot = [preMid!.id, postMid!.id];
    const courseCode = await card({ code: 'COURSECARD001', targetType: CodeTargetType.COURSE, grantedSectionIds: oldSnapshot });
    const sectionCode = await card({ code: 'SECTIONCARD001', targetType: CodeTargetType.SECTION, sectionId: preMid!.id, grantedSectionIds: [preMid!.id] });
    const part2Code = await card({ code: 'PARTCARD002', targetType: CodeTargetType.PART, coursePartId: part2.id, grantedSectionIds: [postMid!.id] });
    const freshCourseCode = await card({ code: 'COURSECARD002', targetType: CodeTargetType.COURSE, grantedSectionIds: oldSnapshot, status: CodeStatus.ACTIVE, redemptionCount: 0 });
    const revokedCourseCode = await card({ code: 'COURSECARD003', targetType: CodeTargetType.COURSE, grantedSectionIds: oldSnapshot, status: CodeStatus.REVOKED, redemptionCount: 0 });
    const expiredCourseCode = await card({ code: 'COURSECARD004', targetType: CodeTargetType.COURSE, grantedSectionIds: oldSnapshot, status: CodeStatus.ACTIVE, redemptionCount: 0, expiresAt: new Date(Date.now() - DAY) });

    /** A restricted enrollment with the grant rows a card redemption wrote. */
    async function restrictedEnrollment(
      userId: string,
      grants: Array<{ sectionId: string; codeId: string | null; partId?: string }>,
      accessEndsAt: Date | null = null,
    ) {
      return prisma.enrollment.create({
        data: {
          userId,
          courseId: course.id,
          state: EnrollmentState.ACTIVE,
          method: EnrollmentMethod.CODE,
          coversAllSections: false,
          accessStartsAt: new Date(Date.now() - DAY),
          accessEndsAt,
          sectionGrants: {
            create: grants.map((g) => ({
              sectionId: g.sectionId,
              source: SectionGrantSource.CODE,
              codeId: g.codeId,
              partId: g.partId ?? null,
            })),
          },
        },
      });
    }
    const redemption = (userId: string, codeId: string, enrollmentId: string) =>
      prisma.accessCodeRedemption.create({
        data: { userId, codeId, courseId: course.id, enrollmentId },
      });
    const entitlement = (userId: string, coursePartId: string) =>
      prisma.coursePartEntitlement.create({
        data: { userId, coursePartId, courseId: course.id, source: PartEntitlementSource.CODE },
      });

    // Part 1 holder: what a part card redemption leaves behind.
    const holderEnrollment = await restrictedEnrollment(partHolder.user.id, [
      { sectionId: preMid!.id, codeId: null, partId: part1.id },
    ]);
    await entitlement(partHolder.user.id, part1.id);

    // Whole-course card buyer under the OLD rule: grants for the two sections
    // that existed, and the redemption record for the card.
    const courseCardEnrollment = await restrictedEnrollment(courseCard.user.id, [
      { sectionId: preMid!.id, codeId: courseCode.id },
      { sectionId: postMid!.id, codeId: courseCode.id },
    ]);
    await redemption(courseCard.user.id, courseCode.id, courseCardEnrollment.id);

    // A grant row that cites the course card but with NO redemption record
    // for this student: a hand-edited row, or someone else's card.
    await restrictedEnrollment(forged.user.id, [{ sectionId: preMid!.id, codeId: courseCode.id }]);

    // Part 2 holder, through a part card.
    const p2Enrollment = await restrictedEnrollment(part2Holder.user.id, [
      { sectionId: postMid!.id, codeId: part2Code.id, partId: part2.id },
    ]);
    await redemption(part2Holder.user.id, part2Code.id, p2Enrollment.id);
    await entitlement(part2Holder.user.id, part2.id);

    // One section card for the Pre-Mid section and no part at all.
    const secEnrollment = await restrictedEnrollment(sectionHolder.user.id, [
      { sectionId: preMid!.id, codeId: sectionCode.id },
    ]);
    await redemption(sectionHolder.user.id, sectionCode.id, secEnrollment.id);

    // Part 1 holder whose window lapsed.
    await restrictedEnrollment(
      expiredHolder.user.id,
      [{ sectionId: preMid!.id, codeId: null, partId: part1.id }],
      new Date(Date.now() - DAY),
    );
    await entitlement(expiredHolder.user.id, part1.id);

    // Whole-course access in the canonical shape.
    await prisma.enrollment.create({
      data: {
        userId: fullCourse.user.id,
        courseId: course.id,
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: true,
        accessStartsAt: new Date(Date.now() - DAY),
      },
    });

    // Documents hanging off the new section: one on a lecture, one on the
    // section itself. Unprotected, so the only thing between a student and a
    // ticket is the section scope.
    const newLesson = preMidSecond!.lessons[0]!;
    const lessonDoc = await prisma.attachment.create({
      data: {
        courseId: course.id,
        lessonId: newLesson.id,
        title: 'Lecture notes',
        objectKey: `attachments/${course.id}/lecture-notes.pdf`,
        isProtected: false,
        isDownloadable: true,
      },
    });
    const sectionDoc = await prisma.attachment.create({
      data: {
        courseId: course.id,
        sectionId: preMidSecond!.id,
        title: 'Section handout',
        objectKey: `attachments/${course.id}/section-handout.pdf`,
        isProtected: false,
        isDownloadable: true,
      },
    });

    return {
      admin,
      partHolder,
      courseCard,
      forged,
      fullCourse,
      part2Holder,
      sectionHolder,
      expiredHolder,
      stranger,
      newBuyer,
      course,
      part1,
      part2,
      preMid: preMid!,
      postMid: postMid!,
      preMidSecond: preMidSecond!,
      newLesson,
      lessonDoc,
      sectionDoc,
      holderEnrollment,
      courseCardEnrollment,
      freshCourseCode,
      revokedCourseCode,
      expiredCourseCode,
    };
  }

  type Scenario = Awaited<ReturnType<typeof scenario>>;
  type Session = Awaited<ReturnType<typeof login>>;

  type Outline = Array<{
    id: string;
    title: string;
    locked: boolean;
    lessons: Array<{ id: string; locked: boolean }>;
  }>;

  const lockMap = (sections: Outline) =>
    Object.fromEntries(sections.map((s) => [s.title, s.locked]));

  /** The admin assigns the second lecturer's Pre-Mid section to Part 1 through
   *  the real dashboard route, nothing written by hand. */
  async function assignNewSectionToPart1(s: Scenario) {
    const admin = await login(app, s.admin.phone, 'admin-device');
    const assigned = await http(app)
      .put(`${API}/admin/course-parts/${s.part1.id}/sections`)
      .set(admin.headers)
      .send({ sectionIds: [s.preMid.id, s.preMidSecond.id] })
      .expect(200);
    const part1View = assigned.body.data.parts.find((p: { id: string }) => p.id === s.part1.id);
    expect(part1View.sections.map((x: { id: string }) => x.id).sort()).toEqual(
      [s.preMid.id, s.preMidSecond.id].sort(),
    );
  }

  const as = (s: Scenario, who: { user: { phone: string }; deviceKey: string }) =>
    login(app, who.user.phone, who.deviceKey);

  const detail = (s: Scenario, session: Session) =>
    http(app).get(`${API}/courses/${s.course.id}`).set(session.headers);
  const outline = (s: Scenario, session: Session) =>
    http(app).get(`${API}/courses/${s.course.id}/sections`).set(session.headers);
  const partsView = (s: Scenario, session: Session) =>
    http(app).get(`${API}/courses/${s.course.id}/parts`).set(session.headers);
  const lesson = (session: Session, lessonId: string) =>
    http(app).get(`${API}/lessons/${lessonId}`).set(session.headers);
  const ticket = (session: Session, videoId: string, lessonId: string) =>
    http(app)
      .post(`${API}/playback/videos/${videoId}/ticket`)
      .set(session.headers)
      .send({ lessonId });
  const docTicket = (session: Session, attachmentId: string) =>
    http(app).get(`${API}/attachments/${attachmentId}/ticket`).set(session.headers);
  const redeem = (s: Scenario, session: Session, code: string) =>
    http(app).post(`${API}/courses/${s.course.id}/redeem`).set(session.headers).send({ code });

  /** Reasons the playback path recorded for this student's refused tickets. */
  const deniedReasons = async (userId: string) =>
    (
      await prisma.securityEvent.findMany({
        where: { userId, type: SecurityEventType.TICKET_DENIED },
        select: { message: true },
      })
    ).map((e) => e.message);

  /** Every gate opens the new section for this session. */
  async function expectNewSectionOpen(s: Scenario, session: Session, userId: string) {
    for (const l of s.preMidSecond.lessons) {
      const res = await lesson(session, l.id).expect(200);
      expect(res.body.data.id).toBe(l.id);
    }
    // The fixture asset has no verified DRM, so the ticket is refused further
    // down by the DRM gate — which runs AFTER authorization — never for the
    // section. The recorded denial reasons make the difference observable.
    const sectionDenialsBefore = (await deniedReasons(userId)).filter(
      (m) => m === 'section not covered by access',
    ).length;
    const play = await ticket(session, s.newLesson.video!.id, s.newLesson.id);
    expect(errorCode(play.body)).not.toBe('NOT_ENROLLED');
    expect(['PLAYBACK_DENIED', 'VIDEO_UNAVAILABLE', 'VIDEO_NOT_READY']).toContain(errorCode(play.body));
    // No NEW section denial was recorded for this request (an earlier, pre-
    // assignment refusal in the same test is expected to be on record).
    const sectionDenialsAfter = (await deniedReasons(userId)).filter(
      (m) => m === 'section not covered by access',
    ).length;
    expect(sectionDenialsAfter).toBe(sectionDenialsBefore);

    const lessonTicket = await docTicket(session, s.lessonDoc.id).expect(200);
    expect(lessonTicket.body.data.url).toContain(`uid=${userId}`);
    const sectionTicket = await docTicket(session, s.sectionDoc.id).expect(200);
    expect(sectionTicket.body.data.url).toContain(`uid=${userId}`);
  }

  /** Every gate refuses the new section for this session with `code`. */
  async function expectNewSectionRefused(s: Scenario, session: Session, code: string) {
    const res = await lesson(session, s.newLesson.id);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(res.body)).toBe(code);
    expect(errorCode((await ticket(session, s.newLesson.video!.id, s.newLesson.id)).body)).toBe(code);
    expect(errorCode((await docTicket(session, s.lessonDoc.id)).body)).toBe(code);
    expect(errorCode((await docTicket(session, s.sectionDoc.id)).body)).toBe(code);
  }

  // ---------------------------------------------------------------------------
  // Part holders
  // ---------------------------------------------------------------------------

  it('a Part 1 holder opens, plays and reads a section added to Part 1 after they bought it', async () => {
    const s = await scenario();
    const holder = await as(s, s.partHolder);

    // Before the admin acts: the new section is in no part, so it is locked
    // and refused — consistently, outline and gate agree.
    const before = await detail(s, holder).expect(200);
    expect(lockMap(before.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });
    await expectNewSectionRefused(s, holder, 'NOT_ENROLLED');

    await assignNewSectionToPart1(s);

    // No grant row was back-filled: the frozen rows are untouched...
    const grants = await prisma.enrollmentSectionGrant.findMany({
      where: { enrollmentId: s.holderEnrollment.id },
    });
    expect(grants.map((g) => g.sectionId)).toEqual([s.preMid.id]);

    // ...and yet every read now unlocks the new section.
    const after = await detail(s, holder).expect(200);
    expect(lockMap(after.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': false,
    });
    expect(after.body.data.sections.map((x: { title: string }) => x.title)).toEqual([
      'قبل الميد',
      'بعد الميد',
      'قبل الميد م/احمد العوضي',
    ]);
    expect(after.body.data.sections[2].lessons.every((l: { locked: boolean }) => !l.locked)).toBe(true);

    const listed = await outline(s, holder).expect(200);
    expect(lockMap(listed.body.data)).toEqual(lockMap(after.body.data.sections));

    const parts = await partsView(s, holder).expect(200);
    const ownedPart = parts.body.data.parts.find((p: { id: string }) => p.id === s.part1.id);
    expect(ownedPart.owned).toBe(true);
    expect(ownedPart.sections.map((x: { id: string; locked: boolean }) => [x.id, x.locked])).toEqual([
      [s.preMid.id, false],
      [s.preMidSecond.id, false],
    ]);
    expect(parts.body.data.parts.find((p: { id: string }) => p.id === s.part2.id).owned).toBe(false);
    expect(parts.body.data.ownsAllParts).toBe(false);

    await expectNewSectionOpen(s, holder, s.partHolder.user.id);

    // Part 1 never bleeds into Part 2.
    const refused = await lesson(holder, s.postMid.lessons[0]!.id);
    expect(refused.status).toBe(403);
    expect(errorCode(refused.body)).toBe('NOT_ENROLLED');
  });

  it('a Part 2 holder gets Part 2 and nothing of Part 1, including the new section', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    const p2 = await as(s, s.part2Holder);

    const view = await detail(s, p2).expect(200);
    expect(lockMap(view.body.data.sections)).toEqual({
      'قبل الميد': true,
      'بعد الميد': false,
      'قبل الميد م/احمد العوضي': true,
    });
    await lesson(p2, s.postMid.lessons[0]!.id).expect(200);
    expect(errorCode((await lesson(p2, s.preMid.lessons[0]!.id)).body)).toBe('NOT_ENROLLED');
    await expectNewSectionRefused(s, p2, 'NOT_ENROLLED');
    expect(await deniedReasons(s.part2Holder.user.id)).toContain('section not covered by access');

    // A part card is never a whole-course card.
    const parts = await partsView(s, p2).expect(200);
    expect(parts.body.data.ownsAllParts).toBe(false);
    expect(parts.body.data.parts.find((p: { id: string }) => p.id === s.part1.id).owned).toBe(false);
  });

  it('a Part 1 holder whose access window lapsed is refused as EXPIRED, part or not', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    const expired = await as(s, s.expiredHolder);

    const view = await detail(s, expired).expect(200);
    expect(view.body.data.access.state).toBe('EXPIRED');
    expect(Object.values(lockMap(view.body.data.sections))).toEqual([true, true, true]);
    // ACCESS_EXPIRED is answered as 410 Gone, not 403: the code is the contract.
    expect(errorCode((await lesson(expired, s.preMid.lessons[0]!.id)).body)).toBe('ACCESS_EXPIRED');
    await expectNewSectionRefused(s, expired, 'ACCESS_EXPIRED');
  });

  it('a revoked entitlement no longer unlocks the part, but the frozen grant survives', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    await prisma.coursePartEntitlement.updateMany({
      where: { userId: s.partHolder.user.id, coursePartId: s.part1.id },
      data: { revokedAt: new Date(), revokedReason: 'test' },
    });

    const holder = await as(s, s.partHolder);
    const view = await detail(s, holder).expect(200);
    expect(lockMap(view.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });
    await lesson(holder, s.preMid.lessons[0]!.id).expect(200);
    await expectNewSectionRefused(s, holder, 'NOT_ENROLLED');
  });

  it('an archived section inside a held part stays out of every gate', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    await prisma.courseSection.update({
      where: { id: s.preMidSecond.id },
      data: { status: ContentStatus.ARCHIVED },
    });

    const holder = await as(s, s.partHolder);
    const view = await detail(s, holder).expect(200);
    // Archived sections are not listed to students at all.
    expect(view.body.data.sections.map((x: { title: string }) => x.title)).toEqual([
      'قبل الميد',
      'بعد الميد',
    ]);
    expect((await lesson(holder, s.newLesson.id)).status).toBeGreaterThanOrEqual(400);
    expect((await ticket(holder, s.newLesson.video!.id, s.newLesson.id)).status).toBeGreaterThanOrEqual(400);
    expect((await docTicket(holder, s.sectionDoc.id)).status).toBeGreaterThanOrEqual(400);
    expect((await docTicket(holder, s.lessonDoc.id)).status).toBeGreaterThanOrEqual(400);
  });

  // ---------------------------------------------------------------------------
  // Whole-course access, in both shapes
  // ---------------------------------------------------------------------------

  it('a whole-course card bought under the old snapshot rule is the whole course, live, at every gate', async () => {
    const s = await scenario();
    const buyer = await as(s, s.courseCard);

    // The rows are the old shape and stay that way: restricted flag, two
    // frozen grants, one redemption record. Nothing is rewritten.
    const rowBefore = await prisma.enrollment.findUniqueOrThrow({
      where: { id: s.courseCardEnrollment.id },
      include: { sectionGrants: true },
    });
    expect(rowBefore.coversAllSections).toBe(false);
    expect(rowBefore.sectionGrants).toHaveLength(2);

    // Even BEFORE the admin puts the new section in a part: it is a section of
    // the course the student bought, so it is theirs.
    const before = await detail(s, buyer).expect(200);
    expect(Object.values(lockMap(before.body.data.sections))).toEqual([false, false, false]);
    expect(lockMap((await outline(s, buyer).expect(200)).body.data)).toEqual(
      lockMap(before.body.data.sections),
    );
    await expectNewSectionOpen(s, buyer, s.courseCard.user.id);

    await assignNewSectionToPart1(s);

    const after = await detail(s, buyer).expect(200);
    expect(Object.values(lockMap(after.body.data.sections))).toEqual([false, false, false]);
    for (const sec of [s.preMid, s.postMid, s.preMidSecond]) {
      await lesson(buyer, sec.lessons[0]!.id).expect(200);
    }
    await expectNewSectionOpen(s, buyer, s.courseCard.user.id);

    // The parts view agrees: nothing to buy, every part held via the course.
    const parts = await partsView(s, buyer).expect(200);
    expect(parts.body.data.ownsAllParts).toBe(true);
    expect(parts.body.data.parts.map((p: { owned: boolean; ownedVia: string }) => [p.owned, p.ownedVia])).toEqual([
      [true, 'FULL_COURSE'],
      [true, 'FULL_COURSE'],
    ]);
    const options = await http(app).get(`${API}/courses/${s.course.id}/join-options`).set(buyer.headers).expect(200);
    expect(options.body.data.fullCourse.owned).toBe(true);
    expect(options.body.data.fullCourse.purchasable).toBe(false);

    // Holding the course already, a second card is refused as such.
    const again = await redeem(s, buyer, 'COURSECARD002');
    expect(errorCode(again.body)).toBe('ALREADY_ENROLLED');

    const rowAfter = await prisma.enrollment.findUniqueOrThrow({
      where: { id: s.courseCardEnrollment.id },
      include: { sectionGrants: true },
    });
    expect(rowAfter.coversAllSections).toBe(false);
    expect(rowAfter.sectionGrants).toHaveLength(2);
  });

  it('a whole-course enrollment (coversAllSections) keeps every section, before and after the assignment', async () => {
    const s = await scenario();
    const full = await as(s, s.fullCourse);

    const before = await detail(s, full).expect(200);
    expect(Object.values(lockMap(before.body.data.sections))).toEqual([false, false, false]);

    await assignNewSectionToPart1(s);

    const after = await detail(s, full).expect(200);
    expect(Object.values(lockMap(after.body.data.sections))).toEqual([false, false, false]);
    for (const sec of [s.preMid, s.postMid, s.preMidSecond]) {
      await lesson(full, sec.lessons[0]!.id).expect(200);
    }
    await expectNewSectionOpen(s, full, s.fullCourse.user.id);
    expect((await partsView(s, full).expect(200)).body.data.ownsAllParts).toBe(true);
  });

  it('redeeming a whole-course card today records whole-course access, whatever the card snapshot says', async () => {
    const s = await scenario();
    const buyer = await as(s, s.newBuyer);

    // The card's snapshot predates the new section; the redemption ignores it.
    const res = await redeem(s, buyer, 'COURSECARD002').expect(200);
    expect(res.body.data.state).toBe('ACTIVE');

    const row = await prisma.enrollment.findUniqueOrThrow({
      where: { userId_courseId: { userId: s.newBuyer.user.id, courseId: s.course.id } },
      include: { sectionGrants: true },
    });
    expect(row.coversAllSections).toBe(true);
    expect(row.sectionGrants).toHaveLength(0);
    const code = await prisma.accessCode.findUniqueOrThrow({ where: { id: s.freshCourseCode.id } });
    expect(code.status).toBe(CodeStatus.EXHAUSTED);
    expect(code.redemptionCount).toBe(1);

    const view = await detail(s, buyer).expect(200);
    expect(Object.values(lockMap(view.body.data.sections))).toEqual([false, false, false]);
    await expectNewSectionOpen(s, buyer, s.newBuyer.user.id);
    expect((await partsView(s, buyer).expect(200)).body.data.ownsAllParts).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Nothing else widens
  // ---------------------------------------------------------------------------

  it('a grant row that cites a course card the student never redeemed widens nothing', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    const f = await as(s, s.forged);

    const view = await detail(s, f).expect(200);
    expect(lockMap(view.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });
    await lesson(f, s.preMid.lessons[0]!.id).expect(200);
    expect(errorCode((await lesson(f, s.postMid.lessons[0]!.id)).body)).toBe('NOT_ENROLLED');
    await expectNewSectionRefused(s, f, 'NOT_ENROLLED');
    expect((await partsView(s, f).expect(200)).body.data.ownsAllParts).toBe(false);
  });

  it('a student with only a section card keeps that section and gains nothing', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    const sec = await as(s, s.sectionHolder);

    const view = await detail(s, sec).expect(200);
    expect(lockMap(view.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });
    await lesson(sec, s.preMid.lessons[0]!.id).expect(200);
    await expectNewSectionRefused(s, sec, 'NOT_ENROLLED');
    expect((await partsView(s, sec).expect(200)).body.data.ownsAllParts).toBe(false);
  });

  it('a student with no enrollment is refused everywhere', async () => {
    const s = await scenario();
    await assignNewSectionToPart1(s);
    const none = await as(s, s.stranger);

    const view = await detail(s, none).expect(200);
    expect(Object.values(lockMap(view.body.data.sections))).toEqual([true, true, true]);
    for (const sec of [s.preMid, s.postMid]) {
      const res = await lesson(none, sec.lessons[0]!.id);
      expect(res.status).toBe(403);
      expect(errorCode(res.body)).toBe('NOT_ENROLLED');
    }
    await expectNewSectionRefused(s, none, 'NOT_ENROLLED');
  });

  it('a revoked, expired or already-used course card grants nothing', async () => {
    const s = await scenario();
    const none = await as(s, s.stranger);

    for (const code of ['COURSECARD003', 'COURSECARD004']) {
      const res = await redeem(s, none, code);
      expect(res.status).toBe(400);
      expect(errorCode(res.body)).toBe('INVALID_CODE');
    }
    // Exhausted by the courseCard student already.
    const used = await redeem(s, none, 'COURSECARD001');
    expect(errorCode(used.body)).toBe('CODE_ALREADY_USED');

    expect(
      await prisma.enrollment.count({ where: { userId: s.stranger.user.id, courseId: s.course.id } }),
    ).toBe(0);
    expect(await prisma.accessCodeRedemption.count({ where: { userId: s.stranger.user.id } })).toBe(0);
    for (const code of [s.revokedCourseCode, s.expiredCourseCode]) {
      const row = await prisma.accessCode.findUniqueOrThrow({ where: { id: code.id } });
      expect(row.redemptionCount).toBe(0);
    }
    expect(Object.values(lockMap((await detail(s, none).expect(200)).body.data.sections))).toEqual([true, true, true]);
    await expectNewSectionRefused(s, none, 'NOT_ENROLLED');
  });
});
