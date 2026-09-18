import { PartPricingModel } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import {
  fromPiastres,
  MoneyError,
  percentOf,
  toBasisPoints,
  toEgpNumber,
  toPiastres,
} from '../wallet/money';

/** One part, as far as pricing is concerned. */
export interface PricedPart {
  id: string;
  title: string;
  sortOrder: number;
  pricingModel: PartPricingModel;
  /** Set when the model is PERCENTAGE. */
  pricePercent?: number | string | null;
  /** Set when the model is FIXED. */
  priceAmount?: number | string | null;
}

export interface PartAllocation {
  id: string;
  title: string;
  sortOrder: number;
  pricingModel: PartPricingModel;
  /** Percentage as entered, for PERCENTAGE parts. */
  percent: number | null;
  /** What this part costs right now, in integer piastres. */
  piastres: number;
  /** The same figure as the decimal string the database column takes. */
  amount: string;
  /** The same figure as EGP, for JSON responses. */
  egp: number;
}

export interface AllocationResult {
  model: PartPricingModel;
  parts: PartAllocation[];
  /** Course price the allocation was computed against, in piastres. */
  coursePricePiastres: number;
  /** Sum of the part prices, in piastres. Always equal to the course price. */
  allocatedPiastres: number;
}

/**
 * The default structure the requirements call for when an admin creates a
 * course and takes Option A: two parts, split 60/40.
 *
 * Exported as data rather than buried in a service method so the dashboard can
 * show the same labels and the same split without hardcoding them again.
 */
export const DEFAULT_PART_STRUCTURE = [
  {
    title: 'Part 1 — Before Mid + Revision',
    titleAr: 'الجزء الأول — ما قبل الميد + المراجعة',
    pricePercent: 60,
  },
  {
    title: 'Part 2 — After Mid + Revision',
    titleAr: 'الجزء الثاني — ما بعد الميد + المراجعة',
    pricePercent: 40,
  },
] as const;

/**
 * Resolves what every part of a course costs, and proves the allocation adds up.
 *
 * ── Why this is more than a sum ─────────────────────────────────────────────
 *
 * **Percentages do not divide cleanly.** A 999.99 EGP course split 3 × 33.33%
 * plus one 0.01% part will not, if each share is rounded independently, sum
 * back to 999.99 — it lands a piastre or two out. Charging a student a total
 * that differs from the advertised course price by a piastre is the kind of
 * discrepancy that is impossible to explain and impossible to reconcile.
 *
 * So percentage allocation uses **largest-remainder apportionment**: every part
 * gets the floor of its exact share, then the leftover piastres go one each to
 * the parts with the largest discarded remainders. The result sums to the
 * course price *exactly*, by construction, and the distribution is the fairest
 * one available — no part is ever more than a piastre off its true share.
 *
 * **Fixed amounts must be exact.** There is nothing to apportion, so the sum is
 * simply required to equal the course price. Over-allocation charges more than
 * the course is worth; under-allocation means buying every part still does not
 * buy the course. Both are refused with the exact shortfall named, because
 * "invalid pricing" is useless to an admin trying to fix it.
 *
 * **Models cannot be mixed.** A 40% part plus a 300 EGP part only sums to the
 * total for one particular course price and would silently stop summing the
 * moment that price changed. All active parts of a course share one model.
 *
 * Pure: no database, no clock. Every rule above is directly testable.
 * ────────────────────────────────────────────────────────────────────────────
 */
export function allocatePartPrices(
  parts: PricedPart[],
  coursePrice: number | string,
): AllocationResult {
  if (parts.length === 0) {
    throw AppException.validation({ parts: ['a course with parts must have at least one'] });
  }

  let coursePricePiastres: number;
  try {
    coursePricePiastres = toPiastres(coursePrice, 'coursePrice');
  } catch (error) {
    if (error instanceof MoneyError) {
      throw AppException.validation({ [error.field]: [error.problem] });
    }
    throw error;
  }

  const model = parts[0].pricingModel;
  const mixed = parts.find((part) => part.pricingModel !== model);
  if (mixed) {
    throw AppException.validation({
      pricingModel: [
        `every part of a course must use the same pricing model; "${mixed.title}" uses ${mixed.pricingModel} while the others use ${model}`,
      ],
    });
  }

  const ordered = [...parts].sort((a, b) => a.sortOrder - b.sortOrder);

  return model === PartPricingModel.PERCENTAGE
    ? allocateByPercentage(ordered, coursePricePiastres)
    : allocateByFixedAmount(ordered, coursePricePiastres);
}

// ---------------------------------------------------------------------------

function allocateByPercentage(
  parts: PricedPart[],
  coursePricePiastres: number,
): AllocationResult {
  const fields: Record<string, string[]> = {};
  const basisPoints: number[] = [];

  for (const part of parts) {
    if (part.pricePercent === undefined || part.pricePercent === null) {
      fields[part.id] = ['a percentage-priced part needs a percentage'];
      basisPoints.push(0);
      continue;
    }
    try {
      basisPoints.push(toBasisPoints(part.pricePercent, part.id));
    } catch (error) {
      fields[part.id] = [
        error instanceof MoneyError ? error.problem : 'is not a valid percentage',
      ];
      basisPoints.push(0);
    }
  }

  if (Object.keys(fields).length > 0) throw AppException.validation(fields);

  const totalBp = basisPoints.reduce((sum, bp) => sum + bp, 0);

  // Exactly 100%. Not "about", not "at least" — the requirement is that the
  // parts account for the whole course, and any other total is a mistake the
  // admin needs told about now rather than discovered by a student later.
  if (totalBp !== 10_000) {
    const total = totalBp / 100;
    throw AppException.validation({
      pricePercent: [
        totalBp > 10_000
          ? `part percentages total ${total}%, which is ${(total - 100).toFixed(2)}% over 100%`
          : `part percentages total ${total}%, which is ${(100 - total).toFixed(2)}% short of 100%`,
      ],
    });
  }

  // Largest-remainder apportionment. `percentOf` rounds half-up, which is right
  // for a single figure but would not sum here, so the exact numerator is used
  // and the remainders are compared directly.
  const exact = basisPoints.map((bp) => coursePricePiastres * bp);
  const floors = exact.map((value) => Math.floor(value / 10_000));
  const remainders = exact.map((value, i) => value - floors[i] * 10_000);

  let leftover = coursePricePiastres - floors.reduce((sum, v) => sum + v, 0);

  // Ties break towards the earlier part, so the same input always produces the
  // same prices — an allocation that shuffled between requests would be
  // impossible to reason about.
  const order = remainders
    .map((remainder, index) => ({ remainder, index }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);

  const piastres = [...floors];
  for (const { index } of order) {
    if (leftover <= 0) break;
    piastres[index] += 1;
    leftover -= 1;
  }

  return {
    model: PartPricingModel.PERCENTAGE,
    coursePricePiastres,
    allocatedPiastres: piastres.reduce((sum, v) => sum + v, 0),
    parts: parts.map((part, i) => ({
      id: part.id,
      title: part.title,
      sortOrder: part.sortOrder,
      pricingModel: PartPricingModel.PERCENTAGE,
      percent: basisPoints[i] / 100,
      piastres: piastres[i],
      amount: fromPiastres(piastres[i]),
      egp: toEgpNumber(piastres[i]),
    })),
  };
}

function allocateByFixedAmount(
  parts: PricedPart[],
  coursePricePiastres: number,
): AllocationResult {
  const fields: Record<string, string[]> = {};
  const piastres: number[] = [];

  for (const part of parts) {
    if (part.priceAmount === undefined || part.priceAmount === null) {
      fields[part.id] = ['a fixed-price part needs an amount'];
      piastres.push(0);
      continue;
    }
    try {
      piastres.push(toPiastres(part.priceAmount, part.id));
    } catch (error) {
      fields[part.id] = [error instanceof MoneyError ? error.problem : 'is not a valid amount'];
      piastres.push(0);
    }
  }

  if (Object.keys(fields).length > 0) throw AppException.validation(fields);

  const allocated = piastres.reduce((sum, v) => sum + v, 0);

  if (allocated !== coursePricePiastres) {
    const difference = allocated - coursePricePiastres;
    throw AppException.validation({
      priceAmount: [
        difference > 0
          ? `part prices total ${toEgpNumber(allocated)} EGP, which is ${toEgpNumber(difference)} EGP more than the course price of ${toEgpNumber(coursePricePiastres)} EGP`
          : `part prices total ${toEgpNumber(allocated)} EGP, which is ${toEgpNumber(-difference)} EGP less than the course price of ${toEgpNumber(coursePricePiastres)} EGP`,
      ],
    });
  }

  return {
    model: PartPricingModel.FIXED,
    coursePricePiastres,
    allocatedPiastres: allocated,
    parts: parts.map((part, i) => ({
      id: part.id,
      title: part.title,
      sortOrder: part.sortOrder,
      pricingModel: PartPricingModel.FIXED,
      percent: null,
      piastres: piastres[i],
      amount: fromPiastres(piastres[i]),
      egp: toEgpNumber(piastres[i]),
    })),
  };
}

/**
 * Splits a part's price between the teacher and the platform.
 *
 * Integer arithmetic with the platform taking the remainder, so the two halves
 * always add back to exactly the price — which is what the
 * `teacherAmount + platformAmount = priceAtPurchase` CHECK constraint asserts
 * on every row.
 */
export function splitTeacherShare(
  pricePiastres: number,
  sharePercent: number | string | null | undefined,
): { teacherPiastres: number; platformPiastres: number; percent: number | null } {
  if (sharePercent === null || sharePercent === undefined) {
    return { teacherPiastres: 0, platformPiastres: pricePiastres, percent: null };
  }

  let bp: number;
  try {
    bp = toBasisPoints(sharePercent, 'sharePercent');
  } catch {
    return { teacherPiastres: 0, platformPiastres: pricePiastres, percent: null };
  }

  const teacherPiastres = Math.min(percentOf(pricePiastres, bp), pricePiastres);
  return {
    teacherPiastres,
    platformPiastres: pricePiastres - teacherPiastres,
    percent: bp / 100,
  };
}
