import type { INestApplication } from '@nestjs/common';
import {
  AccessDurationType,
  CodeStatus,
  CourseStatus,
  EnrollmentState,
  PaymentStatus,
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
 * Money and codes, against a real database.
 *
 * These are the tests that cannot be written against a mock. Three of them
 * depend on actual PostgreSQL behaviour:
 *
 *   • the concurrent-redemption test depends on Serializable isolation and a
 *     unique index actually being enforced;
 *   • the price-history test depends on the append-only write really
 *     appending;
 *   • the archive test depends on `onDelete: Restrict` preventing a delete
 *     that a mock would happily allow.
 */

describe('commerce', () => {
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

  async function fixture(price = 450) {
    const admin = await createUser(prisma, { role: UserRole.ADMIN });
    const teacher = await createUser(prisma, { role: UserRole.TEACHER });
    const student = await createUser(prisma, { role: UserRole.STUDENT });
    await createDevice(prisma, student.id, 'student-device');

    const course = await createCourse(prisma, {
      teacherId: teacher.id,
      price,
      accessDurationType: AccessDurationType.FIXED_DAYS,
      accessDurationDays: 180,
    });

    return {
      admin,
      teacher,
      student,
      course,
      adminSession: await login(app, admin.phone, 'admin-device'),
      teacherSession: await login(app, teacher.phone, 'teacher-device'),
      studentSession: await login(app, student.phone, 'student-device'),
    };
  }

  // ---------------------------------------------------------------------------
  // Price history — spec §28, §71, §73
  // ---------------------------------------------------------------------------

  describe('price changes', () => {
    it('appends a new version instead of overwriting the old one', async () => {
      const { course, teacherSession } = await fixture(450);

      await http(app)
        .post(`${API}/admin/courses/${course.id}/price`)
        .set(teacherSession.headers)
        .send({ amount: 550, reason: 'Demand' })
        .expect(201);

      const prices = await prisma.coursePrice.findMany({
        where: { courseId: course.id },
        orderBy: { version: 'asc' },
      });

      expect(prices).toHaveLength(2);
      expect(Number(prices[0]!.amount)).toBe(450);
      expect(prices[0]!.isCurrent).toBe(false);
      expect(prices[0]!.effectiveTo).not.toBeNull();
      expect(Number(prices[1]!.amount)).toBe(550);
      expect(prices[1]!.isCurrent).toBe(true);
    });

    /**
     * The exact scenario the specification spells out: a student pays 100, the
     * teacher raises the price to 150, and the old transaction must still read
     * 100.
     */
    it('leaves a completed payment untouched when the price later rises', async () => {
      const { course, student, teacherSession, adminSession } = await fixture(100);

      // Buy at 100 and confirm.
      const price = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });

      const enrollment = await prisma.enrollment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          state: EnrollmentState.PENDING_PAYMENT,
          method: 'PAYMENT',
        },
      });

      const payment = await prisma.payment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          enrollmentId: enrollment.id,
          coursePriceId: price.id,
          amount: price.amount,
          currency: 'EGP',
          status: PaymentStatus.PENDING,
          provider: 'MANUAL',
          idempotencyKey: `test-${enrollment.id}`,
        },
      });

      await http(app)
        .post(`${API}/admin/payments/${payment.id}/confirm`)
        .set(adminSession.headers)
        .send({ note: 'Bank transfer' })
        .expect(200);

      // Now raise the price.
      await http(app)
        .post(`${API}/admin/courses/${course.id}/price`)
        .set(teacherSession.headers)
        .send({ amount: 150 })
        .expect(201);

      const stored = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      const ledger = await prisma.revenueLedger.findFirstOrThrow({
        where: { paymentId: payment.id },
      });

      expect(Number(stored.amount)).toBe(100);
      expect(Number(ledger.grossAmount)).toBe(100);

      const current = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });
      expect(Number(current.amount)).toBe(150);
    });

    it('refuses a price change from a teacher without pricing permission', async () => {
      const { course } = await fixture();
      const other = await createUser(prisma, { role: UserRole.TEACHER });
      const session = await login(app, other.phone, 'other-device');

      const response = await http(app)
        .post(`${API}/admin/courses/${course.id}/price`)
        .set(session.headers)
        .send({ amount: 1 });

      expect(response.status).toBeGreaterThanOrEqual(403);
    });

    it('refuses a negative price', async () => {
      const { course, teacherSession } = await fixture();

      const response = await http(app)
        .post(`${API}/admin/courses/${course.id}/price`)
        .set(teacherSession.headers)
        .send({ amount: -10 });

      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // ---------------------------------------------------------------------------
  // Payment capture
  // ---------------------------------------------------------------------------

  describe('payment capture', () => {
    it('is idempotent — a duplicate webhook writes no second revenue row', async () => {
      const { course, student, adminSession } = await fixture(300);

      const price = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });
      const enrollment = await prisma.enrollment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          state: EnrollmentState.PENDING_PAYMENT,
          method: 'PAYMENT',
        },
      });
      const payment = await prisma.payment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          enrollmentId: enrollment.id,
          coursePriceId: price.id,
          amount: price.amount,
          currency: 'EGP',
          status: PaymentStatus.PENDING,
          provider: 'MANUAL',
          idempotencyKey: `test-${enrollment.id}`,
        },
      });

      await http(app)
        .post(`${API}/admin/payments/${payment.id}/confirm`)
        .set(adminSession.headers)
        .send({})
        .expect(200);

      await http(app)
        .post(`${API}/admin/payments/${payment.id}/confirm`)
        .set(adminSession.headers)
        .send({})
        .expect(200);

      const ledgerRows = await prisma.revenueLedger.count({
        where: { paymentId: payment.id },
      });
      expect(ledgerRows).toBe(1);
    });

    it('activates access with the configured duration', async () => {
      const { course, student, adminSession } = await fixture(300);

      const price = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });
      const enrollment = await prisma.enrollment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          state: EnrollmentState.PENDING_PAYMENT,
          method: 'PAYMENT',
        },
      });
      const payment = await prisma.payment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          enrollmentId: enrollment.id,
          coursePriceId: price.id,
          amount: price.amount,
          currency: 'EGP',
          status: PaymentStatus.PENDING,
          provider: 'MANUAL',
          idempotencyKey: `test2-${enrollment.id}`,
        },
      });

      await http(app)
        .post(`${API}/admin/payments/${payment.id}/confirm`)
        .set(adminSession.headers)
        .send({})
        .expect(200);

      const updated = await prisma.enrollment.findUniqueOrThrow({
        where: { id: enrollment.id },
      });

      expect(updated.state).toBe(EnrollmentState.ACTIVE);
      expect(updated.accessEndsAt).not.toBeNull();

      const days = Math.round(
        (updated.accessEndsAt!.getTime() - Date.now()) / 86_400_000,
      );
      expect(days).toBe(180);
    });

    it('is refused to a student confirming their own payment', async () => {
      const { course, student, studentSession } = await fixture(300);

      const price = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });
      const payment = await prisma.payment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          coursePriceId: price.id,
          amount: price.amount,
          currency: 'EGP',
          status: PaymentStatus.PENDING,
          provider: 'MANUAL',
          idempotencyKey: `self-${student.id}`,
        },
      });

      const response = await http(app)
        .post(`${API}/admin/payments/${payment.id}/confirm`)
        .set(studentSession.headers)
        .send({});

      expect(response.status).toBeGreaterThanOrEqual(403);
      const after = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      expect(after.status).toBe(PaymentStatus.PENDING);
    });
  });

  // ---------------------------------------------------------------------------
  // Codes
  // ---------------------------------------------------------------------------

  describe('access codes', () => {
    async function makeCode(courseId: string, adminId: string, maxRedemptions = 1) {
      return prisma.accessCode.create({
        data: {
          code: `TESTCODE${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
          courseId,
          maxRedemptions,
          status: CodeStatus.ACTIVE,
          accessDurationType: AccessDurationType.FIXED_DAYS,
          accessDurationDays: 90,
          issuedById: adminId,
        },
      });
    }

    it('grants access on first redemption', async () => {
      const { course, admin, student, studentSession } = await fixture();
      const code = await makeCode(course.id, admin.id);

      await http(app)
        .post(`${API}/courses/${course.id}/redeem`)
        .set(studentSession.headers)
        .send({ code: code.code })
        .expect(200);

      const enrollment = await prisma.enrollment.findUnique({
        where: { userId_courseId: { userId: student.id, courseId: course.id } },
      });
      expect(enrollment?.state).toBe(EnrollmentState.ACTIVE);
    });

    it('refuses the same single-use code a second time', async () => {
      const { course, admin, studentSession } = await fixture();
      const code = await makeCode(course.id, admin.id);

      await http(app)
        .post(`${API}/courses/${course.id}/redeem`)
        .set(studentSession.headers)
        .send({ code: code.code })
        .expect(200);

      const second = await createUser(prisma, { role: UserRole.STUDENT });
      await createDevice(prisma, second.id, 'second-device');
      const secondSession = await login(app, second.phone, 'second-device');

      const response = await http(app)
        .post(`${API}/courses/${course.id}/redeem`)
        .set(secondSession.headers)
        .send({ code: code.code });

      expect(errorCode(response.body)).toBe('CODE_ALREADY_USED');
    });

    /**
     * The race the unique index and Serializable isolation exist for. Both
     * students submit the same one-use code at the same moment; exactly one
     * must win.
     */
    it('lets exactly one of two simultaneous redemptions succeed', async () => {
      const { course, admin } = await fixture();
      const code = await makeCode(course.id, admin.id, 1);

      const a = await createUser(prisma, { role: UserRole.STUDENT });
      const b = await createUser(prisma, { role: UserRole.STUDENT });
      await createDevice(prisma, a.id, 'dev-a');
      await createDevice(prisma, b.id, 'dev-b');

      const [sa, sb] = await Promise.all([
        login(app, a.phone, 'dev-a'),
        login(app, b.phone, 'dev-b'),
      ]);

      const [ra, rb] = await Promise.all([
        http(app)
          .post(`${API}/courses/${course.id}/redeem`)
          .set(sa.headers)
          .send({ code: code.code }),
        http(app)
          .post(`${API}/courses/${course.id}/redeem`)
          .set(sb.headers)
          .send({ code: code.code }),
      ]);

      const successes = [ra, rb].filter((r) => r.status < 300).length;
      expect(successes).toBe(1);

      const redemptions = await prisma.accessCodeRedemption.count({
        where: { codeId: code.id },
      });
      expect(redemptions).toBe(1);

      const after = await prisma.accessCode.findUniqueOrThrow({ where: { id: code.id } });
      expect(after.redemptionCount).toBe(1);
    });

    it('refuses an expired code', async () => {
      const { course, admin, studentSession } = await fixture();
      const code = await prisma.accessCode.create({
        data: {
          code: 'EXPIREDCODE9',
          courseId: course.id,
          maxRedemptions: 1,
          status: CodeStatus.ACTIVE,
          expiresAt: new Date(Date.now() - 1000),
          issuedById: admin.id,
        },
      });

      const response = await http(app)
        .post(`${API}/courses/${course.id}/redeem`)
        .set(studentSession.headers)
        .send({ code: code.code });

      expect(errorCode(response.body)).toBe('INVALID_CODE');
    });

    it('refuses a code issued for a different course', async () => {
      const { admin, teacher, studentSession, course } = await fixture();
      const other = await createCourse(prisma, { teacherId: teacher.id });
      const code = await makeCode(other.id, admin.id);

      const response = await http(app)
        .post(`${API}/courses/${course.id}/redeem`)
        .set(studentSession.headers)
        .send({ code: code.code });

      expect(errorCode(response.body)).toBe('INVALID_CODE');
    });
  });

  // ---------------------------------------------------------------------------
  // Archive preserves history — spec §30, §47, §92
  // ---------------------------------------------------------------------------

  describe('archiving a course', () => {
    it('keeps payments, revenue and enrollment history intact', async () => {
      const { course, student, admin, adminSession } = await fixture(400);

      const price = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });
      const enrollment = await prisma.enrollment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          state: EnrollmentState.ACTIVE,
          method: 'PAYMENT',
        },
      });
      const payment = await prisma.payment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          enrollmentId: enrollment.id,
          coursePriceId: price.id,
          amount: price.amount,
          currency: 'EGP',
          status: PaymentStatus.PAID,
          provider: 'MANUAL',
          paidAt: new Date(),
          idempotencyKey: `arch-${enrollment.id}`,
        },
      });
      await prisma.revenueLedger.create({
        data: {
          paymentId: payment.id,
          courseId: course.id,
          grossAmount: price.amount,
          teacherAmount: 0,
          platformAmount: price.amount,
          sharePercent: 0,
          currency: 'EGP',
          courseTitleSnapshot: course.title,
        },
      });

      await http(app)
        .post(`${API}/admin/courses/${course.id}/archive`)
        .set(adminSession.headers)
        .send({ reason: 'Semester over' })
        .expect(201);

      expect(await prisma.payment.count({ where: { courseId: course.id } })).toBe(1);
      expect(await prisma.revenueLedger.count({ where: { courseId: course.id } })).toBe(1);
      expect(await prisma.enrollment.count({ where: { courseId: course.id } })).toBe(1);

      const archived = await prisma.course.findUniqueOrThrow({ where: { id: course.id } });
      expect(archived.status).toBe(CourseStatus.ARCHIVED);
      expect(archived.deletedAt).toBeNull();

      void admin;
    });

    it('records an archive snapshot for later reporting', async () => {
      const { course, adminSession } = await fixture();

      await http(app)
        .post(`${API}/admin/courses/${course.id}/archive`)
        .set(adminSession.headers)
        .send({ reason: 'Semester over' })
        .expect(201);

      const record = await prisma.archiveRecord.findFirst({
        where: { courseId: course.id },
      });
      expect(record).not.toBeNull();
    });

    it('cannot be deleted at the database level while a payment references it', async () => {
      // The FK is `onDelete: Restrict`. This test asserts the database itself
      // refuses, not merely that the API declines to offer a delete route.
      const { course, student } = await fixture(400);

      const price = await prisma.coursePrice.findFirstOrThrow({
        where: { courseId: course.id, isCurrent: true },
      });
      await prisma.payment.create({
        data: {
          userId: student.id,
          courseId: course.id,
          coursePriceId: price.id,
          amount: price.amount,
          currency: 'EGP',
          status: PaymentStatus.PAID,
          provider: 'MANUAL',
          paidAt: new Date(),
          idempotencyKey: `restrict-${course.id}`,
        },
      });

      await expect(
        prisma.course.delete({ where: { id: course.id } }),
      ).rejects.toBeDefined();
    });
  });
});
