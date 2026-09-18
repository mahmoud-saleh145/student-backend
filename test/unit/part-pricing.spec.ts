import { PartPricingModel } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import {
  allocatePartPrices,
  DEFAULT_PART_STRUCTURE,
  splitTeacherShare,
  type PricedPart,
} from '../../src/modules/course-parts/part-pricing';

/**
 * Course-part price allocation.
 *
 * The rule this file protects: **the parts of a course must add up to the
 * course.** Not approximately — exactly. If they sum to a piastre more, a
 * student buying every part pays more than the advertised price. A piastre
 * less, and buying everything still does not buy the course. Either is the kind
 * of discrepancy that is impossible to explain and impossible to reconcile.
 *
 * Everything here is pure — no database, no clock — so a failure points at the
 * arithmetic and nothing else.
 */

function pct(id: string, percent: number, sortOrder: number): PricedPart {
  return {
    id,
    title: id,
    sortOrder,
    pricingModel: PartPricingModel.PERCENTAGE,
    pricePercent: percent,
  };
}

function fixed(id: string, amount: number, sortOrder: number): PricedPart {
  return {
    id,
    title: id,
    sortOrder,
    pricingModel: PartPricingModel.FIXED,
    priceAmount: amount,
  };
}

describe('the default structure', () => {
  it('is the 60/40 two-part split the requirements specify', () => {
    expect(DEFAULT_PART_STRUCTURE).toHaveLength(2);
    expect(DEFAULT_PART_STRUCTURE[0].pricePercent).toBe(60);
    expect(DEFAULT_PART_STRUCTURE[1].pricePercent).toBe(40);
    expect(
      DEFAULT_PART_STRUCTURE.reduce((sum, p) => sum + p.pricePercent, 0),
    ).toBe(100);
  });

  it('allocates a 1000 EGP course as 600 / 400', () => {
    const result = allocatePartPrices([pct('p1', 60, 1), pct('p2', 40, 2)], 1000);

    expect(result.parts.map((p) => p.egp)).toEqual([600, 400]);
    expect(result.allocatedPiastres).toBe(result.coursePricePiastres);
  });
});

describe('percentage allocation', () => {
  it('accepts any number of parts that total 100%', () => {
    for (const percents of [[100], [50, 50], [30, 30, 40], [25, 25, 25, 25], [10, 20, 30, 40]]) {
      const parts = percents.map((p, i) => pct(`p${i}`, p, i + 1));
      const result = allocatePartPrices(parts, 800);
      expect(result.allocatedPiastres).toBe(80_000);
    }
  });

  it('refuses an over-allocation, naming the excess', () => {
    try {
      allocatePartPrices([pct('p1', 60, 1), pct('p2', 60, 2)], 1000);
      fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe(ErrorCode.VALIDATION_ERROR);
      // The admin has to be told what is wrong, not merely that something is.
      expect(JSON.stringify((error as AppException).fields)).toMatch(/120%/);
      expect(JSON.stringify((error as AppException).fields)).toMatch(/over/);
    }
  });

  it('refuses an under-allocation, naming the shortfall', () => {
    try {
      allocatePartPrices([pct('p1', 60, 1), pct('p2', 30, 2)], 1000);
      fail('expected a validation error');
    } catch (error) {
      expect(JSON.stringify((error as AppException).fields)).toMatch(/90%/);
      expect(JSON.stringify((error as AppException).fields)).toMatch(/short/);
    }
  });

  it('sums to the course price exactly even when the shares do not divide', () => {
    // 3 × 33.33% + 0.01% of 999.99 EGP. Rounding each share independently
    // lands a piastre or two out; largest-remainder apportionment does not.
    const parts = [
      pct('p1', 33.33, 1),
      pct('p2', 33.33, 2),
      pct('p3', 33.33, 3),
      pct('p4', 0.01, 4),
    ];
    const result = allocatePartPrices(parts, 999.99);

    expect(result.allocatedPiastres).toBe(99_999);
    expect(result.parts.reduce((sum, p) => sum + p.piastres, 0)).toBe(99_999);
  });

  it('never leaves a part more than a piastre from its true share', () => {
    const parts = [pct('p1', 33.33, 1), pct('p2', 33.33, 2), pct('p3', 33.34, 3)];
    const result = allocatePartPrices(parts, 100);

    for (const part of result.parts) {
      const exact = (10_000 * (part.percent ?? 0)) / 100;
      expect(Math.abs(part.piastres - exact)).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic — the same input always produces the same prices', () => {
    const parts = [pct('p1', 33.33, 1), pct('p2', 33.33, 2), pct('p3', 33.34, 3)];
    const first = allocatePartPrices(parts, 999.99).parts.map((p) => p.piastres);

    for (let i = 0; i < 5; i += 1) {
      expect(allocatePartPrices(parts, 999.99).parts.map((p) => p.piastres)).toEqual(first);
    }
  });

  it('handles a free course without dividing by zero', () => {
    const result = allocatePartPrices([pct('p1', 60, 1), pct('p2', 40, 2)], 0);
    expect(result.parts.map((p) => p.egp)).toEqual([0, 0]);
    expect(result.allocatedPiastres).toBe(0);
  });

  it('refuses a percentage part with no percentage', () => {
    const broken: PricedPart = {
      id: 'p1',
      title: 'p1',
      sortOrder: 1,
      pricingModel: PartPricingModel.PERCENTAGE,
      pricePercent: null,
    };
    expect(() => allocatePartPrices([broken], 1000)).toThrow(AppException);
  });
});

describe('fixed allocation', () => {
  it('accepts amounts that total the course price', () => {
    // The worked example from the requirements.
    const result = allocatePartPrices(
      [fixed('p1', 300, 1), fixed('p2', 400, 2), fixed('p3', 300, 3)],
      1000,
    );

    expect(result.parts.map((p) => p.egp)).toEqual([300, 400, 300]);
    expect(result.allocatedPiastres).toBe(100_000);
  });

  it('refuses an over-allocation, naming the excess in EGP', () => {
    try {
      allocatePartPrices([fixed('p1', 300, 1), fixed('p2', 800, 2)], 1000);
      fail('expected a validation error');
    } catch (error) {
      const message = JSON.stringify((error as AppException).fields);
      expect(message).toMatch(/1100/);
      expect(message).toMatch(/100 EGP more/);
    }
  });

  it('refuses an under-allocation, naming the shortfall in EGP', () => {
    try {
      allocatePartPrices([fixed('p1', 300, 1), fixed('p2', 400, 2)], 1000);
      fail('expected a validation error');
    } catch (error) {
      expect(JSON.stringify((error as AppException).fields)).toMatch(/300 EGP less/);
    }
  });

  it('handles piastre-level amounts without float drift', () => {
    const result = allocatePartPrices(
      [fixed('p1', 0.01, 1), fixed('p2', 0.02, 2), fixed('p3', 0.07, 3)],
      0.1,
    );
    expect(result.allocatedPiastres).toBe(10);
  });
});

describe('pricing model mixing', () => {
  it('refuses a course whose parts use different models', () => {
    // A 40% part plus a 300 EGP part only sums to the total for one particular
    // course price, and would silently stop summing the moment it changed.
    try {
      allocatePartPrices([pct('p1', 60, 1), fixed('p2', 400, 2)], 1000);
      fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect(JSON.stringify((error as AppException).fields)).toMatch(/same pricing model/);
    }
  });
});

describe('edge cases', () => {
  it('refuses an empty part list', () => {
    expect(() => allocatePartPrices([], 1000)).toThrow(AppException);
  });

  it('refuses a negative course price', () => {
    expect(() => allocatePartPrices([pct('p1', 100, 1)], -1)).toThrow(AppException);
  });

  it('orders the result by sortOrder regardless of input order', () => {
    const result = allocatePartPrices([pct('b', 40, 2), pct('a', 60, 1)], 1000);
    expect(result.parts.map((p) => p.id)).toEqual(['a', 'b']);
    expect(result.parts.map((p) => p.egp)).toEqual([600, 400]);
  });
});

describe('splitTeacherShare', () => {
  it('splits a price so both halves add back to it exactly', () => {
    // This is what the database CHECK constraint asserts on every row.
    for (const [price, percent] of [
      [10_000, 60],
      [33_333, 33.33],
      [1, 50],
      [99_999, 12.5],
    ] as const) {
      const split = splitTeacherShare(price, percent);
      expect(split.teacherPiastres + split.platformPiastres).toBe(price);
    }
  });

  it('gives the platform everything when no share is configured', () => {
    const split = splitTeacherShare(50_000, null);
    expect(split.teacherPiastres).toBe(0);
    expect(split.platformPiastres).toBe(50_000);
    expect(split.percent).toBeNull();
  });

  it('never pays a teacher more than the price', () => {
    const split = splitTeacherShare(10_000, 100);
    expect(split.teacherPiastres).toBe(10_000);
    expect(split.platformPiastres).toBe(0);
  });

  it('falls back to the platform when the share is unparseable', () => {
    const split = splitTeacherShare(10_000, 'not a number');
    expect(split.teacherPiastres).toBe(0);
    expect(split.platformPiastres).toBe(10_000);
  });
});
