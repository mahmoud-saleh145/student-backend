/**
 * =============================================================================
 * EduPlatform — media edge gate (Cloudflare Worker)
 * =============================================================================
 *
 * Deploy this in front of the private R2 bucket that holds HLS playlists,
 * segments, captions and protected attachments. Nothing in that bucket is
 * publicly readable; this Worker is the only path to its bytes.
 *
 * Why an edge Worker rather than plain S3 presigned URLs
 * -----------------------------------------------------
 * A presigned URL is bound to an *object and a clock*, nothing else. Whoever
 * holds the string can fetch the bytes — copy it into a group chat and every
 * recipient gets the video until it expires. That is not good enough for paid
 * content.
 *
 * The signature this Worker checks additionally covers the **viewer**: user,
 * session, device and playback ticket. A copied URL therefore fails at the
 * edge even while it is still inside its expiry window, because the Worker can
 * ask the API whether that ticket is still live and belongs to that viewer.
 *
 * It also lets the server enforce a quality ceiling (`mh`), which is not
 * something a client-side player choice can be trusted to respect.
 *
 * The signature contract
 * ----------------------
 * Computed by src/modules/storage/storage.service.ts as:
 *
 *     HMAC-SHA256(
 *       MEDIA_SIGNING_KEY,
 *       objectKey + "\n" + exp + "\n" + uid + "\n" + sid + "\n" +
 *       did + "\n" + tid + "\n" + maxHeight
 *     )  → base64url
 *
 * Absent optional values are the empty string; maxHeight is 0 when unset. The
 * field order and the newline separator are part of the contract — newline is
 * used rather than a delimiter like "|" so no value can be shifted across a
 * boundary to forge an equivalent canonical string.
 *
 * Setup
 * -----
 *   npm create cloudflare@latest edu-media-gate
 *   # replace src/index.js with this file
 *
 *   wrangler.toml:
 *     name = "edu-media-gate"
 *     main = "src/index.js"
 *     compatibility_date = "2025-01-01"
 *
 *     [[r2_buckets]]
 *     binding = "MEDIA"
 *     bucket_name = "edu-media-prod"
 *
 *     [[r2_buckets]]
 *     binding = "LIBRARY"
 *     bucket_name = "edu-library"
 *
 *     [vars]
 *     API_ORIGIN = "https://api.example.com"
 *     TICKET_CHECK = "true"
 *
 *   wrangler secret put MEDIA_SIGNING_KEY     # same value as the API's
 *   wrangler secret put EDGE_LIVENESS_SECRET  # same value as the API's
 *   wrangler deploy
 *
 * Then point MEDIA_CDN_BASE_URL at the Worker's route, e.g.
 * https://media.example.com/
 *
 * Verification
 * ------------
 *   curl -I https://media.example.com/hls/abc/master.m3u8
 *     → 403 (no signature)
 *
 *   Request a playback ticket from the app, copy the manifest URL, and curl it
 *   from a different machine → 200 the first time (same signature, still
 *   valid) but 403 once TICKET_CHECK is on and the ticket is bound elsewhere.
 * =============================================================================
 */

export default {
  /**
   * @param {Request} request
   * @param {{ MEDIA: R2Bucket, LIBRARY?: R2Bucket, MEDIA_SIGNING_KEY: string, EDGE_LIVENESS_SECRET?: string, API_ORIGIN?: string, TICKET_CHECK?: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const origin = allowedOrigin(request, env);

    // hls.js and pdf.js send Range, which makes the request non-simple and
    // triggers a preflight. Without an answer here the real request is never
    // sent at all.
    if (request.method === 'OPTIONS') {
      if (!origin) return deny(405, 'method_not_allowed', origin);
      const headers = new Headers({
        'access-control-allow-methods': 'GET, HEAD, OPTIONS',
        'access-control-allow-headers': 'range',
        'access-control-max-age': '86400',
        'cache-control': 'no-store',
      });
      return new Response(null, { status: 204, headers: applyCors(headers, origin) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return deny(405, 'method_not_allowed', origin);
    }

    const url = new URL(request.url);

    // --- public images ------------------------------------------------------
    // Course and library thumbnails, library covers and avatars are public by
    // design and are requested WITHOUT a signature. They are served from this
    // location's edge cache, and on a miss from the MEDIA binding — never via
    // the API. Matched on the RAW path against a strict pattern, before any
    // decoding, so an encoded or traversing path cannot reach this branch; it
    // falls through to the signed path below and is refused there exactly as
    // before. A signed URL (one carrying `sig`) always takes the signed path.
    if (!url.searchParams.has('sig')) {
      const publicKey = publicImageKey(url.pathname);
      if (publicKey) return servePublicImage(request, env, ctx, publicKey);
    }

    // Strip the leading slash: object keys are stored without one.
    const objectKey = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

    if (!objectKey) return deny(404, 'not_found', origin);

    // Defence in depth: never serve the source upload, whatever the signature
    // says. Originals live under uploads/ and are only ever read by the
    // transcoding worker, using bucket credentials rather than this route.
    if (objectKey.startsWith('uploads/') || objectKey.includes('/source/')) {
      return deny(403, 'forbidden_prefix', origin);
    }

    const exp = Number(url.searchParams.get('exp') ?? 0);
    const uid = url.searchParams.get('uid') ?? '';
    const sid = url.searchParams.get('sid') ?? '';
    const did = url.searchParams.get('did') ?? '';
    const tid = url.searchParams.get('tid') ?? '';
    const mh = Number(url.searchParams.get('mh') ?? 0);
    const sig = url.searchParams.get('sig') ?? '';

    if (!sig || !exp || !uid) return deny(403, 'unsigned', origin);

    // --- expiry -------------------------------------------------------------
    // Checked before the HMAC so an expired URL costs one comparison rather
    // than a crypto operation.
    if (exp * 1000 <= Date.now()) return deny(403, 'expired', origin);

    // --- signature ----------------------------------------------------------
    const canonical = [objectKey, exp, uid, sid, did, tid, mh].join('\n');
    const expected = await hmacBase64Url(env.MEDIA_SIGNING_KEY, canonical);

    if (!timingSafeEqual(expected, sig)) return deny(403, 'bad_signature', origin);

    // --- quality ceiling ----------------------------------------------------
    // The API decides which renditions a given grant may fetch (it can lower
    // the ceiling for a suspicious session). Rendition height is part of the
    // object key, so it is checked here rather than trusted to the player.
    if (mh > 0) {
      const height = renditionHeight(objectKey);
      if (height !== null && height > mh) return deny(403, 'quality_ceiling', origin);
    }

    // --- live ticket check --------------------------------------------------
    // The signature proves the URL was minted for this viewer. It does not
    // prove the grant is *still* valid — the student may have been signed out,
    // their device revoked, or a capture detected since. One cached round-trip
    // to the API closes that gap.
    //
    // A Library grant (`lib_` owned, `libp_` preview) FAILS CLOSED: a failed
    // check is not evidence the grant is still good. Without a configured check,
    // on any network error or timeout, any non-200 answer, a body that is not
    // JSON, or anything but a clear boolean, the answer is 503: nothing was
    // decided, and trying again may work. A clear `live: false` is 403.
    // Attachment and video grants keep the behaviour below.
    if (isLibraryTicket(tid)) {
      if (env.TICKET_CHECK !== 'true' || !env.API_ORIGIN) {
        return deny(503, 'ticket_unverifiable', origin);
      }
      const live = await libraryTicketIsLive(env, ctx, tid, uid, sid, did);
      if (live === null) return deny(503, 'ticket_unverifiable', origin);
      if (!live) return deny(403, 'ticket_revoked', origin);
    } else if (env.TICKET_CHECK === 'true' && tid && env.API_ORIGIN) {
      const live = await ticketIsLive(env, ctx, tid, uid, sid, did);
      if (!live) return deny(403, 'ticket_revoked', origin);
    }

    // --- serve --------------------------------------------------------------
    const range = request.headers.get('range');

    // Library documents live in their own bucket so that paid PDFs do not
    // consume the capacity budgeted for protected video. The bucket is derived
    // from the key prefix rather than from a query parameter, so it needs no
    // change to the signature contract above — the key is already inside the
    // HMAC, which makes the choice of bucket authenticated for free.
    //
    // Falling back to MEDIA when LIBRARY is unbound keeps an already-deployed
    // Worker serving exactly what it served before this binding existed.
    const store = objectKey.startsWith('library/') && env.LIBRARY ? env.LIBRARY : env.MEDIA;

    const object = await store.get(objectKey, {
      range: range ? parseRange(range) : undefined,
    });

    if (!object) return deny(404, 'not_found', origin);

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-type', contentTypeFor(objectKey));

    // Never let a signed media response be cached by a shared cache: the URL
    // encodes one viewer's grant, and a cached copy served to a second viewer
    // would defeat the entire scheme.
    headers.set('cache-control', 'private, no-store, max-age=0');
    headers.set('x-content-type-options', 'nosniff');
    // Default to same-site, which is what the mobile app and a bare <video>
    // need. applyCors relaxes it to cross-origin only for an allowlisted web
    // origin, because a browser reading these bytes with fetch — hls.js for a
    // segment, pdf.js for a document — is blocked by CORP before CORS is even
    // consulted.
    headers.set('cross-origin-resource-policy', 'same-site');
    applyCors(headers, origin);

    if (object.range) {
      const { offset = 0, length = object.size } = object.range;
      headers.set(
        'content-range',
        `bytes ${offset}-${offset + length - 1}/${object.size}`,
      );
      return new Response(request.method === 'HEAD' ? null : object.body, {
        status: 206,
        headers,
      });
    }

    return new Response(request.method === 'HEAD' ? null : object.body, {
      status: 200,
      headers,
    });
  },
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Cross-origin reads, for the web client only.
 *
 * This Worker was written when the only client was the mobile app, where the
 * player fetches media from native code and no browser is enforcing an origin.
 * The note that "nothing needs cross-origin read access" stopped being true the
 * moment a browser became a client: hls.js reads playlists and segments with
 * fetch, and pdf.js reads a Library document the same way. Both are blocked by
 * the same-origin policy unless this responds with an explicit allowance — so
 * on the web, video and documents failed before any signature was even checked.
 *
 * The allowance is an exact-match allowlist from WEB_ORIGINS, never a wildcard,
 * and never with credentials: the URL already proves who the viewer is, and
 * echoing an arbitrary origin would let any page read a signed URL it managed
 * to obtain. Requests without an Origin — the mobile app, curl, the <video>
 * element itself — are answered exactly as before.
 */
function allowedOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !env.WEB_ORIGINS) return null;
  const allowed = env.WEB_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? origin : null;
}

function applyCors(headers, origin) {
  if (!origin) return headers;
  headers.set('access-control-allow-origin', origin);
  // The allowance depends on the request's Origin, so any cache must key on it.
  headers.append('vary', 'Origin');
  // Range matters: a player seeking into a video, and pdf.js reading a document
  // in pieces, both need the ranged response to be readable.
  headers.set('access-control-expose-headers', 'content-length, content-range, accept-ranges, x-deny-reason');
  // CORP would otherwise block the read even with CORS in place.
  headers.set('cross-origin-resource-policy', 'cross-origin');
  return headers;
}

function deny(status, reason, origin) {
  // The reason is returned as a header, not a body: a player receiving JSON
  // where it expected a playlist produces a confusing error. The header is
  // enough for curl-based debugging.
  const headers = new Headers({ 'x-deny-reason': reason, 'cache-control': 'no-store' });
  // The reason has to survive the browser's filter too, or a blocked web player
  // reports an opaque network failure instead of "ticket_revoked".
  return new Response(null, { status, headers: applyCors(headers, origin) });
}

async function hmacBase64Url(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message),
  );

  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** Constant-time string comparison — a fast-exit compare leaks the signature. */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** "hls/<videoId>/720p/seg00042.ts" → 720 */
function renditionHeight(objectKey) {
  const match = objectKey.match(/\/(\d{3,4})p\//);
  return match ? Number(match[1]) : null;
}

/** `tid` prefixes; must match library-documents.service.ts. Inside the HMAC. */
const LIBRARY_OWNED_TICKET_PREFIX = 'lib_';
const LIBRARY_PREVIEW_TICKET_PREFIX = 'libp_';

/**
 * The liveness probe URL, which is also the cache key.
 *
 * For Library grants the URL carries the session (`sid`) and device (`did`) the
 * signed URL was minted for, so one session's or device's cached answer can
 * never be reused for another. Video and attachment probes are byte-for-byte
 * what they were.
 */
function livenessProbe(env, ticketId, userId, sid, did) {
  let probe = `${env.API_ORIGIN}/api/v1/playback/tickets/${ticketId}/state?uid=${encodeURIComponent(userId)}`;
  if (isLibraryTicket(ticketId)) {
    probe += `&sid=${encodeURIComponent(sid ?? '')}&did=${encodeURIComponent(did ?? '')}`;
  }
  return probe;
}

function isLibraryTicket(ticketId) {
  return (
    ticketId.startsWith(LIBRARY_OWNED_TICKET_PREFIX) ||
    ticketId.startsWith(LIBRARY_PREVIEW_TICKET_PREFIX)
  );
}

/**
 * The headers on every liveness probe. The secret is a header, never part of
 * the probe URL, so it stays out of logs and of the cache key. Probes do not
 * follow redirects, so it is never sent anywhere but API_ORIGIN.
 */
function probeHeaders(env) {
  const headers = { 'x-edge-check': '1' };
  if (env.EDGE_LIVENESS_SECRET) headers['x-edge-secret'] = env.EDGE_LIVENESS_SECRET;
  return headers;
}

/**
 * Library liveness. Returns true or false for a clear answer from the API, and
 * null when there is none. The caller refuses both false and null.
 *
 * The timeout is longer than the video probe's: this runs once per document
 * rather than once per segment, and a slow database should not refuse a paid
 * document that a moment's patience would have opened.
 *
 * Cache: a per-data-centre Cache API entry, `max-age=10`, keyed by the probe URL
 * (ticket, user, session, device), so a clear answer is at most 10 seconds
 * stale, and a failed probe is never cached. Cloudflare documents that Cache API
 * operations have no effect on `*.workers.dev`: on that hostname every request
 * probes, staleness is zero, and the API sees one probe per document fetch.
 */
async function libraryTicketIsLive(env, ctx, ticketId, userId, sid, did) {
  const probe = livenessProbe(env, ticketId, userId, sid, did);
  const cacheKey = new Request(probe, { method: 'GET' });
  const cache = caches.default;

  try {
    const cached = await cache.match(cacheKey);
    if (cached) return readLive(await cached.json());
  } catch {
    // An unreadable cache entry is not an answer; ask the API.
  }

  let payload;
  try {
    const response = await fetch(probe, {
      headers: probeHeaders(env),
      signal: AbortSignal.timeout(5000),
      redirect: 'manual',
    });
    if (response.status !== 200) return null;
    payload = await response.json();
  } catch {
    return null;
  }

  // Only a clear boolean is an answer. Anything else is denied and NOT cached,
  // so a malformed reply cannot pin a decision for the cache window.
  const raw = payload?.data?.live ?? payload?.live;
  if (typeof raw !== 'boolean') return null;
  const live = raw === true;
  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify({ live }), {
        headers: { 'cache-control': 'max-age=10', 'content-type': 'application/json' },
      }),
    ),
  );
  return live;
}

/**
 * Asks the API whether a playback ticket is still live.
 *
 * Cached for 10 seconds in the Worker's own cache. A segment request arrives
 * every few seconds during playback, and without caching this would put one
 * API call per segment per viewer on the origin. Ten seconds is short enough
 * that a revocation takes effect almost immediately and long enough to cut the
 * call volume by an order of magnitude.
 *
 * Video and attachment grants only. Library grants use `libraryTicketIsLive`.
 */
async function ticketIsLive(env, ctx, ticketId, userId, sid, did) {
  const probe = livenessProbe(env, ticketId, userId, sid, did);
  const cacheKey = new Request(probe, { method: 'GET' });
  const cache = caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    return readLive(await cached.json());
  }

  let response;
  try {
    response = await fetch(probe, {
      headers: probeHeaders(env),
      signal: AbortSignal.timeout(2000),
      redirect: 'manual',
    });
  } catch {
    // Fail OPEN on a network error, deliberately.
    //
    // The signature has already been verified, so the request is from the
    // right viewer with an unexpired grant. Failing closed here would black
    // out all playback whenever the API has a hiccup, trading a large
    // availability loss for a small security gain on an already-authenticated
    // request.
    return true;
  }

  if (!response.ok) return response.status !== 403 && response.status !== 404;

  const payload = await response.json();

  ctx.waitUntil(
    cache.put(
      cacheKey,
      new Response(JSON.stringify(payload), {
        headers: { 'cache-control': 'max-age=10', 'content-type': 'application/json' },
      }),
    ),
  );

  return readLive(payload);
}

/**
 * Pull the liveness flag out of the API's answer.
 *
 * The API wraps every handler's return value in an envelope —
 * `{ success, data: { live }, meta }` — so reading `payload.live` found
 * `undefined`, which is not `true`, and every signed media request was refused
 * with `ticket_revoked` even though the grant was live. That took down video
 * segments and Library documents together, while manifests and AES keys (which
 * the API serves itself, never through this Worker) kept working — which is
 * what made it look like a storage problem rather than an edge one.
 *
 * Both shapes are accepted so this Worker keeps working whichever side of the
 * envelope the API is on, and a missing flag still reads as "not live".
 */
function readLive(payload) {
  const live = payload?.data?.live ?? payload?.live;
  return live === true;
}

// -----------------------------------------------------------------------------
// Public images
// -----------------------------------------------------------------------------

/**
 * The only keys served without a signature.
 *
 * Must stay identical to PUBLIC_IMAGE_KEY_PATTERN in
 * src/modules/storage/storage.service.ts (a unit test reads both files and
 * compares them). Segments are `[A-Za-z0-9_-]+` and the last ends in an image
 * extension, which is exactly what the API's key builders produce. That rules
 * out `%` (so no encoded or double-encoded bypass), `.` segments and `..`
 * (no traversal), `\`, empty segments, query-like characters, and every
 * private namespace: `hls/`, `source/`, `uploads/`, `library/`, `attachments/`,
 * `captions/` and the video poster frames under `thumbnails/videos/`.
 */
const PUBLIC_IMAGE_KEY = /^(?:thumbnails\/(?:courses|library)|avatars)(?:\/[A-Za-z0-9_-]+)+\.(?:jpe?g|png|webp)$/;

/** What the browser may keep: keys are versioned (a UUID per upload) and never rewritten. */
const PUBLIC_BROWSER_CACHE = 'public, max-age=31536000, immutable';

/**
 * How long this location keeps a copy. Short on purpose: a deleted image (a
 * cleared cover, a removed avatar) stays reachable at its old URL for at most
 * this long, because a workers.dev cache cannot be purged from the API. A
 * replacement is never stale — it is a new key, hence a new URL.
 */
const PUBLIC_EDGE_TTL_SECONDS = 86400;

/** A missing key is remembered briefly, so a burst for it costs one R2 read. */
const PUBLIC_MISSING_TTL_SECONDS = 60;

/** Same ceiling as the upload routes; nothing larger belongs in these namespaces. */
const PUBLIC_MAX_BYTES = 10 * 1024 * 1024;

/** The cache key is the object key alone: query strings cannot bust the cache. */
const PUBLIC_CACHE_ORIGIN = 'https://public-assets.edu-media-gate.internal/';

function publicImageKey(pathname) {
  const key = pathname.replace(/^\//, '');
  return PUBLIC_IMAGE_KEY.test(key) ? key : null;
}

/**
 * One public image.
 *
 * Two approximate, per-location limits, keyed by the client address Cloudflare
 * itself observed (`cf-connecting-ip`, set by the edge, not by the client):
 *
 *   PUBLIC_ASSET_LIMITER       every public request. Generous, because a whole
 *                              university or a mobile carrier can share one
 *                              address and a catalogue page loads many images.
 *   PUBLIC_ASSET_MISS_LIMITER  cache misses only — the requests that cost an
 *                              R2 read. Tight, because only a client walking
 *                              many distinct keys produces many of them.
 *
 * Both bindings are optional: without them (local tests, an older deploy)
 * nothing is limited, which matches the behaviour before they existed.
 */
async function servePublicImage(request, env, ctx, key) {
  const client = request.headers.get('cf-connecting-ip') || 'unknown';

  if (env.PUBLIC_ASSET_LIMITER) {
    const { success } = await env.PUBLIC_ASSET_LIMITER.limit({ key: `ip:${client}` });
    if (!success) return publicTooMany();
  }

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(PUBLIC_CACHE_ORIGIN + key, { method: 'GET' });

  let stored = cache ? await cache.match(cacheKey) : undefined;
  let source = 'HIT';

  if (!stored) {
    source = 'MISS';

    if (env.PUBLIC_ASSET_MISS_LIMITER) {
      const { success } = await env.PUBLIC_ASSET_MISS_LIMITER.limit({ key: `ip:${client}` });
      if (!success) return publicTooMany();
    }

    const object = await env.MEDIA.get(key);

    if (!object || !object.body || object.size > PUBLIC_MAX_BYTES) {
      if (object && object.body) await object.body.cancel();
      stored = new Response(null, {
        status: 404,
        headers: { 'cache-control': `public, max-age=${PUBLIC_MISSING_TTL_SECONDS}` },
      });
    } else {
      const headers = new Headers({
        'content-type': publicContentType(key),
        'content-length': String(object.size),
        etag: object.httpEtag,
        'last-modified': new Date(object.uploaded).toUTCString(),
        'cache-control': `public, max-age=${PUBLIC_EDGE_TTL_SECONDS}`,
      });
      stored = new Response(object.body, { status: 200, headers });
    }

    if (cache) ctx.waitUntil(cache.put(cacheKey, stored.clone()));
  }

  return publicResponse(request, stored, source);
}

/** The client's view of a stored entry: browser policy, validators, HEAD and 304. */
async function publicResponse(request, stored, source) {
  const headers = new Headers({
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'cross-origin',
    'access-control-allow-origin': '*',
    'x-asset-cache': source,
  });

  if (stored.status !== 200) {
    if (stored.body) await stored.body.cancel();
    headers.set('cache-control', `public, max-age=${PUBLIC_MISSING_TTL_SECONDS}`);
    headers.set('x-deny-reason', 'not_found');
    return new Response(null, { status: 404, headers });
  }

  for (const name of ['content-type', 'content-length', 'etag', 'last-modified']) {
    const value = stored.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set('cache-control', PUBLIC_BROWSER_CACHE);

  const etag = stored.headers.get('etag');
  if (etag && etagMatches(request.headers.get('if-none-match'), etag)) {
    if (stored.body) await stored.body.cancel();
    headers.delete('content-length');
    return new Response(null, { status: 304, headers });
  }

  if (request.method === 'HEAD') {
    if (stored.body) await stored.body.cancel();
    return new Response(null, { status: 200, headers });
  }

  return new Response(stored.body, { status: 200, headers });
}

/** RFC 9110 weak comparison, as If-None-Match requires; `*` matches any. */
function etagMatches(header, etag) {
  if (!header) return false;
  const bare = (value) => value.trim().replace(/^W\//, '');
  const target = bare(etag);
  return header.split(',').some((candidate) => {
    const value = candidate.trim();
    return value === '*' || bare(value) === target;
  });
}

/** Decided by the extension the pattern already guaranteed — never by stored metadata. */
function publicContentType(key) {
  if (key.endsWith('.png')) return 'image/png';
  if (key.endsWith('.webp')) return 'image/webp';
  return 'image/jpeg';
}

function publicTooMany() {
  return new Response(null, {
    status: 429,
    headers: {
      'retry-after': '60',
      'cache-control': 'no-store',
      'x-deny-reason': 'rate_limited',
      'access-control-allow-origin': '*',
    },
  });
}

function contentTypeFor(objectKey) {
  if (objectKey.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (objectKey.endsWith('.ts')) return 'video/mp2t';
  if (objectKey.endsWith('.m4s')) return 'video/iso.segment';
  if (objectKey.endsWith('.mp4')) return 'video/mp4';
  if (objectKey.endsWith('.vtt')) return 'text/vtt';
  if (objectKey.endsWith('.pdf')) return 'application/pdf';
  if (objectKey.endsWith('.jpg') || objectKey.endsWith('.jpeg')) return 'image/jpeg';
  if (objectKey.endsWith('.png')) return 'image/png';
  if (objectKey.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function parseRange(header) {
  const match = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return undefined;

  const [, startRaw, endRaw] = match;

  if (startRaw === '') {
    return { suffix: Number(endRaw) };
  }

  const offset = Number(startRaw);
  return endRaw === ''
    ? { offset }
    : { offset, length: Number(endRaw) - offset + 1 };
}
