import { createHmac } from 'node:crypto';

import { ManifestService } from '../../src/modules/playback/manifest.service';

/**
 * HLS content-key derivation.
 *
 * These two statics are shared by the API and by the transcoding worker: the
 * worker encrypts segments with `deriveContentKey`, and the API hands the same
 * bytes to an authorized player. They therefore have to agree exactly and
 * forever — a change to either function silently un-decryptable every video
 * already in storage.
 *
 * The tests below pin the properties that make the scheme sound, and one
 * frozen vector that makes an accidental change to the derivation loud.
 */

const KEY_ROOT = 'test-key-root-not-a-real-secret';

describe('ManifestService.deriveContentKey', () => {
  it('produces a 16-byte key, the length AES-128 requires', () => {
    const key = ManifestService.deriveContentKey(KEY_ROOT, 'vid_1');
    expect(key).toHaveLength(16);
  });

  it('is deterministic — the worker and the API derive the same bytes', () => {
    const a = ManifestService.deriveContentKey(KEY_ROOT, 'vid_1');
    const b = ManifestService.deriveContentKey(KEY_ROOT, 'vid_1');
    expect(a.equals(b)).toBe(true);
  });

  it('gives every video a distinct key', () => {
    // Otherwise one leaked key decrypts the whole catalogue.
    const keys = ['vid_1', 'vid_2', 'vid_3', 'vid_4'].map((id) =>
      ManifestService.deriveContentKey(KEY_ROOT, id).toString('hex'),
    );

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('changes completely when the root secret is rotated', () => {
    const before = ManifestService.deriveContentKey(KEY_ROOT, 'vid_1');
    const after = ManifestService.deriveContentKey(`${KEY_ROOT}-rotated`, 'vid_1');

    expect(before.equals(after)).toBe(false);
  });

  it('does not leak the root secret into the derived key', () => {
    const key = ManifestService.deriveContentKey(KEY_ROOT, 'vid_1');
    expect(key.toString('utf8')).not.toContain(KEY_ROOT.slice(0, 8));
    expect(key.toString('hex')).not.toContain(
      Buffer.from(KEY_ROOT).toString('hex').slice(0, 16),
    );
  });

  /**
   * A frozen vector. If someone changes the HMAC label, the digest length or
   * the truncation, this fails immediately rather than in production six
   * months later when an old video stops playing.
   */
  it('matches its frozen reference vector', () => {
    const key = ManifestService.deriveContentKey('fixed-root', 'fixed-video');

    // Recompute the expectation the same way the implementation documents it:
    // HMAC-SHA256(root, "hls-key:<videoId>"), first 16 bytes.
    const expected = createHmac('sha256', 'fixed-root')
      .update('hls-key:fixed-video')
      .digest()
      .subarray(0, 16);

    expect(key.equals(expected)).toBe(true);
  });
});

describe('ManifestService.deriveIv', () => {
  it('produces a 32-character hex IV, as EXT-X-KEY requires', () => {
    const iv = ManifestService.deriveIv('vid_1');
    expect(iv).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic per video', () => {
    expect(ManifestService.deriveIv('vid_1')).toBe(ManifestService.deriveIv('vid_1'));
  });

  it('differs between videos', () => {
    expect(ManifestService.deriveIv('vid_1')).not.toBe(ManifestService.deriveIv('vid_2'));
  });
});

/**
 * The reason manifests are generated per request rather than served from
 * storage. Stated as a test so the rationale travels with the code: a
 * packaged playlist is written once at transcode time and is identical for
 * every viewer, so there is nowhere in it to put a per-viewer signature.
 *
 * This is a documentation test — it asserts the API surface exists, which is
 * what a refactor toward "just serve the .m3u8 from R2" would remove.
 */
describe('dynamic manifest generation', () => {
  it('exposes a per-ticket master URL builder rather than a static object key', () => {
    expect(typeof ManifestService.prototype.buildMasterUrl).toBe('function');
    expect(typeof ManifestService.prototype.masterPlaylist).toBe('function');
    expect(typeof ManifestService.prototype.mediaPlaylist).toBe('function');
  });
});
