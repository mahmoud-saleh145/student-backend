import { Throttle } from '@nestjs/throttler';

/**
 * Rate limits for individual routes.
 *
 * ## Every decorator here overrides `default`, and that is load-bearing
 *
 * `ThrottlerGuard` does not look for a named throttler on the route — it loops
 * over the throttlers it was *configured* with and reads
 * `THROTTLER_LIMIT + throttler.name` off the handler for each one. A decorator
 * naming something that is not in that list is silently inert: no error, no
 * warning, the limit simply does not exist.
 *
 * `AppModule` configures exactly one throttler, `default`. So these must all
 * target `default`. An earlier version of this file declared
 * `@Throttle({ auth: … })`, `@Throttle({ playback: … })` and
 * `@Throttle({ code: … })`, which read as three extra limits and were in
 * practice three no-ops:
 *
 *   - `AuthThrottle` on login/register/password did nothing. Those routes were
 *     already covered by `CredentialThrottle`, so the outcome was right by
 *     accident rather than by design.
 *   - `PlaybackThrottle` did nothing. The "60 tickets/hour" anti-scraping
 *     ceiling was not being enforced at the route at all; ticket issuance was
 *     bounded only by whatever the global 120/min limit allowed, which is not
 *     the same control and does not survive scraping spread over minutes.
 *   - `CodeThrottle` did nothing, on all three code-redemption routes. Brute
 *     forcing an access code was bounded only by the global limit.
 *
 * Registering extra names in `ThrottlerModule` would be the wrong fix: the guard
 * applies *every* configured throttler to *every* request, so a second name does
 * not scope itself to the routes that name it — it silently tightens the whole
 * API to the tighter of the two limits. Overriding `default` keeps one bucket
 * per request and makes the route's own limit the only limit in play.
 *
 * Read from the environment at module load: a decorator is evaluated once,
 * statically, and cannot reach `ConfigService`. Each value is validated by
 * `EnvValidation` at boot, and `num()` keeps a malformed value from producing
 * `NaN`, which the guard would treat as a limit of zero.
 */
function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * The credential ceiling — register, login, change-password.
 *
 * Tight, and keyed by IP *and* submitted phone (see `ThrottlerProxyGuard`), so
 * neither one attacker behind a NAT nor password spraying across many accounts
 * gets a free run at it.
 */
export const CREDENTIAL_TTL_SECONDS = num(process.env.THROTTLE_TTL, 60);
export const CREDENTIAL_LIMIT = num(process.env.THROTTLE_AUTH_LIMIT, 10);

export const CredentialThrottle = () =>
  Throttle({
    default: { ttl: CREDENTIAL_TTL_SECONDS * 1000, limit: CREDENTIAL_LIMIT },
  });

/**
 * Playback ticket issuance — the real anti-scraping control.
 *
 * Deliberately a long window with a small count: a student watches a handful of
 * lessons, so a steady stream of tickets is what scraping looks like, and a
 * per-minute ceiling would not distinguish it from ordinary use. Applied per
 * authenticated user, since `ThrottlerProxyGuard` keys authenticated requests on
 * `user.id`.
 */
export const PLAYBACK_TICKET_LIMIT = num(process.env.PLAYBACK_TICKETS_PER_HOUR, 60);

export const PlaybackThrottle = () =>
  Throttle({
    default: { ttl: 3_600_000, limit: PLAYBACK_TICKET_LIMIT },
  });

/**
 * Access-code redemption.
 *
 * Codes are the one credential an attacker can brute-force cheaply, so the
 * window is generous but the count is small: ten attempts per five minutes is
 * far above legitimate use and far below a search.
 */
export const CODE_ATTEMPT_LIMIT = 10;

export const CodeThrottle = () =>
  Throttle({
    default: { ttl: 300_000, limit: CODE_ATTEMPT_LIMIT },
  });
