import { CodeTargetType, EnrollmentState } from '@prisma/client';

import {
  MIN_RENEWAL_EXTENSION_MS,
  type RedemptionCoverageFacts,
  redemptionGrantsNothing,
} from '../../src/modules/enrollments/redemption-coverage';

/**
 * A part or section card must not be spent on nothing.
 *
 * The rule under test decides one thing: would this redemption change anything
 * for this student? It is refused only when the answer is no. Every case that
 * used to redeem and DID give the student something has to keep redeeming, so
 * most of this file is the list of things that are still allowed.
 */

const NOW = new Date('2026-11-20T12:00:00Z');
const DAY = 86_400_000;

function facts(overrides: Partial<RedemptionCoverageFacts> = {}): RedemptionCoverageFacts {
  return {
    targetType: CodeTargetType.PART,
    cardSectionIds: ['sec_1', 'sec_2'],
    enrollment: { state: EnrollmentState.ACTIVE, accessEndsAt: null },
    coveredSectionIds: ['sec_1', 'sec_2'],
    part: 'HELD',
    nextAccessEndsAt: null,
    now: NOW,
    ...overrides,
  };
}

describe('redemptionGrantsNothing', () => {
  describe('refused: nothing new', () => {
    it('a part card for a part the student already holds', () => {
      expect(redemptionGrantsNothing(facts())).toBe(true);
    });

    it('a part card when the student holds the whole course, part entitlement or not', () => {
      // Normally refused before the transaction by the older whole-course
      // rule. This is the same answer for the race that rule cannot see: a
      // course card committing between that check and this transaction.
      expect(redemptionGrantsNothing(facts({ coveredSectionIds: null, part: 'NOT_HELD' }))).toBe(
        true,
      );
      expect(redemptionGrantsNothing(facts({ coveredSectionIds: null, part: 'HELD' }))).toBe(true);
    });

    it('a section card for a section the student can already open', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            targetType: CodeTargetType.SECTION,
            cardSectionIds: ['sec_1'],
            coveredSectionIds: ['sec_1', 'sec_9'],
            part: null,
          }),
        ),
      ).toBe(true);
    });

    it('a section card when the student holds the whole course', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            targetType: CodeTargetType.SECTION,
            cardSectionIds: ['sec_1'],
            coveredSectionIds: null,
            part: null,
          }),
        ),
      ).toBe(true);
    });

    it('a part card whose part has been removed, when every frozen section is held', () => {
      expect(redemptionGrantsNothing(facts({ part: 'GONE' }))).toBe(true);
    });

    it('a card that would only shorten a lifetime window', () => {
      expect(
        redemptionGrantsNothing(facts({ nextAccessEndsAt: new Date(NOW.getTime() + 30 * DAY) })),
      ).toBe(true);
    });

    it('a card whose window ends no later than the one already held', () => {
      const held = new Date(NOW.getTime() + 90 * DAY);
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: { state: EnrollmentState.ACTIVE, accessEndsAt: held },
            nextAccessEndsAt: new Date(NOW.getTime() + 30 * DAY),
          }),
        ),
      ).toBe(true);
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: { state: EnrollmentState.ACTIVE, accessEndsAt: held },
            nextAccessEndsAt: held,
          }),
        ),
      ).toBe(true);
    });
  });

  describe('refused: a fixed-length window restarted moments later is not a renewal', () => {
    // `grantAccess` restarts the window at redemption, so on a 30-day course a
    // second card always ends later than the first — by however long the
    // student waited. A minute is a mistyped duplicate, not a renewal.
    const held = (waitedMs: number) => new Date(NOW.getTime() + 30 * DAY - waitedMs);
    const next = new Date(NOW.getTime() + 30 * DAY);

    it.each([
      ['milliseconds later (the loser of two simultaneous cards)', 40],
      ['a minute later', 60_000],
      ['an hour later', 3_600_000],
      ['a millisecond short of a day later', MIN_RENEWAL_EXTENSION_MS - 1],
    ])('%s', (_name, waited) => {
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: { state: EnrollmentState.ACTIVE, accessEndsAt: held(waited) },
            nextAccessEndsAt: next,
          }),
        ),
      ).toBe(true);
    });

    it('a full day later it is a renewal again', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: {
              state: EnrollmentState.ACTIVE,
              accessEndsAt: held(MIN_RENEWAL_EXTENSION_MS),
            },
            nextAccessEndsAt: next,
          }),
        ),
      ).toBe(false);
    });
  });

  describe('still redeems: the card gives the student something', () => {
    it('no enrollment at all', () => {
      expect(redemptionGrantsNothing(facts({ enrollment: null }))).toBe(false);
    });

    it.each([
      EnrollmentState.PENDING_APPROVAL,
      EnrollmentState.PENDING_PAYMENT,
      EnrollmentState.EXPIRED,
      EnrollmentState.REVOKED,
    ])('an enrollment that is %s', (state) => {
      expect(
        redemptionGrantsNothing(facts({ enrollment: { state, accessEndsAt: null } })),
      ).toBe(false);
    });

    it('an ACTIVE enrollment whose window has lapsed', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: {
              state: EnrollmentState.ACTIVE,
              accessEndsAt: new Date(NOW.getTime() - 1),
            },
          }),
        ),
      ).toBe(false);
    });

    it('a renewal: the card moves the end of access later', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: {
              state: EnrollmentState.ACTIVE,
              accessEndsAt: new Date(NOW.getTime() + 3 * DAY),
            },
            nextAccessEndsAt: new Date(NOW.getTime() + 120 * DAY),
          }),
        ),
      ).toBe(false);
    });

    it('a renewal: the card removes the end of access', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            enrollment: {
              state: EnrollmentState.ACTIVE,
              accessEndsAt: new Date(NOW.getTime() + 3 * DAY),
            },
            nextAccessEndsAt: null,
          }),
        ),
      ).toBe(false);
    });

    it('a part card for a part not yet held', () => {
      expect(
        redemptionGrantsNothing(facts({ coveredSectionIds: ['sec_9'], part: 'NOT_HELD' })),
      ).toBe(false);
    });

    it('a part card when every frozen section is open but the part itself is not held', () => {
      // Bought section by section. The entitlement is what makes ownership
      // follow sections added to the part later, so it is new.
      expect(redemptionGrantsNothing(facts({ part: 'NOT_HELD' }))).toBe(false);
    });

    it('a part card carrying a section the student cannot open', () => {
      expect(
        redemptionGrantsNothing(facts({ cardSectionIds: ['sec_1', 'sec_2', 'sec_3'] })),
      ).toBe(false);
    });

    it('a card whose every section has been withdrawn is left to the older rules', () => {
      expect(redemptionGrantsNothing(facts({ cardSectionIds: [] }))).toBe(false);
    });

    it('a section card for a section not yet held', () => {
      expect(
        redemptionGrantsNothing(
          facts({
            targetType: CodeTargetType.SECTION,
            cardSectionIds: ['sec_3'],
            part: null,
          }),
        ),
      ).toBe(false);
    });
  });

  describe('out of scope: other kinds of card keep their own rule', () => {
    it.each([CodeTargetType.COURSE, CodeTargetType.TEACHER])('%s', (targetType) => {
      expect(
        redemptionGrantsNothing(
          facts({ targetType, cardSectionIds: null, coveredSectionIds: null, part: null }),
        ),
      ).toBe(false);
    });
  });
});
