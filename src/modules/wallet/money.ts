import { AppException } from '../../common/errors/app.exception';

/**
 * Exact money arithmetic for the credit system.
 *
 * Every amount in this platform is EGP with two decimal places. JavaScript
 * numbers cannot represent that exactly — `0.1 + 0.2 !== 0.3` — and a wallet
 * that is wrong by a piastre per transaction is a wallet nobody can audit. So
 * all arithmetic here is done on **integer piastres** (1 EGP = 100 piastres),
 * and a decimal string is produced only at the boundary.
 *
 * These functions are pure: no database, no clock, no injected state. That is
 * deliberate — this is the part that costs real money when it is wrong, so it
 * has to be directly testable without standing up a module.
 */

/** Largest amount the platform will accept anywhere, in EGP. */
export const MAX_MONEY_EGP = 1_000_000;

const MAX_PIASTRES = MAX_MONEY_EGP * 100;

/**
 * Parses an EGP amount into integer piastres.
 *
 * Accepts a number, a numeric string, or a Prisma Decimal (anything with a
 * sane `toString`). Rejects anything that is not a finite, non-negative amount
 * with at most two decimal places, rather than silently rounding a third
 * decimal away — a caller passing 10.005 has a bug, and hiding it here would
 * move the loss into the ledger.
 */
export function toPiastres(value: unknown, field = 'amount'): number {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : typeof value === 'string'
        ? value.trim()
        : value != null && typeof (value as { toString?: unknown }).toString === 'function'
          ? String(value)
          : '';

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new MoneyError(field, 'must be a non-negative amount with at most 2 decimal places');
  }

  const [whole, fraction = ''] = text.split('.');
  const piastres = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (!Number.isSafeInteger(piastres) || piastres > MAX_PIASTRES) {
    throw new MoneyError(field, `must not exceed ${MAX_MONEY_EGP}`);
  }

  return piastres;
}

/** Renders integer piastres as the decimal string the database column expects. */
export function fromPiastres(piastres: number): string {
  if (!Number.isSafeInteger(piastres)) {
    throw new MoneyError('amount', 'is not a whole number of piastres');
  }
  const sign = piastres < 0 ? '-' : '';
  const abs = Math.abs(piastres);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Piastres as a plain number of EGP, for JSON responses only. */
export function toEgpNumber(piastres: number): number {
  return Math.round(piastres) / 100;
}

/**
 * Parses a percentage (0–100, at most two decimals) into integer basis points.
 * 20% → 2000. 12.5% → 1250.
 */
export function toBasisPoints(value: unknown, field = 'discountPercent'): number {
  const text =
    typeof value === 'number'
      ? Number.isFinite(value)
        ? value.toString()
        : ''
      : typeof value === 'string'
        ? value.trim()
        : '';

  if (!/^\d+(\.\d{1,2})?$/.test(text)) {
    throw new MoneyError(field, 'must be a percentage between 0 and 100');
  }

  const [whole, fraction = ''] = text.split('.');
  const bp = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  if (bp > 10_000) {
    throw new MoneyError(field, 'must be between 0 and 100');
  }

  return bp;
}

/** Basis points back to a percentage number, for responses. */
export function fromBasisPoints(bp: number): number {
  return Math.round(bp) / 100;
}

/**
 * Applies a percentage to an amount, rounding half-up to the nearest piastre.
 *
 * Half-up rather than banker's rounding because that is what a human doing the
 * sum on paper expects, and every one of these numbers is shown to a human.
 */
export function percentOf(piastres: number, basisPoints: number): number {
  return Math.floor((piastres * basisPoints + 5_000) / 10_000);
}

/**
 * Parses an amount, reporting a bad value as a field validation error.
 *
 * `toPiastres` throws a bare `MoneyError` because it is pure and knows nothing
 * about HTTP. That is right for the arithmetic, but a `MoneyError` that reaches
 * the global exception filter is an *unrecognised* error and becomes a 500 —
 * telling the caller the server broke when in fact they sent a bad number.
 *
 * So anything parsing a caller-supplied amount uses this instead, and gets a
 * 422 naming the offending field. Values read back out of the database keep
 * using `toPiastres` directly: a malformed amount in a money column really is
 * a server fault, and should be loud.
 */
export function parseAmount(value: unknown, field = 'amount'): number {
  try {
    return toPiastres(value, field);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw AppException.validation({ [error.field]: [error.problem] });
    }
    throw error;
  }
}

/** A validation failure carrying the field it belongs to. */
export class MoneyError extends Error {
  constructor(
    readonly field: string,
    readonly problem: string,
  ) {
    super(`${field} ${problem}`);
    this.name = 'MoneyError';
  }
}
