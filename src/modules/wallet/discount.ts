import { DiscountType } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';

import {
  fromBasisPoints,
  fromPiastres,
  MoneyError,
  percentOf,
  toBasisPoints,
  toEgpNumber,
  toPiastres,
} from './money';

/** What an administrator types when creating a recharge code. */
export interface DiscountInput {
  /** Face value printed on the card, in EGP. */
  faceValue: number | string;
  discountType?: DiscountType;
  /** Required for PERCENTAGE. 0–100, at most two decimals. */
  discountPercent?: number | string;
  /** Required for FIXED. An absolute EGP amount, never more than the face value. */
  discountAmount?: number | string;
}

/**
 * The four frozen numbers of a recharge code, in integer piastres plus the
 * decimal strings the database columns take.
 */
export interface DiscountResult {
  faceValuePiastres: number;
  discountPiastres: number;
  actualPaidPiastres: number;
  creditPiastres: number;

  faceValue: string;
  discountAmount: string;
  actualPaidAmount: string;
  creditAmount: string;

  discountType: DiscountType;
  /** Null unless the type is PERCENTAGE. */
  discountPercent: number | null;
}

/**
 * Resolves what a recharge code is worth.
 *
 * The rule the whole financial report rests on:
 *
 *     actualPaid = faceValue − discount        ← this is the REVENUE
 *     credits    = actualPaid                  ← this is what the wallet gets
 *
 * A 1 000 EGP card sold at 20% off is 800 EGP of revenue and 800 credits, not
 * 1 000 of either. The face value is a marketing number and never appears in
 * the revenue total.
 *
 * A 100% discount is explicitly legal and produces 0 / 0 / 0 — a giveaway card
 * that grants nothing and books nothing. What is *not* legal is a discount
 * larger than the face value, which would imply negative revenue.
 *
 * Pure by design; the wallet's money behaviour is tested through this function
 * without a database.
 */
export function resolveDiscount(input: DiscountInput): DiscountResult {
  try {
    const faceValuePiastres = toPiastres(input.faceValue, 'faceValue');
    const type = input.discountType ?? DiscountType.NONE;

    let discountPiastres = 0;
    let percent: number | null = null;

    if (type === DiscountType.PERCENTAGE) {
      if (input.discountPercent === undefined || input.discountPercent === null) {
        throw new MoneyError('discountPercent', 'is required for a percentage discount');
      }
      const bp = toBasisPoints(input.discountPercent);
      percent = fromBasisPoints(bp);
      discountPiastres = percentOf(faceValuePiastres, bp);
    } else if (type === DiscountType.FIXED) {
      if (input.discountAmount === undefined || input.discountAmount === null) {
        throw new MoneyError('discountAmount', 'is required for a fixed discount');
      }
      discountPiastres = toPiastres(input.discountAmount, 'discountAmount');
    }

    // Rounding cannot push the discount past the face value, but a FIXED
    // discount typed by hand certainly can, and that would mean paying the
    // student to take the card.
    if (discountPiastres > faceValuePiastres) {
      throw new MoneyError('discountAmount', 'cannot exceed the face value');
    }

    const actualPaidPiastres = faceValuePiastres - discountPiastres;

    return {
      faceValuePiastres,
      discountPiastres,
      actualPaidPiastres,
      // Credits granted are exactly what was paid. Kept as its own field
      // rather than aliased, because a future promotion ("pay 800, get 900")
      // would change this line and nothing else.
      creditPiastres: actualPaidPiastres,

      faceValue: fromPiastres(faceValuePiastres),
      discountAmount: fromPiastres(discountPiastres),
      actualPaidAmount: fromPiastres(actualPaidPiastres),
      creditAmount: fromPiastres(actualPaidPiastres),

      discountType: type,
      discountPercent: percent,
    };
  } catch (error) {
    if (error instanceof MoneyError) {
      throw AppException.validation({ [error.field]: [error.problem] });
    }
    throw error;
  }
}

/** Convenience for responses that want EGP numbers rather than strings. */
export function discountSummary(result: DiscountResult) {
  return {
    faceValue: toEgpNumber(result.faceValuePiastres),
    discountType: result.discountType,
    discountPercent: result.discountPercent,
    discountAmount: toEgpNumber(result.discountPiastres),
    actualPaidAmount: toEgpNumber(result.actualPaidPiastres),
    creditAmount: toEgpNumber(result.creditPiastres),
  };
}
