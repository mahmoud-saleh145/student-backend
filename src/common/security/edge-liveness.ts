import { SetMetadata } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Worker-to-backend authentication for the ticket liveness route.
 *
 * The media Worker asks `GET /playback/tickets/:id/state` whether a signed URL
 * is still good. Two things depend on recognising that caller:
 *
 *   - the route must not answer strangers: it says whether a user holds a
 *     Library part and has a live session;
 *   - it must not count against the per-IP throttle: every probe arrives from
 *     a small set of Cloudflare addresses, so ordinary traffic could exhaust
 *     one bucket, and a Library document now fails closed on the resulting 429.
 *
 * The secret travels only in this header, Worker to API, over TLS. It is never
 * placed in a URL, so it cannot reach an access log or the Worker's cache key.
 */
export const EDGE_SECRET_HEADER = 'x-edge-secret';

export const EDGE_LIVENESS_ROUTE = 'edgeLivenessRoute';

/** Marks a route the throttler may skip for a caller holding the edge secret. */
export const EdgeLivenessRoute = () => SetMetadata(EDGE_LIVENESS_ROUTE, true);

/**
 * Constant-time check of the header against the configured secret.
 *
 * Both sides are hashed first because `timingSafeEqual` throws on a length
 * mismatch, which would otherwise reveal the secret's length. No configured
 * secret means nobody is authenticated: it never means everybody is.
 */
export function hasValidEdgeSecret(provided: unknown, expected: string | null | undefined): boolean {
  if (!expected || typeof provided !== 'string' || provided.length === 0) return false;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(provided), digest(expected));
}
