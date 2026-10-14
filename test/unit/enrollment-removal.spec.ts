import { ConfigService } from '@nestjs/config';
import { EnrollmentMethod, EnrollmentState, PaymentStatus, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';

/**
 * "Remove from course" — `EnrollmentsService.revoke`.
 *
 * The rule under test: removing a student is an ACCESS decision. It must end
 * access to that one course (and keep it ended — no pending payment, stale
 * section grant or live part entitlement may bring it back), while every
 * financial and academic record survives untouched: paid payments, revenue,
 * code redemptions and the code's own status, watch history, the wallet, and
 * the student's other courses.
 *
 * The store below is stateful and evaluates the `where` clauses the service
 * actually sends for the operations it uses, so a query that targets the wrong
 * rows fails here rather than passing against a canned return value.
 */

type Row = Record<string, unknown> & { id: string };

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const TEACHER = { id: 'usr_teacher', role: UserRole.TEACHER };

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      throw new Error(`fake store: unsupported filter on ${key}: ${JSON.stringify(c)}`);
    }
    return value === condition;
  });
}

function seed() {
  return {
    enrollment: [
      {
        id: 'enr_target',
        userId: 'usr_student',
        courseId: 'crs_a',
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: true,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
      // Same student, another course: must be untouched.
      {
        id: 'enr_other_course',
        userId: 'usr_student',
        courseId: 'crs_b',
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: true,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
      // Another student, same course: must be untouched.
      {
        id: 'enr_classmate',
        userId: 'usr_classmate',
        courseId: 'crs_a',
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: true,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
    ] as Row[],
    enrollmentSectionGrant: [
      { id: 'grt_1', enrollmentId: 'enr_target', sectionId: 'sec_1', source: 'CODE', codeId: 'cod_1', partId: null, createdAt: new Date('2026-09-01') },
      { id: 'grt_other', enrollmentId: 'enr_other_course', sectionId: 'sec_b', source: 'CODE', codeId: 'cod_2', partId: null, createdAt: new Date('2026-09-01') },
    ] as Row[],
    payment: [
      { id: 'pay_paid', userId: 'usr_student', courseId: 'crs_a', enrollmentId: 'enr_target', status: PaymentStatus.PAID, amount: 300, currency: 'EGP', refundedAmount: 0 },
      { id: 'pay_pending', userId: 'usr_student', courseId: 'crs_a', enrollmentId: 'enr_target', status: PaymentStatus.PENDING, amount: 300, currency: 'EGP', refundedAmount: 0 },
      { id: 'pay_other_course', userId: 'usr_student', courseId: 'crs_b', enrollmentId: 'enr_other_course', status: PaymentStatus.PENDING, amount: 100, currency: 'EGP', refundedAmount: 0 },
    ] as Row[],
    paymentTransaction: [] as Row[],
    revenueLedger: [
      { id: 'rev_1', paymentId: 'pay_paid', courseId: 'crs_a', grossAmount: 300 },
    ] as Row[],
    accessCode: [
      { id: 'cod_1', status: 'EXHAUSTED', redemptionCount: 1, maxRedemptions: 1 },
    ] as Row[],
    accessCodeRedemption: [
      { id: 'red_1', codeId: 'cod_1', userId: 'usr_student', enrollmentId: 'enr_target', courseId: 'crs_a' },
    ] as Row[],
    coursePartEntitlement: [
      { id: 'ent_a', userId: 'usr_student', courseId: 'crs_a', coursePartId: 'prt_1', revokedAt: null },
      { id: 'ent_b', userId: 'usr_student', courseId: 'crs_b', coursePartId: 'prt_9', revokedAt: null },
    ] as Row[],
    playbackTicket: [
      { id: 'tkt_a', userId: 'usr_student', courseId: 'crs_a', status: 'ACTIVE' },
      { id: 'tkt_b', userId: 'usr_student', courseId: 'crs_b', status: 'ACTIVE' },
    ] as Row[],
    watchProgress: [
      { id: 'wp_1', userId: 'usr_student', courseId: 'crs_a', lessonId: 'les_1', percent: 80 },
    ] as Row[],
    course: [
      { id: 'crs_a', studentCount: 2 },
      { id: 'crs_b', studentCount: 1 },
    ] as Row[],
    auditLog: [] as Row[],
  };
}

type Store = ReturnType<typeof seed>;

/** Yields to the event loop, so two "concurrent" calls genuinely interleave. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

function buildTx(db: Store) {
  let ids = 0;
  const table = (name: keyof Store) => db[name];

  const crud = (name: keyof Store) => ({
    findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      table(name).filter((r) => matches(r, where)),
    ),
    count: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      table(name).filter((r) => matches(r, where)).length,
    ),
    updateMany: jest.fn(
      async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = table(name).filter((r) => matches(r, where));
        for (const row of hit) Object.assign(row, data);
        return { count: hit.length };
      },
    ),
    deleteMany: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const keep = table(name).filter((r) => !matches(r, where));
      const count = table(name).length - keep.length;
      (db[name] as Row[]) = keep;
      return { count };
    }),
    createMany: jest.fn(async ({ data }: { data: Record<string, unknown>[] }) => {
      for (const row of data) table(name).push({ id: `${name}_${++ids}`, ...row });
      return { count: data.length };
    }),
    create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row = { id: `${name}_${++ids}`, ...data };
      table(name).push(row);
      return row;
    }),
    update: jest.fn(
      async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = table(name).find((r) => r.id === where.id);
        if (!row) throw new Error(`fake store: ${name} ${where.id} missing`);
        Object.assign(row, data);
        return row;
      },
    ),
  });

  return {
    enrollment: {
      ...crud('enrollment'),
      findUnique: jest.fn(
        async ({
          where,
        }: {
          where: { id?: string; userId_courseId?: { userId: string; courseId: string } };
        }) => {
          await tick();
          const row = where.id
            ? db.enrollment.find((r) => r.id === where.id)
            : db.enrollment.find(
                (r) =>
                  r.userId === where.userId_courseId?.userId &&
                  r.courseId === where.userId_courseId?.courseId,
              );
          if (!row) return null;
          return {
            ...row,
            sectionGrants: db.enrollmentSectionGrant
              .filter((g) => g.enrollmentId === row.id)
              .map(({ sectionId, source, codeId, partId, createdAt }) => ({
                sectionId,
                source,
                codeId,
                partId,
                createdAt,
              })),
          };
        },
      ),
      upsert: jest.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { userId_courseId: { userId: string; courseId: string } };
          create: Record<string, unknown>;
          update: Record<string, unknown>;
        }) => {
          const row = db.enrollment.find(
            (r) =>
              r.userId === where.userId_courseId.userId &&
              r.courseId === where.userId_courseId.courseId,
          );
          if (row) return Object.assign(row, update);
          const created = { id: `enr_${++ids}`, ...create } as Row;
          db.enrollment.push(created);
          return created;
        },
      ),
    },
    enrollmentSectionGrant: crud('enrollmentSectionGrant'),
    payment: {
      ...crud('payment'),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = db.payment.find((r) => r.id === where.id);
        return row ? { ...row, course: { id: row.courseId, title: 'Course', teachers: [] }, revenue: [] } : null;
      }),
    },
    paymentTransaction: crud('paymentTransaction'),
    revenueLedger: crud('revenueLedger'),
    accessCode: crud('accessCode'),
    accessCodeRedemption: crud('accessCodeRedemption'),
    coursePartEntitlement: crud('coursePartEntitlement'),
    playbackTicket: crud('playbackTicket'),
    watchProgress: crud('watchProgress'),
    course: crud('course'),
    auditLog: crud('auditLog'),
  };
}

function build(db: Store = seed()) {
  const tx = buildTx(db);
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const audit = {
    record: jest.fn(async () => undefined),
    recordTx: jest.fn(async (t: typeof tx, entry: Record<string, unknown>) => {
      await t.auditLog.create({ data: entry });
    }),
  };

  const service = new EnrollmentsService(
    prisma as never,
    {} as never,
    { assertCanManageCourse: jest.fn(async () => undefined) } as never,
    {} as never,
    {} as never,
    { createForUser: jest.fn(async () => undefined) } as never,
    audit as never,
  );

  const payments = new PaymentsService(
    prisma as never,
    audit as never,
    {} as never,
    new ConfigService({ payment: { defaultPlatformSharePercent: 30 } }),
  );

  return { db, tx, service, payments, audit };
}

const enrollment = (db: Store, id: string) => db.enrollment.find((r) => r.id === id)!;

describe('removing a student from a course', () => {
  it('revokes access to that course only', async () => {
    const { db, service } = build();

    const result = await service.revoke('enr_target', ADMIN, 'Left the group', 'crs_a');

    expect(result).toMatchObject({
      ok: true,
      state: EnrollmentState.REVOKED,
      alreadyRemoved: false,
      userId: 'usr_student',
      courseId: 'crs_a',
    });
    expect(enrollment(db, 'enr_target')).toMatchObject({
      state: EnrollmentState.REVOKED,
      revokedById: ADMIN.id,
      revokedReason: 'Left the group',
    });

    // Their other course and their classmate are untouched.
    expect(enrollment(db, 'enr_other_course').state).toBe(EnrollmentState.ACTIVE);
    expect(enrollment(db, 'enr_classmate').state).toBe(EnrollmentState.ACTIVE);
  });

  it('stops live playback for that course and no other', async () => {
    const { db, service } = build();
    const result = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(result.revokedPlaybackTickets).toBe(1);
    expect(db.playbackTicket.find((t) => t.id === 'tkt_a')!.status).toBe('REVOKED');
    expect(db.playbackTicket.find((t) => t.id === 'tkt_b')!.status).toBe('ACTIVE');
  });

  it('recounts the course student count from ACTIVE enrollments', async () => {
    const { db, service } = build();
    await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(db.course.find((c) => c.id === 'crs_a')!.studentCount).toBe(1);
    expect(db.course.find((c) => c.id === 'crs_b')!.studentCount).toBe(1);
  });

  it('keeps paid payments and recognised revenue exactly as they were (no refund)', async () => {
    const { db, service } = build();
    const result = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(db.payment.find((p) => p.id === 'pay_paid')).toMatchObject({
      status: PaymentStatus.PAID,
      refundedAmount: 0,
    });
    expect(db.revenueLedger).toEqual([
      { id: 'rev_1', paymentId: 'pay_paid', courseId: 'crs_a', grossAmount: 300 },
    ]);
    expect(db.paymentTransaction.some((t) => t.type === 'refund')).toBe(false);
    expect(result.retained.paidPayments).toBe(1);
  });

  it('cancels a pending payment on this enrollment, so a late confirmation cannot restore access', async () => {
    const { db, service, payments } = build();
    const result = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(result.cancelledPayments).toBe(1);
    expect(db.payment.find((p) => p.id === 'pay_pending')!.status).toBe(PaymentStatus.CANCELLED);
    expect(db.paymentTransaction).toEqual([
      expect.objectContaining({ paymentId: 'pay_pending', type: 'cancel', status: 'enrollment_revoked' }),
    ]);
    // The other course's pending payment is not this removal's business.
    expect(db.payment.find((p) => p.id === 'pay_other_course')!.status).toBe(PaymentStatus.PENDING);

    // The existing capture path refuses a cancelled payment, which is what
    // keeps the enrollment REVOKED.
    await expect(payments.capture({ paymentId: 'pay_pending' })).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(enrollment(db, 'enr_target').state).toBe(EnrollmentState.REVOKED);
  });

  it('leaves the code consumed and its redemption on record', async () => {
    const { db, service } = build();
    const result = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(db.accessCode).toEqual([
      { id: 'cod_1', status: 'EXHAUSTED', redemptionCount: 1, maxRedemptions: 1 },
    ]);
    expect(db.accessCodeRedemption).toHaveLength(1);
    expect(result.retained.codeRedemptions).toBe(1);
  });

  it('keeps watch history', async () => {
    const { db, service } = build();
    await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(db.watchProgress).toEqual([
      { id: 'wp_1', userId: 'usr_student', courseId: 'crs_a', lessonId: 'les_1', percent: 80 },
    ]);
  });

  it('revokes part entitlements on this course only, additively', async () => {
    const { db, service } = build();
    const result = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(result.revokedPartEntitlements).toBe(1);
    expect(db.coursePartEntitlement.find((e) => e.id === 'ent_a')).toMatchObject({
      revokedById: ADMIN.id,
      revokedReason: 'Left the group',
    });
    expect(db.coursePartEntitlement.find((e) => e.id === 'ent_a')!.revokedAt).toBeInstanceOf(Date);
    expect(db.coursePartEntitlement.find((e) => e.id === 'ent_b')!.revokedAt).toBeNull();
    expect(db.coursePartEntitlement).toHaveLength(2);
  });

  it('clears the section entitlement and snapshots it in the audit entry', async () => {
    const { db, service } = build();
    const result = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(result.removedSectionGrants).toBe(1);
    expect(enrollment(db, 'enr_target').coversAllSections).toBe(false);
    expect(db.enrollmentSectionGrant.map((g) => g.id)).toEqual(['grt_other']);

    expect(db.auditLog).toHaveLength(1);
    expect(db.auditLog[0]).toMatchObject({
      action: 'ACCESS_REVOKE',
      entity: 'enrollment',
      entityId: 'enr_target',
      note: 'Left the group',
      before: {
        coversAllSections: true,
        sectionGrants: [expect.objectContaining({ sectionId: 'sec_1', codeId: 'cod_1' })],
      },
      after: expect.objectContaining({ cancelledPaymentIds: ['pay_pending'] }),
    });
  });

  it('does not let an old whole-course grant come back with a later one-section card', async () => {
    const { db, tx, service } = build();
    await service.revoke('enr_target', ADMIN, 'Left the group');

    await service.grantAccess(tx as never, {
      userId: 'usr_student',
      course: {
        id: 'crs_a',
        accessDurationType: 'LIFETIME',
        accessDurationDays: null,
        accessEndsAt: null,
      },
      method: EnrollmentMethod.CODE,
      sectionScope: ['sec_2'],
      codeId: 'cod_new',
    });

    expect(enrollment(db, 'enr_target')).toMatchObject({
      state: EnrollmentState.ACTIVE,
      coversAllSections: false,
    });
    expect(
      db.enrollmentSectionGrant
        .filter((g) => g.enrollmentId === 'enr_target')
        .map((g) => g.sectionId),
    ).toEqual(['sec_2']);
  });
});

describe('repeats, races and refusals', () => {
  it('is idempotent: a retry changes nothing and says it was already removed', async () => {
    const { db, service } = build();
    await service.revoke('enr_target', ADMIN, 'Left the group');
    const snapshot = JSON.stringify(db);

    const again = await service.revoke('enr_target', ADMIN, 'Left the group');

    expect(again).toMatchObject({ ok: true, alreadyRemoved: true, cancelledPayments: 0 });
    expect(JSON.stringify(db)).toBe(snapshot);
  });

  it('applies the side effects once when two removals race', async () => {
    const { db, service } = build();

    const [first, second] = await Promise.all([
      service.revoke('enr_target', ADMIN, 'Left the group'),
      service.revoke('enr_target', ADMIN, 'Left the group'),
    ]);

    expect([first.alreadyRemoved, second.alreadyRemoved].sort()).toEqual([false, true]);
    expect(db.paymentTransaction).toHaveLength(1);
    expect(db.auditLog).toHaveLength(1);
  });

  it('answers an unknown enrollment with NOT_FOUND', async () => {
    const { service } = build();
    await expect(service.revoke('enr_missing', ADMIN, 'Left the group')).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('answers an enrollment of a different course with NOT_FOUND and changes nothing', async () => {
    const { db, service } = build();
    const before = JSON.stringify(db);

    await expect(
      service.revoke('enr_other_course', ADMIN, 'Left the group', 'crs_a'),
    ).rejects.toBeInstanceOf(AppException);
    expect(JSON.stringify(db)).toBe(before);
  });

  it('refuses a teacher, even one allowed to view the students', async () => {
    const { db, service } = build();
    const before = JSON.stringify(db);

    await expect(service.revoke('enr_target', TEACHER, 'Left the group')).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_ROLE,
    });
    expect(JSON.stringify(db)).toBe(before);
  });

  it('refuses while a payment is authorised at the provider, leaving everything as it was', async () => {
    const db = seed();
    db.payment.push({
      id: 'pay_auth',
      userId: 'usr_student',
      courseId: 'crs_a',
      enrollmentId: 'enr_target',
      status: PaymentStatus.AUTHORIZED,
      amount: 300,
      currency: 'EGP',
      refundedAmount: 0,
    });
    const { service } = build(db);
    const before = JSON.stringify(db);

    await expect(service.revoke('enr_target', ADMIN, 'Left the group')).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(JSON.stringify(db)).toBe(before);
  });
});
