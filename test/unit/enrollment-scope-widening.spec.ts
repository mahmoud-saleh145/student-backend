import { EnrollmentMethod, EnrollmentState } from '@prisma/client';

import { EnrollmentsService } from '../../src/modules/enrollments/enrollments.service';

/**
 * Section-scoped grants must never inherit whole-course coverage from a row
 * that does not actually hold the whole course.
 *
 * `Enrollment.coversAllSections` defaults to TRUE, so a PENDING_APPROVAL or
 * PENDING_PAYMENT row (written by a join request) and an EXPIRED row both
 * carry `true`. `grantAccess` used to keep that flag on a section-scoped
 * grant, so "request approval, then redeem the cheapest section card" unlocked
 * every section of the course.
 */

const NOW = Date.now();

function build(existing: {
  coversAllSections: boolean;
  state: EnrollmentState;
  accessEndsAt: Date | null;
} | null) {
  const upsert = jest.fn(async (args: { create: { coversAllSections: boolean }; update: { coversAllSections: boolean } }) => ({
    id: 'enr_1',
    ...args.update,
  }));
  const tx = {
    enrollment: {
      findUnique: jest.fn(async () => (existing ? { id: 'enr_1', ...existing } : null)),
      upsert,
      count: jest.fn(async () => 1),
    },
    enrollmentSectionGrant: { createMany: jest.fn(async () => ({ count: 1 })) },
    course: { update: jest.fn(async () => ({})) },
  };

  const service = new EnrollmentsService(
    {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
  );

  const grant = (sectionScope: string[] | null) =>
    service.grantAccess(tx as never, {
      userId: 'usr_1',
      course: { id: 'crs_1', accessDurationType: 'LIFETIME', accessDurationDays: null, accessEndsAt: null },
      method: EnrollmentMethod.CODE,
      sectionScope,
    });

  const writtenCoverage = () => {
    const args = upsert.mock.calls[0]![0];
    return { create: args.create.coversAllSections, update: args.update.coversAllSections };
  };

  return { grant, writtenCoverage, tx };
}

describe('grantAccess coverage widening', () => {
  it.each([
    EnrollmentState.PENDING_APPROVAL,
    EnrollmentState.PENDING_PAYMENT,
    EnrollmentState.EXPIRED,
    EnrollmentState.REVOKED,
  ])('a section card on a %s row grants only that section', async (state) => {
    const { grant, writtenCoverage, tx } = build({ coversAllSections: true, state, accessEndsAt: null });

    await grant(['sec_cheap']);

    expect(writtenCoverage()).toEqual({ create: false, update: false });
    expect(tx.enrollmentSectionGrant.createMany).toHaveBeenCalledTimes(1);
  });

  it('an ACTIVE whole-course row whose access already lapsed is not "live"', async () => {
    const { grant, writtenCoverage } = build({
      coversAllSections: true,
      state: EnrollmentState.ACTIVE,
      accessEndsAt: new Date(NOW - 60_000),
    });

    await grant(['sec_cheap']);

    expect(writtenCoverage().update).toBe(false);
  });

  it('a live whole-course holder keeps the whole course (widen, never narrow)', async () => {
    const { grant, writtenCoverage } = build({
      coversAllSections: true,
      state: EnrollmentState.ACTIVE,
      accessEndsAt: new Date(NOW + 86_400_000),
    });

    await grant(['sec_cheap']);

    expect(writtenCoverage().update).toBe(true);
  });

  it('a course-wide grant always covers everything', async () => {
    const { grant, writtenCoverage } = build({
      coversAllSections: false,
      state: EnrollmentState.PENDING_APPROVAL,
      accessEndsAt: null,
    });

    await grant(null);

    expect(writtenCoverage()).toEqual({ create: true, update: true });
  });

  it('a first-ever section grant is section-scoped', async () => {
    const { grant, writtenCoverage } = build(null);

    await grant(['sec_1']);

    expect(writtenCoverage().create).toBe(false);
  });
});
