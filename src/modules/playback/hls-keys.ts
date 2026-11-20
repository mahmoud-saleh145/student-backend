import { createHmac } from 'node:crypto';

/**
 * AES-128 content keys for the mobile HLS pipeline: one place that knows how a
 * stored `videos.encryptionKeyId` maps to the bytes a player must receive.
 * Shared by the API (key route, playlist rewrite) and the worker (encode).
 *
 * ── v1 (every video encoded before 2026-11-20; must never change) ─────────
 *   key = HMAC-SHA256(HLS_KEY_ROOT, "hls-key:<videoId>")[0..16]
 *   one key and one fixed IV for every rendition and segment of a video;
 *   recorded as `derived:<videoId>`.
 *
 * ── v2 (new encodes when the worker runs HLS_KEY_VERSION=v2) ──────────────
 *   key = HMAC-SHA256(root[rootId], "hls-key:v2:<videoId>:<tier>")[0..16]
 *   one key PER RENDITION (tier = the rung's short side, 480/720/1080) and a
 *   DIFFERENT IV PER SEGMENT: segment n is encrypted with IV = n (its media
 *   sequence number), which ffmpeg writes explicitly on a key line before each
 *   segment (`-hls_flags periodic_rekey`, see HlsTranscoder.ffmpegArgs), so
 *   every (key, IV) pair is unique. IVs are not secret (RFC 8216 §5.2). Recorded as
 *   `derived:v2:<rootId>:<videoId>`, which names the root so a root can be
 *   rotated: new encodes use a new id while old ones keep their own.
 *
 * Domain separation: content keys use the `hls-key:` label family; the URL
 * signatures in ManifestService use `master:`, `media:`, `key:` and `key2:`.
 * Both are HMACs under the same root secret, but no signed message can ever
 * equal a key-derivation message, so neither can be used to forge the other.
 * Nothing here logs, stores or returns a key except to its caller.
 */
export type HlsKeyVersion = 'v1' | 'v2';

/** `rootId` of `HLS_KEY_ROOT` itself. */
export const DEFAULT_KEY_ROOT_ID = 'r1';
const ROOT_ID = /^[a-z0-9]{1,16}$/;

export type ParsedKeyId =
  | { version: 1 }
  | { version: 2; rootId: string };

/**
 * Reads a row's `encryptionKeyId`. Returns null for anything that is not a
 * well-formed id OF THIS VIDEO: such a row must not be served a key at all,
 * rather than one derived by guesswork.
 */
export function parseEncryptionKeyId(keyId: string | null | undefined, videoId: string): ParsedKeyId | null {
  if (!keyId) return null;
  if (keyId === `derived:${videoId}`) return { version: 1 };
  const prefix = 'derived:v2:';
  if (!keyId.startsWith(prefix)) return null;
  const rest = keyId.slice(prefix.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const rootId = rest.slice(0, sep);
  if (!ROOT_ID.test(rootId) || rest.slice(sep + 1) !== videoId) return null;
  return { version: 2, rootId };
}

export function formatV2KeyId(rootId: string, videoId: string): string {
  if (!ROOT_ID.test(rootId)) throw new Error(`invalid HLS key root id "${rootId}"`);
  return `derived:v2:${rootId}:${videoId}`;
}

export function deriveContentKeyV1(keyRoot: string, videoId: string): Buffer {
  return createHmac('sha256', keyRoot).update(`hls-key:${videoId}`).digest().subarray(0, 16);
}

/** The v1 IV (one per video), as the hex string ffmpeg's keyinfo takes. */
export function deriveIvV1(videoId: string): string {
  return createHmac('sha256', `iv:${videoId}`).update(videoId).digest('hex').slice(0, 32);
}

export function deriveContentKeyV2(keyRoot: string, videoId: string, tier: number): Buffer {
  if (!Number.isInteger(tier) || tier <= 0) throw new Error(`invalid rendition tier ${tier}`);
  return createHmac('sha256', keyRoot).update(`hls-key:v2:${videoId}:${tier}`).digest().subarray(0, 16);
}

/**
 * The configured roots by id: `r1` is always `HLS_KEY_ROOT`; further roots
 * come from `HLS_KEY_ROOT_<ID>` (id lower-cased), for rotation.
 */
export function keyRootsFromEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const roots: Record<string, string> = {};
  if (env.HLS_KEY_ROOT) roots[DEFAULT_KEY_ROOT_ID] = env.HLS_KEY_ROOT;
  for (const [name, value] of Object.entries(env)) {
    const m = /^HLS_KEY_ROOT_([A-Z0-9]{1,16})$/.exec(name);
    if (!m || !value || m[1] === 'ID') continue;
    const id = m[1]!.toLowerCase();
    if (id === DEFAULT_KEY_ROOT_ID) continue; // r1 is HLS_KEY_ROOT, never overridden
    roots[id] = value;
  }
  return roots;
}
