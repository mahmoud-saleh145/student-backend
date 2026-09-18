import { AccountStatus, EnrollmentState, type Prisma, UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * The audience builder.
 *
 * An audience is a **rule**, not a list. It is stored on the announcement and
 * re-evaluated every time the announcement fires, so a weekly reminder aimed at
 * second-year pharmacy students reaches whoever is a second-year pharmacy
 * student that week. Freezing the list at creation would quietly stop reaching
 * anyone who enrolled afterwards, which reads as a bug rather than a policy.
 *
 * How the dimensions combine:
 *
 *     within a dimension  →  OR    (year 2 OR year 3)
 *     across dimensions   →  AND   (year 2-or-3 AND pharmacy AND enrolled)
 *     exclusions          →  removed last, unconditionally
 *
 * That is the shape people actually describe when they say who a message is
 * for, and it stops short of being a query language — which matters, because a
 * query language reaching the database from an admin form is a much larger
 * thing to secure.
 *
 * **The client never sends a filter.** It sends ids and enum members; this
 * module builds the `where`. Nothing here interpolates a caller-supplied string
 * into a query, and every id lands inside a parameterised `in`.
 */

/** Hard ceiling per dimension, so one request cannot build a vast IN clause. */
export const MAX_IDS_PER_DIMENSION = 200;

/** Refuse to fan out beyond this in one occurrence. */
export const MAX_AUDIENCE_SIZE = 50_000;

export interface AudienceRule {
  /** Defaults to STUDENT. Staff are reachable but must be asked for. */
  roles?: UserRole[];

  universityIds?: string[];
  facultyIds?: string[];
  departmentIds?: string[];
  academicYearIds?: string[];

  /** Enrolled in any of these courses. */
  courseIds?: string[];
  /** Enrollment states that count. Defaults to ACTIVE when courses are given. */
  enrollmentStates?: EnrollmentState[];
  /** Enrolled in any course carrying one of these subjects. */
  subjectIds?: string[];

  /**
   * Include suspended and banned accounts. Off by default: someone whose
   * account is suspended should not be receiving course announcements.
   */
  includeInactiveAccounts?: boolean;

  /** Removed after every other rule has been applied. */
  excludeUserIds?: string[];
}

/** The dimensions that live on the student profile. */
const PROFILE_DIMENSIONS = [
  ['universityIds', 'universityId'],
  ['facultyIds', 'facultyId'],
  ['departmentIds', 'departmentId'],
  ['academicYearIds', 'academicYearId'],
] as const;

const ARRAY_FIELDS: (keyof AudienceRule)[] = [
  'roles',
  'universityIds',
  'facultyIds',
  'departmentIds',
  'academicYearIds',
  'courseIds',
  'enrollmentStates',
  'subjectIds',
  'excludeUserIds',
];

/**
 * Rejects a rule that cannot mean what its author intended.
 *
 * The important case is the empty array. `{ in: [] }` matches nothing, so a
 * rule carrying `academicYearIds: []` would compile cleanly, send to nobody,
 * and report success — the worst failure mode available to a broadcast system,
 * because it looks exactly like a working send. An omitted dimension means
 * "don't filter on this"; an empty one is a mistake, and is refused.
 */
export function assertValidAudienceRule(rule: AudienceRule): void {
  const fields: Record<string, string[]> = {};

  for (const field of ARRAY_FIELDS) {
    const value = rule[field];
    if (value === undefined) continue;

    if (!Array.isArray(value)) {
      fields[field] = ['Must be an array.'];
      continue;
    }

    if (value.length === 0) {
      fields[field] = [
        'Empty list. Omit this field to mean "any" — an empty list matches nobody.',
      ];
      continue;
    }

    if (value.length > MAX_IDS_PER_DIMENSION) {
      fields[field] = [
        `${value.length} entries, over the limit of ${MAX_IDS_PER_DIMENSION}.`,
      ];
    }
  }

  if (rule.enrollmentStates && !rule.courseIds && !rule.subjectIds) {
    fields.enrollmentStates = [
      'Needs courseIds or subjectIds — a state alone does not say enrolled in what.',
    ];
  }

  if (Object.keys(fields).length > 0) {
    throw AppException.validation(fields, 'Audience rule is not valid');
  }
}

/**
 * Compiles a rule into a Prisma filter.
 *
 * Pure: no database, no clock, no configuration. That is deliberate — the
 * interesting cases (a rule that accidentally matches everyone, a rule that
 * matches nobody) are then testable without a database, and this is exactly
 * the code where a quiet mistake reaches thousands of phones.
 */
export function compileAudience(rule: AudienceRule): Prisma.UserWhereInput {
  assertValidAudienceRule(rule);

  const where: Prisma.UserWhereInput = {
    // Deleted accounts are never reachable, by any rule.
    deletedAt: null,
    role: { in: rule.roles ?? [UserRole.STUDENT] },
  };

  if (!rule.includeInactiveAccounts) {
    where.status = AccountStatus.ACTIVE;
  }

  // --- profile dimensions ----------------------------------------------------
  const profile: Prisma.StudentProfileWhereInput = {};
  for (const [ruleKey, column] of PROFILE_DIMENSIONS) {
    const ids = rule[ruleKey];
    if (ids?.length) profile[column] = { in: ids };
  }

  if (Object.keys(profile).length > 0) {
    // `is` rather than a bare object: a user with no student profile must fail
    // the filter rather than pass it vacuously.
    where.studentProfile = { is: profile };
  }

  // --- enrollment dimensions -------------------------------------------------
  if (rule.courseIds?.length || rule.subjectIds?.length) {
    const enrollment: Prisma.EnrollmentWhereInput = {
      state: { in: rule.enrollmentStates ?? [EnrollmentState.ACTIVE] },
    };

    if (rule.courseIds?.length) enrollment.courseId = { in: rule.courseIds };
    if (rule.subjectIds?.length) {
      enrollment.course = { subjectId: { in: rule.subjectIds } };
    }

    // `some` means one enrollment satisfying every condition at once, which is
    // what "enrolled in a pharmacy course, actively" has to mean. Splitting the
    // conditions across separate `some` clauses would match a student with an
    // expired pharmacy enrolment and an active unrelated one.
    where.enrollments = { some: enrollment };
  }

  // --- exclusions ------------------------------------------------------------
  if (rule.excludeUserIds?.length) {
    where.id = { notIn: rule.excludeUserIds };
  }

  return where;
}

/**
 * True when a rule filters on nothing at all.
 *
 * Not an error — "everyone" is a legitimate audience — but the caller is
 * expected to make the admin confirm it, because the difference between
 * "everyone" and a rule whose filters were dropped by a client bug is
 * invisible at the point of sending.
 */
export function targetsEveryone(rule: AudienceRule): boolean {
  return !ARRAY_FIELDS.some(
    (field) => field !== 'roles' && (rule[field] as unknown[] | undefined)?.length,
  );
}

/**
 * Reads the legacy columns as a rule.
 *
 * Announcements created before the audience builder carry three nullable
 * columns ANDed together. Translating them here means there is one evaluation
 * path rather than two, and no data migration was needed to get it.
 */
export function ruleFromLegacyColumns(row: {
  courseId: string | null;
  universityId: string | null;
  academicYearId: string | null;
}): AudienceRule {
  const rule: AudienceRule = {};
  if (row.courseId) rule.courseIds = [row.courseId];
  if (row.universityId) rule.universityIds = [row.universityId];
  if (row.academicYearId) rule.academicYearIds = [row.academicYearId];
  return rule;
}

/** Narrows stored JSON back to a rule, refusing anything that is not one. */
export function parseStoredRule(value: unknown): AudienceRule {
  if (value === null || value === undefined) return {};

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new AppException(ErrorCode.AUDIENCE_RULE_INVALID, {
      message: 'Stored audience rule is not an object.',
    });
  }

  const rule = value as AudienceRule;
  assertValidAudienceRule(rule);
  return rule;
}
