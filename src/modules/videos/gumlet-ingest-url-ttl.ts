/**
 * Lifetime of the R2 presigned URL handed to Gumlet for input ingestion.
 *
 * WHY THIS EXISTS AS A MODULE
 *
 * The value used to be a bare `3600` literal inside `adopt()`. That is exactly
 * how the production failure on 2026-10-15 happened, so the constant and its
 * bounds now live in one testable place rather than being scattered between the
 * service, its tests and documentation.
 *
 * WHY ONE HOUR WAS TOO SHORT
 *
 * Gumlet's ingest is asynchronous and QUEUED, not synchronous with our request.
 * `created_at` at Gumlet is the moment we POST the asset; the provider then
 * schedules its own download and only then begins transcoding. For the asset
 * that failed, Gumlet's own record showed:
 *
 *   input.transformations.pre_processing_successful = true   <- it DID fetch
 *   updated_at - created_at                            = 86.8 minutes
 *   X-Amz-Expires                                     = 3600 seconds
 *   time between the URL expiring and the terminal error  = +26.8 minutes
 *
 * It reported `ERR_ASSET_NOT_FOUND` ("trouble downloading the input video/audio
 * file") 27 minutes AFTER our signature had expired. SigV4 is checked at each
 * request, so a download that had to be (re-)attempted after expiry fails even
 * though the object itself is perfectly readable - AWS documents this exact
 * behaviour for downloads that are interrupted and restarted.
 *
 * WHAT A LONGER LIFETIME ACTUALLY BUYS
 *
 * Only one thing: it stops the URL from expiring underneath a provider that is
 * still legitimately working. It does NOT stop Gumlet from failing on a source
 * it genuinely cannot reach, nor a codec/transcode failure, nor a provider-side
 * queue problem, nor DRM packaging errors. Those are separate failure modes and
 * are handled by recording the provider's verdict honestly, not by widening a
 * window.
 *
 * WHAT IT COSTS NOTHING IN
 *
 * The URL still grants read on exactly ONE private object in the `uploads`
 * bucket. It is never logged, never returned to a client, still bypasses the
 * CDN entirely, and the Worker's rule that `/source/` is never served is
 * untouched. A longer window on a single-object, single-use ingestion grant is
 * a materially different thing from a long-lived viewer URL.
 *
 * WHY NOT A DURATION-DERIVED LIFETIME
 *
 * It is tempting to scale the TTL to the source's duration, but the measurement
 * above shows duration does NOT predict the ingest window: the failed asset was
 * 47.4 minutes long while a 63.5-minute source completed in 2.6 minutes. The
 * variable that matters is provider-side scheduling latency, which we cannot
 * observe from here. A flat, generous window with a documented ceiling is
 * therefore both simpler to reason about and more reliable than any formula.
 *
 * BOUNDS
 *
 *   minimum  3600s (1h)  - strictly wider than the old value, so raising the
 *                          floor can never shorten an existing deployment.
 *   default 21600s (6h)  - ~5x the longest ingest observed here, and comfortably
 *                          inside a single business day of re-processing.
 *   maximum 86400s (24h) - governed by operator intent, not by need. AWS SigV4
 *                          permits up to 7 days, but a source object still
 *                          readable a day later is not a useful capability, and
 *                          a hard daily ceiling bounds the blast radius of a
 *                          leaked URL.
 */

export const GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS = 6 * 60 * 60;

export const GUMLET_INGEST_URL_TTL_MIN_SECONDS = 60 * 60;

export const GUMLET_INGEST_URL_TTL_MAX_SECONDS = 24 * 60 * 60;

/**
 * Resolve the ingestion-URL lifetime from a raw environment value.
 *
 * Pure so it can be unit-tested without booting Nest, and so the same rule runs
 * in the app and in any test.
 *
 * Behaviour, deliberately boring:
 *   unset / blank / not a number -> the default
 *   below the floor                -> clamped up to the floor (never shortens)
 *   above the ceiling              -> clamped down to the ceiling
 *
 * Clamping rather than rejecting keeps a typo from taking ingestion down
 * entirely: a too-small TTL fails slowly and expensively, a hard startup
 * failure fails loudly but blocks every upload.
 */
export function resolveGumletIngestUrlTtlSeconds(raw: string | number | undefined | null): number {
  if (raw === undefined || raw === null || raw === '') return GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS;

  const parsed = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return GUMLET_INGEST_URL_TTL_DEFAULT_SECONDS;

  const seconds = Math.floor(parsed);
  if (seconds < GUMLET_INGEST_URL_TTL_MIN_SECONDS) return GUMLET_INGEST_URL_TTL_MIN_SECONDS;
  if (seconds > GUMLET_INGEST_URL_TTL_MAX_SECONDS) return GUMLET_INGEST_URL_TTL_MAX_SECONDS;
  return seconds;
}
