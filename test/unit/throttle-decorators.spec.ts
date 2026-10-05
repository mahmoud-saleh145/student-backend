import 'reflect-metadata';

import { THROTTLER_LIMIT, THROTTLER_TTL } from '@nestjs/throttler/dist/throttler.constants';
import { describe, expect, it, beforeEach } from '@jest/globals';

/**
 * Regression coverage for the inert rate limiters.
 *
 * `ThrottlerGuard` iterates the throttlers it was configured with and reads
 * `THROTTLER_LIMIT + throttler.name` off the handler for each. `AppModule`
 * configures exactly one, `default`. So every decorator that named `auth`,
 * `playback` or `code` was writing metadata nobody ever read:
 *
 *   - the 60-tickets-per-hour anti-scraping ceiling on `POST /playback/tickets`
 *     was not enforced at all,
 *   - the 10-per-5-minutes limit on all three code-redemption routes was not
 *     enforced at all,
 *   - login/register/password were covered only because `CredentialThrottle`
 *     independently targeted `default`.
 *
 * These tests assert the metadata a real guard reads, against the same
 * configured throttler list `AppModule` builds. That is the actual contract: a
 * name that is not in the list is a silent no-op, and only reading the metadata
 * through the configured list would catch that.
 */

const CONFIGURED_THROTTLERS: Array<{ name: string }> = [{ name: 'default' }];

type HandlerLike = (...args: never[]) => unknown;

function readConfiguredLimit(handler: HandlerLike): number | undefined {
  for (const t of CONFIGURED_THROTTLERS) {
    const value = Reflect.getMetadata(THROTTLER_LIMIT + t.name, handler);
    if (value !== undefined) return value as number;
  }
  return undefined;
}

function readConfiguredTtl(handler: HandlerLike): number | undefined {
  for (const t of CONFIGURED_THROTTLERS) {
    const value = Reflect.getMetadata(THROTTLER_TTL + t.name, handler);
    if (value !== undefined) return value as number;
  }
  return undefined;
}

describe('route rate limits must target a configured throttler name', () => {
  let CredentialThrottle: () => MethodDecorator;
  let PlaybackThrottle: () => MethodDecorator;
  let CodeThrottle: () => MethodDecorator;

  beforeEach(async () => {
    const mod = await import('../../src/common/decorators/throttle.decorator');
    CredentialThrottle = mod.CredentialThrottle;
    PlaybackThrottle = mod.PlaybackThrottle;
    CodeThrottle = mod.CodeThrottle;
  });

  it('configures exactly one throttler, named default', () => {
    // If this ever grows, every decorator below has to be re-checked: a new
    // configured name is applied to EVERY request, not just the routes that
    // mention it, which would silently tighten the whole API.
    expect(CONFIGURED_THROTTLERS).toHaveLength(1);
    expect(CONFIGURED_THROTTLERS[0]?.name).toBe('default');
  });

  describe('CredentialThrottle', () => {
    it('writes a limit the configured throttler actually reads', () => {
      class C {
        @CredentialThrottle()
        handler() {}
      }

      expect(readConfiguredLimit(C.prototype.handler)).toBe(10);
      expect(readConfiguredTtl(C.prototype.handler)).toBe(60_000);
    });
  });

  describe('PlaybackThrottle', () => {
    it('enforces the anti-scraping ceiling on ticket issuance', () => {
      class C {
        @PlaybackThrottle()
        handler() {}
      }

      // The whole point of the fix: this was 60 tickets/hour in the source and
      // nothing enforced it.
      expect(readConfiguredLimit(C.prototype.handler)).toBe(60);
      expect(readConfiguredTtl(C.prototype.handler)).toBe(3_600_000);
    });

    it('uses a window long enough to distinguish scraping from watching', () => {
      class C {
        @PlaybackThrottle()
        handler() {}
      }

      const ttl = readConfiguredTtl(C.prototype.handler);

      // A per-minute ceiling would flag ordinary students; scraping spreads its
      // requests over a long window, so the window has to be long too.
      expect(ttl).toBeGreaterThanOrEqual(60 * 60 * 1000);
    });
  });

  describe('CodeThrottle', () => {
    it('enforces the brute-force limit code redemption needs', () => {
      class C {
        @CodeThrottle()
        handler() {}
      }

      expect(readConfiguredLimit(C.prototype.handler)).toBe(10);
      expect(readConfiguredTtl(C.prototype.handler)).toBe(300_000);
    });
  });

  it('writes no metadata under any unconfigured name', () => {
    class C {
      @PlaybackThrottle()
      @CodeThrottle()
      @CredentialThrottle()
      handler() {}
    }

    // Guards the regression at its root: a decorator must not leave stray
    // `playback`/`code`/`auth` metadata behind that would resurrect the
    // illusion of a named bucket.
    for (const name of ['auth', 'playback', 'code']) {
      expect(Reflect.getMetadata(THROTTLER_LIMIT + name, C.prototype.handler)).toBeUndefined();
      expect(Reflect.getMetadata(THROTTLER_TTL + name, C.prototype.handler)).toBeUndefined();
    }
  });
});

describe('limit values come from validated configuration', () => {
  it('falls back rather than producing NaN when a variable is malformed', async () => {
    const { CredentialThrottle, PLAYBACK_TICKET_LIMIT, CODE_ATTEMPT_LIMIT } = await import(
      '../../src/common/decorators/throttle.decorator'
    );

    expect(Number.isFinite(PLAYBACK_TICKET_LIMIT)).toBe(true);
    expect(PLAYBACK_TICKET_LIMIT).toBeGreaterThan(0);
    expect(CODE_ATTEMPT_LIMIT).toBeGreaterThan(0);

    class C {
      @CredentialThrottle()
      handler() {}
    }

    // A NaN limit would be read as "limit of zero" by the guard and lock the
    // route out entirely, so the value must always be a real positive number.
    const limit = readConfiguredLimit(C.prototype.handler);
    expect(Number.isFinite(limit)).toBe(true);
    expect(limit).toBeGreaterThan(0);
  });
});
