import { Throttle } from '@nestjs/throttler';

/**
 * The tight bucket for credential endpoints.
 *
 * Applied with `@CredentialThrottle()` to register, login, refresh and
 * password change — the four routes where an attacker gets something for
 * guessing, and the only four the low limit was ever meant for.
 *
 * It overrides the `default` throttler rather than adding a second named one.
 * That distinction is the whole point: a second throttler would be evaluated
 * on every request in the application (`ThrottlerGuard` applies all of them),
 * which is how the previous arrangement both throttled the entire API at the
 * credential limit and doubled the platform's Redis bill.
 *
 * Read from the environment at module load because a decorator is evaluated
 * once, statically, and cannot reach into `ConfigService`. The same two
 * variables the throttler config uses, with the same defaults, so there is no
 * second source of truth to drift.
 */
function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CREDENTIAL_TTL_SECONDS = num(process.env.THROTTLE_TTL, 60);
export const CREDENTIAL_LIMIT = num(process.env.THROTTLE_AUTH_LIMIT, 10);

export const CredentialThrottle = () =>
  Throttle({
    default: { ttl: CREDENTIAL_TTL_SECONDS * 1000, limit: CREDENTIAL_LIMIT },
  });
