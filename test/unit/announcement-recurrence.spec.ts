const AnnouncementFrequency = {
  DAILY: 'DAILY',
  WEEKLY: 'WEEKLY',
  MONTHLY: 'MONTHLY',
  ONCE: 'ONCE',
} as const;

import {
  assertValidRecurrence,
  nextOccurrence,
} from '../../src/modules/notifications/recurrence';

/**
 * Scheduling arithmetic.
 *
 * All of it is pure, so the awkward cases — a timezone that changes offset
 * twice a year, a month without a 31st, a wall-clock time that does not exist —
 * are testable directly rather than by waiting for April.
 *
 * Cairo is the default zone for this platform and it observes DST again since
 * 2023, which is why the offset tests below matter: storing the UTC instant
 * instead of the local time would move every evening announcement by an hour
 * for half the year.
 */

const CAIRO = 'Africa/Cairo';

/** What a Date looks like on a Cairo wall clock. */
function inCairo(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CAIRO,
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

const daily = (sendAtLocal: string) => ({
  frequency: AnnouncementFrequency.DAILY,
  sendAtLocal,
  timezone: CAIRO,
});

describe('daylight saving', () => {
  it('keeps 19:00 local across the winter/summer boundary', () => {
    const winter = nextOccurrence(daily('19:00'), new Date('2026-01-10T00:00:00Z'));
    const summer = nextOccurrence(daily('19:00'), new Date('2026-06-10T00:00:00Z'));

    // Different UTC instants…
    expect(winter?.toISOString()).toBe('2026-01-10T17:00:00.000Z');
    expect(summer?.toISOString()).toBe('2026-06-10T16:00:00.000Z');

    // …the same time for the student, which is the whole point.
    expect(inCairo(winter as Date)).toContain('19:00');
    expect(inCairo(summer as Date)).toContain('19:00');
  });

  it('does not skip a send when the local time does not exist', () => {
    // Egypt springs forward at midnight on the last Friday of April, so
    // 00:30 on 2026-04-24 is a wall time that never happens. The send must
    // still occur rather than vanishing for a day.
    const next = nextOccurrence(daily('00:30'), new Date('2026-04-23T12:00:00Z'));

    expect(next).not.toBeNull();
    expect(next?.toISOString()).toBe('2026-04-23T22:30:00.000Z');
    // It lands just past the gap.
    expect(inCairo(next as Date)).toContain('01:30');
  });

  it('returns to the normal time the following day', () => {
    const afterGap = nextOccurrence(daily('00:30'), new Date('2026-04-23T22:30:00.000Z'));

    expect(inCairo(afterGap as Date)).toContain('00:30');
  });
});

describe('weekly', () => {
  it('picks the next matching weekday', () => {
    // Monday 14 Sep 2026; asking for Wednesday and Sunday.
    const next = nextOccurrence(
      {
        frequency: AnnouncementFrequency.WEEKLY,
        sendAtLocal: '08:30',
        timezone: CAIRO,
        weekdays: [3, 7],
      },
      new Date('2026-09-14T00:00:00Z'),
    );

    expect(next?.toISOString()).toBe('2026-09-16T05:30:00.000Z');
  });

  it('wraps to the following week when the day has passed', () => {
    // Thursday, asking only for Monday.
    const next = nextOccurrence(
      {
        frequency: AnnouncementFrequency.WEEKLY,
        sendAtLocal: '08:30',
        timezone: CAIRO,
        weekdays: [1],
      },
      new Date('2026-09-17T12:00:00Z'),
    );

    expect(inCairo(next as Date)).toContain('21/09/2026');
  });
});

describe('monthly', () => {
  it('clamps the 31st to the last day of a shorter month', () => {
    // "Monthly on the 31st" means the end of every month, not eight of them.
    const november = nextOccurrence(
      {
        frequency: AnnouncementFrequency.MONTHLY,
        sendAtLocal: '12:00',
        timezone: CAIRO,
        dayOfMonth: 31,
      },
      new Date('2026-11-05T00:00:00Z'),
    );

    expect(inCairo(november as Date)).toContain('30/11/2026');
  });

  it('clamps to 28 in a non-leap February', () => {
    const february = nextOccurrence(
      {
        frequency: AnnouncementFrequency.MONTHLY,
        sendAtLocal: '12:00',
        timezone: CAIRO,
        dayOfMonth: 31,
      },
      new Date('2027-02-05T00:00:00Z'),
    );

    expect(inCairo(february as Date)).toContain('28/02/2027');
  });
});

describe('exhaustion', () => {
  it('stops after maxOccurrences', () => {
    expect(
      nextOccurrence(
        { ...daily('19:00'), maxOccurrences: 3, occurrenceCount: 3 },
        new Date('2026-01-10T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('stops a one-off that has already fired', () => {
    expect(
      nextOccurrence(
        {
          frequency: AnnouncementFrequency.ONCE,
          sendAtLocal: '19:00',
          timezone: CAIRO,
          occurrenceCount: 1,
        },
        new Date('2026-01-10T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('stops past the end date', () => {
    expect(
      nextOccurrence(
        { ...daily('19:00'), endsOn: new Date('2026-01-09T00:00:00Z') },
        new Date('2026-01-10T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('waits for the start date', () => {
    const next = nextOccurrence(
      { ...daily('19:00'), startsOn: new Date('2027-03-01T00:00:00Z') },
      new Date('2026-01-10T00:00:00Z'),
    );

    expect(inCairo(next as Date)).toContain('01/03/2027');
  });
});

describe('strictly forward', () => {
  it('never returns the instant it was given', () => {
    // Otherwise a dispatcher that computes "next" from the occurrence it just
    // sent would return the same one and loop.
    const at = new Date('2026-01-10T17:00:00.000Z');
    const next = nextOccurrence(daily('19:00'), at);

    expect(next?.getTime()).toBeGreaterThan(at.getTime());
  });

  it('rolls to tomorrow when today’s time has passed', () => {
    const next = nextOccurrence(daily('19:00'), new Date('2026-01-10T18:00:00Z'));

    expect(next?.toISOString()).toBe('2026-01-11T17:00:00.000Z');
  });
});

describe('validation', () => {
  const cases: [string, Parameters<typeof assertValidRecurrence>[0], string][] = [
    [
      'a malformed time',
      { frequency: AnnouncementFrequency.DAILY, sendAtLocal: '7pm', timezone: CAIRO },
      'sendAtLocal',
    ],
    [
      'an out-of-range hour',
      { frequency: AnnouncementFrequency.DAILY, sendAtLocal: '25:00', timezone: CAIRO },
      'sendAtLocal',
    ],
    [
      'an unknown timezone',
      {
        frequency: AnnouncementFrequency.DAILY,
        sendAtLocal: '19:00',
        timezone: 'Mars/Olympus',
      },
      'timezone',
    ],
    [
      'a weekly schedule with no weekday',
      {
        frequency: AnnouncementFrequency.WEEKLY,
        sendAtLocal: '19:00',
        timezone: CAIRO,
        weekdays: [],
      },
      'weekdays',
    ],
    [
      'a weekday outside 1–7',
      {
        frequency: AnnouncementFrequency.WEEKLY,
        sendAtLocal: '19:00',
        timezone: CAIRO,
        weekdays: [0],
      },
      'weekdays',
    ],
    [
      'a monthly schedule with no day',
      { frequency: AnnouncementFrequency.MONTHLY, sendAtLocal: '19:00', timezone: CAIRO },
      'dayOfMonth',
    ],
    [
      'an end before the start',
      {
        ...daily('19:00'),
        startsOn: new Date('2026-06-01T00:00:00Z'),
        endsOn: new Date('2026-05-01T00:00:00Z'),
      },
      'endsOn',
    ],
  ];

  it.each(cases)('refuses %s', (_label, spec, field) => {
    try {
      assertValidRecurrence(spec);
      throw new Error('should have thrown');
    } catch (e) {
      const error = e as { fields?: Record<string, string[]> };
      expect(error.fields).toHaveProperty(field);
    }
  });

  it('accepts a well-formed weekly schedule', () => {
    expect(() =>
      assertValidRecurrence({
        frequency: AnnouncementFrequency.WEEKLY,
        sendAtLocal: '19:00',
        timezone: CAIRO,
        weekdays: [1, 4],
      }),
    ).not.toThrow();
  });
});
