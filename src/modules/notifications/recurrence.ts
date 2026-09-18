import { AnnouncementFrequency } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';

/**
 * When a scheduled announcement fires next.
 *
 * Pure: no database, no queue, and the current time is always passed in rather
 * than read. Everything hard about scheduling is arithmetic, and arithmetic is
 * worth being able to test without standing anything up.
 *
 * ## Why local time is stored, not UTC
 *
 * An announcement is scheduled as a **wall-clock time in a timezone** — 19:00
 * in Africa/Cairo — not as an instant. Egypt reintroduced daylight saving in
 * 2023, so the UTC instant behind "19:00 Cairo" moves by an hour twice a year.
 * Storing the instant would drift the message to 18:00 for half the year, which
 * is exactly the kind of bug nobody reports and everybody notices.
 *
 * ## The two honest edge cases
 *
 * Egypt's transitions happen at midnight, so a send scheduled between 00:00 and
 * 01:00 hits them:
 *
 *  - **Spring forward** deletes that wall time. The computation lands on the
 *    next instant that does exist, so the send happens shortly after, never
 *    silently skipped.
 *  - **Fall back** repeats it. The first of the two is used, and the dispatch
 *    claim (unique on `occurrenceAt`) makes the second a no-op, so it fires
 *    once rather than twice.
 *
 * Neither is a problem worth avoiding by scheduling at 00:30. Both are worth
 * stating, because the alternative is discovering them from a duplicate push.
 */

export interface RecurrenceSpec {
  frequency: AnnouncementFrequency;
  /** "HH:MM", 24-hour, in `timezone`. */
  sendAtLocal: string;
  /** IANA zone name, e.g. "Africa/Cairo". */
  timezone: string;
  /** WEEKLY only. ISO weekdays: 1 = Monday … 7 = Sunday. */
  weekdays?: number[];
  /** MONTHLY only. 1–31, clamped to the last day of a shorter month. */
  dayOfMonth?: number | null;
  /** No occurrence before this instant. */
  startsOn?: Date | null;
  /** No occurrence after this instant. */
  endsOn?: Date | null;
  maxOccurrences?: number | null;
  occurrenceCount?: number;
}

/** Days scanned before giving up. Covers a monthly rule across a full year. */
const MAX_SEARCH_DAYS = 400;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface LocalParts {
  year: number;
  month: number;
  day: number;
}

/**
 * Validates a spec, reporting every problem at once.
 *
 * Scheduling is configured in a form and then not looked at again until it
 * fires, possibly weeks later. A rejection now is far cheaper than a message
 * that never arrives.
 */
export function assertValidRecurrence(spec: RecurrenceSpec): void {
  const fields: Record<string, string[]> = {};

  if (!HHMM.test(spec.sendAtLocal)) {
    fields.sendAtLocal = ['Must be "HH:MM" in 24-hour form, e.g. "19:00".'];
  }

  if (!isValidTimezone(spec.timezone)) {
    fields.timezone = [`Unknown timezone "${spec.timezone}".`];
  }

  if (spec.frequency === AnnouncementFrequency.WEEKLY) {
    const days = spec.weekdays ?? [];
    if (days.length === 0) {
      fields.weekdays = ['A weekly schedule needs at least one weekday.'];
    } else if (days.some((d) => !Number.isInteger(d) || d < 1 || d > 7)) {
      fields.weekdays = ['ISO weekdays only: 1 = Monday … 7 = Sunday.'];
    }
  }

  if (spec.frequency === AnnouncementFrequency.MONTHLY) {
    const day = spec.dayOfMonth;
    if (day == null || !Number.isInteger(day) || day < 1 || day > 31) {
      fields.dayOfMonth = ['A monthly schedule needs a day of month between 1 and 31.'];
    }
  }

  if (spec.startsOn && spec.endsOn && spec.endsOn <= spec.startsOn) {
    fields.endsOn = ['Must be after startsOn.'];
  }

  if (spec.maxOccurrences != null && spec.maxOccurrences < 1) {
    fields.maxOccurrences = ['Must be at least 1, or omitted for unlimited.'];
  }

  if (Object.keys(fields).length > 0) {
    throw AppException.validation(fields, 'Schedule is not valid');
  }
}

/**
 * The first instant strictly after `after` at which this should fire.
 *
 * Returns null when the schedule is exhausted — past its end date, past its
 * occurrence limit, or a one-off that has already run. Null is the signal the
 * dispatcher uses to stop looking at the row, so "no more sends" and "an error"
 * are never confused.
 */
export function nextOccurrence(spec: RecurrenceSpec, after: Date): Date | null {
  assertValidRecurrence(spec);

  const count = spec.occurrenceCount ?? 0;
  if (spec.maxOccurrences != null && count >= spec.maxOccurrences) return null;

  // A one-off that has fired is done, whatever the dates say.
  if (spec.frequency === AnnouncementFrequency.ONCE && count > 0) return null;

  const [hour, minute] = spec.sendAtLocal.split(':').map(Number) as [number, number];

  // Never look before the start date; never before now.
  const floor = spec.startsOn && spec.startsOn > after ? spec.startsOn : after;

  let cursor = localPartsOf(floor, spec.timezone);

  for (let i = 0; i < MAX_SEARCH_DAYS; i += 1) {
    if (matchesPattern(spec, cursor)) {
      const day = effectiveDay(spec, cursor);
      const instant = zonedWallTimeToUtc(
        { ...cursor, day },
        hour,
        minute,
        spec.timezone,
      );

      if (instant > floor) {
        if (spec.endsOn && instant > spec.endsOn) return null;
        return instant;
      }
    }

    cursor = addDays(cursor, 1);
  }

  // A valid spec always matches inside 400 days; reaching here means the
  // pattern is unsatisfiable, and returning null stops the row rather than
  // spinning on it.
  return null;
}

/** Does this calendar date match the frequency pattern? */
function matchesPattern(spec: RecurrenceSpec, parts: LocalParts): boolean {
  switch (spec.frequency) {
    case AnnouncementFrequency.ONCE:
    case AnnouncementFrequency.DAILY:
      return true;

    case AnnouncementFrequency.WEEKLY:
      return (spec.weekdays ?? []).includes(isoWeekday(parts));

    case AnnouncementFrequency.MONTHLY: {
      const wanted = spec.dayOfMonth ?? 1;
      const last = daysInMonth(parts.year, parts.month);
      // The 31st in a 30-day month fires on the 30th rather than being skipped:
      // "monthly on the 31st" means the end of every month, not eight of them.
      return parts.day === Math.min(wanted, last);
    }

    default:
      return false;
  }
}

/** MONTHLY clamps; every other frequency uses the cursor's own day. */
function effectiveDay(spec: RecurrenceSpec, parts: LocalParts): number {
  if (spec.frequency !== AnnouncementFrequency.MONTHLY) return parts.day;
  const last = daysInMonth(parts.year, parts.month);
  return Math.min(spec.dayOfMonth ?? 1, last);
}

// ---------------------------------------------------------------------------
// Timezone arithmetic
// ---------------------------------------------------------------------------

/**
 * The UTC offset of `zone` at a given instant, in milliseconds.
 *
 * Derived by formatting the instant in the zone and reading the result back as
 * though it were UTC: the difference between the two is the offset. This uses
 * the platform's own timezone database rather than a hardcoded rule, which
 * matters for Egypt specifically — its DST rules have changed twice since 2014.
 */
function offsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    // Intl renders midnight as 24 in some locales/versions; normalise it.
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  return asUtc - instant;
}

/**
 * The UTC instant for a wall-clock time in a zone.
 *
 * Two passes, because the offset depends on the answer: the first guess uses
 * the offset at the naive instant, the second corrects it using the offset at
 * the guess. That converges everywhere except inside a DST gap, where it lands
 * just past the gap — which is the behaviour documented at the top of this file.
 */
function zonedWallTimeToUtc(
  parts: LocalParts,
  hour: number,
  minute: number,
  zone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute);

  let instant = naive - offsetMs(naive, zone);
  instant = naive - offsetMs(instant, zone);

  return new Date(instant);
}

/** The calendar date an instant falls on, in a zone. */
function localPartsOf(instant: Date, zone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');

  return { year: get('year'), month: get('month'), day: get('day') };
}

function addDays(parts: LocalParts, days: number): LocalParts {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
  };
}

function isoWeekday(parts: LocalParts): number {
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  return day === 0 ? 7 : day;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
