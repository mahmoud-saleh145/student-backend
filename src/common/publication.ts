import { ContentStatus, CourseStatus } from '@prisma/client';

import { AppException, ErrorCode } from './errors';

/**
 * =============================================================================
 * Publication rules for anything a student can acquire
 * =============================================================================
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 *
 * Every one of these checks existed somewhere, and none of them agreed:
 *
 *   • the catalogue lists only `status: PUBLISHED`
 *   • `assertOnSale` in the library refused only `ARCHIVED`, so a `DRAFT` part
 *     was invisible in the app but purchasable by direct API call
 *   • a course card redeemed extra courses filtered with
 *     `notIn: [ARCHIVED, SUSPENDED]`, so a `DRAFT` or `HIDDEN` course granted
 *     access
 *   • `grantPartFromCode` checked nothing but `deletedAt`
 *
 * Inconsistent rules at the boundary are the same as no rule: whichever path a
 * client happens to use decides whether the guard exists. So the definition
 * lives here, once, and every acquisition path asks this module.
 *
 * ── Why `PUBLISHED` and not "not archived" ───────────────────────────────────
 *
 * `ARCHIVED` means "we took this down but students keep what they paid for".
 * `HIDDEN` and `DRAFT` mean "this is not offered". All three must block a *new*
 * acquisition, for one reason: an item that cannot be seen in the catalogue
 * cannot be legitimately bought, so honouring a purchase for it is selling
 * something the seller never put up for sale. Existing entitlements are a
 * separate question and are deliberately **not** touched here — withdrawing a
 * course must not revoke what students already own.
 *
 * This is deliberately independent of any UI. Hiding a button is not a control.
 */

/** The only content status a student may newly acquire. */
export const ACQUIRABLE_CONTENT_STATUS: ContentStatus = ContentStatus.PUBLISHED;

/** The only course status a student may newly acquire. */
export const ACQUIRABLE_COURSE_STATUS: CourseStatus = CourseStatus.PUBLISHED;

export function isAcquirableContent(status: ContentStatus | null | undefined): boolean {
  return status === ACQUIRABLE_CONTENT_STATUS;
}

export function isAcquirableCourse(status: CourseStatus | null | undefined): boolean {
  return status === ACQUIRABLE_COURSE_STATUS;
}

/**
 * Whether a purchasable child (course part, library part, library package) can
 * be acquired right now.
 *
 * `isActive` is checked separately from `status` because they answer different
 * questions. `status` is the editorial state; `isActive` is the commercial one
 * — the schema describes an inactive part as "retired without destroying what
 * students already own, and cannot be bought". Honouring either one alone is a
 * hole: a `PUBLISHED` but inactive part is still for sale under a status-only
 * rule, and an active `DRAFT` part is still for sale under an `isActive`-only
 * rule.
 */
export function isOnSale(input: {
  status: ContentStatus | null | undefined;
  isActive: boolean;
  deletedAt?: Date | null;
}): boolean {
  return Boolean(input.isActive) && input.deletedAt == null && isAcquirableContent(input.status);
}

function notOnSale(what: string, id?: string): AppException {
  return new AppException(ErrorCode.INVALID_STATE, {
    message: `${what} is not currently available for purchase`,
    details: id ? { id } : undefined,
  });
}

/**
 * A course may only be acquired through a *published* course.
 *
 * Deliberately stricter than the old `notIn: [ARCHIVED, SUSPENDED]` filter used
 * on the extra courses frozen into a card: `DRAFT` and `HIDDEN` slipped through
 * that one. Kept as a predicate returning a boolean rather than a throw so the
 * caller can decide whether a refusal should abort a whole redemption or merely
 * drop one course from a multi-course card.
 */
export function isCourseAcquirable(input: {
  status: CourseStatus | null | undefined;
  deletedAt?: Date | null;
}): boolean {
  return input.deletedAt == null && isAcquirableCourse(input.status);
}

/** Throws unless a course may be newly acquired. */
export function assertCourseAcquirable(
  input: { status: CourseStatus | null | undefined; deletedAt?: Date | null },
  id?: string,
): void {
  if (!isCourseAcquirable(input)) {
    throw new AppException(ErrorCode.COURSE_NOT_AVAILABLE, {
      details: { status: input.status },
    });
  }
}

/** Throws unless a course part may be newly acquired. */
export function assertPartOnSale(
  input: { status: ContentStatus | null | undefined; isActive: boolean; deletedAt?: Date | null },
  id?: string,
): void {
  if (!isOnSale(input)) throw notOnSale('This course part', id);
}

/** Throws unless a library part or package may be newly acquired. */
export function assertLibraryItemOnSale(
  input: { status: ContentStatus | null | undefined; isActive: boolean; deletedAt?: Date | null },
  what = 'This item',
  id?: string,
): void {
  if (!isOnSale(input)) throw notOnSale(what, id);
}

/**
 * The material a library item belongs to must also be purchasable.
 *
 * Separate from the item's own state on purpose: a `PUBLISHED` part inside a
 * `DRAFT` material is not for sale, and the old check in the library let a
 * `HIDDEN` material through because it only refused `DRAFT` and `ARCHIVED`.
 */
export function assertMaterialOnSale(
  material: { status: ContentStatus | null | undefined; isActive: boolean; deletedAt?: Date | null },
  id?: string,
): void {
  if (!isOnSale(material)) throw notOnSale('This material', id);
}