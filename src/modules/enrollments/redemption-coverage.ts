import { CodeTargetType, EnrollmentState } from '@prisma/client';

/**
 * Would redeeming this card change anything for this student?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A whole-course card presented by a student who already holds the whole
 * course has always been refused (`ALREADY_ENROLLED`) with the card left
 * unspent. A PART or SECTION card had no such guard: the redemption row was
 * written, the card flipped to EXHAUSTED, `grantAccess` re-inserted grant rows
 * that already existed (`skipDuplicates`), `grantPartFromCode` answered
 * `alreadyHeld` — and the student had paid for a card that bought nothing.
 * Typing the same part's second card by mistake, or a section card for a
 * section inside a part already held, burned real money silently.
 *
 * ── The rule ────────────────────────────────────────────────────────────────
 *
 * The redemption is refused only when it would grant NOTHING. Every one of
 * these still redeems, exactly as before:
 *
 *  - no enrollment yet, or one that is not live (pending, revoked, expired,
 *    lapsed) — the card activates or re-activates access;
 *  - an access window the card would extend — a second card on a time-limited
 *    course is a renewal, and renewals are sold;
 *  - any section on the card the student cannot open today;
 *  - a part card for a part the student holds no live entitlement for, even
 *    when every section frozen on the card is already open to them one by
 *    one: the entitlement is what makes part ownership follow the part's later
 *    sections, so it is new. (Not so for a live whole-course holder, who
 *    already has every later section.)
 *
 * Pure on purpose: no database and no clock. The caller gathers the facts
 * through the redemption transaction's own client, so the answer is taken from
 * the same snapshot the card is consumed in.
 */
export interface RedemptionCoverageFacts {
  targetType: CodeTargetType;
  /** Sections the card would grant. `null` is "the whole course". */
  cardSectionIds: string[] | null;
  /** The student's enrollment on the course, or null when there is none. */
  enrollment: { state: EnrollmentState; accessEndsAt: Date | null } | null;
  /**
   * What the student can open today, by `CourseAccessService.sectionCoverage`:
   * `null` for the whole course, otherwise the explicit list.
   */
  coveredSectionIds: string[] | null;
  /**
   * PART cards only. `HELD`: a live entitlement exists. `NOT_HELD`: the part
   * exists and the student has no live entitlement. `GONE`: the part has been
   * removed, so there is no entitlement left for the card to create.
   */
  part: 'HELD' | 'NOT_HELD' | 'GONE' | null;
  /** The access end the redemption would write. `null` is "no end". */
  nextAccessEndsAt: Date | null;
  now: Date;
}

export function redemptionGrantsNothing(facts: RedemptionCoverageFacts): boolean {
  // Whole-course and teacher cards keep their own, older rule
  // (`EnrollmentsService.redeemCode` refuses a live whole-course holder).
  if (
    facts.targetType !== CodeTargetType.SECTION &&
    facts.targetType !== CodeTargetType.PART
  ) {
    return false;
  }
  if (facts.cardSectionIds === null) return false;

  const enrollment = facts.enrollment;
  if (!enrollment) return false;

  const live =
    enrollment.state === EnrollmentState.ACTIVE &&
    (enrollment.accessEndsAt === null ||
      enrollment.accessEndsAt.getTime() > facts.now.getTime());
  if (!live) return false;

  // A renewal: the student's access ends, and this card would move that end
  // later (or remove it).
  if (enrollment.accessEndsAt !== null) {
    const extends_ =
      facts.nextAccessEndsAt === null ||
      facts.nextAccessEndsAt.getTime() > enrollment.accessEndsAt.getTime();
    if (extends_) return false;
  }

  // The whole course, live: every section it has now and every section added
  // later. No part or section card can add to that, entitlement included.
  if (facts.coveredSectionIds === null) return true;

  const covered = new Set(facts.coveredSectionIds);
  if (!facts.cardSectionIds.every((id) => covered.has(id))) return false;

  if (facts.targetType === CodeTargetType.PART && facts.part === 'NOT_HELD') {
    return false;
  }

  return true;
}
