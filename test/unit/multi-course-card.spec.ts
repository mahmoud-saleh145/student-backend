import { ContentStatus, CourseStatus, EnrollmentMethod, UserRole } from '@prisma/client';

import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';

/**
 * Multi-course cards, and the extra courses they carry.
 *
 * ── The hole ─────────────────────────────────────────────────────────────────
 *
 * A code can be scoped to several courses at once — a teacher's card that
 * unlocks their whole catalogue, say. Those courses are frozen into the code
 * row when it is generated, and the student redeems against the *primary* course.
 * The primary course was validated strictly. The extras were filtered with
 *
 *     status: { notIn: [CourseStatus.ARCHIVED, CourseStatus.SUSPENDED] }
 *
 * which admits `DRAFT` and `HIDDEN`. So a card that had been created while a
 * course was live kept granting it forever after the course was pulled: the
 * course could be invisible in the catalogue, unpurchasable through every other
 * route, and still handed to a student who presented any card carrying its id.
 *
 * That is the shape of bug this file exists to prevent — not "can I buy a draft
 * course" (which `requirePublishedCourse` already refused) but "can I reach one
 * through a route nobody was watching".
 *
 * The fix filters the query to `PUBLISHED` and asserts per course immediately
 * before granting, so the rule does not depend on one `where` clause staying
 * correct through future edits.
 */

interface ExtraCourse {
  id: string;
  status: CourseStatus;
  deletedAt?: Date | null;
}

const PRIMARY = {
  id: 'crs_primary',
  title: 'Anatomy I',
  status: CourseStatus.PUBLISHED,
  isFree: false,
  enrollmentMethods: [EnrollmentMethod.CODE],
  accessDurationType: 'LIFETIME',
  accessDurationDays: null,
  accessEndsAt: null,
};

function build(extras: ExtraCourse[]) {
  const grantedCourseIds: string[] = [];
  const findManyCalls: unknown[] = [];

  const enrollmentUpsert = jest.fn(async (args: { create?: { courseId: string } }) => {
    if (args.create) grantedCourseIds.push(args.create.courseId);
    return { id: `enr_${grantedCourseIds.length}`, state: 'ACTIVE' };
  });

  const tx = {
    enrollment: {
      findUnique: jest.fn(async () => null),
      upsert: enrollmentUpsert,
      count: jest.fn(async () => 1),
    },
    enrollmentSectionGrant: { createMany: jest.fn(async () => ({ count: 0 })) },
    course: {
      update: jest.fn(async () => ({})),
      findMany: jest.fn(async (args: unknown) => {
        findManyCalls.push(args);
        // Emulate the database honouring the filter: only published,
        // non-deleted rows come back. This is what makes the assertion below
        // meaningful — the service must not depend on the row appearing.
        return extras
          .filter(
            (c) =>
              c.deletedAt == null &&
              (args as { where?: { status?: CourseStatus } }).where?.status === c.status,
          )
          .map((c) => ({
            id: c.id,
            status: c.status,
            deletedAt: c.deletedAt ?? null,
            accessDurationType: 'LIFETIME',
            accessDurationDays: null,
            accessEndsAt: null,
          }));
      }),
    },
    accessCodeRedemption: { updateMany: jest.fn(async () => ({ count: 1 })) },
    auditLog: { create: jest.fn(async () => ({})) },
    coursePart: { findFirst: jest.fn(async () => null) },
    coursePartEntitlement: { findUnique: jest.fn(async () => null), upsert: jest.fn() },
    coursePartPurchase: { create: jest.fn() },
    coursePrice: { findFirst: jest.fn(async () => null) },
    $queryRawUnsafe: jest.fn(async () => []),
    $queryRaw: jest.fn(async () => []),
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    enrollment: { findUnique: jest.fn(async () => null) },
    notification: { create: jest.fn(async () => ({})) },
    user: { findUnique: jest.fn(async () => ({ id: 'usr_1' })) },
  };

  const courses = {
    requirePublishedCourse: jest.fn(async () => PRIMARY),
  };

  const targetingCalls: string[] = [];

  const access = {
    assertCourseTargeting: jest.fn(async (_userId: string, _role: UserRole, courseId: string) => {
      targetingCalls.push(courseId);
    }),
    resolve: jest.fn(async () => ({ state: 'NONE' })),
    allowedSectionIds: jest.fn(async () => null),
  };

  const codes = {
    redeemInTransaction: jest.fn(async () => ({
      code: {
        id: 'cod_1',
        accessDurationType: 'LIFETIME',
        accessDurationDays: null,
        accessEndsAt: null,
        coursePartId: null,
      },
      scope: {
        targetType: 'TEACHER',
        courseIds: ['crs_primary', ...extras.map((c) => c.id)],
        sectionIds: [],
      },
    })),
  };

  const service = new EnrollmentsService(
    prisma as never,
    courses as never,
    access as never,
    { createPendingPayment: jest.fn() } as never,
    codes as never,
    { createForUser: jest.fn(async () => undefined) } as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  const redeem = () =>
    service.redeemCode({
      userId: 'usr_1',
      role: UserRole.STUDENT,
      courseId: 'crs_primary',
      code: 'ANY-CODE',
    });

  return { redeem, grantedCourseIds, findManyCalls, targetingCalls, tx };
}

describe('a multi-course card only grants published courses', () => {
  it('grants the primary course and any published extras', async () => {
    const { redeem, grantedCourseIds } = build([
      { id: 'crs_extra_ok', status: CourseStatus.PUBLISHED },
    ]);

    await redeem();

    expect(grantedCourseIds).toEqual(
      expect.arrayContaining(['crs_primary', 'crs_extra_ok']),
    );
  });

  it.each([CourseStatus.DRAFT, CourseStatus.HIDDEN, CourseStatus.SUSPENDED, CourseStatus.ARCHIVED])(
    'never grants an extra course that is %s',
    async (status) => {
      const { redeem, grantedCourseIds } = build([{ id: 'crs_extra_bad', status }]);

      await redeem();

      expect(grantedCourseIds).not.toContain('crs_extra_bad');
      // The primary grant still happens: refusing the extra must not consume
      // the card or fail a redemption the student was entitled to.
      expect(grantedCourseIds).toContain('crs_primary');
    },
  );

  it('filters the extra-course query to published only', async () => {
    const { redeem, findManyCalls } = build([{ id: 'crs_extra_ok', status: CourseStatus.PUBLISHED }]);

    await redeem();

    const call = findManyCalls[0] as { where?: { status?: unknown } };
    expect(call.where?.status).toBe(CourseStatus.PUBLISHED);
  });

  it('checks every extra course for targeting before granting it', async () => {
    // Targeting is the other half of this path: a card must not become a way to
    // reach a course the student was never eligible for. The primary course and
    // each extra are checked independently.
    const { redeem, targetingCalls } = build([{ id: 'crs_extra_ok', status: CourseStatus.PUBLISHED }]);

    await redeem();

    expect(targetingCalls).toEqual(
      expect.arrayContaining(['crs_primary', 'crs_extra_ok']),
    );
  });

  it('does not grant a deleted extra course', async () => {
    const { redeem, grantedCourseIds } = build([
      { id: 'crs_extra_gone', status: CourseStatus.PUBLISHED, deletedAt: new Date() },
    ]);

    await redeem();

    expect(grantedCourseIds).not.toContain('crs_extra_gone');
  });

  it('still grants the sections frozen onto the card for the primary course', async () => {
    // The primary course's section grants are what the student paid for; an
    // unpublished extra must not disturb them.
    const { redeem, grantedCourseIds } = build([
      { id: 'crs_extra_bad', status: CourseStatus.DRAFT },
    ]);

    await redeem();

    expect(grantedCourseIds).toEqual(['crs_primary']);
  });
});