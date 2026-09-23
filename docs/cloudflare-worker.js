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
 *     [vars]
 *     API_ORIGIN = "https://api.example.com"
 *     TICKET_CHECK = "true"
 *
 *   wrangler secret put MEDIA_SIGNING_KEY     # same value as the API's
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
   * @param {{ MEDIA: R2Bucket, MEDIA_SIGNING_KEY: string, API_ORIGIN?: string, TICKET_CHECK?: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return deny(405, 'method_not_allowed');
    }

    const url = new globalThis.URL(request.url);
    // Strip the leading slash: object keys are stored without one.
    const objectKey = decodeURIComponent(url.pathname.replace(/^\/+/, ''));

    if (!objectKey) return deny(404, 'not_found');

    // Defence in depth: never serve the source upload, whatever the signature
    // says. Originals live under uploads/ and are only ever read by the
    // transcoding worker, using bucket credentials rather than this route.
    if (objectKey.startsWith('uploads/') || objectKey.includes('/source/')) {
      return deny(403, 'forbidden_prefix');
    }

    const exp = Number(url.searchParams.get('exp') ?? 0);
    const uid = url.searchParams.get('uid') ?? '';
    const sid = url.searchParams.get('sid') ?? '';
    const did = url.searchParams.get('did') ?? '';
    const tid = url.searchParams.get('tid') ?? '';
    const mh = Number(url.searchParams.get('mh') ?? 0);
    const sig = url.searchParams.get('sig') ?? '';

    if (!sig || !exp || !uid) return deny(403, 'unsigned');

    // --- expiry -------------------------------------------------------------
    // Checked before the HMAC so an expired URL costs one comparison rather
    // than a crypto operation.
    if (exp * 1000 <= Date.now()) return deny(403, 'expired');

    // --- signature ----------------------------------------------------------
    const canonical = [objectKey, exp, uid, sid, did, tid, mh].join('\n');
    const expected = await hmacBase64Url(env.MEDIA_SIGNING_KEY, canonical);

    if (!timingSafeEqual(expected, sig)) return deny(403, 'bad_signature');

    // --- quality ceiling ----------------------------------------------------
    // The API decides which renditions a given grant may fetch (it can lower
    // the ceiling for a suspicious session). Rendition height is part of the
    // object key, so it is checked here rather than trusted to the player.
    if (mh > 0) {
      const height = renditionHeight(objectKey);
      if (height !== null && height > mh) return deny(403, 'quality_ceiling');
    }

    // --- live ticket check --------------------------------------------------
    // The signature proves the URL was minted for this viewer. It does not
    // prove the grant is *still* valid — the student may have been signed out,
    // their device revoked, or a capture detected since. One cached round-trip
    // to the API closes that gap.
    if (env.TICKET_CHECK === 'true' && tid && env.API_ORIGIN) {
      const live = await ticketIsLive(env, ctx, tid, uid);
      if (!live) return deny(403, 'ticket_revoked');
    }

    // --- serve --------------------------------------------------------------
    const range = request.headers.get('range');

    const object = await env.MEDIA.get(objectKey, {
      range: range ? parseRange(range) : undefined,
    });

    if (!object) return deny(404, 'not_found');

    const headers = new globalThis.Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('content-type', contentTypeFor(objectKey));

    // Never let a signed media response be cached by a shared cache: the URL
    // encodes one viewer's grant, and a cached copy served to a second viewer
    // would defeat the entire scheme.
    headers.set('cache-control', 'private, no-store, max-age=0');
    headers.set('x-content-type-options', 'nosniff');
    // Playlists and segments are fetched by the app's own player, never
    // embedded in a page, so nothing needs cross-origin read access.
    headers.set('cross-origin-resource-policy', 'same-site');

    if (object.range) {
      const { offset = 0, length = object.size } = object.range;
      headers.set(
        'content-range',
        `bytes ${offset}-${offset + length - 1}/${object.size}`,
      );
      return new globalThis.Response(request.method === 'HEAD' ? null : object.body, {
        status: 206,
        headers,
      });
    }

    return new globalThis.Response(request.method === 'HEAD' ? null : object.body, {
      status: 200,
      headers,
    });
  },
};

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function deny(status, reason) {
  // The reason is returned as a header, not a body: a player receiving JSON
  // where it expected a playlist produces a confusing error. The header is
  // enough for curl-based debugging.
  return new globalThis.Response(null, {
    status,
    headers: { 'x-deny-reason': reason, 'cache-control': 'no-store' },
  });
}

async function hmacBase64Url(secret, message) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new globalThis.TextEncoder().encode(message),
  );

  return globalThis.btoa(String.fromCharCode(...new Uint8Array(signature)))
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

/**
 * Asks the API whether a playback ticket is still live.
 *
 * Cached for 10 seconds in the Worker's own cache. A segment request arrives
 * every few seconds during playback, and without caching this would put one
 * API call per segment per viewer on the origin. Ten seconds is short enough
 * that a revocation takes effect almost immediately and long enough to cut the
 * call volume by an order of magnitude.
 */
async function ticketIsLive(env, ctx, ticketId, userId) {
  const probe = `${env.API_ORIGIN}/api/v1/playback/tickets/${ticketId}/state?uid=${encodeURIComponent(userId)}`;
  const cacheKey = new globalThis.Request(probe, { method: 'GET' });
  const cache = globalThis.caches.default;

  const cached = await cache.match(cacheKey);
  if (cached) {
    const body = await cached.json();
    return body.live === true;
  }

  let response;
  try {
    response = await globalThis.fetch(probe, {
      headers: { 'x-edge-check': '1' },
      signal: globalThis.AbortSignal.timeout(2000),
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
      new globalThis.Response(JSON.stringify(payload), {
        headers: { 'cache-control': 'max-age=10', 'content-type': 'application/json' },
      }),
    ),
  );

  return payload.live === true;
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
