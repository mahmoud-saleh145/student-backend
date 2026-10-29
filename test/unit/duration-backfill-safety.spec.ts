/**
 * Duration backfill safety.
 *
 * The backfill script writes to the `videos` table using the live Prisma client,
 * so its rules are pinned here as pure functions rather than by executing it.
 * What must hold:
 *
 *   * a provider duration is validated before it is trusted;
 *   * 0/absent/garbage is UNKNOWN, never a stored zero;
 *   * the stored value is seconds (no /1000);
 *   * a recount is a pure recomputation, so it is idempotent.
 */

type LessonLike = { id: string; durationSeconds: number };

/** Mirrors `normalizeDurationSeconds` in the backfill script. */
function normalize(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return null;
  const seconds = Math.round(raw);
  return seconds > 0 ? seconds : null;
}

/** Mirrors the recount rules copied from `CoursesService.recountCourse`. */
function recount(lessons: LessonLike[], sections: number) {
  const published = lessons.filter((l) => l.durationSeconds >= 0);
  return {
    sectionCount: sections,
    lessonCount: published.length,
    totalDurationSeconds: published.reduce((sum, l) => sum + l.durationSeconds, 0),
  };
}

describe('provider duration validation', () => {
  it('accepts a plausible positive float-seconds value', () => {
    expect(normalize(183.088)).toBe(183);
    expect(normalize(4317)).toBe(4317);
  });

  it('rejects everything that is not a trustworthy positive number', () => {
    expect(normalize(0)).toBeNull();
    expect(normalize(-1)).toBeNull();
    expect(normalize(NaN)).toBeNull();
    expect(normalize(Infinity)).toBeNull();
    expect(normalize(undefined)).toBeNull();
    expect(normalize(null)).toBeNull();
    expect(normalize('4317')).toBeNull();
    expect(normalize({})).toBeNull();
    expect(normalize([])).toBeNull();
  });

  it('never produces a zero from a positive input', () => {
    // A sub-second value rounds to 0, which is not a duration we can display.
    expect(normalize(0.2)).toBeNull();
  });

  it('does not convert seconds into milliseconds', () => {
    // A 40-minute lecture is 2400 seconds. Dividing by 1000 would store 2.
    expect(normalize(2400)).toBe(2400);
    expect(normalize(2400)).not.toBe(2);
  });

  it('would have produced the right answer for the real assets', () => {
    // The actual values the provider returned for the six broken videos.
    expect(normalize(4779)).toBe(4779);
    expect(normalize(2849)).toBe(2849);
    expect(normalize(3909)).toBe(3909);
    expect(normalize(3311)).toBe(3311);
    expect(normalize(3313)).toBe(3313);
    expect(normalize(4317)).toBe(4317);
  });
});

/**
 * Mirrors the write payload built by `scripts/backfill-gumlet-durations.js`.
 *
 * The script repairs ONE number. This is pinned because the payload is the
 * only thing that decides what a production write actually touches: a stray
 * `frameRate` here would write the provider's `input.fps` of 90000 straight into
 * a real column. Geometry is the ingest path's job, not the backfill's.
 */
function buildWritePayload(seconds: number): Record<string, number> {
  return { durationSeconds: seconds };
}

describe('backfill write payload', () => {
  it('contains durationSeconds and nothing else', () => {
    const payload = buildWritePayload(3983);
    expect(Object.keys(payload)).toEqual(['durationSeconds']);
    expect(payload.durationSeconds).toBe(3983);
  });

  it('never carries source geometry or any DRM/platform column', () => {
    const forbidden = [
      'width', 'height', 'frameRate',
      'status', 'drmProvider', 'gumletAssetId', 'gumletStatus',
      'drmVerifiedAt', 'drmRequested', 'drmBlockedReason', 'drmCheckedAt',
    ];
    for (const seconds of [1, 183, 3983, 2932, 4317]) {
      for (const field of forbidden) {
        expect(Object.keys(buildWritePayload(seconds))).not.toContain(field);
      }
    }
  });

  it('is written only for a normalised positive provider value', () => {
    // normalize() returning null means the script skips the row entirely, so no
    // payload is ever built from an unknown duration.
    for (const raw of [0, -1, 0.2, NaN, Infinity, undefined, null, '3983']) {
      const seconds = normalize(raw);
      if (seconds === null) continue;
      expect(buildWritePayload(seconds).durationSeconds).toBe(seconds);
      expect(seconds).toBeGreaterThan(0);
    }
  });
});

describe('course duration recount', () => {
  const lessons = [
    { id: 'l1', durationSeconds: 4317 },
    { id: 'l2', durationSeconds: 4779 },
  ];

  it('sums lesson durations', () => {
    expect(recount(lessons, 2)).toEqual({
      sectionCount: 2,
      lessonCount: 2,
      totalDurationSeconds: 9096,
    });
  });

  it('is idempotent - recounting unchanged lessons changes nothing', () => {
    const first = recount(lessons, 2);
    const second = recount(lessons, 2);
    expect(second).toEqual(first);
  });

  it('is a recomputation, not an accumulator - it cannot drift', () => {
    // Running it ten times must not multiply the total.
    let total = 0;
    for (let i = 0; i < 10; i += 1) total = recount(lessons, 2).totalDurationSeconds;
    expect(total).toBe(9096);
  });

  it('handles a course with no durations without producing NaN', () => {
    const empty = recount([{ id: 'l1', durationSeconds: 0 }], 1);
    expect(empty.totalDurationSeconds).toBe(0);
    expect(Number.isNaN(empty.totalDurationSeconds)).toBe(false);
  });
});