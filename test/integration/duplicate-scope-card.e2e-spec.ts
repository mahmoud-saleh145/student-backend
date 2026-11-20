import type { INestApplication } from '@nestjs/common';
import {
  AccessDurationType,
  CodeStatus,
  CodeTargetType,
  ContentStatus,
  EnrollmentMethod,
  EnrollmentState,
  PartPricingModel,
  PrismaClient,
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
 * A part or section card must not be spent on nothing.
 *
 * Before this suite existed, a student who typed a second card for a part they
 * already held — or a section card for a section inside a part they held — was
 * answered 200: the card flipped to EXHAUSTED, a redemption row was written,
 * and nothing they could open had changed. The money for that card was gone.
 *
 * The refusal now happens inside the redemption transaction, after the card is
 * validated and before it is consumed. These tests drive the real route against
 * a real database, because the two properties that matter cannot be shown with
 * a mocked client:
 *
 *   1. a refused card is byte-for-byte unspent and can still be sold to, and
 *      redeemed by, someone else; and
 *   2. two different cards for the same part, presented at the same instant by
 *      the same student, spend exactly one card.
 *
 * Half of the file is the other direction: everything that used to redeem and
 * DID give the student something still redeems.
 */
describe('duplicate part and section cards', () => {
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
    const session = await login(app, user.phone, deviceKey);
    return { user, session };
  }

  /**
   * Two parts. Part 1 holds sections A and B, Part 2 holds section C. Section
   * D belongs to no part and is sold only by its own card.
   */
  async function scenario(
    options: {
      accessDurationType?: AccessDurationType;
      accessDurationDays?: number | null;
    } = {},
  ) {
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const course = await createCourse(prisma, {
      teacherId: teacher.id,
      price: 1000,
      enrollmentMethods: [EnrollmentMethod.CODE],
      accessDurationType: options.accessDurationType,
      accessDurationDays: options.accessDurationDays,
      sections: [
        { title: 'A', lessons: 1 },
        { title: 'B', lessons: 1 },
        { title: 'C', lessons: 1 },
        { title: 'D', lessons: 1 },
      ],
    });
    const [a, b, c, d] = course.sections;

    const part1 = await prisma.coursePart.create({
      data: {
        courseId: course.id,
        title: 'Part 1',
        sortOrder: 1,
        pricingModel: PartPricingModel.PERCENTAGE,
        pricePercent: 60,
        sections: { connect: [{ id: a!.id }, { id: b!.id }] },
      },
    });
    const part2 = await prisma.coursePart.create({
      data: {
        courseId: course.id,
        title: 'Part 2',
        sortOrder: 2,
        pricingModel: PartPricingModel.PERCENTAGE,
        pricePercent: 40,
        sections: { connect: { id: c!.id } },
      },
    });

    return { course, a: a!, b: b!, c: c!, d: d!, part1, part2 };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;
  type Session = Awaited<ReturnType<typeof student>>['session'];

  /** A fresh, unredeemed card, the way the dashboard prints one. */
  const card = (
    s: Scenario,
    data: {
      code: string;
      targetType: CodeTargetType;
      sectionId?: string;
      coursePartId?: string;
      grantedSectionIds: string[];
      maxRedemptions?: number;
    },
  ) =>
    prisma.accessCode.create({
      data: {
        code: data.code,
        courseId: s.course.id,
        targetType: data.targetType,
        sectionId: data.sectionId ?? null,
        coursePartId: data.coursePartId ?? null,
        grantedSectionIds: data.grantedSectionIds,
        grantedCourseIds: [s.course.id],
        maxRedemptions: data.maxRedemptions ?? 1,
        redemptionCount: 0,
        status: CodeStatus.ACTIVE,
      },
    });

  const part1Card = (s: Scenario, code: string, maxRedemptions = 1) =>
    card(s, {
      code,
      targetType: CodeTargetType.PART,
      coursePartId: s.part1.id,
      grantedSectionIds: [s.a.id, s.b.id],
      maxRedemptions,
    });
  const part2Card = (s: Scenario, code: string) =>
    card(s, {
      code,
      targetType: CodeTargetType.PART,
      coursePartId: s.part2.id,
      grantedSectionIds: [s.c.id],
    });
  const sectionCard = (s: Scenario, code: string, sectionId: string) =>
    card(s, {
      code,
      targetType: CodeTargetType.SECTION,
      sectionId,
      grantedSectionIds: [sectionId],
    });
  const courseCard = (s: Scenario, code: string) =>
    card(s, {
      code,
      targetType: CodeTargetType.COURSE,
      grantedSectionIds: [s.a.id, s.b.id, s.c.id, s.d.id],
    });

  const redeem = (s: Scenario, session: Session, code: string) =>
    http(app).post(`${API}/courses/${s.course.id}/redeem`).set(session.headers).send({ code });

  /** Everything a redemption writes, so "unspent" can be asserted exactly. */
  async function footprint(s: Scenario, userId: string) {
    const [codes, redemptions, purchases, entitlements, enrollment, audits] = await Promise.all([
      prisma.accessCode.findMany({
        where: { courseId: s.course.id },
        select: { code: true, status: true, redemptionCount: true },
        orderBy: { code: 'asc' },
      }),
      prisma.accessCodeRedemption.count({ where: { userId } }),
      prisma.coursePartPurchase.count({ where: { userId } }),
      prisma.coursePartEntitlement.findMany({
        where: { userId, revokedAt: null },
        select: { coursePartId: true },
        orderBy: { coursePartId: 'asc' },
      }),
      prisma.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId: s.course.id } },
        select: {
          state: true,
          coversAllSections: true,
          accessStartsAt: true,
          accessEndsAt: true,
          sectionGrants: { select: { sectionId: true }, orderBy: { sectionId: 'asc' } },
        },
      }),
      prisma.auditLog.count({ where: { actorId: userId, action: 'CODE_REDEEM' } }),
    ]);
    return { codes, redemptions, purchases, entitlements, enrollment, audits };
  }

  const cardRow = (code: string) =>
    prisma.accessCode.findUniqueOrThrow({
      where: { code },
      select: { status: true, redemptionCount: true },
    });

  async function expectRefusedUnspent(
    s: Scenario,
    who: Awaited<ReturnType<typeof student>>,
    code: string,
  ) {
    const before = await footprint(s, who.user.id);
    const res = await redeem(s, who.session, code);
    expect(res.status).toBe(409);
    expect(errorCode(res.body)).toBe('ALREADY_ENROLLED');
    expect(await footprint(s, who.user.id)).toEqual(before);
    expect(await cardRow(code)).toEqual({ status: CodeStatus.ACTIVE, redemptionCount: 0 });
  }

  // ---------------------------------------------------------------------------
  // Refused, and the card is left unspent
  // ---------------------------------------------------------------------------

  describe('refused without spending the card', () => {
    it('a second card for a part the student already holds', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await expectRefusedUnspent(s, buyer, 'PART1CARD002');
    });

    it('a section card for a section inside a part the student holds', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await sectionCard(s, 'SECTIONCARDA1', s.a.id);
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await expectRefusedUnspent(s, buyer, 'SECTIONCARDA1');
    });

    it('a second card for a section the student already bought by card', async () => {
      const s = await scenario();
      await sectionCard(s, 'SECTIONCARDD1', s.d.id);
      await sectionCard(s, 'SECTIONCARDD2', s.d.id);
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'SECTIONCARDD1').expect(200);
      await expectRefusedUnspent(s, buyer, 'SECTIONCARDD2');
    });

    it('a section a part gained after the part was bought', async () => {
      // Part ownership is live: a section added to Part 1 later is already the
      // holder's, so a card for it buys nothing either.
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await sectionCard(s, 'SECTIONCARDD1', s.d.id);
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await prisma.courseSection.update({ where: { id: s.d.id }, data: { partId: s.part1.id } });

      await expectRefusedUnspent(s, buyer, 'SECTIONCARDD1');
    });

    it('part and section cards presented by a whole-course holder', async () => {
      const s = await scenario();
      await courseCard(s, 'COURSECARD001');
      await part1Card(s, 'PART1CARD001');
      await sectionCard(s, 'SECTIONCARDD1', s.d.id);
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'COURSECARD001').expect(200);
      await expectRefusedUnspent(s, buyer, 'PART1CARD001');
      await expectRefusedUnspent(s, buyer, 'SECTIONCARDD1');
    });

    it('a duplicate on a fixed-length course, entered right after the first', async () => {
      // The window restarts at redemption, so the second card would end a few
      // milliseconds later than the first. That is not a renewal.
      const s = await scenario({
        accessDurationType: AccessDurationType.FIXED_DAYS,
        accessDurationDays: 30,
      });
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await expectRefusedUnspent(s, buyer, 'PART1CARD002');
    });

    it('a card whose own access window would only shorten what is held', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      await prisma.accessCode.update({
        where: { code: 'PART1CARD002' },
        data: { accessDurationType: AccessDurationType.FIXED_DAYS, accessDurationDays: 30 },
      });
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await expectRefusedUnspent(s, buyer, 'PART1CARD002');
      // Lifetime access was not cut down to 30 days.
      expect((await footprint(s, buyer.user.id)).enrollment!.accessEndsAt).toBeNull();
    });

    it('an old card whose extra section has since been archived', async () => {
      // Printed when Part 1 held A and B. B is then withdrawn; a student who
      // holds the part must not lose an old card to a section nobody can open.
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await prisma.courseSection.update({
        where: { id: s.b.id },
        data: { status: ContentStatus.ARCHIVED },
      });
      await card(s, {
        code: 'PART1NEWCARD1',
        targetType: CodeTargetType.PART,
        coursePartId: s.part1.id,
        grantedSectionIds: [s.a.id],
      });
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1NEWCARD1').expect(200);
      await expectRefusedUnspent(s, buyer, 'PART1CARD001');
    });

    it('a card for a part that has since been removed, when its sections are held', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await prisma.coursePart.update({ where: { id: s.part1.id }, data: { deletedAt: new Date() } });

      await expectRefusedUnspent(s, buyer, 'PART1CARD002');
    });

    it('a refused card is still good for the next student', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const holder = await student('holder-device');
      const friend = await student('friend-device');

      await redeem(s, holder.session, 'PART1CARD001').expect(200);
      await expectRefusedUnspent(s, holder, 'PART1CARD002');

      await redeem(s, friend.session, 'PART1CARD002').expect(200);
      expect(await cardRow('PART1CARD002')).toEqual({
        status: CodeStatus.EXHAUSTED,
        redemptionCount: 1,
      });
      expect((await footprint(s, friend.user.id)).entitlements).toEqual([
        { coursePartId: s.part1.id },
      ]);
    });

    it('a multi-use part card keeps its remaining uses when a holder retypes another', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1MULTI01', 3);
      const holder = await student('holder-device');
      const other = await student('other-device');

      await redeem(s, holder.session, 'PART1CARD001').expect(200);

      const before = await footprint(s, holder.user.id);
      const res = await redeem(s, holder.session, 'PART1MULTI01');
      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('ALREADY_ENROLLED');
      expect(await footprint(s, holder.user.id)).toEqual(before);
      expect(await cardRow('PART1MULTI01')).toEqual({ status: CodeStatus.ACTIVE, redemptionCount: 0 });

      await redeem(s, other.session, 'PART1MULTI01').expect(200);
      expect(await cardRow('PART1MULTI01')).toEqual({ status: CodeStatus.ACTIVE, redemptionCount: 1 });
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency
  // ---------------------------------------------------------------------------

  describe('two cards at the same instant', () => {
    it('spends exactly one of two cards for the same part', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      const results = await Promise.all([
        redeem(s, buyer.session, 'PART1CARD001'),
        redeem(s, buyer.session, 'PART1CARD002'),
      ]);

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
      const refused = results.find((r) => r.status === 409)!;
      expect(errorCode(refused.body)).toBe('ALREADY_ENROLLED');

      const after = await footprint(s, buyer.user.id);
      expect(after.redemptions).toBe(1);
      expect(after.purchases).toBe(1);
      expect(after.audits).toBe(1);
      expect(after.entitlements).toEqual([{ coursePartId: s.part1.id }]);
      expect(after.codes.filter((c) => c.status === CodeStatus.EXHAUSTED)).toHaveLength(1);
      expect(after.codes.filter((c) => c.status === CodeStatus.ACTIVE)).toHaveLength(1);
      expect(after.codes.reduce((sum, c) => sum + c.redemptionCount, 0)).toBe(1);
    });

    it('spends exactly one of two cards for the same part on a fixed-length course', async () => {
      // The loser is retried a few milliseconds after the winner committed and
      // would "extend" the window by that much. It must still be refused.
      const s = await scenario({
        accessDurationType: AccessDurationType.FIXED_DAYS,
        accessDurationDays: 30,
      });
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      const results = await Promise.all([
        redeem(s, buyer.session, 'PART1CARD001'),
        redeem(s, buyer.session, 'PART1CARD002'),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const after = await footprint(s, buyer.user.id);
      expect(after.redemptions).toBe(1);
      expect(after.purchases).toBe(1);
      expect(after.codes.reduce((sum, c) => sum + c.redemptionCount, 0)).toBe(1);
    });

    it('spends exactly one of a part card and a card for a section inside it', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await sectionCard(s, 'SECTIONCARDA1', s.a.id);
      const buyer = await student('buyer-device');

      const results = await Promise.all([
        redeem(s, buyer.session, 'PART1CARD001'),
        redeem(s, buyer.session, 'SECTIONCARDA1'),
      ]);

      // Either order is a correct history. Part first: the section card is
      // refused. Section first: the part card still adds section B and the
      // entitlement, so both are honestly spent.
      const statuses = results.map((r) => r.status).sort();
      const after = await footprint(s, buyer.user.id);
      const spent = after.codes.reduce((sum, c) => sum + c.redemptionCount, 0);

      expect(after.redemptions).toBe(spent);
      expect(after.entitlements).toEqual([{ coursePartId: s.part1.id }]);
      if (statuses[1] === 409) {
        expect(statuses).toEqual([200, 409]);
        expect(spent).toBe(1);
        expect(await cardRow('SECTIONCARDA1')).toEqual({
          status: CodeStatus.ACTIVE,
          redemptionCount: 0,
        });
      } else {
        expect(statuses).toEqual([200, 200]);
        expect(spent).toBe(2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Still redeems — existing entitlement rules are unchanged
  // ---------------------------------------------------------------------------

  describe('still redeems', () => {
    it('a first part card, then the other part, then a loose section', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part2Card(s, 'PART2CARD001');
      await sectionCard(s, 'SECTIONCARDD1', s.d.id);
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await redeem(s, buyer.session, 'PART2CARD001').expect(200);
      await redeem(s, buyer.session, 'SECTIONCARDD1').expect(200);

      const after = await footprint(s, buyer.user.id);
      expect(after.redemptions).toBe(3);
      expect(after.purchases).toBe(2);
      expect(after.entitlements.map((e) => e.coursePartId).sort()).toEqual(
        [s.part1.id, s.part2.id].sort(),
      );
      expect(after.enrollment).toMatchObject({
        state: EnrollmentState.ACTIVE,
        coversAllSections: false,
      });
      expect(after.enrollment!.sectionGrants.map((g) => g.sectionId).sort()).toEqual(
        [s.a.id, s.b.id, s.c.id, s.d.id].sort(),
      );
      expect(after.codes.every((c) => c.status === CodeStatus.EXHAUSTED)).toBe(true);
    });

    it('a part card after its sections were bought one by one — the part itself is new', async () => {
      const s = await scenario();
      await sectionCard(s, 'SECTIONCARDA1', s.a.id);
      await sectionCard(s, 'SECTIONCARDB1', s.b.id);
      await part1Card(s, 'PART1CARD001');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'SECTIONCARDA1').expect(200);
      await redeem(s, buyer.session, 'SECTIONCARDB1').expect(200);
      await redeem(s, buyer.session, 'PART1CARD001').expect(200);

      const after = await footprint(s, buyer.user.id);
      expect(after.entitlements).toEqual([{ coursePartId: s.part1.id }]);
      expect(after.purchases).toBe(1);
      expect(await cardRow('PART1CARD001')).toEqual({
        status: CodeStatus.EXHAUSTED,
        redemptionCount: 1,
      });
    });

    it('a whole-course card on top of a part — it widens to the whole course', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await courseCard(s, 'COURSECARD001');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await redeem(s, buyer.session, 'COURSECARD001').expect(200);

      expect((await footprint(s, buyer.user.id)).enrollment).toMatchObject({
        state: EnrollmentState.ACTIVE,
        coversAllSections: true,
      });
    });

    it('a teacher card on top of a part — it widens to the whole course', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      const lead = await prisma.courseTeacher.findFirstOrThrow({
        where: { courseId: s.course.id },
        select: { teacherId: true },
      });
      await prisma.accessCode.create({
        data: {
          code: 'TEACHERCARD01',
          targetType: CodeTargetType.TEACHER,
          teacherId: lead.teacherId,
          grantedCourseIds: [s.course.id],
          maxRedemptions: 1,
          redemptionCount: 0,
          status: CodeStatus.ACTIVE,
        },
      });
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await redeem(s, buyer.session, 'TEACHERCARD01').expect(200);

      expect((await footprint(s, buyer.user.id)).enrollment).toMatchObject({
        state: EnrollmentState.ACTIVE,
        coversAllSections: true,
      });
    });

    it('a part card on a pending join request — it activates that part only', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      const buyer = await student('buyer-device');
      await prisma.enrollment.create({
        data: {
          userId: buyer.user.id,
          courseId: s.course.id,
          state: EnrollmentState.PENDING_APPROVAL,
          method: EnrollmentMethod.ADMIN_APPROVAL,
        },
      });

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);

      const after = await footprint(s, buyer.user.id);
      expect(after.enrollment).toMatchObject({
        state: EnrollmentState.ACTIVE,
        coversAllSections: false,
      });
      expect(after.entitlements).toEqual([{ coursePartId: s.part1.id }]);
    });

    it('a part card after the part entitlement was revoked', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await prisma.coursePartEntitlement.update({
        where: { userId_coursePartId: { userId: buyer.user.id, coursePartId: s.part1.id } },
        data: { revokedAt: new Date(), revokedReason: 'test' },
      });

      await redeem(s, buyer.session, 'PART1CARD002').expect(200);
      expect((await footprint(s, buyer.user.id)).entitlements).toEqual([
        { coursePartId: s.part1.id },
      ]);
    });

    it('a part card when access has lapsed — it re-activates', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await prisma.enrollment.update({
        where: { userId_courseId: { userId: buyer.user.id, courseId: s.course.id } },
        data: { accessEndsAt: new Date(Date.now() - DAY) },
      });

      await redeem(s, buyer.session, 'PART1CARD002').expect(200);
      const after = await footprint(s, buyer.user.id);
      expect(after.enrollment).toMatchObject({ state: EnrollmentState.ACTIVE, accessEndsAt: null });
      expect(await cardRow('PART1CARD002')).toEqual({
        status: CodeStatus.EXHAUSTED,
        redemptionCount: 1,
      });
    });

    it('a part card after the enrollment was revoked', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await prisma.enrollment.update({
        where: { userId_courseId: { userId: buyer.user.id, courseId: s.course.id } },
        data: { state: EnrollmentState.REVOKED, revokedAt: new Date() },
      });

      await redeem(s, buyer.session, 'PART1CARD002').expect(200);
      expect((await footprint(s, buyer.user.id)).enrollment).toMatchObject({
        state: EnrollmentState.ACTIVE,
      });
    });

    it('a renewal on a time-limited course — a second card extends the window', async () => {
      const s = await scenario({
        accessDurationType: AccessDurationType.FIXED_DAYS,
        accessDurationDays: 30,
      });
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      // Three days of access left.
      const soon = new Date(Date.now() + 3 * DAY);
      await prisma.enrollment.update({
        where: { userId_courseId: { userId: buyer.user.id, courseId: s.course.id } },
        data: { accessEndsAt: soon },
      });

      await redeem(s, buyer.session, 'PART1CARD002').expect(200);
      const after = await footprint(s, buyer.user.id);
      expect(after.enrollment!.accessEndsAt!.getTime()).toBeGreaterThan(soon.getTime() + 20 * DAY);
      expect(await cardRow('PART1CARD002')).toEqual({
        status: CodeStatus.EXHAUSTED,
        redemptionCount: 1,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // The older refusals are untouched
  // ---------------------------------------------------------------------------

  describe('unchanged refusals', () => {
    it('the same card twice is still CODE_ALREADY_USED', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1MULTI01', 3);
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1MULTI01').expect(200);
      const res = await redeem(s, buyer.session, 'PART1MULTI01');
      expect(res.status).toBe(409);
      expect(errorCode(res.body)).toBe('CODE_ALREADY_USED');
      expect(await cardRow('PART1MULTI01')).toEqual({ status: CodeStatus.ACTIVE, redemptionCount: 1 });
    });

    it('a revoked card is still INVALID_CODE for a holder, not "already held"', async () => {
      const s = await scenario();
      await part1Card(s, 'PART1CARD001');
      await part1Card(s, 'PART1CARD002');
      const buyer = await student('buyer-device');

      await redeem(s, buyer.session, 'PART1CARD001').expect(200);
      await prisma.accessCode.update({
        where: { code: 'PART1CARD002' },
        data: { status: CodeStatus.REVOKED },
      });

      const res = await redeem(s, buyer.session, 'PART1CARD002');
      expect(res.status).toBe(400);
      expect(errorCode(res.body)).toBe('INVALID_CODE');
    });
  });
});
