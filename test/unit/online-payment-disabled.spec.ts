import { CourseStatus, EnrollmentMethod } from '@prisma/client';

import { CourseAccessService } from '../../src/modules/courses/course-access.service';

/**
 * Online payment, dormant.
 *
 * The requirement is precise and easy to satisfy the wrong way: hide the
 * online-payment flow for now, and keep the implementation so it can be turned
 * back on. Deleting the code would satisfy the first half and destroy the
 * second. Hiding it in the mobile app would satisfy neither properly — the app
 * renders exactly the methods this service advertises, so any other client,
 * and the enrolment endpoint itself, would still offer a checkout that cannot
 * complete.
 *
 * So the switch is one server-side read of `payment.provider`, which ships as
 * 'none'. These tests pin both directions, because a flag that cannot be
 * turned back on is just a deletion with extra steps.
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
    // PENDING_PAYMENT used to offer PAYMENT or CODE. With no provider that
    // must not collapse to nothing, or a student stuck mid-payment has no
    // route forward.
    expect(methodsFor('none', ALL, 'PENDING_PAYMENT')).toEqual([EnrollmentMethod.CODE]);
  });

  it('offers nothing for a course that is not published', async () => {
    const service = build('none') as unknown as {
      availableMethods: (s: string, c: EnrollmentMethod[], st: CourseStatus) => EnrollmentMethod[];
    };
    expect(service.availableMethods('NOT_ENROLLED', ALL, CourseStatus.DRAFT)).toEqual([]);
  });
});

describe('the moment a provider is configured', () => {
  it('PAYMENT is offered again, with no code change', async () => {
    // The point of the whole approach. If this test needed the payment module
    // restored to pass, the implementation had been deleted rather than
    // hidden.
    expect(methodsFor('paymob', ALL)).toContain(EnrollmentMethod.PAYMENT);
    expect(methodsFor('stripe', ALL)).toContain(EnrollmentMethod.PAYMENT);
  });

  it('and a part-paid enrolment can retry the payment', async () => {
    expect(methodsFor('paymob', ALL, 'PENDING_PAYMENT')).toEqual([
      EnrollmentMethod.PAYMENT,
      EnrollmentMethod.CODE,
    ]);
  });
});

describe('a course that never offered payment', () => {
  it('is unaffected either way', async () => {
    const configured = [EnrollmentMethod.CODE];
    expect(methodsFor('none', configured)).toEqual([EnrollmentMethod.CODE]);
    expect(methodsFor('paymob', configured)).toEqual([EnrollmentMethod.CODE]);
  });
});
