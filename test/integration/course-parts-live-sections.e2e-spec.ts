import type { INestApplication } from '@nestjs/common';
import {
  ContentStatus,
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
 * A section added to a part AFTER the part was sold reaches existing holders.
 *
 * The production incident (Chemistry (B), 2026-11-02): "Part 1 — Before Mid"
 * contained one Pre-Mid section when the cards were sold. A second lecturer's
 * Pre-Mid section was then created and assigned to Part 1 in the dashboard.
 * Every student who had redeemed a Part 1 card held an entitlement for the
 * part, but their section grants were frozen at redemption, so the new section
 * was refused by the lesson gate while the course outline (`GET /courses/:id`)
 * still showed it unlocked.
 *
 * This runs the whole thing over HTTP against a real database: the admin
 * assigns the section through the real route, and the student reads the
 * course, the outline and the lessons through the real guards.
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

  /**
   * Two parts, 60/40. Part 1 holds the Pre-Mid section, Part 2 the Post-Mid
   * one. A third "Pre-Mid (second lecturer)" section exists but is not yet in
   * any part — that is the section the admin will add to Part 1.
   */
  async function scenario() {
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const admin = await createUser(prisma, { role: UserRole.ADMIN });
    const partHolder = await createUser(prisma, { role: UserRole.STUDENT });
    const sectionHolder = await createUser(prisma, { role: UserRole.STUDENT });
    await createDevice(prisma, admin.id, 'admin-device');
    await createDevice(prisma, partHolder.id, 'holder-device');
    await createDevice(prisma, sectionHolder.id, 'section-device');

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

    // What a Part 1 card redemption leaves behind: a restricted enrollment,
    // the grant rows frozen to the part's sections AT THAT TIME, and the
    // entitlement.
    const holderEnrollment = await prisma.enrollment.create({
      data: {
        userId: partHolder.id,
        courseId: course.id,
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: false,
        accessStartsAt: new Date(Date.now() - 1000),
        sectionGrants: {
          create: { sectionId: preMid!.id, source: SectionGrantSource.CODE, partId: part1.id },
        },
      },
    });
    await prisma.coursePartEntitlement.create({
      data: {
        userId: partHolder.id,
        coursePartId: part1.id,
        courseId: course.id,
        source: PartEntitlementSource.CODE,
      },
    });

    // A student who bought ONE section card for the Pre-Mid section and holds
    // no part at all. The new section must not leak to them.
    await prisma.enrollment.create({
      data: {
        userId: sectionHolder.id,
        courseId: course.id,
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: false,
        accessStartsAt: new Date(Date.now() - 1000),
        sectionGrants: { create: { sectionId: preMid!.id, source: SectionGrantSource.CODE } },
      },
    });

    return {
      admin,
      partHolder,
      sectionHolder,
      course,
      part1,
      part2,
      preMid: preMid!,
      postMid: postMid!,
      preMidSecond: preMidSecond!,
      holderEnrollment,
    };
  }

  type Outline = Array<{
    id: string;
    title: string;
    locked: boolean;
    lessons: Array<{ id: string; locked: boolean }>;
  }>;

  const lockMap = (sections: Outline) =>
    Object.fromEntries(sections.map((s) => [s.title, s.locked]));

  it('a section added to a bought part is unlocked for existing holders on every read, and only for them', async () => {
    const s = await scenario();

    // Before the admin acts: the holder has Pre-Mid only, the new section is
    // not in any part and is locked, and the outline says so consistently.
    const holder = await login(app, s.partHolder.phone, 'holder-device');

    const before = await http(app)
      .get(`${API}/courses/${s.course.id}`)
      .set(holder.headers)
      .expect(200);
    expect(lockMap(before.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });

    // The admin assigns the second lecturer's Pre-Mid section to Part 1 —
    // the real dashboard route, nothing written by hand.
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

    // No grant row was back-filled: the frozen rows are untouched...
    const grants = await prisma.enrollmentSectionGrant.findMany({
      where: { enrollmentId: s.holderEnrollment.id },
    });
    expect(grants.map((g) => g.sectionId)).toEqual([s.preMid.id]);

    // ...and yet the holder now sees the new section open in the course
    // detail, in the outline endpoint, and in the parts view.
    const detail = await http(app)
      .get(`${API}/courses/${s.course.id}`)
      .set(holder.headers)
      .expect(200);
    expect(lockMap(detail.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': false,
    });
    expect(detail.body.data.sections.map((x: { title: string }) => x.title)).toEqual([
      'قبل الميد',
      'بعد الميد',
      'قبل الميد م/احمد العوضي',
    ]);

    const outline = await http(app)
      .get(`${API}/courses/${s.course.id}/sections`)
      .set(holder.headers)
      .expect(200);
    expect(lockMap(outline.body.data)).toEqual(lockMap(detail.body.data.sections));

    const parts = await http(app)
      .get(`${API}/courses/${s.course.id}/parts`)
      .set(holder.headers)
      .expect(200);
    const ownedPart = parts.body.data.parts.find((p: { id: string }) => p.id === s.part1.id);
    expect(ownedPart.owned).toBe(true);
    expect(
      ownedPart.sections.map((x: { id: string; locked: boolean }) => [x.id, x.locked]),
    ).toEqual([
      [s.preMid.id, false],
      [s.preMidSecond.id, false],
    ]);
    const lockedPart = parts.body.data.parts.find((p: { id: string }) => p.id === s.part2.id);
    expect(lockedPart.owned).toBe(false);

    // The gate agrees with the outline: a lecture in the new section opens,
    // a lecture in the Post-Mid part is still refused.
    const newLesson = s.preMidSecond.lessons[0]!;
    await http(app).get(`${API}/lessons/${newLesson.id}`).set(holder.headers).expect(200);

    const postMidLesson = s.postMid.lessons[0]!;
    const refused = await http(app)
      .get(`${API}/lessons/${postMidLesson.id}`)
      .set(holder.headers);
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(errorCode(refused.body)).toBe('NOT_ENROLLED');

    // A section-card student who holds no part gains nothing from the change.
    const sectionOnly = await login(app, s.sectionHolder.phone, 'section-device');
    const theirs = await http(app)
      .get(`${API}/courses/${s.course.id}`)
      .set(sectionOnly.headers)
      .expect(200);
    expect(lockMap(theirs.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });
    const theirRefusal = await http(app)
      .get(`${API}/lessons/${newLesson.id}`)
      .set(sectionOnly.headers);
    expect(errorCode(theirRefusal.body)).toBe('NOT_ENROLLED');
  });

  it('a revoked entitlement no longer unlocks the part, but the frozen grant survives', async () => {
    const s = await scenario();
    await prisma.courseSection.update({
      where: { id: s.preMidSecond.id },
      data: { partId: s.part1.id },
    });
    await prisma.coursePartEntitlement.updateMany({
      where: { userId: s.partHolder.id, coursePartId: s.part1.id },
      data: { revokedAt: new Date(), revokedReason: 'test' },
    });

    const holder = await login(app, s.partHolder.phone, 'holder-device');
    const detail = await http(app)
      .get(`${API}/courses/${s.course.id}`)
      .set(holder.headers)
      .expect(200);

    expect(lockMap(detail.body.data.sections)).toEqual({
      'قبل الميد': false,
      'بعد الميد': true,
      'قبل الميد م/احمد العوضي': true,
    });
  });

  it('an archived section inside a held part stays out of the scope', async () => {
    const s = await scenario();
    await prisma.courseSection.update({
      where: { id: s.preMidSecond.id },
      data: { partId: s.part1.id, status: ContentStatus.ARCHIVED },
    });

    const holder = await login(app, s.partHolder.phone, 'holder-device');
    const refused = await http(app)
      .get(`${API}/lessons/${s.preMidSecond.lessons[0]!.id}`)
      .set(holder.headers);
    expect(refused.status).toBeGreaterThanOrEqual(400);
  });
});
