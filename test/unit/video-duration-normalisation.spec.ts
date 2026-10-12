/**
 * Duration normalisation and persistence.
 *
 * Regression coverage for the "video plays fine but the dashboard shows 00"
 * bug. The chain that was broken is:
 *
 *   Gumlet asset API -> GumletDrmService.getAsset -> GumletIngestService.sync
 *     -> videos.durationSeconds -> lessons.durationSeconds -> dashboard
 *
 * The provider always reported the duration (`input.duration`, float seconds).
 * The client threw it away at the HTTP boundary, so nothing on the Gumlet path
 * ever wrote a duration and every value stayed at the schema default of 0.
 */
import {
  mergeDurationSeconds,
  normalizeProviderDurationSeconds,
  positiveIntOrNull,
  positiveNumberOrNull,
} from '../../src/modules/videos/provider-duration.util';

describe('normalizeProviderDurationSeconds', () => {
  it('rounds a float-seconds duration from the provider', () => {
    // Gumlet reports `input.duration` as float SECONDS, e.g. 183.088.
    expect(normalizeProviderDurationSeconds(183.088)).toBe(183);
  });

  it('does NOT divide by 1000 - the provider is already in seconds', () => {
    // A 40-minute lecture is 2400s, not 2,400,000ms. A /1000 here would turn a
    // legitimate lecture into a 2-second one.
    expect(normalizeProviderDurationSeconds(2400)).toBe(2400);
  });

  it('treats a missing, null or non-numeric value as unknown, not zero', () => {
    expect(normalizeProviderDurationSeconds(undefined)).toBeNull();
    expect(normalizeProviderDurationSeconds(null)).toBeNull();
    expect(normalizeProviderDurationSeconds('')).toBeNull();
    expect(normalizeProviderDurationSeconds('183')).toBeNull();
    expect(normalizeProviderDurationSeconds(NaN)).toBeNull();
    expect(normalizeProviderDurationSeconds(Infinity)).toBeNull();
  });

  it('treats 0 and negatives as unknown rather than a real zero length', () => {
    expect(normalizeProviderDurationSeconds(0)).toBeNull();
    expect(normalizeProviderDurationSeconds(-5)).toBeNull();
  });

  it('treats a sub-second value that rounds to zero as unknown', () => {
    expect(normalizeProviderDurationSeconds(0.2)).toBeNull();
  });
});

describe('positiveIntOrNull / positiveNumberOrNull', () => {
  it('accepts positive values and rounds integers', () => {
    expect(positiveIntOrNull(1920)).toBe(1920);
    expect(positiveIntOrNull(23.98)).toBe(24);
    expect(positiveNumberOrNull(23.98)).toBe(23.98);
  });

  it('rejects absent, zero and negative geometry', () => {
    expect(positiveIntOrNull(0)).toBeNull();
    expect(positiveIntOrNull(-1)).toBeNull();
    expect(positiveIntOrNull(undefined)).toBeNull();
    expect(positiveNumberOrNull(0)).toBeNull();
    expect(positiveNumberOrNull(null)).toBeNull();
  });
});

describe('mergeDurationSeconds', () => {
  it('lets a fresh measurement win over a stored value', () => {
    expect(mergeDurationSeconds(120, 300)).toBe(300);
  });

  it('preserves a stored value when the new measurement is unknown', () => {
    // THE regression: a later status sync that omits the field must not erase
    // the duration an earlier sync already stored.
    expect(mergeDurationSeconds(300, null)).toBe(300);
  });

  it('still writes 0 when nothing was ever known', () => {
    expect(mergeDurationSeconds(0, null)).toBe(0);
    expect(mergeDurationSeconds(null, null)).toBe(0);
  });

  it('is monotonic: repeated unknown syncs never regress the value', () => {
    let stored = 0;
    for (const incoming of [null, null, 600, null, null, null]) {
      stored = mergeDurationSeconds(stored, incoming);
    }
    expect(stored).toBe(600);
  });
});