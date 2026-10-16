import {
  GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS,
  GUMLET_INGEST_URL_TTL_MAX_SECONDS,
  GUMLET_INGEST_URL_TTL_MIN_SECONDS,
  resolveGumletIngestUrlTtlSeconds,
} from '../../src/modules/videos/gumlet-ingest-url-ttl';

/**
 * Lifetime selection for the R2 presigned URL handed to Gumlet.
 *
 * The value used to be a bare `3600` inside `adopt()`. These tests pin the
 * resolution rule so no future edit reintroduces a shorter window by accident -
 * a too-short window fails slowly and expensively rather than loudly.
 */
describe('resolveGumletIngestUrlTtlSeconds', () => {
  it('defaults to six hours, not one', () => {
    expect(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS).toBe(6 * 60 * 60);
    expect(resolveGumletIngestUrlTtlSeconds(undefined)).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
  });

  it('treats unset, blank and malformed values as the default', () => {
    expect(resolveGumletIngestUrlTtlSeconds(null)).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
    expect(resolveGumletIngestUrlTtlSeconds('')).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
    expect(resolveGumletIngestUrlTtlSeconds('   ')).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
    expect(resolveGumletIngestUrlTtlSeconds('not-a-number')).toBe(
      GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS,
    );
    expect(resolveGumletIngestUrlTtlSeconds('abc')).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
    // A negative or zero TTL is not "expired immediately", it is a mistake.
    expect(resolveGumletIngestUrlTtlSeconds(-1)).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
    expect(resolveGumletIngestUrlTtlSeconds(0)).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
  });

  it('accepts a numeric string, as env vars always arrive', () => {
    expect(resolveGumletIngestUrlTtlSeconds('7200')).toBe(7200);
    expect(resolveGumletIngestUrlTtlSeconds(7200)).toBe(7200);
    expect(resolveGumletIngestUrlTtlSeconds(' 7200 ')).toBe(7200);
  });

  it('NEVER returns a value shorter than the old hard-coded hour', () => {
    // The regression this whole module exists to prevent: a typo that silently
    // restores the one-hour window that expired underneath a queued Gumlet job.
    for (const raw of ['1', '60', '599', '3600', '3599', 'abc', '', undefined, null]) {
      expect(resolveGumletIngestUrlTtlSeconds(raw)).toBeGreaterThanOrEqual(
        GUMLET_INGEST_URL_TTL_MIN_SECONDS,
      );
    }
  });

  it('clamps up to the floor instead of rejecting a small value', () => {
    expect(resolveGumletIngestUrlTtlSeconds(60)).toBe(GUMLET_INGEST_URL_TTL_MIN_SECONDS);
    expect(resolveGumletIngestUrlTtlSeconds(1800)).toBe(GUMLET_INGEST_URL_TTL_MIN_SECONDS);
  });

  it('clamps down to the ceiling', () => {
    expect(GUMLET_INGEST_URL_TTL_MAX_SECONDS).toBe(24 * 60 * 60);
    // AWS SigV4 permits up to 7 days; the project deliberately stops at one so a
    // leaked URL has a bounded life.
    expect(resolveGumletIngestUrlTtlSeconds(7 * 24 * 60 * 60)).toBe(GUMLET_INGEST_URL_TTL_MAX_SECONDS);
    expect(resolveGumletIngestUrlTtlSeconds('999999')).toBe(GUMLET_INGEST_URL_TTL_MAX_SECONDS);
  });

  it('floors a fractional value rather than rounding it up', () => {
    expect(resolveGumletIngestUrlTtlSeconds(3600.99)).toBe(3600);
    expect(resolveGumletIngestUrlTtlSeconds(6 * 60 * 60 + 0.5)).toBe(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
  });

  it('bounds are ordered: floor <= default <= ceiling', () => {
    expect(GUMLET_INGEST_URL_TTL_MIN_SECONDS).toBeLessThan(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS);
    expect(GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS).toBeLessThan(GUMLET_INGEST_URL_TTL_MAX_SECONDS);
  });

  it('never returns a non-integer or a non-finite value', () => {
    for (const raw of ['1', 'abc', '', undefined, null, '0', '-5', '604800', 1.7]) {
      const v = resolveGumletIngestUrlTtlSeconds(raw);
      expect(Number.isInteger(v)).toBe(true);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });
});
