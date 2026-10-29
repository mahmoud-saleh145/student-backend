import { EnrollmentMethod, EnrollmentState, PaymentStatus, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';

/**
 * Transferring a student's course access — `EnrollmentsService.transfer`.
 *
 * The scenario under test mirrors the real migration this operation was built
 * for: a student who bought Part 1 of one university's Engineering Drawing
 * course moves to another university whose Engineering Drawing course is a
 * separate product with its own parts and sections.
 *
 * The rules under test:
 *  1. the destination enrollment is granted (section-scoped when the source
 *     was, whole-course when the source was) and the source enrollment is
 *     revoked, in ONE transaction — a failing step leaves nothing behind;
 *  2. the student's academic profile follows the destination course, so the
 *     live targeting checks pass for the destination and stop passing for the
 *     source;
 *  3. no Payment, PaymentTransaction, RevenueLedger, AccessCodeRedemption or
 *     CoursePartPurchase row is created and no revenue is recognised — a
 *     transfer is not a purchase;
 *  4. redemptions, part purchases and watch history survive untouched, and
 *     source part entitlements are revoked additively (rows stay);
 *  5. the destination part entitlement is recorded with source MIGRATION and
 *     no purchase;
 *  6. the operation is idempotent, refuses concurrent or contradictory state,
 *     and never narrows an existing destination enrollment.
 *
 * The store below is stateful and evaluates the `where` clauses the service
 * actually sends, and the fake `$transaction` snapshots and restores the whole
 * store on throw, so "atomic" is verified rather than assumed.
 */

type Row = Record<string, unknown> & { id: string };

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const TEACHER = { id: 'usr_teacher', role: UserRole.TEACHER };
const STUDENT = 'usr_malak';

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    const value = row[key];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const c = condition as Record<string, unknown>;
      if ('in' in c) return (c.in as unknown[]).includes(value);
      if ('not' in c) return value !== c.not;
      if ('lte' in c) return value != null && (value as number) <= (c.lte as number);
      throw new Error(`fake store: unsupported filter on ${key}: ${JSON.stringify(c)}`);
    }
    return value === condition;
  });
}

function seed() {
  return {
    user: [
      { id: STUDENT, phone: '01026815667', role: UserRole.STUDENT, fullName: 'ملك أشرف محمد' },
    ] as Row[],
    studentProfile: [
      {
        id: 'prf_malak',
        userId: STUDENT,
        universityId: 'uni_mansoura',
        facultyId: 'fac_mansoura_programs',
        departmentId: 'dep_mte',
        academicYearId: 'yr_level000',
      },
    ] as Row[],
    university: [
      { id: 'uni_sinai', name: 'Sinai university', isActive: true, deletedAt: null },
    ] as Row[],
    faculty: [
      { id: 'fac_sinai', universityId: 'uni_sinai', name: 'Faculty of Engineering', isActive: true, deletedAt: null },
    ] as Row[],
    department: [
      { id: 'dep_programs', facultyId: 'fac_sinai', name: 'Programs', isActive: true, deletedAt: null },
    ] as Row[],
    academicYear: [
      { id: 'yr_level000', structureId: 'str_levels', name: 'Level 000', isActive: true },
    ] as Row[],
    course: [
      {
        id: 'crs_mansoura',
        title: 'Engineering Drawing (B)',
        universityId: 'uni_mansoura',
        facultyId: 'fac_mansoura_programs',
        studentCount: 1,
        deletedAt: null,
      },
      {
        id: 'crs_sinai',
        title: 'Engineering Drawing (S)',
        universityId: 'uni_sinai',
        facultyId: 'fac_sinai',
        accessDurationType: 'LIFETIME',
        accessDurationDays: null,
        accessEndsAt: null,
        studentCount: 0,
        deletedAt: null,
      },
    ] as Row[],
    courseDepartment: [
      { id: 'cd_sinai_programs', courseId: 'crs_sinai', departmentId: 'dep_programs' },
    ] as Row[],
    coursePart: [
      {
        id: 'prt_sinai_part1',
        courseId: 'crs_sinai',
        title: 'Part 1 — Before Mid + Revision',
        deletedAt: null,
        sections: [{ id: 'sec_sinai_part1', deletedAt: null, sortOrder: 1 }],
      },
      {
        id: 'prt_sinai_part2',
        courseId: 'crs_sinai',
        title: 'Part 2 — After Mid + Revision',
        deletedAt: null,
        sections: [{ id: 'sec_sinai_part2', deletedAt: null, sortOrder: 2 }],
      },
      {
        id: 'prt_mansoura_part1',
        courseId: 'crs_mansoura',
        title: 'Part 1 — Before Mid + Revision',
        deletedAt: null,
        sections: [{ id: 'sec_mansoura_part1', deletedAt: null, sortOrder: 1 }],
      },
    ] as Row[],
    enrollment: [
      {
        id: 'enr_mansoura',
        userId: STUDENT,
        courseId: 'crs_mansoura',
        state: EnrollmentState.ACTIVE,
        method: EnrollmentMethod.CODE,
        coversAllSections: false,
        accessEndsAt: null,
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
    ] as Row[],
    enrollmentSectionGrant: [
      {
        id: 'grt_src',
        enrollmentId: 'enr_mansoura',
        sectionId: 'sec_mansoura_part1',
        source: 'CODE',
        codeId: 'cod_part',
        partId: 'prt_mansoura_part1',
        createdAt: new Date('2026-10-23'),
      },
    ] as Row[],
    payment: [] as Row[],
    paymentTransaction: [] as Row[],
    revenueLedger: [] as Row[],
    accessCode: [
      { id: 'cod_part', status: 'EXHAUSTED', redemptionCount: 1, maxRedemptions: 1 },
    ] as Row[],
    accessCodeRedemption: [
      {
        id: 'red_src',
        codeId: 'cod_part',
        userId: STUDENT,
        enrollmentId: 'enr_mansoura',
        courseId: 'crs_mansoura',
        redeemedAt: new Date('2026-10-23'),
      },
    ] as Row[],
    coursePartPurchase: [
      {
        id: 'pur_src',
        userId: STUDENT,
        courseId: 'crs_mansoura',
        coursePartId: 'prt_mansoura_part1',
        priceAtPurchase: 600,
        accessCodeId: 'cod_part',
        idempotencyKey: 'partcode:cod_part:usr_malak',
        purchasedAt: new Date('2026-10-23'),
      },
    ] as Row[],
    coursePartEntitlement: [
      {
        id: 'ent_src',
        userId: STUDENT,
        courseId: 'crs_mansoura',
        coursePartId: 'prt_mansoura_part1',
        source: 'CODE',
        purchaseId: 'pur_src',
        revokedAt: null,
        revokedById: null,
        revokedReason: null,
      },
    ] as Row[],
    playbackTicket: [
      { id: 'tkt_src', userId: STUDENT, courseId: 'crs_mansoura', status: 'ACTIVE' },
    ] as Row[],
    watchProgress: [
      { id: 'wp_1', userId: STUDENT, courseId: 'crs_mansoura', lessonId: 'les_1', percent: 80 },
    ] as Row[],
    auditLog: [] as Row[],
  };
}

type Store = ReturnType<typeof seed>;

const tick = () => new Promise((resolve) => setImmediate(resolve));

function buildTx(db: Store) {
  let ids = 0;
  const table = (name: keyof Store) => db[name] as Row[];

  const crud = (name: keyof Store) => ({
    findMany: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      table(name).filter((r) => matches(r, where)),
    ),
    findFirst: jest.fn(async ({ where }: { where?: Record<string, unknown> } = {}) =>
      table(name).find((r) => matches(r, where)) ?? null,
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
    createMany: jest.fn(
      async ({ data, skipDuplicates }: { data: Record<string, unknown>[]; skipDuplicates?: boolean }) => {
        let count = 0;
        for (const row of data) {
          // Honour the only uniqueness grantAccess relies on here, so the
          // fake cannot silently accept a duplicate the real database would
          // reject.
          if (
            skipDuplicates &&
            name === 'enrollmentSectionGrant' &&
            table(name).some(
              (g) =>
                g.enrollmentId === row.enrollmentId && g.sectionId === row.sectionId,
            )
          ) {
            continue;
          }
          table(name).push({ id: `${name}_${++ids}`, ...row });
          count += 1;
        }
        return { count };
      },
    ),
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
    ...Object.fromEntries(
      (['user', 'university', 'faculty', 'department', 'academicYear', 'courseDepartment'] as const).map(
        (name) => [name, crud(name)],
      ),
    ),
    course: {
      ...crud('course'),
      findFirst: jest.fn(
        async ({ where }: { where: { id: string; deletedAt?: null } }) => {
          const row = table('course').find((r) => matches(r, where));
          if (!row) return null;
          return {
            ...row,
            departments: db.courseDepartment
              .filter((d) => d.courseId === row.id)
              .map((d) => ({ departmentId: d.departmentId })),
          };
        },
      ),
    },
    coursePart: {
      ...crud('coursePart'),
      findFirst: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = db.coursePart.find((r) => matches(r, where));
        if (!row) return null;
        const sections = (row.sections as { id: string; deletedAt: null }[]).filter(
          (s) => matches(s as unknown as Row, { deletedAt: null }),
        );
        return { ...row, sections: sections.map((s) => ({ id: s.id })) };
      }),
    },
    studentProfile: {
      ...crud('studentProfile'),
      findUnique: jest.fn(async ({ where }: { where: { userId: string } }) => {
        const row = db.studentProfile.find((r) => r.userId === where.userId);
        return row ? { ...row } : null;
      }),
      update: jest.fn(
        async ({ where, data }: { where: { userId: string }; data: Record<string, unknown> }) => {
          const row = db.studentProfile.find((r) => r.userId === where.userId);
          if (!row) throw new Error('fake store: studentProfile missing');
          Object.assign(row, data);
          return { ...row };
        },
      ),
    },
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
            course: db.course.find((c) => c.id === row.courseId) ?? null,
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
    payment: crud('payment'),
    paymentTransaction: crud('paymentTransaction'),
    revenueLedger: crud('revenueLedger'),
    accessCode: crud('accessCode'),
    accessCodeRedemption: crud('accessCodeRedemption'),
    coursePartPurchase: crud('coursePartPurchase'),
    coursePartEntitlement: {
      ...crud('coursePartEntitlement'),
      findUnique: jest.fn(
        async ({ where }: { where: { userId_coursePartId: { userId: string; coursePartId: string } } }) => {
          const row = db.coursePartEntitlement.find(
            (r) =>
              r.userId === where.userId_coursePartId.userId &&
              r.coursePartId === where.userId_coursePartId.coursePartId,
          );
          return row ? { ...row } : null;
        },
      ),
    },
    playbackTicket: crud('playbackTicket'),
    watchProgress: crud('watchProgress'),
    auditLog: crud('auditLog'),
  };
}

function build(db: Store = seed()) {
  const tx = buildTx(db);
  const prisma = {
    ...tx,
    // Snapshot-and-restore on throw: the real transaction is SERIALIZABLE and
    // all-or-nothing, and several tests below assert exactly that a failure
    // part-way through leaves no partial state. A bare fn(tx) fake would make
    // those assertions meaningless.
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => {
      const snapshot = structuredClone(db);
      try {
        return await fn(tx);
      } catch (error) {
        const restored = structuredClone(snapshot) as Record<string, unknown>;
        const target = db as Record<string, unknown>;
        for (const key of Object.keys(target)) delete target[key];
        Object.assign(db, restored);
        throw error;
      }
    }),
  };

  const audit = {
    record: jest.fn(async () => undefined),
    recordTx: jest.fn(async (t: typeof tx, entry: Record<string, unknown>) => {
      await t.auditLog.create({ data: entry });
    }),
  };

  const access = { assertCanManageCourse: jest.fn(async () => undefined) };
  const notifications = { createForUser: jest.fn(async () => undefined) };
  const catalog = {
    resolveAcademicStructure: jest.fn(async () => ({
      id: 'str_levels',
      kind: 'LEVEL',
      scopeKey: 'platform',
    })),
  };

  const service = new EnrollmentsService(
    prisma as never,
    {} as never,
    access as never,
    {} as never,
    {} as never,
    notifications as never,
    audit as never,
    catalog as never,
  );

  return { db, tx, service, access, notifications, audit, catalog };
}

const enrollment = (db: Store, id: string) => db.enrollment.find((r) => r.id === id)!;

const transferPart1 = {
  enrollmentId: 'enr_mansoura',
  destinationCourseId: 'crs_sinai',
  destinationPartId: 'prt_sinai_part1',
  reason: 'Student transferred to Sinai University Engineering',
};

describe('transferring a section-scoped enrollment to another university’s course', () => {
  it('grants the destination part scope, revokes the source and updates the profile', async () => {
    const { db, service } = build();

    const result = await service.transfer(transferPart1, ADMIN);

    expect(result).toMatchObject({
      ok: true,
      alreadyTransferred: false,
      userId: STUDENT,
      from: { enrollmentId: 'enr_mansoura', courseId: 'crs_mansoura', state: EnrollmentState.REVOKED },
      to: {
        enrollmentId: expect.any(String),
        courseId: 'crs_sinai',
        state: EnrollmentState.ACTIVE,
        coversAllSections: false,
        grantedSectionIds: ['sec_sinai_part1'],
        partId: 'prt_sinai_part1',
        partEntitlementCreated: true,
      },
      profile: {
        universityId: 'uni_sinai',
        facultyId: 'fac_sinai',
        departmentId: 'dep_programs',
        academicYearId: 'yr_level000',
      },
    });

    // Exactly one destination enrollment, section-scoped and admin-granted.
    const destinationEnrollments = db.enrollment.filter((e) => e.courseId === 'crs_sinai');
    expect(destinationEnrollments).toHaveLength(1);
    expect(destinationEnrollments[0]).toMatchObject({
      userId: STUDENT,
      state: EnrollmentState.ACTIVE,
      method: EnrollmentMethod.ADMIN_APPROVAL,
      coversAllSections: false,
      approvedById: ADMIN.id,
    });

    // The source enrollment survives as REVOKED history, its grants removed.
    expect(enrollment(db, 'enr_mansoura')).toMatchObject({
      state: EnrollmentState.REVOKED,
      revokedById: ADMIN.id,
      revokedReason: transferPart1.reason,
      coversAllSections: false,
    });
    expect(db.enrollmentSectionGrant.filter((g) => g.enrollmentId === 'enr_mansoura')).toHaveLength(0);

    // Student counts follow the access change.
    expect(db.course.find((c) => c.id === 'crs_sinai')!.studentCount).toBe(1);
    expect(db.course.find((c) => c.id === 'crs_mansoura')!.studentCount).toBe(0);
  });

  it('grants no access beyond the named destination part', async () => {
    const { db, service } = build();

    await service.transfer(transferPart1, ADMIN);

    const grants = db.enrollmentSectionGrant.filter(
      (g) => (db.enrollment.find((e) => e.id === g.enrollmentId) as Row).courseId === 'crs_sinai',
    );
    expect(grants.map((g) => g.sectionId)).toEqual(['sec_sinai_part1']);
    expect(grants[0]).toMatchObject({ source: 'ADMIN', partId: 'prt_sinai_part1', codeId: null });

    // The destination course's other part has no grants and no entitlement.
    expect(db.enrollmentSectionGrant.some((g) => g.sectionId === 'sec_sinai_part2')).toBe(false);
    expect(
      db.coursePartEntitlement.some(
        (e) => e.coursePartId === 'prt_sinai_part2' && e.revokedAt === null,
      ),
    ).toBe(false);
  });

  it('creates no purchase, payment or revenue — a transfer is not a purchase', async () => {
    const { db, service } = build();
    const paymentsBefore = JSON.stringify(db.payment);
    const purchasesBefore = JSON.stringify(db.coursePartPurchase);
    const revenueBefore = JSON.stringify(db.revenueLedger);
    const redemptionsBefore = JSON.stringify(db.accessCodeRedemption);
    const codesBefore = JSON.stringify(db.accessCode);

    await service.transfer(transferPart1, ADMIN);

    expect(JSON.stringify(db.payment)).toBe(paymentsBefore);
    expect(JSON.stringify(db.coursePartPurchase)).toBe(purchasesBefore);
    expect(JSON.stringify(db.revenueLedger)).toBe(revenueBefore);
    expect(JSON.stringify(db.accessCodeRedemption)).toBe(redemptionsBefore);
    expect(JSON.stringify(db.accessCode)).toBe(codesBefore);
  });

  it('keeps the original redemption, part purchase and watch history intact', async () => {
    const { db, service } = build();

    await service.transfer(transferPart1, ADMIN);

    expect(db.accessCodeRedemption).toHaveLength(1);
    expect(db.accessCodeRedemption[0]).toMatchObject({
      enrollmentId: 'enr_mansoura',
      courseId: 'crs_mansoura',
    });
    expect(db.coursePartPurchase).toHaveLength(1);
    expect(db.coursePartPurchase[0]).toMatchObject({ priceAtPurchase: 600, courseId: 'crs_mansoura' });
    expect(db.watchProgress).toEqual([
      { id: 'wp_1', userId: STUDENT, courseId: 'crs_mansoura', lessonId: 'les_1', percent: 80 },
    ]);
  });

  it('records the destination part entitlement as MIGRATION with no purchase', async () => {
    const { db, service } = build();

    await service.transfer(transferPart1, ADMIN);

    const destinationEntitlement = db.coursePartEntitlement.find(
      (e) => e.coursePartId === 'prt_sinai_part1',
    )!;
    expect(destinationEntitlement).toMatchObject({
      userId: STUDENT,
      courseId: 'crs_sinai',
      source: 'MIGRATION',
      purchaseId: null,
      revokedAt: null,
    });

    // The source entitlement is revoked additively — the row stays.
    const sourceEntitlement = db.coursePartEntitlement.find((e) => e.id === 'ent_src')!;
    expect(sourceEntitlement.revokedAt).toBeInstanceOf(Date);
    expect(sourceEntitlement).toMatchObject({ revokedById: ADMIN.id, revokedReason: transferPart1.reason });
    expect(db.coursePartEntitlement).toHaveLength(2);
  });

  it('stops live playback of the source course and writes a full audit trail', async () => {
    const { db, service } = build();

    const result = await service.transfer(transferPart1, ADMIN);

    expect(result.from.revokedPlaybackTickets).toBe(1);
    expect(db.playbackTicket.find((t) => t.id === 'tkt_src')!.status).toBe('REVOKED');

    const actions = db.auditLog.map((a) => a.action);
    expect(actions).toContain('ACCESS_REVOKE'); // from revokeEnrollmentInTx, with transfer context
    expect(actions).toContain('ACCESS_GRANT'); // destination enrollment
    expect(actions).toContain('UPDATE'); // profile move
    const grant = db.auditLog.find((a) => a.action === 'ACCESS_GRANT')!;
    expect(grant.entityId).toBe(result.to.enrollmentId);
    expect(grant.after).toMatchObject({
      transferFromCourseId: 'crs_mansoura',
      transferFromEnrollmentId: 'enr_mansoura',
      grantedSectionIds: ['sec_sinai_part1'],
    });
    const revoke = db.auditLog.find((a) => a.action === 'ACCESS_REVOKE')!;
    expect(revoke.before).toMatchObject({ userId: STUDENT, courseId: 'crs_mansoura' });
    expect(revoke.after).toMatchObject({
      transfer: { destinationCourseId: 'crs_sinai', destinationPartId: 'prt_sinai_part1' },
    });
  });

  it('notifies the student after the transaction commits', async () => {
    const { service, notifications } = build();

    await service.transfer(transferPart1, ADMIN);

    expect(notifications.createForUser).toHaveBeenCalledWith(
      expect.objectContaining({ userId: STUDENT, kind: 'ENROLLMENT', route: '/course/crs_sinai' }),
    );
  });
});

describe('whole-course transfers', () => {
  it('grants the whole destination course when the source covered the whole course', async () => {
    const db = seed();
    const source = db.enrollment.find((e) => e.id === 'enr_mansoura')!;
    Object.assign(source, { coversAllSections: true });
    const { service } = build(db);

    const result = await service.transfer(
      { enrollmentId: 'enr_mansoura', destinationCourseId: 'crs_sinai', reason: 'Moved universities' },
      ADMIN,
    );

    expect(result.to).toMatchObject({ coversAllSections: true, grantedSectionIds: [], partId: null });
    expect(enrollment(db, result.to.enrollmentId)).toMatchObject({
      state: EnrollmentState.ACTIVE,
      coversAllSections: true,
    });
    // No part involvement at all.
    expect(db.coursePartEntitlement.filter((e) => e.coursePartId === 'prt_sinai_part1')).toHaveLength(0);
  });
});

describe('repeats, races and refusals', () => {
  it('is idempotent: a retry answers alreadyTransferred and changes nothing', async () => {
    const { db, service } = build();
    await service.transfer(transferPart1, ADMIN);
    const snapshot = structuredClone(db);

    const again = await service.transfer(transferPart1, ADMIN);

    expect(again).toMatchObject({
      ok: true,
      alreadyTransferred: true,
      from: { enrollmentId: 'enr_mansoura', courseId: 'crs_mansoura', state: EnrollmentState.REVOKED },
      to: { courseId: 'crs_sinai', state: EnrollmentState.ACTIVE },
    });
    expect(structuredClone(db)).toEqual(snapshot);
  });

  it('refuses a teacher, even one who can manage the course', async () => {
    const { db, service } = build();
    const before = structuredClone(db);

    await expect(service.transfer(transferPart1, TEACHER)).rejects.toMatchObject({
      code: ErrorCode.INSUFFICIENT_ROLE,
    });
    expect(structuredClone(db)).toEqual(before);
  });

  it('refuses when the actor may not manage the destination course', async () => {
    const { db, service, access } = build();
    // First call manages the source course, second the destination.
    access.assertCanManageCourse
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new AppException(ErrorCode.NOT_FOUND, { message: 'Course' }));
    const before = structuredClone(db);

    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
    expect(structuredClone(db)).toEqual(before);
  });

  it('rolls everything back when a payment is authorised at the provider', async () => {
    const db = seed();
    db.payment.push({
      id: 'pay_auth',
      userId: STUDENT,
      courseId: 'crs_mansoura',
      enrollmentId: 'enr_mansoura',
      status: PaymentStatus.AUTHORIZED,
      amount: 600,
      currency: 'EGP',
      refundedAmount: 0,
    });
    const { service } = build(db);
    const before = structuredClone(db);

    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    // The destination grant and the profile change made earlier in the
    // transaction are gone with it: no partial state.
    expect(structuredClone(db)).toEqual(before);
    expect(db.enrollment.some((e) => e.courseId === 'crs_sinai')).toBe(false);
    expect(db.studentProfile.find((p) => p.userId === STUDENT)!.universityId).toBe('uni_mansoura');
  });

  it('aborts when the source enrollment is revoked concurrently, rolling back the grant', async () => {
    const { db, service, catalog } = build();
    // A concurrent operator removes the student between this request's outer
    // checks and its transaction: simulate by revoking via the catalog hook,
    // the last read before the transaction starts.
    catalog.resolveAcademicStructure.mockImplementation(async () => {
      Object.assign(db.enrollment.find((e) => e.id === 'enr_mansoura')!, {
        state: EnrollmentState.REVOKED,
      });
      return { id: 'str_levels', kind: 'LEVEL', scopeKey: 'platform' };
    });

    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.CONFLICT,
    });
    expect(db.enrollment.some((e) => e.courseId === 'crs_sinai')).toBe(false);
    expect(db.studentProfile.find((p) => p.userId === STUDENT)!.universityId).toBe('uni_mansoura');
  });

  it('answers a completed-but-revoked-elsewhere state with INVALID_STATE, not a guess', async () => {
    const db = seed();
    Object.assign(db.enrollment.find((e) => e.id === 'enr_mansoura')!, {
      state: EnrollmentState.REVOKED,
      revokedById: ADMIN.id,
    });
    const { service } = build(db);
    const before = structuredClone(db);

    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(structuredClone(db)).toEqual(before);
  });

  it('refuses a destination course equal to the source course', async () => {
    const { service } = build();
    await expect(
      service.transfer({ ...transferPart1, destinationCourseId: 'crs_mansoura' }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses a section-scoped transfer that names no destination part', async () => {
    const { service } = build();
    await expect(
      service.transfer(
        { enrollmentId: 'enr_mansoura', destinationCourseId: 'crs_sinai', reason: 'Moved universities' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses a destination part that belongs to a different course', async () => {
    const { service } = build();
    await expect(
      service.transfer(
        { ...transferPart1, destinationPartId: 'prt_mansoura_part1' },
        ADMIN,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('refuses a department the destination course is not offered to', async () => {
    const { service } = build();
    await expect(
      service.transfer({ ...transferPart1, departmentId: 'dep_mte' }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });
  });

  it('refuses a rung that does not belong to the destination ladder', async () => {
    const { service, catalog } = build();
    catalog.resolveAcademicStructure.mockResolvedValue({
      id: 'str_other',
      kind: 'YEAR',
      scopeKey: 'faculty:fac_sinai',
    });
    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });

  it('refuses to downgrade a student who already holds the whole destination course', async () => {
    const db = seed();
    db.enrollment.push({
      id: 'enr_sinai_existing',
      userId: STUDENT,
      courseId: 'crs_sinai',
      state: EnrollmentState.ACTIVE,
      method: EnrollmentMethod.PAYMENT,
      coversAllSections: true,
      accessEndsAt: null,
      revokedAt: null,
    });
    const { service } = build(db);
    const before = structuredClone(db);

    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(structuredClone(db)).toEqual(before);
  });

  it('answers an unknown enrollment with NOT_FOUND', async () => {
    const { service } = build();
    await expect(
      service.transfer({ ...transferPart1, enrollmentId: 'enr_missing' }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('answers an unknown destination course with NOT_FOUND', async () => {
    const { service } = build();
    await expect(
      service.transfer({ ...transferPart1, destinationCourseId: 'crs_missing' }, ADMIN),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
  });

  it('refuses a destination course with no academic home (global course)', async () => {
    const db = seed();
    Object.assign(db.course.find((c) => c.id === 'crs_sinai')!, {
      universityId: null,
      facultyId: null,
    });
    const { service } = build(db);

    await expect(service.transfer(transferPart1, ADMIN)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_ERROR,
    });
  });
});
