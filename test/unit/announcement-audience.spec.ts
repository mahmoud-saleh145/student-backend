import { AccountStatus, EnrollmentState, UserRole } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import {
  MAX_IDS_PER_DIMENSION,
  assertValidAudienceRule,
  compileAudience,
  ruleFromLegacyColumns,
  targetsEveryone,
} from '../../src/modules/notifications/audience';

/**
 * The audience compiler.
 *
 * This is the code that decides who receives a broadcast, so the tests are
 * mostly about the two ways it can be wrong in opposite directions: matching
 * nobody when it should match someone, and matching everybody when it should
 * match a few. The first wastes a send; the second cannot be taken back.
 *
 * Every test here runs without a database, which is the reason the compiler is
 * a pure function in the first place.
 */

describe('defaults', () => {
  it('targets active, non-deleted students when given nothing', () => {
    const where = compileAudience({});

    expect(where).toMatchObject({
      deletedAt: null,
      status: AccountStatus.ACTIVE,
      role: { in: [UserRole.STUDENT] },
    });
  });

  it('never reaches deleted accounts, whatever else is asked for', () => {
    const where = compileAudience({
      roles: [UserRole.STUDENT, UserRole.TEACHER, UserRole.ADMIN],
      includeInactiveAccounts: true,
    });

    expect(where.deletedAt).toBeNull();
  });

  it('includes suspended accounts only when explicitly asked', () => {
    expect(compileAudience({}).status).toBe(AccountStatus.ACTIVE);
    expect(compileAudience({ includeInactiveAccounts: true }).status).toBeUndefined();
  });
});

describe('combining dimensions', () => {
  it('ORs within a dimension', () => {
    const where = compileAudience({ academicYearIds: ['y2', 'y3'] });

    expect(where.studentProfile).toEqual({ is: { academicYearId: { in: ['y2', 'y3'] } } });
  });

  it('ANDs across dimensions', () => {
    const where = compileAudience({
      academicYearIds: ['y2'],
      facultyIds: ['pharmacy'],
      universityIds: ['cu'],
    });

    // One profile filter carrying all three: a student must satisfy every one.
    expect(where.studentProfile).toEqual({
      is: {
        universityId: { in: ['cu'] },
        facultyId: { in: ['pharmacy'] },
        academicYearId: { in: ['y2'] },
      },
    });
  });

  it('uses `is`, so a user with no student profile fails the filter', () => {
    // A bare nested object would match a null relation vacuously in some
    // shapes; `is` is what makes "second-year students" exclude staff.
    const where = compileAudience({ academicYearIds: ['y2'] });

    expect(where.studentProfile).toHaveProperty('is');
  });

  it('puts course and state in one `some`, not two', () => {
    // Two separate `some` clauses would match a student with an expired
    // pharmacy enrollment and an active unrelated one — the classic bug.
    const where = compileAudience({
      courseIds: ['c1'],
      enrollmentStates: [EnrollmentState.ACTIVE],
    });

    expect(where.enrollments).toEqual({
      some: { state: { in: [EnrollmentState.ACTIVE] }, courseId: { in: ['c1'] } },
    });
  });

  it('defaults enrollment state to ACTIVE when courses are given', () => {
    const where = compileAudience({ courseIds: ['c1'] });

    expect(where.enrollments).toMatchObject({
      some: { state: { in: [EnrollmentState.ACTIVE] } },
    });
  });

  it('reaches students by subject through their enrollments', () => {
    const where = compileAudience({ subjectIds: ['anatomy'] });

    expect(where.enrollments).toMatchObject({
      some: { course: { subjectId: { in: ['anatomy'] } } },
    });
  });

  it('applies exclusions last and unconditionally', () => {
    const where = compileAudience({
      academicYearIds: ['y2'],
      excludeUserIds: ['usr_1', 'usr_2'],
    });

    expect(where.id).toEqual({ notIn: ['usr_1', 'usr_2'] });
  });
});

describe('rules that would match nobody', () => {
  /**
   * The failure this file exists for.
   *
   * `{ in: [] }` is valid Prisma that matches zero rows. A rule carrying an
   * empty dimension would compile, send to nobody, and report success — which
   * looks exactly like a working send. It has to be refused, not compiled.
   */
  it('refuses an empty dimension rather than matching nobody', () => {
    expect(() => compileAudience({ academicYearIds: [] })).toThrow();

    try {
      compileAudience({ academicYearIds: [] });
    } catch (e) {
      const error = e as { code: ErrorCode; fields?: Record<string, string[]> };
      expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
      expect(error.fields?.academicYearIds?.[0]).toContain('Empty list');
    }
  });

  it('reports every empty dimension at once, not just the first', () => {
    try {
      assertValidAudienceRule({ academicYearIds: [], facultyIds: [], courseIds: [] });
      throw new Error('should have thrown');
    } catch (e) {
      const error = e as { fields?: Record<string, string[]> };
      expect(Object.keys(error.fields ?? {}).sort()).toEqual([
        'academicYearIds',
        'courseIds',
        'facultyIds',
      ]);
    }
  });

  it('refuses an enrollment state with nothing to be enrolled in', () => {
    // "Anyone whose enrollment is expired" is not an audience; expired in what?
    expect(() =>
      compileAudience({ enrollmentStates: [EnrollmentState.EXPIRED] }),
    ).toThrow();
  });

  it('accepts an omitted dimension as "any"', () => {
    expect(() => compileAudience({ academicYearIds: undefined })).not.toThrow();
  });
});

describe('rules that would match too many', () => {
  it('refuses a dimension over the id limit', () => {
    const tooMany = Array.from({ length: MAX_IDS_PER_DIMENSION + 1 }, (_, i) => `c${i}`);

    expect(() => compileAudience({ courseIds: tooMany })).toThrow();
  });

  it('flags a rule that filters on nothing', () => {
    // Not an error — "everyone" is legitimate — but the caller must be able to
    // tell it apart from a rule whose filters were dropped by a client bug.
    expect(targetsEveryone({})).toBe(true);
    expect(targetsEveryone({ roles: [UserRole.STUDENT] })).toBe(true);
    expect(targetsEveryone({ academicYearIds: ['y2'] })).toBe(false);
  });
});

describe('legacy announcements', () => {
  it('reads the old columns as a rule, so there is one evaluation path', () => {
    expect(
      ruleFromLegacyColumns({
        courseId: 'c1',
        universityId: 'cu',
        academicYearId: null,
      }),
    ).toEqual({ courseIds: ['c1'], universityIds: ['cu'] });
  });

  it('turns all-null columns into an empty rule, meaning everyone', () => {
    const rule = ruleFromLegacyColumns({
      courseId: null,
      universityId: null,
      academicYearId: null,
    });

    expect(rule).toEqual({});
    expect(targetsEveryone(rule)).toBe(true);
  });
});
