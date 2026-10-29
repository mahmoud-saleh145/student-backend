import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

import type { Request } from 'express';

/**
 * Which address a request is attributed to (owner decision D6).
 *
 * Two kinds of caller reach this API:
 *
 *  - The mobile app, directly. Its address is `req.ip`, which Express derives
 *    from the socket and - when `TRUST_PROXY` is on - from the hops the hosting
 *    balancer appended (`TRUST_PROXY_HOPS`). The client can write anything into
 *    `X-Forwarded-For`, so the header itself is never read here.
 *
 *  - The student web app's server (Next.js on Vercel), on behalf of a browser.
 *    `req.ip` is then a Vercel egress address shared by every web student. The
 *    web server knows the browser's address (Vercel overwrites
 *    `X-Forwarded-For` / `X-Real-IP` with it) and forwards it in
 *    `X-Edu-Client-Ip`, together with a shared secret in `X-Edu-Proxy-Secret`.
 *    The forwarded address is believed ONLY when that secret matches
 *    `WEB_PROXY_SHARED_SECRET`; otherwise both headers are ignored and the
 *    request is attributed to `req.ip` like any other direct caller.
 *
 * The secret is compared in constant time, removed from the request before any
 * other code runs, and never logged or echoed.
 */

export const WEB_CLIENT_IP_HEADER = 'x-edu-client-ip';
export const WEB_PROXY_SECRET_HEADER = 'x-edu-proxy-secret';
/** A shorter secret is refused at boot by env validation. */
export const MIN_WEB_PROXY_SECRET_LENGTH = 32;

export type ClientIpSource = 'web-proxy' | 'direct';

export interface ResolvedClientIp {
  ip: string | null;
  source: ClientIpSource;
}

/** Constant-time comparison that also hides the expected length. */
export function proxySecretMatches(provided: string | undefined, expected: string | null): boolean {
  if (!expected || expected.length < MIN_WEB_PROXY_SECRET_LENGTH || !provided) return false;
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** A single, syntactically valid IPv4/IPv6 address, or null. Never a list. */
export function parseForwardedClientIp(raw: string | undefined): string | null {
  if (!raw) return null;
  const value = raw.trim();
  if (value.length === 0 || value.length > 45 || value.includes(',')) return null;
  return isIP(value) ? value : null;
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function resolveClientIp(req: Request, secret: string | null): ResolvedClientIp {
  const direct = req.ip ?? req.socket?.remoteAddress ?? null;
  if (proxySecretMatches(header(req, WEB_PROXY_SECRET_HEADER), secret)) {
    const forwarded = parseForwardedClientIp(header(req, WEB_CLIENT_IP_HEADER));
    if (forwarded) return { ip: forwarded, source: 'web-proxy' };
  }
  return { ip: direct, source: 'direct' };
}

/**
 * Applies the resolution to the request so every existing `req.ip` reader -
 * the throttler, sessions, security events, the audit log - gets the same
 * answer without each one re-implementing it. Strips both headers so nothing
 * downstream can read the secret or a forwarded address of unknown standing.
 */
export function applyClientIp(req: Request, secret: string | null): ResolvedClientIp {
  const resolved = resolveClientIp(req, secret);
  delete req.headers[WEB_PROXY_SECRET_HEADER];
  delete req.headers[WEB_CLIENT_IP_HEADER];
  if (resolved.source === 'web-proxy') {
    Object.defineProperty(req, 'ip', {
      value: resolved.ip,
      configurable: true,
      enumerable: true,
      writable: false,
    });
  }
  req.clientIpSource = resolved.source;
  return resolved;
}

// ---------------------------------------------------------------------------
// Diagnostics: how the hosting platform actually builds the forwarding chain
// ---------------------------------------------------------------------------

/** Headers some platforms use to carry the client address. Read for display only. */
export const DIAGNOSTIC_ADDRESS_HEADERS = [
  'x-real-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'x-client-ip',
  'fly-client-ip',
] as const;

/**
 * The largest `TRUST_PROXY_HOPS` the API accepts. Env validation (`@Max(10)`)
 * and `configuration.ts` both stop at 10, and the diagnostic must cover every
 * value an operator could actually configure.
 */
export const MAX_TRUST_PROXY_HOPS = 10;

/** How many forwarding entries the diagnostic lists (the RIGHTMOST ones). */
export const DIAGNOSTIC_FORWARDED_FOR_SHOWN = 20;

/**
 * Entries parsed from one X-Forwarded-For header. Far above any real chain and
 * still bounded, so a hostile header cannot make the diagnostic expensive.
 */
const MAX_FORWARDED_FOR_PARSED = 200;

export interface ClientIpChainReport {
  trustProxy: boolean;
  trustProxyHops: number;
  socketAddress: string | null;
  /**
   * The RIGHTMOST entries of X-Forwarded-For, in the order received (left to
   * right), at most `DIAGNOSTIC_FORWARDED_FOR_SHOWN`. The right end is the part
   * the platform wrote; the left end is whatever the client sent, so that is
   * the end that gets dropped when the header is long.
   */
  forwardedFor: string[];
  /** Entries in the header (up to an internal bound), shown or not. */
  forwardedForTotal: number;
  /** True when `forwardedFor` omits entries from the left. */
  forwardedForTruncated: boolean;
  /**
   * What `req.ip` would be for each `trust proxy` hop count,
   * 1..`MAX_TRUST_PROXY_HOPS`, computed from the FULL header (not only the
   * entries shown).
   */
  ipByHopCount: Record<string, string | null>;
  /** The address the operator says this request came from, when given and valid. */
  expectedIp: string | null;
  /**
   * Hop counts whose `ipByHopCount` equals `expectedIp` (empty when none, or
   * when no expected address was given). See OWNER_DECISIONS D6 for how two
   * calls are combined into a decision.
   */
  hopCountsMatchingExpected: number[];
  resolvedIp: string | null;
  resolvedSource: ClientIpSource | null;
  otherAddressHeaders: Record<string, string | null>;
}

/**
 * The address Express returns for `trust proxy = hops`: the socket peer and
 * the forwarding entries are read from the right, and the first untrusted one
 * wins; with more hops than entries it is the leftmost entry.
 */
export function expressIpForHops(socketAddress: string | null, forwardedFor: string[], hops: number): string | null {
  const chain = [socketAddress, ...[...forwardedFor].reverse()];
  return chain[Math.min(hops, chain.length - 1)] ?? null;
}

/**
 * A description of the caller's OWN request, for an operator checking the
 * platform's proxy behaviour (OWNER_DECISIONS D6). It never influences
 * attribution, and it reads only the forwarding and address headers above:
 * the proxy secret was already stripped by the middleware and is never read.
 */
export function describeClientIpChain(
  req: Request,
  cfg: { trustProxy: boolean; trustProxyHops: number },
  options: { expectedIp?: string | null } = {},
): ClientIpChainReport {
  const rawForwarded = header(req, 'x-forwarded-for') ?? '';
  // Every entry (up to the bound) feeds the hop computation, exactly as Express
  // reads the whole header; only the display is shortened, from the left.
  const allForwarded = rawForwarded
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(-MAX_FORWARDED_FOR_PARSED)
    .map((part) => part.slice(0, 64));
  const forwardedFor = allForwarded.slice(-DIAGNOSTIC_FORWARDED_FOR_SHOWN);
  const socketAddress = req.socket?.remoteAddress ?? null;
  const ipByHopCount: Record<string, string | null> = {};
  for (let hops = 1; hops <= MAX_TRUST_PROXY_HOPS; hops += 1) {
    ipByHopCount[String(hops)] = expressIpForHops(socketAddress, allForwarded, hops);
  }
  const expectedIp = parseForwardedClientIp(options.expectedIp ?? undefined);
  const hopCountsMatchingExpected = expectedIp
    ? Object.entries(ipByHopCount)
        .filter(([, ip]) => ip === expectedIp)
        .map(([hops]) => Number(hops))
    : [];
  const otherAddressHeaders: Record<string, string | null> = {};
  for (const name of DIAGNOSTIC_ADDRESS_HEADERS) {
    otherAddressHeaders[name] = header(req, name)?.slice(0, 64) ?? null;
  }
  return {
    trustProxy: cfg.trustProxy,
    trustProxyHops: cfg.trustProxyHops,
    socketAddress,
    forwardedFor,
    forwardedForTotal: allForwarded.length,
    forwardedForTruncated: allForwarded.length > forwardedFor.length,
    ipByHopCount,
    expectedIp,
    hopCountsMatchingExpected,
    resolvedIp: req.ip ?? null,
    resolvedSource: req.clientIpSource ?? null,
    otherAddressHeaders,
  };
}
