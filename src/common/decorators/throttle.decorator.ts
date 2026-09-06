import { Throttle } from '@nestjs/throttler';

/**
 * Tight limit for credential endpoints. Applied per IP + phone by
 * AuthThrottlerGuard so one attacker cannot lock out a whole NAT range.
 */
export const AuthThrottle = () =>
  Throttle({ auth: { limit: Number(process.env.THROTTLE_AUTH_LIMIT ?? 10), ttl: 60_000 } });

/** Ticket issuance ceiling — the main anti-scraping control. */
export const PlaybackThrottle = () =>
  Throttle({
    playback: {
      limit: Number(process.env.PLAYBACK_TICKETS_PER_HOUR ?? 60),
      ttl: 3_600_000,
    },
  });

/** Moderate limit for code redemption, to slow brute-forcing of codes. */
export const CodeThrottle = () => Throttle({ code: { limit: 10, ttl: 300_000 } });
