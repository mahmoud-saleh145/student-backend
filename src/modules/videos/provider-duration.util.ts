/**
 * Duration normalisation for provider-reported video metadata.
 *
 * Why this file exists
 * --------------------
 * `Video.durationSeconds` and `Lesson.durationSeconds` are `Int @default(0)` -
 * NOT NULL. That means the database cannot tell "we have not measured this yet"
 * apart from "this video is zero seconds long", so the distinction has to be
 * preserved in code, all the way from the provider response to the `UPDATE`.
 *
 * The rule the whole pipeline follows: **a missing, zero, negative or
 * non-numeric duration is UNKNOWN, never zero.** An unknown duration must be
 * written as NULL (i.e. left untouched) so that it can never overwrite a valid
 * value that is already stored, and so that no layer can later render it as a
 * confirmed `00`.
 */

/**
 * Normalises a provider-reported duration to whole SECONDS, or null.
 *
 * Units: providers report seconds here. Gumlet's `input.duration` is a float
 * number of seconds (e.g. `183.088`), matching `durationSeconds` 1:1, so this
 * rounds rather than dividing by 1000.
 *
 * Returning null for 0 is deliberate and load-bearing. A genuinely zero-length
 * asset is not a thing we can play, and treating `0` as real would let a
 * transient "still probing" response from the provider overwrite a good stored
 * duration with `0` - which is precisely the bug this guards against.
 */
export function normalizeProviderDurationSeconds(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw <= 0) return null;

  const seconds = Math.round(raw);
  // A positive sub-second value rounds to 0, which is not a usable duration.
  return seconds > 0 ? seconds : null;
}

/** A finite, strictly positive integer, or null. */
export function positiveIntOrNull(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const value = Math.round(raw);
  return value > 0 ? value : null;
}

/** A finite, strictly positive number, or null. Used for frame rates. */
export function positiveNumberOrNull(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  return raw > 0 ? raw : null;
}

/**
 * Merges a freshly measured duration into a stored one without ever losing a
 * value we already trust.
 *
 * Rules, in order:
 *   1. A fresh positive measurement always wins - it is newer truth.
 *   2. A fresh missing/zero/unparseable measurement NEVER overwrites a stored
 *      positive duration. Status sync runs repeatedly and must be monotonic, so
 *      a later poll that happens to omit the field cannot erase the answer an
 *      earlier poll already stored.
 *
 * @param stored   the value currently in the database
 * @param incoming the value just measured, already normalised (null = unknown)
 * @returns the value to persist
 */
export function mergeDurationSeconds(stored: number | null | undefined, incoming: number | null): number {
  if (incoming !== null && Number.isFinite(incoming) && incoming > 0) {
    return Math.round(incoming);
  }
  if (typeof stored === 'number' && Number.isFinite(stored) && stored > 0) {
    return stored;
  }
  return 0;
}