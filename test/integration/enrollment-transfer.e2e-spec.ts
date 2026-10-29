import { INestApplication } from '@nestjs/common';
import {
  AcademicStructureKind,
  AccessDurationType,
  CodeStatus,
  CodeTargetType,
  ContentStatus,
  CourseStatus,
  EnrollmentMethod,
  EnrollmentState,
  PartEntitlementSource,
  PartPricingModel,
  PrismaClient,
  SectionGrantSource,
  UserRole,
  WatchEventType,
} from '@prisma/client';

import { CourseAccessService } from '../../src/modules/courses/course-access.service';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';
import {
  API,
  bootstrapTestApp,
  createUser,
  errorCode,
  http,
  login,
  resetDatabase,
  shutdownTestApp,
} from './helpers';

/**
 * Student-transfer integration tests — against a REAL PostgreSQL.
 *
 * The unit suite (`test/unit/enrollment-transfer.spec.ts`) proves the service's
 * logic against a stateful fake. What only a real database can prove is here:
 *
 *  - `withSerializableRetry` really runs the transfer at SERIALIZABLE
 *    (MONEY_TX_OPTIONS) and Prisma really rolls the whole thing back when a
 *    step throws — the profile move, the destination grant, the part
 *    entitlement, the source revocation, the counters and the audit rows
 *    commit or roll back TOGETHER;
 *  - two concurrent transfers of the same enrollment cannot both apply: one
 *    commits, the other is either answered as already-transferred or refused
 *    with CONFLICT, and the final state holds no duplicate grant, entitlement
 *    or audit row;
 *  - a repeat of a completed transfer changes nothing — not one financial,
 *    redemption or watch-history row.
 *
 * Guard: `test/integration/setup.ts` refuses a DATABASE_URL whose database
 * name does not end in `_test` and truncates every table per test. This spec
 * is local-only by construction; never point it at a shared database.
 */

let app: INestApplication;
let prisma: PrismaClient;

beforeAll(async () => {
  ({ app, prisma } = await bootstrapTestApp());
});

afterAll(async () => {
  await shutdownTestApp();
});

// -----------------------------------------------------------------------------
// Scenario fixture — the real migration this operation was built for
// -----------------------------------------------------------------------------

interface Scenario {
  admin: { id: string; phone: string };
  teacher: { id: string; phone: string };
  student: { id: string };
  mansoura: { id: string };
  sinai: { id: string };
  mansouraFaculty: { id: string };
  sinaiFaculty: { id: string };
  mansouraDepartment: { id: string };
  sinaiPrograms: { id: string };
  level000: { id: string };
  sourceCourse: { id: string };
  destinationCourse: { id: string };
  sourcePart: { id: string };
  sourceSection: { id: string };
  destinationPart1: { id: string };
  destinationSection1: { id: string };
  destinationPart2: { id: string };
  destinationSection2: { id: string };
  sourceLesson: { id: string };
  sourceVideo: { id: string };
  sourceEnrollment: { id: string };
}

/**
 * Builds the whole graph with real rows: two universities, two engineering
 * faculties, a platform LEVEL ladder with "Level 000", a Mansoura source
 * course (Part 1 with one section, a lesson, a video) and a Sinai destination
 * course (Part 1 and Part 2, each with one section). The student holds a
 * section-scoped CODE enrollment of the source's Part 1, paid for with a
 * 600 EGP part code: the redemption, the purchase and the entitlement are
 * seeded as HISTORY the transfer must not touch.
 */
async function seedScenario(): Promise<Scenario> {
  const admin = await createUser(prisma, { role: UserRole.ADMIN, fullName: 'Test Admin Full Name' });
  const teacher = await createUser(prisma, {
    role: UserRole.TEACHER,
    fullName: 'Test Teacher Full Name',
  });
  const student = await createUser(prisma, { fullName: 'Test Student Full Name' });

  const [mansoura, sinai] = await Promise.all([
    prisma.university.create({
      data: { name: 'Mansoura University', nameAr: 'جامعة المنصورة' },
    }),
    prisma.university.create({ data: { name: 'Sinai University', nameAr: 'جامعة سيناء' } }),
  ]);

  const mansouraFaculty = await prisma.faculty.create({
    data: { universityId: mansoura.id, name: 'Faculty of Engineering', nameAr: 'كلية الهندسة' },
  });
  const sinaiFaculty = await prisma.faculty.create({
    data: { universityId: sinai.id, name: 'Faculty of Engineering', nameAr: 'كلية الهندسة' },
  });

  const mansouraDepartment = await prisma.department.create({
    data: { facultyId: mansouraFaculty.id, name: 'Mechanical', nameAr: 'ميكانيكا' },
  });
  const sinaiPrograms = await prisma.department.create({
    data: { facultyId: sinaiFaculty.id, name: 'Programs', nameAr: 'برامج' },
  });

  const structure = await prisma.academicStructure.create({
    data: { scopeKey: 'platform', kind: AcademicStructureKind.LEVEL },
  });
  const level000 = await prisma.academicYear.create({
    data: { structureId: structure.id, order: 0, name: 'Level 000', nameAr: 'مستوى 000' },
  });

  // --- source course: Mansoura Engineering Drawing (B) ----------------------
  const sourceCourse = await prisma.course.create({
    data: {
      slug: `source-${Date.now().toString(36)}`,
      title: 'Engineering Drawing (B)',
      status: CourseStatus.PUBLISHED,
      publishedAt: new Date(),
      universityId: mansoura.id,
      facultyId: mansouraFaculty.id,
      enrollmentMethods: [EnrollmentMethod.CODE],
      accessDurationType: AccessDurationType.LIFETIME,
    },
  });
  const sourcePart = await prisma.coursePart.create({
    data: {
      courseId: sourceCourse.id,
      title: 'Part 1',
      sortOrder: 1,
      pricingModel: PartPricingModel.FIXED,
      priceAmount: 600,
    },
  });
  const sourceSection = await prisma.courseSection.create({
    data: {
      courseId: sourceCourse.id,
      partId: sourcePart.id,
      title: 'Before Midterm',
      sortOrder: 1,
      status: ContentStatus.PUBLISHED,
    },
  });
  const sourceLesson = await prisma.lesson.create({
    data: {
      courseId: sourceCourse.id,
      sectionId: sourceSection.id,
      title: 'Orthographic projection',
      sortOrder: 1,
      status: ContentStatus.PUBLISHED,
      durationSeconds: 600,
    },
  });
  const sourceVideo = await prisma.video.create({
    data: {
      lessonId: sourceLesson.id,
      courseId: sourceCourse.id,
      status: 'READY',
      hlsPrefix: `hls/${sourceLesson.id}/`,
      masterPlaylistKey: `hls/${sourceLesson.id}/master.m3u8`,
      durationSeconds: 600,
      isEncrypted: true,
      encryptionKeyId: 'k1',
      lessonLinks: { create: { lessonId: sourceLesson.id } },
    },
  });

  // --- destination course: Sinai Engineering Drawing (S) --------------------
  const destinationCourse = await prisma.course.create({
    data: {
      slug: `destination-${Date.now().toString(36)}`,
      title: 'Engineering Drawing (S)',
      status: CourseStatus.PUBLISHED,
      publishedAt: new Date(),
      universityId: sinai.id,
      facultyId: sinaiFaculty.id,
      enrollmentMethods: [EnrollmentMethod.CODE, EnrollmentMethod.ADMIN_APPROVAL],
      accessDurationType: AccessDurationType.LIFETIME,
      departments: { create: { departmentId: sinaiPrograms.id } },
    },
  });
  const destinationPart1 = await prisma.coursePart.create({
    data: {
      courseId: destinationCourse.id,
      title: 'Part 1 — Before Mid',
      sortOrder: 1,
      pricingModel: PartPricingModel.FIXED,
      priceAmount: 600,
    },
  });
  const destinationSection1 = await prisma.courseSection.create({
    data: {
      courseId: destinationCourse.id,
      partId: destinationPart1.id,
      title: 'Before Midterm',
      sortOrder: 1,
      status: ContentStatus.PUBLISHED,
    },
  });
  await prisma.lesson.create({
    data: {
      courseId: destinationCourse.id,
      sectionId: destinationSection1.id,
      title: 'Drawing instruments',
      sortOrder: 1,
      status: ContentStatus.PUBLISHED,
      durationSeconds: 600,
    },
  });
  const destinationPart2 = await prisma.coursePart.create({
    data: {
      courseId: destinationCourse.id,
      title: 'Part 2 — After Mid',
      sortOrder: 2,
      pricingModel: PartPricingModel.FIXED,
      priceAmount: 600,
    },
  });
  const destinationSection2 = await prisma.courseSection.create({
    data: {
      courseId: destinationCourse.id,
      partId: destinationPart2.id,
      title: 'After Midterm',
      sortOrder: 2,
      status: ContentStatus.PUBLISHED,
    },
  });

  // --- the student, under the Mansoura chain --------------------------------
  await prisma.studentProfile.create({
    data: {
      userId: student.id,
      universityId: mansoura.id,
      facultyId: mansouraFaculty.id,
      departmentId: mansouraDepartment.id,
      academicYearId: level000.id,
    },
  });

  // --- paid history: one 600 EGP Part-1 code, redeemed once ------------------
  const sourceEnrollment = await prisma.enrollment.create({
    data: {
      userId: student.id,
      courseId: sourceCourse.id,
      state: EnrollmentState.ACTIVE,
      method: EnrollmentMethod.CODE,
      coversAllSections: false,
      accessStartsAt: new Date(Date.now() - 86_400_000),
      accessEndsAt: null,
    },
  });
  // The counter a real join/redemption would have written.
  await prisma.course.update({
    where: { id: sourceCourse.id },
    data: { studentCount: 1 },
  });
  const code = await prisma.accessCode.create({
    data: {
      code: `PART-${Math.random().toString(36).slice(2, 10).toUpperCase()}`,
      courseId: sourceCourse.id,
      coursePartId: sourcePart.id,
      targetType: CodeTargetType.PART,
      status: CodeStatus.EXHAUSTED,
      maxRedemptions: 1,
      redemptionCount: 1,
      priceAmount: 600,
    },
  });
  await prisma.enrollmentSectionGrant.create({
    data: {
      enrollmentId: sourceEnrollment.id,
      sectionId: sourceSection.id,
      source: SectionGrantSource.CODE,
      codeId: code.id,
      partId: sourcePart.id,
    },
  });
  await prisma.accessCodeRedemption.create({
    data: { codeId: code.id, userId: student.id, enrollmentId: sourceEnrollment.id, courseId: sourceCourse.id },
  });
  const purchase = await prisma.coursePartPurchase.create({
    data: {
      userId: student.id,
      courseId: sourceCourse.id,
      coursePartId: sourcePart.id,
      priceAtPurchase: 600,
      pricingModelAtPurchase: PartPricingModel.PERCENTAGE,
      teacherAmount: 0,
      platformAmount: 600,
      partTitleSnapshot: 'Part 1',
      courseTitleSnapshot: 'Engineering Drawing (B)',
      accessCodeId: code.id,
      idempotencyKey: `partcode:${code.id}:${student.id}`,
    },
  });
  await prisma.coursePartEntitlement.create({
    data: {
      userId: student.id,
      courseId: sourceCourse.id,
      coursePartId: sourcePart.id,
      source: PartEntitlementSource.CODE,
      purchaseId: purchase.id,
    },
  });

  // --- live viewing state on the source course ------------------------------
  await prisma.playbackTicket.create({
    data: {
      userId: student.id,
      videoId: sourceVideo.id,
      lessonId: sourceLesson.id,
      courseId: sourceCourse.id,
      watermarkTag: 'wm-test',
      expiresAt: new Date(Date.now() + 300_000),
    },
  });
  await prisma.watchProgress.create({
    data: {
      userId: student.id,
      lessonId: sourceLesson.id,
      courseId: sourceCourse.id,
      percent: 80,
      positionSeconds: 480,
      watchedSeconds: 480,
    },
  });
  await prisma.watchEvent.create({
    data: {
      userId: student.id,
      lessonId: sourceLesson.id,
      courseId: sourceCourse.id,
      videoId: sourceVideo.id,
      type: WatchEventType.PROGRESS,
      positionSeconds: 480,
      deltaSeconds: 30,
    },
  });

  return {
    admin,
    teacher,
    student,
    mansoura,
    sinai,
    mansouraFaculty,
    sinaiFaculty,
    mansouraDepartment,
    sinaiPrograms,
    level000,
    sourceCourse,
    destinationCourse,
    sourcePart,
    sourceSection,
    destinationPart1,
    destinationSection1,
    destinationPart2,
    destinationSection2,
    sourceLesson,
    sourceVideo,
    sourceEnrollment,
  };
}

/** Everything a transfer must never create or change. */
async function financialSnapshot() {
  const [payments, purchases, redemptions, revenue, codes, wallet] = await Promise.all([
    prisma.payment.findMany({ orderBy: { id: 'asc' } }),
    prisma.coursePartPurchase.findMany({ orderBy: { id: 'asc' } }),
    prisma.accessCodeRedemption.findMany({ orderBy: { id: 'asc' } }),
    prisma.revenueLedger.findMany({ orderBy: { id: 'asc' } }),
    prisma.accessCode.findMany({ orderBy: { id: 'asc' } }),
    prisma.walletTransaction.findMany({ orderBy: { id: 'asc' } }),
  ]);
  // Decimal columns compare reliably as their JSON form.
  return JSON.stringify({ payments, purchases, redemptions, revenue, codes, wallet });
}

/**
 * Arms ONE failure inside the next `$transaction` run: the chosen model
 * operation rejects on first use, exactly as a mid-transaction crash would.
 * The proxy passes everything else through untouched, so the transaction
 * path, the isolation level and the retry loop are all the real ones.
 *
 * Returns the disarm function; always call it — even after a failed test.
 */
function injectTxFailure(model: string, operation: string): () => void {
  const target = prisma as unknown as Record<string, unknown>;
  const original = (
    target.$transaction as (
      fn: (tx: unknown) => Promise<unknown>,
      opts?: unknown,
    ) => Promise<unknown>
  ).bind(prisma);

  target.$transaction = (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) =>
    original(
      async (tx: unknown) => {
        const proxied = new Proxy(tx as object, {
          get(txTarget, prop) {
            const value = Reflect.get(txTarget, prop) as unknown;
            if (value === null || (typeof value !== 'function' && typeof value !== 'object')) {
              return value;
            }
            if (typeof value === 'function') return (value as (...a: unknown[]) => unknown).bind(txTarget);
            if (prop !== model) {
              // Other model delegates: bind methods so nothing depends on
              // where the delegate came from.
              return new Proxy(value as object, {
                get(delegate, op) {
                  const method = Reflect.get(delegate, op) as unknown;
                  if (typeof op === 'symbol' || typeof method !== 'function') return method;
                  return (method as (...a: unknown[]) => unknown).bind(delegate);
                },
              });
            }
            return new Proxy(value as object, {
              get(delegate, op) {
                const method = Reflect.get(delegate, op) as unknown;
                if (typeof op === 'symbol' || typeof method !== 'function') return method;
                return (...args: unknown[]) => {
                  if (op === operation) {
                    return Promise.reject(
                      new Error(`injected failure: ${String(model)}.${String(op)}`),
                    );
                  }
                  return (method as (...a: unknown[]) => unknown).apply(delegate, args);
                };
              },
            });
          },
        });
        return fn(proxied);
      },
      opts,
    );

  return () => {
    // Remove the own property so the prototype method is what remains — the
    // client is shared with the rest of the suite and must stay pristine.
    delete target.$transaction;
  };
}

const transferBody = (scenario: Scenario, extra: Record<string, unknown> = {}) => ({
  destinationCourseId: scenario.destinationCourse.id,
  destinationPartId: scenario.destinationPart1.id,
  reason: 'Transfer from Mansoura University Engineering to Sinai University Engineering',
  ...extra,
});

/** The same request as the HTTP body, plus the path parameter — for direct service calls. */
const serviceParams = (scenario: Scenario) => ({
  enrollmentId: scenario.sourceEnrollment.id,
  ...transferBody(scenario),
});

// -----------------------------------------------------------------------------

describe('transferring a student between universities (integration, real PostgreSQL)', () => {
  let scenario: Scenario;

  beforeEach(async () => {
    await resetDatabase(prisma);
    scenario = await seedScenario();
  });

  it('moves access and the academic profile atomically, preserving every financial and history row', async () => {
    const admin = await login(app, scenario.admin.phone ?? '');
    const before = await financialSnapshot();

    const response = await http(app)
      .post(`${API}/admin/enrollments/${scenario.sourceEnrollment.id}/transfer`)
      .set(admin.headers)
      .send(transferBody(scenario))
      .expect(200);

    const body = (response.body.data ?? response.body) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, alreadyTransferred: false });

    // --- destination: exactly one ACTIVE, section-scoped, admin-granted row -
    const destinationEnrollments = await prisma.enrollment.findMany({
      where: { userId: scenario.student.id, courseId: scenario.destinationCourse.id },
    });
    expect(destinationEnrollments).toHaveLength(1);
    expect(destinationEnrollments[0]).toMatchObject({
      state: EnrollmentState.ACTIVE,
      method: EnrollmentMethod.ADMIN_APPROVAL,
      coversAllSections: false,
      approvedById: scenario.admin.id,
      accessEndsAt: null, // the destination course is LIFETIME
    });

    // The granted scope is exactly Part 1's section — never Part 2's.
    const destinationGrants = await prisma.enrollmentSectionGrant.findMany({
      where: { enrollmentId: destinationEnrollments[0].id },
    });
    expect(destinationGrants.map((g) => g.sectionId)).toEqual([scenario.destinationSection1.id]);
    expect(destinationGrants[0]).toMatchObject({
      source: SectionGrantSource.ADMIN,
      partId: scenario.destinationPart1.id,
      codeId: null,
    });

    // --- destination part entitlement: MIGRATION, no purchase ----------------
    const destinationEntitlement = await prisma.coursePartEntitlement.findUnique({
      where: {
        userId_coursePartId: {
          userId: scenario.student.id,
          coursePartId: scenario.destinationPart1.id,
        },
      },
    });
    expect(destinationEntitlement).toMatchObject({
      courseId: scenario.destinationCourse.id,
      source: PartEntitlementSource.MIGRATION,
      purchaseId: null,
      revokedAt: null,
    });

    // --- source: revoked history, grants removed, entitlement kept -----------
    const sourceEnrollment = await prisma.enrollment.findUnique({
      where: { id: scenario.sourceEnrollment.id },
    });
    expect(sourceEnrollment).toMatchObject({
      state: EnrollmentState.REVOKED,
      coversAllSections: false,
      revokedById: scenario.admin.id,
    });
    expect(
      await prisma.enrollmentSectionGrant.count({
        where: { enrollmentId: scenario.sourceEnrollment.id },
      }),
    ).toBe(0);
    const sourceEntitlement = await prisma.coursePartEntitlement.findUnique({
      where: {
        userId_coursePartId: { userId: scenario.student.id, coursePartId: scenario.sourcePart.id },
      },
    });
    expect(sourceEntitlement?.revokedAt).toBeInstanceOf(Date); // additive revocation

    // --- profile follows the destination course ------------------------------
    const profile = await prisma.studentProfile.findUnique({ where: { userId: scenario.student.id } });
    expect(profile).toMatchObject({
      universityId: scenario.sinai.id,
      facultyId: scenario.sinaiFaculty.id,
      departmentId: scenario.sinaiPrograms.id,
      academicYearId: scenario.level000.id, // her rung, validated on the Sinai ladder
    });

    // --- financial history: byte-identical, and nothing new ------------------
    expect(await financialSnapshot()).toBe(before);

    // --- watch history: preserved; destination progress starts empty ---------
    const watchProgress = await prisma.watchProgress.findMany({
      where: { userId: scenario.student.id },
    });
    expect(watchProgress).toHaveLength(1);
    expect(watchProgress[0]).toMatchObject({
      courseId: scenario.sourceCourse.id,
      lessonId: scenario.sourceLesson.id,
      percent: 80,
    });
    const watchEvents = await prisma.watchEvent.findMany({
      where: { userId: scenario.student.id },
    });
    expect(watchEvents).toHaveLength(1); // the historical event row survives

    // --- the live source ticket is dead, but kept as a record ----------------
    const ticket = await prisma.playbackTicket.findFirst({
      where: { userId: scenario.student.id, courseId: scenario.sourceCourse.id },
    });
    expect(ticket).toMatchObject({
      status: 'REVOKED',
      revokedReason: 'Course access transferred',
    });

    // --- counters follow access ---------------------------------------------
    expect(
      (await prisma.course.findUnique({ where: { id: scenario.destinationCourse.id } }))
        ?.studentCount,
    ).toBe(1);
    expect(
      (await prisma.course.findUnique({ where: { id: scenario.sourceCourse.id } }))?.studentCount,
    ).toBe(0);

    // --- audit trail: grant, revocation (with transfer context), profile -----
    const audits = await prisma.auditLog.findMany({ where: { entityId: destinationEnrollments[0].id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: 'ACCESS_GRANT', actorId: scenario.admin.id });
    expect(audits[0].after).toMatchObject({
      transferFromCourseId: scenario.sourceCourse.id,
      transferFromEnrollmentId: scenario.sourceEnrollment.id,
      grantedSectionIds: [scenario.destinationSection1.id],
    });
    const revokeAudit = await prisma.auditLog.findFirst({
      where: { action: 'ACCESS_REVOKE', entityId: scenario.sourceEnrollment.id },
    });
    expect(revokeAudit?.after).toMatchObject({
      transfer: {
        destinationCourseId: scenario.destinationCourse.id,
        destinationPartId: scenario.destinationPart1.id,
      },
    });
    const profileAudit = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE', entity: 'user', entityId: scenario.student.id },
    });
    expect(profileAudit).toBeTruthy();

    // --- the student is told, and the gates agree ----------------------------
    const notification = await prisma.notification.findFirst({
      where: { userId: scenario.student.id },
    });
    expect(notification?.route).toBe(`/course/${scenario.destinationCourse.id}`);

    const access = app.get(CourseAccessService);
    await expect(
      access.isTargetedToStudent(scenario.student.id, scenario.destinationCourse.id, UserRole.STUDENT),
    ).resolves.toBe(true);
    await expect(
      access.isTargetedToStudent(scenario.student.id, scenario.sourceCourse.id, UserRole.STUDENT),
    ).resolves.toBe(false); // targeting closes the old course instantly
    await expect(access.allowedSectionIds(scenario.student.id, scenario.destinationCourse.id)).resolves.toEqual([
      scenario.destinationSection1.id,
    ]);
  });

  it('refuses a teacher at the route and changes nothing', async () => {
    const teacher = await login(app, scenario.teacher.phone ?? '');
    const before = await financialSnapshot();

    const response = await http(app)
      .post(`${API}/admin/enrollments/${scenario.sourceEnrollment.id}/transfer`)
      .set(teacher.headers)
      .send(transferBody(scenario))
      .expect(403);

    expect(errorCode(response.body)).toBe('INSUFFICIENT_ROLE');
    expect(
      (await prisma.enrollment.findUnique({ where: { id: scenario.sourceEnrollment.id } }))?.state,
    ).toBe(EnrollmentState.ACTIVE);
    expect(await prisma.enrollment.count({ where: { courseId: scenario.destinationCourse.id } })).toBe(0);
    expect(await financialSnapshot()).toBe(before);
  });

  it('refuses a section-scoped transfer that names no destination part (422)', async () => {
    const admin = await login(app, scenario.admin.phone ?? '');

    const response = await http(app)
      .post(`${API}/admin/enrollments/${scenario.sourceEnrollment.id}/transfer`)
      .set(admin.headers)
      .send(transferBody(scenario, { destinationPartId: undefined }))
      .expect(422);

    expect(errorCode(response.body)).toBe('VALIDATION_ERROR');
    expect(
      (await prisma.enrollment.findUnique({ where: { id: scenario.sourceEnrollment.id } }))?.state,
    ).toBe(EnrollmentState.ACTIVE);
    expect(await prisma.enrollment.count({ where: { courseId: scenario.destinationCourse.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({ where: { entityId: scenario.student.id, entity: 'user' } }),
    ).toBe(0);
  });

  // --- rollback: an injected crash at each stage leaves NOTHING behind -------

  const rollbackCases: { stage: string; model: string; operation: string }[] = [
    // 1b — after the destination grant, before the source revocation.
    { stage: 'destination part entitlement', model: 'coursePartEntitlement', operation: 'create' },
    // 2 — the source revocation itself (destination grant + entitlement done).
    { stage: 'source revocation', model: 'enrollment', operation: 'updateMany' },
    // 3 — the profile move (grant, entitlement and revocation already done).
    { stage: 'profile move', model: 'studentProfile', operation: 'update' },
    // 4 — the audit write (every state change already applied).
    { stage: 'audit record', model: 'auditLog', operation: 'create' },
  ];

  it.each(rollbackCases)(
    'rolls the profile, grant, entitlement, revocation, counters and audits back when the $stage fails',
    async ({ model, operation }) => {
      const service = app.get(EnrollmentsService);
      const before = await financialSnapshot();

      const disarm = injectTxFailure(model, operation);
      try {
        await expect(
          service.transfer(serviceParams(scenario), { id: scenario.admin.id, role: UserRole.ADMIN }),
        ).rejects.toThrow(`injected failure: ${model}.${operation}`);
      } finally {
        disarm();
      }

      // Nothing of the transfer survived: no destination enrollment, no
      // grants, no entitlement, no profile move, no audit rows, no counters.
      expect(await prisma.enrollment.count({ where: { courseId: scenario.destinationCourse.id } })).toBe(0);
      const sourceEnrollment = await prisma.enrollment.findUnique({
        where: { id: scenario.sourceEnrollment.id },
      });
      expect(sourceEnrollment).toMatchObject({ state: EnrollmentState.ACTIVE });
      expect(
        await prisma.enrollmentSectionGrant.count({
          where: { enrollmentId: scenario.sourceEnrollment.id },
        }),
      ).toBe(1); // her section grant is untouched
      expect(
        await prisma.coursePartEntitlement.count({
          where: { userId: scenario.student.id, revokedAt: null },
        }),
      ).toBe(1); // the original CODE entitlement is still her live one
      expect(
        (await prisma.studentProfile.findUnique({ where: { userId: scenario.student.id } }))
          ?.universityId,
      ).toBe(scenario.mansoura.id);
      expect(await prisma.auditLog.count()).toBe(0);
      expect(
        (await prisma.course.findUnique({ where: { id: scenario.sourceCourse.id } }))?.studentCount,
      ).toBe(1);
      expect(
        (await prisma.playbackTicket.findFirst({
          where: { userId: scenario.student.id, courseId: scenario.sourceCourse.id },
        }))?.status,
      ).toBe('ACTIVE'); // her lesson keeps playing

      // And history is exactly what it was — the rollback deletes nothing.
      expect(await financialSnapshot()).toBe(before);
      expect(await prisma.watchProgress.count({ where: { userId: scenario.student.id } })).toBe(1);
      expect(await prisma.watchEvent.count({ where: { userId: scenario.student.id } })).toBe(1);
    },
  );

  it('lets exactly one of two concurrent transfers apply — no duplicate grant, entitlement or audit row', async () => {
    const service = app.get(EnrollmentsService);
    const actor = { id: scenario.admin.id, role: UserRole.ADMIN };
    const before = await financialSnapshot();

    const outcomes = await Promise.allSettled([
      service.transfer(serviceParams(scenario), actor),
      service.transfer(serviceParams(scenario), actor),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected') as PromiseRejectedResult[];
    expect(fulfilled).toHaveLength(1);
    // The loser is either refused outright (its transaction re-read a revoked
    // source) or retried into the idempotent answer — never a second grant.
    if (rejected.length === 1) {
      expect((rejected[0].reason as { code?: string }).code).toBe('CONFLICT');
    } else {
      expect(
        (fulfilled[1] as PromiseFulfilledResult<{ alreadyTransferred?: boolean }>).value
          .alreadyTransferred,
      ).toBe(true);
    }

    // Final state: exactly one of everything, no duplicates anywhere.
    expect(
      await prisma.enrollment.count({ where: { userId: scenario.student.id } }),
    ).toBe(2); // 1 ACTIVE destination + 1 REVOKED source
    const destinationEnrollments = await prisma.enrollment.findMany({
      where: { userId: scenario.student.id, courseId: scenario.destinationCourse.id },
    });
    expect(destinationEnrollments).toHaveLength(1);
    expect(
      await prisma.enrollmentSectionGrant.count({
        where: { enrollmentId: destinationEnrollments[0].id },
      }),
    ).toBe(1);
    expect(
      await prisma.coursePartEntitlement.count({
        where: { userId: scenario.student.id, coursePartId: scenario.destinationPart1.id },
      }),
    ).toBe(1);
    expect(
      await prisma.auditLog.count({ where: { action: 'ACCESS_GRANT' } }),
    ).toBe(1);
    expect(
      await prisma.notification.count({ where: { userId: scenario.student.id } }),
    ).toBe(1);

    // Neither racer created or disturbed a financial or history row.
    expect(await financialSnapshot()).toBe(before);
    expect(await prisma.watchProgress.count({ where: { userId: scenario.student.id } })).toBe(1);
  });

  it('answers a repeat of a completed transfer idempotently, changing nothing', async () => {
    const admin = await login(app, scenario.admin.phone ?? '');
    const first = await http(app)
      .post(`${API}/admin/enrollments/${scenario.sourceEnrollment.id}/transfer`)
      .set(admin.headers)
      .send(transferBody(scenario))
      .expect(200);
    expect((first.body.data ?? first.body).alreadyTransferred).toBe(false);

    const before = await financialSnapshot();
    const auditCount = await prisma.auditLog.count();

    const repeat = await http(app)
      .post(`${API}/admin/enrollments/${scenario.sourceEnrollment.id}/transfer`)
      .set(admin.headers)
      .send(transferBody(scenario))
      .expect(200);

    const body = (repeat.body.data ?? repeat.body) as Record<string, unknown>;
    expect(body).toMatchObject({ ok: true, alreadyTransferred: true });
    expect(await financialSnapshot()).toBe(before);
    expect(await prisma.auditLog.count()).toBe(auditCount); // no second grant audit
    expect(
      await prisma.enrollment.count({ where: { userId: scenario.student.id } }),
    ).toBe(2);
    expect(
      await prisma.coursePartEntitlement.count({
        where: { userId: scenario.student.id, coursePartId: scenario.destinationPart1.id },
      }),
    ).toBe(1);
  });
});
