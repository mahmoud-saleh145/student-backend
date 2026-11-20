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
 *  - an access window the card would extend by a day or more — a second card
 *    on a time-limited course is a renewal, and renewals are sold (see
 *    `MIN_RENEWAL_EXTENSION_MS` for why "a day");
 *  - any section on the card the student does not already hold;
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
/**
 * The least a card must add to a time-limited access window to count as a
 * renewal.
 *
 * `grantAccess` restarts the window from the moment of redemption, so on a
 * fixed-length course ANY later card ends later than the one before it — by
 * however long the student waited between the two. Without a floor, "extends
 * the window" is true one minute after the first card, and the guard never
 * fires on such a course: a mistyped second card is spent for a minute of
 * access, and of two cards presented at the same instant the loser is retried
 * a few milliseconds later and spent as well.
 *
 * A day is deliberately small. It is long enough that a duplicate entered in
 * the same sitting is refused, and short enough that no real renewal — bought
 * because access is about to run out — is ever caught by it.
 */
export const MIN_RENEWAL_EXTENSION_MS = 24 * 60 * 60 * 1000;

export interface RedemptionCoverageFacts {
  targetType: CodeTargetType;
  /**
   * Sections the card would grant, less any that have since been deleted or
   * archived (withdrawn material is not unlocked by anything). `null` is "the
   * whole course".
   */
  cardSectionIds: string[] | null;
  /** The student's enrollment on the course, or null when there is none. */
  enrollment: { state: EnrollmentState; accessEndsAt: Date | null } | null;
  /**
   * What the student's enrollment covers, by
   * `CourseAccessService.sectionCoverage`: `null` for the whole course,
   * otherwise the explicit list. Says nothing about whether the enrollment is
   * live — that is decided here, from `enrollment`.
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
  // Nothing left on the card to compare (every section it named has been
  // withdrawn). Not this rule's call: the redemption proceeds as it always has.
  if (facts.cardSectionIds.length === 0) return false;

  const enrollment = facts.enrollment;
  if (!enrollment) return false;

  const live =
    enrollment.state === EnrollmentState.ACTIVE &&
    (enrollment.accessEndsAt === null ||
      enrollment.accessEndsAt.getTime() > facts.now.getTime());
  if (!live) return false;

  // A renewal: the student's access ends, and this card would remove that
  // end or move it later by a day or more.
  if (enrollment.accessEndsAt !== null) {
    const renews =
      facts.nextAccessEndsAt === null ||
      facts.nextAccessEndsAt.getTime() - enrollment.accessEndsAt.getTime() >=
        MIN_RENEWAL_EXTENSION_MS;
    if (renews) return false;
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
