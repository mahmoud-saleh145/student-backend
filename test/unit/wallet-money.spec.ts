import { DiscountType } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { resolveDiscount } from '../../src/modules/wallet/discount';
import {
  fromPiastres,
  percentOf,
  toBasisPoints,
  toPiastres,
} from '../../src/modules/wallet/money';

/**
 * Recharge-card arithmetic.
 *
 * This is the file that protects the platform's revenue figure. The rule it
 * exists to pin down, stated once:
 *
 *     a card's REVENUE is what the student actually paid,
 *     never the face value printed on it.
 *
 * Getting that backwards would inflate every financial report by exactly the
 * discount given, which is the kind of error nobody notices until the numbers
 * are used for something that matters.
 *
 * Everything under test here is pure — no database, no clock — so a failure
 * points at the arithmetic and nothing else.
 */

describe('money — exact piastre arithmetic', () => {
  it('parses EGP into integer piastres', () => {
    expect(toPiastres('50')).toBe(5_000);
    expect(toPiastres(1000)).toBe(100_000);
    expect(toPiastres('12.34')).toBe(1_234);
    expect(toPiastres('0.05')).toBe(5);
    expect(toPiastres(0)).toBe(0);
  });

  it('round-trips without drift', () => {
    for (const value of ['0.01', '0.10', '99.99', '1234.56', '1000000.00']) {
      expect(fromPiastres(toPiastres(value))).toBe(Number(value).toFixed(2));
    }
  });

  it('is immune to the float error that makes 0.1 + 0.2 ≠ 0.3', () => {
    // The whole reason this module works in integers.
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(toPiastres('0.1') + toPiastres('0.2')).toBe(toPiastres('0.3'));
  });

  it('rejects a third decimal place instead of silently rounding it away', () => {
    // 10.005 is a bug at the call site. Rounding it here would move the loss
    // into the ledger, where nobody would find it.
    expect(() => toPiastres('10.005')).toThrow(/2 decimal places/);
  });

  it('rejects negatives, junk and anything over the ceiling', () => {
    expect(() => toPiastres('-5')).toThrow();
    expect(() => toPiastres('abc')).toThrow();
    expect(() => toPiastres('')).toThrow();
    expect(() => toPiastres(Number.NaN)).toThrow();
    expect(() => toPiastres(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => toPiastres('1000000.01')).toThrow(/exceed/);
  });

  it('parses percentages into basis points', () => {
    expect(toBasisPoints(20)).toBe(2_000);
    expect(toBasisPoints('12.5')).toBe(1_250);
    expect(toBasisPoints(100)).toBe(10_000);
    expect(toBasisPoints(0)).toBe(0);
    expect(() => toBasisPoints(100.01)).toThrow();
    expect(() => toBasisPoints(-1)).toThrow();
  });

  it('rounds a percentage half-up, the way a human would on paper', () => {
    expect(percentOf(100, 5_000)).toBe(50); // 1.00 @ 50%   → 0.50
    expect(percentOf(333, 3_333)).toBe(111); // 3.33 @ 33.33% → 1.11
    expect(percentOf(1, 5_000)).toBe(1); // 0.01 @ 50%   → 0.01 (half-up)
  });
});

describe('resolveDiscount — what a recharge card is worth', () => {
  it('books the amount paid as revenue, not the face value', () => {
    // The worked example from the requirements: 1000 EGP card at 20% off.
    const result = resolveDiscount({
      faceValue: 1000,
      discountType: DiscountType.PERCENTAGE,
      discountPercent: 20,
    });

    expect(result.faceValue).toBe('1000.00');
    expect(result.discountAmount).toBe('200.00');
    expect(result.actualPaidAmount).toBe('800.00'); // revenue
    expect(result.creditAmount).toBe('800.00'); // wallet
    expect(result.actualPaidAmount).not.toBe(result.faceValue);
  });

  it('handles the second worked example identically', () => {
    const result = resolveDiscount({
      faceValue: 500,
      discountType: DiscountType.PERCENTAGE,
      discountPercent: 20,
    });

    expect(result.actualPaidAmount).toBe('400.00');
    expect(result.creditAmount).toBe('400.00');
  });

  it('supports a 100% discount as a genuine giveaway', () => {
    // Explicitly required: paid 0, credits 0, revenue 0 — and still a real
    // card that redeems and appears in the report.
    const result = resolveDiscount({
      faceValue: 1000,
      discountType: DiscountType.PERCENTAGE,
      discountPercent: 100,
    });

    expect(result.discountAmount).toBe('1000.00');
    expect(result.actualPaidAmount).toBe('0.00');
    expect(result.creditAmount).toBe('0.00');
  });

  it('leaves the face value intact when there is no discount', () => {
    const result = resolveDiscount({ faceValue: 50 });
    expect(result.discountType).toBe(DiscountType.NONE);
    expect(result.discountAmount).toBe('0.00');
    expect(result.actualPaidAmount).toBe('50.00');
    expect(result.discountPercent).toBeNull();
  });

  it('applies a fixed discount in EGP', () => {
    const result = resolveDiscount({
      faceValue: 500,
      discountType: DiscountType.FIXED,
      discountAmount: 125.5,
    });

    expect(result.actualPaidAmount).toBe('374.50');
    expect(result.creditAmount).toBe('374.50');
    expect(result.discountPercent).toBeNull();
  });

  it('refuses a discount larger than the face value', () => {
    // Otherwise the platform would be paying the student to take the card.
    expect(() =>
      resolveDiscount({
        faceValue: 100,
        discountType: DiscountType.FIXED,
        discountAmount: 150,
      }),
    ).toThrow(AppException);
  });

  it('refuses a percentage discount with no percentage', () => {
    expect(() =>
      resolveDiscount({ faceValue: 100, discountType: DiscountType.PERCENTAGE }),
    ).toThrow(AppException);
  });

  it('refuses a fixed discount with no amount', () => {
    expect(() =>
      resolveDiscount({ faceValue: 100, discountType: DiscountType.FIXED }),
    ).toThrow(AppException);
  });

  it('reports failures as field validation errors the dashboard can render', () => {
    try {
      resolveDiscount({ faceValue: -1 });
      fail('expected a validation error');
    } catch (error) {
      expect(error).toBeInstanceOf(AppException);
      expect((error as AppException).code).toBe(ErrorCode.VALIDATION_ERROR);
      expect((error as AppException).fields).toHaveProperty('faceValue');
    }
  });

  it('never loses a piastre to rounding', () => {
    // face = discount + paid, for every awkward percentage.
    for (const percent of [3, 7, 12.5, 33.33, 66.67, 99.99]) {
      const r = resolveDiscount({
        faceValue: 999.99,
        discountType: DiscountType.PERCENTAGE,
        discountPercent: percent,
      });
      expect(r.discountPiastres + r.actualPaidPiastres).toBe(r.faceValuePiastres);
    }
  });
});
