import { createHmac } from 'node:crypto';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { HlsTranscoder } from '../../src/jobs/processors/hls-transcoder';
import {
  deriveContentKeyV1,
  deriveContentKeyV2,
  deriveIvV1,
  formatV2KeyId,
  keyRootsFromEnv,
  parseEncryptionKeyId,
} from '../../src/modules/playback/hls-keys';
import { ManifestService } from '../../src/modules/playback/manifest.service';

/**
 * Mobile HLS key scheme v2 (a key per rendition, sequence-number IVs,
 * versioned key ids) beside the unchanged v1.
 *
 * The non-negotiable property: every video encoded before v2 (45 in
 * production, all `derived:<id>`) keeps receiving EXACTLY the same playlist
 * key URL and key bytes. The frozen vectors below make any change to v1 loud.
 */

const ROOT = 'test-root-key-that-is-long-enough-for-hmac-use';
const ROOT2 = 'second-root-key-that-is-long-enough-for-rotation';

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

describe('hls-keys: derivation', () => {
  it('v1 key and IV match their frozen vectors (and ManifestService still exposes them)', () => {
    expect(deriveContentKeyV1('fixed-root', 'fixed-video').toString('hex')).toBe('fdd4e4a02b2b87c895229e22ccf7e77c');
    expect(deriveIvV1('fixed-video')).toBe('7f7106e71050adf1f504b7db4223f32e');
    expect(ManifestService.deriveContentKey('fixed-root', 'fixed-video').toString('hex')).toBe('fdd4e4a02b2b87c895229e22ccf7e77c');
    expect(ManifestService.deriveIv('fixed-video')).toBe('7f7106e71050adf1f504b7db4223f32e');
  });

  it('v2 keys match their frozen vectors: HMAC(root, "hls-key:v2:<id>:<tier>")[0..16]', () => {
    expect(deriveContentKeyV2('fixed-root', 'fixed-video', 480).toString('hex')).toBe('339f7b15843d6a124e01978927843e31');
    expect(deriveContentKeyV2('fixed-root', 'fixed-video', 720).toString('hex')).toBe('33c542de498612ae63911843411cadc8');
    const independent = createHmac('sha256', 'fixed-root').update('hls-key:v2:fixed-video:720').digest().subarray(0, 16);
    expect(deriveContentKeyV2('fixed-root', 'fixed-video', 720).equals(independent)).toBe(true);
  });

  it('separates keys by rendition, by root, by video and from v1', () => {
    const keys = [
      deriveContentKeyV1(ROOT, 'v_1'),
      deriveContentKeyV2(ROOT, 'v_1', 480),
      deriveContentKeyV2(ROOT, 'v_1', 720),
      deriveContentKeyV2(ROOT, 'v_1', 1080),
      deriveContentKeyV2(ROOT2, 'v_1', 720),
      deriveContentKeyV2(ROOT, 'v_2', 720),
    ].map((k) => k.toString('hex'));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((k) => k.length === 32)).toBe(true);
  });

  it('refuses a nonsense tier rather than deriving a key for it', () => {
    expect(() => deriveContentKeyV2(ROOT, 'v_1', 0)).toThrow();
    expect(() => deriveContentKeyV2(ROOT, 'v_1', 720.5)).toThrow();
  });
});

describe('hls-keys: key ids', () => {
  it('parses v1 and v2 ids of the SAME video only', () => {
    expect(parseEncryptionKeyId('derived:v_1', 'v_1')).toEqual({ version: 1 });
    expect(parseEncryptionKeyId('derived:v2:r1:v_1', 'v_1')).toEqual({ version: 2, rootId: 'r1' });
    expect(parseEncryptionKeyId(formatV2KeyId('r7', 'v_1'), 'v_1')).toEqual({ version: 2, rootId: 'r7' });
  });

  it.each([
    ['another video (v1)', 'derived:v_2'],
    ['another video (v2)', 'derived:v2:r1:v_2'],
    ['no root', 'derived:v2::v_1'],
    ['bad root', 'derived:v2:R-1:v_1'],
    ['unknown version', 'derived:v3:r1:v_1'],
    ['garbage', 'kms:abc'],
    ['empty', ''],
  ])('refuses %s', (_label, id) => {
    expect(parseEncryptionKeyId(id, 'v_1')).toBeNull();
  });

  it('formatV2KeyId refuses an invalid root id', () => {
    expect(() => formatV2KeyId('R 1', 'v_1')).toThrow();
  });

  it('roots: r1 is HLS_KEY_ROOT, extra roots come from HLS_KEY_ROOT_<ID>, r1 cannot be overridden', () => {
    const roots = keyRootsFromEnv({
      HLS_KEY_ROOT: ROOT,
      HLS_KEY_ROOT_R2: ROOT2,
      HLS_KEY_ROOT_R1: 'must-not-override',
      HLS_KEY_ROOT_ID: 'r2',
    } as NodeJS.ProcessEnv);
    expect(roots).toEqual({ r1: ROOT, r2: ROOT2 });
  });
});

// ---------------------------------------------------------------------------
// API: playlist rewrite and key route
// ---------------------------------------------------------------------------

type Signer = {
  buildKeyUrl: (ticketId: string, exp: number, renditionHeight?: number) => string;
};

const V1_PLAYLIST =
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key-placeholder",IV=0x00112233445566778899aabbccddeeff\n' +
  '#EXTINF:6.0,\nseg_00000.ts\n#EXTINF:6.0,\nseg_00001.ts\n#EXT-X-ENDLIST\n';
// v2 as the worker's ffmpeg writes it (`periodic_rekey`): a key line before EVERY
// segment, each with that segment's explicit sequence IV.
const V2_PLAYLIST =
  '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n' +
  '#EXT-X-KEY:METHOD=AES-128,URI="key-placeholder",IV=0x00000000000000000000000000000000\n#EXTINF:6.0,\nseg_00000.ts\n' +
  '#EXT-X-KEY:METHOD=AES-128,URI="key-placeholder",IV=0x00000000000000000000000000000001\n#EXTINF:6.0,\nseg_00001.ts\n#EXT-X-ENDLIST\n';

function build(ticket: Record<string, unknown>, playlist: string) {
  const prisma = { playbackTicket: { findUnique: jest.fn(async () => ticket) } };
  const storage = {
    getObjectBuffer: jest.fn(async () => Buffer.from(playlist)),
    signMediaUrl: jest.fn(async (p: { objectKey: string }) => `https://media.test/${p.objectKey}?signed`),
  };
  const config = {
    getOrThrow: (key: string) =>
      ({
        app: { publicUrl: 'https://api.test', apiPrefix: 'api', apiVersion: 1 },
        playback: { heartbeatInterval: 30 },
        video: { keyRoot: ROOT, keyRoots: { r1: ROOT, r2: ROOT2 } },
      })[key],
  };
  const service = new ManifestService(prisma as never, storage as never, config as never);
  return { service, signer: service as unknown as Signer };
}

const future = () => new Date(Date.now() + 5 * 60_000);
const expNow = () => Math.floor(future().getTime() / 1000);

function ticket(video: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: 't_1',
    status: 'ACTIVE',
    expiresAt: future(),
    delivery: 'hls',
    userId: 'u_1',
    sessionId: 's_1',
    deviceId: 'd_1',
    videoId: 'v_1',
    maxHeight: null,
    session: { status: 'ACTIVE' },
    device: { status: 'ACTIVE' },
    video: {
      id: 'v_1',
      mobileStatus: 'READY',
      hlsPrefix: 'hls/v_1/',
      isEncrypted: true,
      encryptionKeyId: 'derived:v_1',
      renditions: [
        { height: 720, width: 1280, bitrateKbps: 2328, playlistKey: 'hls/v_1/720p/index.m3u8' },
        { height: 480, width: 854, bitrateKbps: 1096, playlistKey: 'hls/v_1/480p/index.m3u8' },
      ],
      ...video,
    },
    ...overrides,
  };
}
const v2 = (rootId = 'r1') => ({ encryptionKeyId: `derived:v2:${rootId}:v_1` });

function keyUrls(playlist: string): URL[] {
  return [...playlist.matchAll(/URI="([^"]+)"/g)].map((m) => new URL(m[1]!));
}
function keyArgs(u: URL) {
  const r = u.searchParams.get('r');
  return {
    ticketId: 't_1',
    exp: Number(u.searchParams.get('exp')),
    signature: u.searchParams.get('sig')!,
    ...(r === null ? {} : { rendition: Number(r) }),
  };
}
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AppException) return e.code;
    throw e;
  }
}

describe('ManifestService with v1 videos (must be byte-identical to before v2)', () => {
  it('rewrites the key line to the same URL and signature as always: key:<ticket>:<exp>, no r', async () => {
    const t = build(ticket({}), V1_PLAYLIST);
    const exp = expNow();
    const out = await t.service.mediaPlaylist({ ticketId: 't_1', height: 720, exp, signature: signMedia('t_1', 720, exp) });
    const [url] = keyUrls(out);
    expect(url!.pathname).toBe('/api/v1/playback/keys/t_1');
    expect([...url!.searchParams.keys()]).toEqual(['exp', 'sig']);
    const expected = createHmac('sha256', ROOT).update(`key:t_1:${exp}`).digest('base64url');
    expect(url!.searchParams.get('sig')).toBe(expected);
    expect(out).toContain(',IV=0x00112233445566778899aabbccddeeff'); // the IV attribute is untouched
  });

  it('serves the v1 key bytes for a v1 URL', async () => {
    const t = build(ticket({}), V1_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow()));
    const key = await t.service.contentKey(keyArgs(u));
    expect(key.equals(deriveContentKeyV1(ROOT, 'v_1'))).toBe(true);
  });

  it('treats an encrypted row with no key id as v1 (as every row was read before v2)', async () => {
    const t = build(ticket({ encryptionKeyId: null }), V1_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow()));
    expect((await t.service.contentKey(keyArgs(u))).equals(deriveContentKeyV1(ROOT, 'v_1'))).toBe(true);
  });

  it('refuses a v2-style (rendition-scoped) key URL for a v1 video', async () => {
    const t = build(ticket({}), V1_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow(), 720));
    expect(await codeOf(t.service.contentKey(keyArgs(u)))).toBe(ErrorCode.PLAYBACK_DENIED);
  });
});

describe('ManifestService with v2 videos', () => {
  it('scopes every key line of a rendition to that rendition (r=<height>, signed under key2:)', async () => {
    const t = build(ticket(v2()), V2_PLAYLIST);
    const exp = expNow();
    const out = await t.service.mediaPlaylist({ ticketId: 't_1', height: 720, exp, signature: signMedia('t_1', 720, exp) });
    const urls = keyUrls(out);
    expect(urls).toHaveLength(2); // both per-segment key lines rewritten
    expect(out).not.toContain('key-placeholder');
    for (const u of urls) {
      expect(u.searchParams.get('r')).toBe('720');
      expect(u.searchParams.get('sig')).toBe(createHmac('sha256', ROOT).update(`key2:t_1:720:${exp}`).digest('base64url'));
    }
    // The per-segment IVs pass through untouched (they are not secret).
    expect(out).toContain('IV=0x00000000000000000000000000000000');
    expect(out).toContain('IV=0x00000000000000000000000000000001');
  });

  it('serves each rendition its own key, from the root the row names', async () => {
    const t = build(ticket(v2('r2')), V2_PLAYLIST);
    const k720 = await t.service.contentKey(keyArgs(new URL(t.signer.buildKeyUrl('t_1', expNow(), 720))));
    const k480 = await t.service.contentKey(keyArgs(new URL(t.signer.buildKeyUrl('t_1', expNow(), 480))));
    expect(k720.equals(deriveContentKeyV2(ROOT2, 'v_1', 720))).toBe(true);
    expect(k480.equals(deriveContentKeyV2(ROOT2, 'v_1', 480))).toBe(true);
    expect(k720.equals(k480)).toBe(false);
  });

  it('uses the SHORT side as the tier, for a portrait rung too', async () => {
    const t = build(
      ticket({ ...v2(), renditions: [{ height: 1280, width: 720, bitrateKbps: 2328, playlistKey: 'hls/v_1/720p/index.m3u8' }] }),
      V2_PLAYLIST,
    );
    const k = await t.service.contentKey(keyArgs(new URL(t.signer.buildKeyUrl('t_1', expNow(), 1280))));
    expect(k.equals(deriveContentKeyV2(ROOT, 'v_1', 720))).toBe(true);
  });

  it('refuses a v1-style URL (no rendition) for a v2 video', async () => {
    const t = build(ticket(v2()), V2_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow()));
    expect(await codeOf(t.service.contentKey(keyArgs(u)))).toBe(ErrorCode.PLAYBACK_DENIED);
  });

  it('refuses a signed 480p URL re-pointed at the 720p key (signature covers r)', async () => {
    const t = build(ticket(v2()), V2_PLAYLIST);
    const args = keyArgs(new URL(t.signer.buildKeyUrl('t_1', expNow(), 480)));
    expect(await codeOf(t.service.contentKey({ ...args, rendition: 720 }))).toBe(ErrorCode.PLAYBACK_DENIED);
  });

  it('refuses a rendition the video does not have, even correctly signed', async () => {
    const t = build(ticket(v2()), V2_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow(), 1080));
    expect(await codeOf(t.service.contentKey(keyArgs(u)))).toBe(ErrorCode.PLAYBACK_DENIED);
  });

  it('refuses a rendition above the ticket ceiling (a 480p grant gets no 720p key)', async () => {
    const t = build(ticket(v2(), { maxHeight: 480 }), V2_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow(), 720));
    expect(await codeOf(t.service.contentKey(keyArgs(u)))).toBe(ErrorCode.PLAYBACK_DENIED);
    const ok = new URL(t.signer.buildKeyUrl('t_1', expNow(), 480));
    expect(await codeOf(t.service.contentKey(keyArgs(ok)))).toBe('OK');
  });

  it('refuses a root this API does not hold', async () => {
    const t = build(ticket(v2('r9')), V2_PLAYLIST);
    const u = new URL(t.signer.buildKeyUrl('t_1', expNow(), 720));
    expect(await codeOf(t.service.contentKey(keyArgs(u)))).toBe(ErrorCode.VIDEO_UNAVAILABLE);
  });

  it('refuses a malformed or foreign key id on both the playlist and the key route', async () => {
    const t = build(ticket({ encryptionKeyId: 'derived:v2:r1:v_OTHER' }), V2_PLAYLIST);
    const exp = expNow();
    expect(
      await codeOf(t.service.mediaPlaylist({ ticketId: 't_1', height: 720, exp, signature: signMedia('t_1', 720, exp) })),
    ).toBe(ErrorCode.VIDEO_UNAVAILABLE);
    const u = new URL(t.signer.buildKeyUrl('t_1', exp, 720));
    expect(await codeOf(t.service.contentKey(keyArgs(u)))).toBe(ErrorCode.VIDEO_UNAVAILABLE);
  });

  it('keeps every existing gate: expired link, dead ticket, Gumlet grant, unencrypted asset', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const t1 = build(ticket(v2()), V2_PLAYLIST);
    expect(await codeOf(t1.service.contentKey(keyArgs(new URL(t1.signer.buildKeyUrl('t_1', past, 720))))))
      .toBe(ErrorCode.PLAYBACK_TICKET_EXPIRED);

    const t2 = build(ticket(v2(), { status: 'RELEASED' }), V2_PLAYLIST);
    expect(await codeOf(t2.service.contentKey(keyArgs(new URL(t2.signer.buildKeyUrl('t_1', expNow(), 720))))))
      .toBe(ErrorCode.PLAYBACK_TICKET_EXPIRED);

    const t3 = build(ticket(v2(), { delivery: 'gumlet' }), V2_PLAYLIST);
    expect(await codeOf(t3.service.contentKey(keyArgs(new URL(t3.signer.buildKeyUrl('t_1', expNow(), 720))))))
      .toBe(ErrorCode.PLAYBACK_DENIED);

    const t4 = build(ticket({ ...v2(), isEncrypted: false }), V2_PLAYLIST);
    expect(await codeOf(t4.service.contentKey(keyArgs(new URL(t4.signer.buildKeyUrl('t_1', expNow(), 720))))))
      .toBe(ErrorCode.VIDEO_UNAVAILABLE);
  });
});

// ---------------------------------------------------------------------------
// Worker: keyinfo and verification helpers
// ---------------------------------------------------------------------------

describe('HlsTranscoder key helpers', () => {
  it('v1 keyinfo carries the fixed IV; v2 keyinfo carries none (sequence-number IVs)', () => {
    expect(HlsTranscoder.keyInfoText('/w/enc.key', 'abcd')).toBe('key-placeholder\n/w/enc.key\nabcd\n');
    expect(HlsTranscoder.keyInfoText('/w/enc-720.key')).toBe('key-placeholder\n/w/enc-720.key\n');
  });

  it('verification points EVERY key line at the local key (was: only the first)', () => {
    const out = HlsTranscoder.pointKeysAt(V2_PLAYLIST, 'verify.key');
    expect(out.match(/URI="verify\.key"/g)).toHaveLength(2);
    expect(out).not.toContain('key-placeholder');
  });
});

function signMedia(ticketId: string, height: number, exp: number): string {
  return createHmac('sha256', ROOT).update(`media:${ticketId}:${height}:${exp}`).digest('base64url');
}
