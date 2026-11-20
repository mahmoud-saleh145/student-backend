import {
  CodeTargetType,
  ContentStatus,
  CourseStatus,
  EnrollmentMethod,
  EnrollmentState,
  UserRole,
} from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import type { CodeValidation } from '../../src/modules/codes/codes.service';
import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';

/**
 * The duplicate-card guard, as `redeemCode` wires it.
 *
 * `redemption-coverage.spec.ts` pins the rule and `codes.service.spec.ts` pins
 * the hook's position. This file pins the piece between them: that
 * `redeemCode` actually hands the hook to the card consumption, and that the
 * facts it gathers — through the transaction's own client — are the right ones.
 * Without it, deleting the one line that passes `beforeConsume` would leave
 * every unit test green and only the database suite would notice.
 *
 * `codes.redeemInTransaction` is replaced by a stand-in that does exactly what
 * the real one does around the hook: run it, and consume only if it returns.
 */

const DAY = 86_400_000;

const COURSE = {
  id: 'crs_1',
  title: 'Mechanics',
  status: CourseStatus.PUBLISHED,
  isFree: false,
  enrollmentMethods: [EnrollmentMethod.CODE],
  accessDurationType: 'LIFETIME',
  accessDurationDays: null as number | null,
  accessEndsAt: null as Date | null,
};

interface World {
  /** The student's enrollment on the course, as the transaction reads it. */
  enrollment?: { state: EnrollmentState; accessEndsAt: Date | null } | null;
  /** `sectionCoverage`'s answer: null is the whole course. */
  covered?: string[] | null;
  /** Does the card's part still exist? */
  partExists?: boolean;
  /** The student's entitlement row for that part, if any. */
  entitlement?: { revokedAt: Date | null } | null;
  /** Sections of the card that are still live in the database. */
  liveSections?: string[];
  course?: Partial<typeof COURSE>;
  card?: Partial<CodeValidation['code']>;
  scope?: Partial<CodeValidation['scope']>;
}

function build(world: World = {}) {
  const course = { ...COURSE, ...world.course };
  const pending: CodeValidation = {
    code: {
      id: 'cod_1',
      courseId: course.id,
      coursePartId: 'part_1',
      accessDurationType: null,
      accessDurationDays: null,
      accessEndsAt: null,
      ...world.card,
    },
    scope: {
      targetType: CodeTargetType.PART,
      courseIds: [course.id],
      sectionIds: ['sec_a', 'sec_b'],
      ...world.scope,
    },
  };

  const enrollment =
    world.enrollment === undefined
      ? { state: EnrollmentState.ACTIVE, accessEndsAt: null }
      : world.enrollment;
  const liveSections = world.liveSections ?? pending.scope.sectionIds ?? [];

  const consumed = jest.fn();
  const enrollmentUpsert = jest.fn(async () => ({ id: 'enr_1', state: 'ACTIVE' }));

  const part = {
    id: 'part_1',
    courseId: course.id,
    title: 'Part 1',
    currency: 'EGP',
    pricingModel: 'PERCENTAGE',
    status: ContentStatus.PUBLISHED,
    isActive: true,
    deletedAt: null,
    course: {
      id: course.id,
      title: course.title,
      status: CourseStatus.PUBLISHED,
      deletedAt: null,
      teachers: [],
    },
  };

  const tx = {
    enrollment: {
      findUnique: jest.fn(async () =>
        enrollment ? { id: 'enr_1', coversAllSections: false, ...enrollment } : null,
      ),
      upsert: enrollmentUpsert,
      count: jest.fn(async () => 1),
    },
    enrollmentSectionGrant: { createMany: jest.fn(async () => ({ count: 0 })) },
    course: { update: jest.fn(async () => ({})), findMany: jest.fn(async () => []) },
    courseSection: {
      findMany: jest.fn(async () => liveSections.map((id) => ({ id }))),
    },
    coursePart: {
      findFirst: jest.fn(async () => (world.partExists === false ? null : part)),
    },
    coursePartEntitlement: {
      findUnique: jest.fn(async () =>
        world.entitlement === undefined ? { id: 'ent_1', revokedAt: null } : world.entitlement,
      ),
      upsert: jest.fn(async () => ({ id: 'ent_1' })),
    },
    coursePartPurchase: { create: jest.fn(async () => ({ id: 'pur_1' })) },
    coursePrice: { findFirst: jest.fn(async () => null) },
    accessCodeRedemption: { updateMany: jest.fn(async () => ({ count: 1 })) },
    auditLog: { create: jest.fn(async () => ({})) },
  };

  const prisma = {
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };

  const sectionCoverage = jest.fn(async () =>
    world.covered === undefined ? ['sec_a', 'sec_b'] : world.covered,
  );
  const access = {
    assertCourseTargeting: jest.fn(async () => undefined),
    // A restricted holder: the older, pre-transaction whole-course refusal
    // does not apply, so everything below is decided by the hook.
    resolve: jest.fn(async () => ({ state: 'ACTIVE' })),
    allowedSectionIds: jest.fn(async () => ['sec_a', 'sec_b']),
    sectionCoverage,
  };

  const codes = {
    redeemInTransaction: jest.fn(
      async (
        _tx: unknown,
        params: { beforeConsume?: (p: CodeValidation) => Promise<void> },
      ) => {
        if (params.beforeConsume) await params.beforeConsume(pending);
        consumed();
        return pending;
      },
    ),
  };

  const service = new EnrollmentsService(
    prisma as never,
    { requirePublishedCourse: jest.fn(async () => course) } as never,
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
      courseId: course.id,
      code: 'ANY-CODE',
    });

  return { redeem, consumed, enrollmentUpsert, sectionCoverage, tx, codes };
}

const refused = { code: ErrorCode.ALREADY_ENROLLED };

describe('redeemCode: the duplicate-card guard is wired in', () => {
  it('hands the hook to the card consumption', async () => {
    const { redeem, codes } = build({ entitlement: null });
    await redeem();
    expect(codes.redeemInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ beforeConsume: expect.any(Function) }),
    );
  });

  it('refuses a part card for a part already held — and consumes nothing', async () => {
    const { redeem, consumed, enrollmentUpsert } = build();
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
    expect(enrollmentUpsert).not.toHaveBeenCalled();
  });

  it('reads coverage through the transaction client, not the pool', async () => {
    const { redeem, sectionCoverage, tx } = build();
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(sectionCoverage).toHaveBeenCalledWith(tx, 'usr_1', 'crs_1');
    expect(tx.coursePartEntitlement.findUnique).toHaveBeenCalled();
  });
});

describe('redeemCode: what the guard lets through', () => {
  it('a part the student does not hold', async () => {
    const { redeem, consumed } = build({ entitlement: null });
    await expect(redeem()).resolves.toMatchObject({ state: 'ACTIVE' });
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('a part whose entitlement was revoked', async () => {
    const { redeem, consumed } = build({ entitlement: { revokedAt: new Date() } });
    await redeem();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('a section on the card the student does not hold', async () => {
    const { redeem, consumed } = build({ covered: ['sec_a'] });
    await redeem();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('no enrollment at all — decided without reading anything else', async () => {
    const { redeem, consumed, sectionCoverage, tx } = build({ enrollment: null });
    await redeem();
    expect(consumed).toHaveBeenCalledTimes(1);
    expect(sectionCoverage).not.toHaveBeenCalled();
    expect(tx.courseSection.findMany).not.toHaveBeenCalled();
  });

  it.each([
    EnrollmentState.PENDING_APPROVAL,
    EnrollmentState.PENDING_PAYMENT,
    EnrollmentState.EXPIRED,
    EnrollmentState.REVOKED,
  ])('an enrollment that is %s', async (state) => {
    const { redeem, consumed } = build({ enrollment: { state, accessEndsAt: null } });
    await redeem();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('a renewal: three days left on a 30-day course', async () => {
    const { redeem, consumed } = build({
      course: { accessDurationType: 'FIXED_DAYS', accessDurationDays: 30 },
      enrollment: {
        state: EnrollmentState.ACTIVE,
        accessEndsAt: new Date(Date.now() + 3 * DAY),
      },
    });
    await redeem();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('a renewal carried by the card itself: its own 90 days on top of 3 left', async () => {
    const { redeem, consumed } = build({
      card: { accessDurationType: 'FIXED_DAYS', accessDurationDays: 90 },
      enrollment: {
        state: EnrollmentState.ACTIVE,
        accessEndsAt: new Date(Date.now() + 3 * DAY),
      },
    });
    await redeem();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it('teacher and whole-course cards — the hook reads nothing for them', async () => {
    for (const targetType of [CodeTargetType.TEACHER, CodeTargetType.COURSE]) {
      const { redeem, consumed, sectionCoverage, tx } = build({
        card: { coursePartId: null },
        scope: { targetType, sectionIds: null },
      });
      await redeem();
      expect(consumed).toHaveBeenCalledTimes(1);
      expect(sectionCoverage).not.toHaveBeenCalled();
      expect(tx.courseSection.findMany).not.toHaveBeenCalled();
    }
  });
});

describe('redeemCode: what the guard refuses', () => {
  it('a duplicate on a 30-day course, entered moments after the first', async () => {
    const { redeem, consumed } = build({
      course: { accessDurationType: 'FIXED_DAYS', accessDurationDays: 30 },
      enrollment: {
        state: EnrollmentState.ACTIVE,
        // Redeemed a minute ago.
        accessEndsAt: new Date(Date.now() + 30 * DAY - 60_000),
      },
    });
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
  });

  it('a card whose own window would only shorten lifetime access', async () => {
    const { redeem, consumed } = build({
      card: { accessDurationType: 'FIXED_DAYS', accessDurationDays: 30 },
    });
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
  });

  it('a part that has been removed, when every section on the card is held', async () => {
    const { redeem, consumed, tx } = build({ partExists: false });
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
    // No part, so no entitlement to look for.
    expect(tx.coursePartEntitlement.findUnique).not.toHaveBeenCalled();
  });

  it('an old card whose extra section has since been withdrawn', async () => {
    // Printed when the part held A and B. B was archived; the student holds
    // the part and A. B must not make this card look as if it carried
    // something new.
    const { redeem, consumed } = build({ liveSections: ['sec_a'], covered: ['sec_a'] });
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
  });

  it('a section card for a section already held', async () => {
    const { redeem, consumed, tx } = build({
      card: { coursePartId: null },
      scope: { targetType: CodeTargetType.SECTION, sectionIds: ['sec_a'] },
    });
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
    expect(tx.coursePart.findFirst).not.toHaveBeenCalled();
  });

  it('any part or section card for a live whole-course holder', async () => {
    const { redeem, consumed } = build({ covered: null, entitlement: null });
    await expect(redeem()).rejects.toMatchObject(refused);
    expect(consumed).not.toHaveBeenCalled();
  });
});
