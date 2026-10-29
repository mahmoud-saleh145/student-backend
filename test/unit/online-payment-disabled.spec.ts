import { CourseStatus, EnrollmentMethod } from '@prisma/client';

import { CourseAccessService } from '../../src/modules/courses/course-access.service';

/**
 * Online payment, permanently off.
 *
 * Owner decision (2026-10-30, Phase 6 §4.1): there are no online payments in
 * Student Center, in any application or on any platform. This spec used to pin
 * both directions of a `payment.provider` switch; the switch is gone. The
 * getter is hard-coded false, PAYMENT_PROVIDER is locked to 'none' at boot
 * (env-validation.spec.ts pins that), and these tests pin that no
 * configuration value — not even one that names a provider — can bring the
 * PAYMENT method back. The implementation is still not deleted: Payment rows,
 * the offline admin-confirmation flow and the enrolment contract are intact,
 * and no-online-payments.spec.ts covers the rest of the surface.
 */

function build(provider: string) {
  return new CourseAccessService(
    null as never,
    null as never,
    { get: (key: string) => (key === 'payment.provider' ? provider : undefined) } as never,
  );
}

/** `availableMethods` is private; this is the seam the callers actually use. */
function methodsFor(
  provider: string,
  configured: EnrollmentMethod[],
  state: 'NOT_ENROLLED' | 'PENDING_PAYMENT' | 'ACTIVE' = 'NOT_ENROLLED',
): EnrollmentMethod[] {
  const service = build(provider) as unknown as {
    availableMethods: (
      state: string,
      configured: EnrollmentMethod[],
      courseStatus: CourseStatus,
    ) => EnrollmentMethod[];
  };
  return service.availableMethods(state, configured, CourseStatus.PUBLISHED);
}

const ALL = [
  EnrollmentMethod.FREE,
  EnrollmentMethod.PAYMENT,
  EnrollmentMethod.CODE,
  EnrollmentMethod.ADMIN_APPROVAL,
];

describe('with no payment provider configured', () => {
  it('does not offer PAYMENT', async () => {
    expect(methodsFor('none', ALL)).not.toContain(EnrollmentMethod.PAYMENT);
  });

  it('still offers every other method the course is configured for', async () => {
    // The filter must be surgical. Dropping CODE alongside PAYMENT would
    // leave a paid course with no way in at all.
    expect(methodsFor('none', ALL)).toEqual([
      EnrollmentMethod.FREE,
      EnrollmentMethod.CODE,
      EnrollmentMethod.ADMIN_APPROVAL,
    ]);
  });

  it('leaves CODE as the way to finish a part-paid enrolment', async () => {
    // PENDING_PAYMENT used to offer PAYMENT or CODE. With online payment gone
    // that must not collapse to nothing, or a student stuck mid-payment has no
    // route forward: the admin confirms the offline payment, or the student
    // redeems a code.
    expect(methodsFor('none', ALL, 'PENDING_PAYMENT')).toEqual([EnrollmentMethod.CODE]);
  });

  it('offers nothing for a course that is not published', async () => {
    const service = build('none') as unknown as {
      availableMethods: (s: string, c: EnrollmentMethod[], st: CourseStatus) => EnrollmentMethod[];
    };
    expect(service.availableMethods('NOT_ENROLLED', ALL, CourseStatus.DRAFT)).toEqual([]);
  });
});

describe('even if a provider value somehow reaches the config', () => {
  // Inverted on 2026-10-30 (Phase 6 §4.1). This block used to prove the
  // opposite — that setting PAYMENT_PROVIDER brought PAYMENT back with no code
  // change. The owner's decision is that no configuration may ever do that, so
  // the same probe now pins the refusal. env.validation.ts already rejects
  // these values at boot; this is the second, independent barrier.
  it('PAYMENT is still not offered', async () => {
    expect(methodsFor('paymob', ALL)).not.toContain(EnrollmentMethod.PAYMENT);
    expect(methodsFor('stripe', ALL)).not.toContain(EnrollmentMethod.PAYMENT);
    expect(methodsFor('paymob', ALL)).toEqual([
      EnrollmentMethod.FREE,
      EnrollmentMethod.CODE,
      EnrollmentMethod.ADMIN_APPROVAL,
    ]);
  });

  it('a part-paid enrolment still gets CODE only, never a payment retry', async () => {
    expect(methodsFor('paymob', ALL, 'PENDING_PAYMENT')).toEqual([EnrollmentMethod.CODE]);
    expect(methodsFor('stripe', ALL, 'PENDING_PAYMENT')).toEqual([EnrollmentMethod.CODE]);
  });
});

describe('a course that never offered payment', () => {
  it('is unaffected either way', async () => {
    const configured = [EnrollmentMethod.CODE];
    expect(methodsFor('none', configured)).toEqual([EnrollmentMethod.CODE]);
    expect(methodsFor('paymob', configured)).toEqual([EnrollmentMethod.CODE]);
  });
});
