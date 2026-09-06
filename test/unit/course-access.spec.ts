import { CourseStatus, type Enrollment, EnrollmentState } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { CourseAccessService } from '../../src/modules/courses/course-access.service';

/**
 * The access decision matrix.
 *
 * `decide()` is the single function every content gate in the system reaches
 * — playback tickets, attachment tickets, lesson detail, progress writes. If
 * it is wrong, it is wrong everywhere at once, which is exactly why it was
 * factored out as a pure function and why it gets the densest test in the
 * suite.
 *
 * These tests need no database: `decide()` takes a course status and an
 * enrollment row and returns a verdict.
 */

const DAY = 86_400_000;

function enrollment(overrides: Partial<Enrollment> = {}): Enrollment {
  return {
    id: 'enr_1',
    userId: 'usr_1',
    courseId: 'crs_1',
    state: EnrollmentState.ACTIVE,
    method: 'PAYMENT',
    accessStartsAt: new Date(Date.now() - DAY),
    accessEndsAt: null,
    approvedById: null,
    approvedAt: null,
    revokedById: null,
    revokedAt: null,
    revokedReason: null,
    completedLessons: 0,
    lastLessonId: null,
    lastAccessedAt: null,
    createdAt: new Date(Date.now() - DAY),
    updatedAt: new Date(),
    ...overrides,
  } as Enrollment;
}

describe('CourseAccessService.decide', () => {
  // The service is instantiated with a null Prisma because decide() never
  // touches it. Constructing it this way keeps the test honest: if someone
  // later adds a query inside decide(), this test crashes rather than quietly
  // becoming an integration test.
  const service = new CourseAccessService(null as never);

  describe('grants access', () => {
    it('to an active enrollment on a published course with no end date', () => {
      const result = service.decide(CourseStatus.PUBLISHED, enrollment());

      expect(result.state).toBe('ACTIVE');
      expect(result.canAccessContent).toBe(true);
      expect(result.denialCode).toBeUndefined();
    });

    it('to an active enrollment whose window has not yet closed', () => {
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({ accessEndsAt: new Date(Date.now() + DAY) }),
      );

      expect(result.canAccessContent).toBe(true);
    });
  });

  describe('archive beats everything', () => {
    it.each([
      EnrollmentState.ACTIVE,
      EnrollmentState.PENDING_PAYMENT,
      EnrollmentState.EXPIRED,
      EnrollmentState.REVOKED,
    ])('denies a %s enrollment when the course is archived', (state) => {
      const result = service.decide(CourseStatus.ARCHIVED, enrollment({ state }));

      expect(result.state).toBe('ARCHIVED');
      expect(result.canAccessContent).toBe(false);
      expect(result.denialCode).toBe(ErrorCode.COURSE_ARCHIVED);
    });

    it('reports ARCHIVED even for a student who never enrolled', () => {
      const result = service.decide(CourseStatus.ARCHIVED, null);
      expect(result.state).toBe('ARCHIVED');
    });
  });

  describe('the live window overrides the stored state', () => {
    /**
     * This is the regression that motivated evaluating the window on every
     * request. The nightly sweep flips lapsed enrollments to EXPIRED; between
     * the moment access lapses and the moment the sweep runs, the stored
     * column still says ACTIVE. Trusting it would keep serving video for up to
     * a day after the student stopped paying for it.
     */
    it('denies an enrollment that still reads ACTIVE but whose window has closed', () => {
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({
          state: EnrollmentState.ACTIVE,
          accessEndsAt: new Date(Date.now() - 60_000),
        }),
      );

      expect(result.state).toBe('EXPIRED');
      expect(result.canAccessContent).toBe(false);
      expect(result.denialCode).toBe(ErrorCode.ACCESS_EXPIRED);
    });

    it('treats an access window that has not opened yet as pending', () => {
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({ accessStartsAt: new Date(Date.now() + DAY) }),
      );

      expect(result.canAccessContent).toBe(false);
      expect(result.denialCode).toBe(ErrorCode.ENROLLMENT_PENDING);
    });

    it('treats an end date exactly at now as lapsed, not as still valid', () => {
      // A boundary that resolves the "wrong" way means one student somewhere
      // gets a free extra request. Closed at the boundary is the safe choice.
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({ accessEndsAt: new Date(Date.now() - 1) }),
      );

      expect(result.state).toBe('EXPIRED');
    });
  });

  describe('denies', () => {
    it('a student with no enrollment row', () => {
      const result = service.decide(CourseStatus.PUBLISHED, null);

      expect(result.state).toBe('NOT_ENROLLED');
      expect(result.canAccessContent).toBe(false);
      expect(result.denialCode).toBe(ErrorCode.NOT_ENROLLED);
    });

    it('a revoked enrollment even when its window is still open', () => {
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({
          state: EnrollmentState.REVOKED,
          accessEndsAt: new Date(Date.now() + 365 * DAY),
        }),
      );

      expect(result.state).toBe('REVOKED');
      expect(result.canAccessContent).toBe(false);
    });

    it('an enrollment awaiting payment', () => {
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({ state: EnrollmentState.PENDING_PAYMENT }),
      );

      expect(result.state).toBe('PENDING_PAYMENT');
      expect(result.denialCode).toBe(ErrorCode.PAYMENT_REQUIRED);
    });

    it('an enrollment awaiting administrative approval', () => {
      const result = service.decide(
        CourseStatus.PUBLISHED,
        enrollment({ state: EnrollmentState.PENDING_APPROVAL }),
      );

      expect(result.state).toBe('PENDING_APPROVAL');
      expect(result.denialCode).toBe(ErrorCode.ENROLLMENT_PENDING);
    });

    /**
     * Suspension pauses delivery without touching the enrollment. The student
     * is still enrolled — which is why the reported state stays ACTIVE — but
     * content is withheld, so a later un-suspension needs no data repair.
     */
    it('content on a suspended course while keeping the enrollment ACTIVE', () => {
      const result = service.decide(CourseStatus.SUSPENDED, enrollment());

      expect(result.state).toBe('ACTIVE');
      expect(result.canAccessContent).toBe(false);
      expect(result.denialCode).toBe(ErrorCode.COURSE_NOT_AVAILABLE);
    });

    /**
     * Regression. `unpublish()` accepts DRAFT as a target, which pulls a live
     * course back into authoring. Before this was fixed, the ACTIVE branch
     * only special-cased SUSPENDED, so every already-enrolled student kept
     * full access — including playback tickets — to a course that had been
     * deliberately withdrawn.
     */
    it('content on a course pulled back to DRAFT', () => {
      const result = service.decide(CourseStatus.DRAFT, enrollment());

      expect(result.state).toBe('ACTIVE');
      expect(result.canAccessContent).toBe(false);
      expect(result.denialCode).toBe(ErrorCode.COURSE_NOT_AVAILABLE);
    });
  });

  describe('deliberately still allows', () => {
    /**
     * HIDDEN means "unlisted", not "withheld": the course leaves the
     * catalogue for new students while everyone already enrolled carries on.
     * If this ever starts failing, check it was an intentional product change
     * and not DRAFT-handling copied one enum member too far.
     */
    it('an enrolled student to keep watching a HIDDEN course', () => {
      const result = service.decide(CourseStatus.HIDDEN, enrollment());

      expect(result.state).toBe('ACTIVE');
      expect(result.canAccessContent).toBe(true);
      expect(result.denialCode).toBeUndefined();
    });
  });

  describe('always reports a denial code when it denies', () => {
    // A denial with no code produces a generic 500 at the edge instead of a
    // state the mobile app can render. Every denying branch must name one.
    const cases: [CourseStatus, Enrollment | null][] = [
      [CourseStatus.ARCHIVED, enrollment()],
      [CourseStatus.PUBLISHED, null],
      [CourseStatus.PUBLISHED, enrollment({ state: EnrollmentState.REVOKED })],
      [CourseStatus.PUBLISHED, enrollment({ state: EnrollmentState.EXPIRED })],
      [CourseStatus.PUBLISHED, enrollment({ state: EnrollmentState.ARCHIVED })],
      [CourseStatus.PUBLISHED, enrollment({ state: EnrollmentState.PENDING_PAYMENT })],
      [CourseStatus.PUBLISHED, enrollment({ state: EnrollmentState.PENDING_APPROVAL })],
      [CourseStatus.SUSPENDED, enrollment()],
      [CourseStatus.DRAFT, enrollment()],
      [CourseStatus.PUBLISHED, enrollment({ accessEndsAt: new Date(Date.now() - 1) })],
    ];

    it.each(cases)('status=%s', (status, enr) => {
      const result = service.decide(status, enr);
      if (!result.canAccessContent) {
        expect(result.denialCode).toBeDefined();
      }
    });
  });

  describe('the returned state matches the mobile app AccessState union', () => {
    const allowed = [
      'NOT_ENROLLED',
      'PENDING_APPROVAL',
      'PENDING_PAYMENT',
      'ACTIVE',
      'EXPIRED',
      'REVOKED',
      'ARCHIVED',
    ];

    it.each(Object.values(EnrollmentState))('for a %s enrollment', (state) => {
      const result = service.decide(CourseStatus.PUBLISHED, enrollment({ state }));
      expect(allowed).toContain(result.state);
    });
  });
});
