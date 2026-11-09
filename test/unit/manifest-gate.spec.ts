import { ManifestService } from '../../src/modules/playback/manifest.service';
import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';

/**
 * The three public manifest endpoints are the only place the independent
 * pipeline hands out anything a player can use: the master, the rewritten
 * media playlists and the AES-128 key. Each is gated twice - an HMAC over the
 * URL with an expiry, then the live ticket - and these tests pin what each
 * gate refuses.
 */
const KEY_ROOT = 'test-root-key-that-is-long-enough-for-hmac-use';

type Signer = {
  buildMediaUrl: (ticketId: string, height: number, exp: number) => string;
  buildKeyUrl: (ticketId: string, exp: number) => string;
};

const PLAYLIST =
  '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key-placeholder",IV=0x00\n#EXTINF:6.0,\nseg_00000.ts\n#EXT-X-ENDLIST\n';

function build(ticketRow: Record<string, unknown> | null) {
  const prisma = { playbackTicket: { findUnique: jest.fn(async () => ticketRow) } };
  const storage = {
    getObjectBuffer: jest.fn(async () => Buffer.from(PLAYLIST)),
    signMediaUrl: jest.fn(async (p: { objectKey: string }) => `https://media.test/${p.objectKey}?signed`),
  };
  const config = {
    getOrThrow: (key: string) =>
      ({
        app: { publicUrl: 'https://api.test', apiPrefix: 'api', apiVersion: 1 },
        playback: { heartbeatInterval: 30 },
        video: { keyRoot: KEY_ROOT },
      })[key],
  };
  const service = new ManifestService(prisma as never, storage as never, config as never);
  return { service, signer: service as unknown as Signer, prisma, storage };
}

const future = () => new Date(Date.now() + 5 * 60_000);

function liveTicket(overrides: Record<string, unknown> = {}) {
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
      renditions: [
        { height: 720, width: 1280, bitrateKbps: 2328, playlistKey: 'hls/v_1/720p/index.m3u8' },
        { height: 360, width: 640, bitrateKbps: 664, playlistKey: 'hls/v_1/360p/index.m3u8' },
      ],
    },
    ...overrides,
  };
}

/** Pull `exp` and `sig` back out of a URL the service itself signed. */
function parts(url: string) {
  const u = new URL(url);
  return { exp: Number(u.searchParams.get('exp')), sig: u.searchParams.get('sig')! };
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

describe('manifest URL signatures', () => {
  it('a URL the service signed verifies, and the master lists signed media URLs', async () => {
    const t = build(liveTicket());
    const { exp, sig } = parts(t.service.buildMasterUrl('t_1', future()));
    const master = await t.service.masterPlaylist({ ticketId: 't_1', exp, signature: sig });
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).toMatch(/playback\/manifest\/t_1\/720\.m3u8\?exp=\d+&sig=/);
  });

  it('refuses a tampered signature, a signature for another ticket, a replayed expired link and a pushed-out expiry', async () => {
    const t = build(liveTicket());
    const { exp, sig } = parts(t.service.buildMasterUrl('t_1', future()));
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1);
    expect(await codeOf(t.service.masterPlaylist({ ticketId: 't_1', exp, signature: flipped }))).toBe(
      ErrorCode.PLAYBACK_DENIED,
    );
    expect(await codeOf(t.service.masterPlaylist({ ticketId: 't_2', exp, signature: sig }))).toBe(
      ErrorCode.PLAYBACK_DENIED,
    );

    const stale = parts(t.service.buildMasterUrl('t_1', new Date(Date.now() - 1000)));
    expect(
      await codeOf(t.service.masterPlaylist({ ticketId: 't_1', exp: stale.exp, signature: stale.sig })),
    ).toBe(ErrorCode.PLAYBACK_TICKET_EXPIRED);
    // The expiry is part of the signed string, so it cannot be extended by hand.
    expect(await codeOf(t.service.masterPlaylist({ ticketId: 't_1', exp: exp + 3600, signature: sig }))).toBe(
      ErrorCode.PLAYBACK_DENIED,
    );
    // None of those ever reached the database.
    expect(t.prisma.playbackTicket.findUnique).toHaveBeenCalledTimes(0);
  });

  it('a media-playlist signature is bound to its rung: the 360p link cannot fetch 720p', async () => {
    const t = build(liveTicket());
    const { exp, sig } = parts(t.service.buildMasterUrl('t_1', future()));
    const master = await t.service.masterPlaylist({ ticketId: 't_1', exp, signature: sig });
    const media360 = master.split('\n').find((l) => l.includes('/360.m3u8'))!;
    const p = parts(media360);
    expect(
      await codeOf(t.service.mediaPlaylist({ ticketId: 't_1', height: 720, exp: p.exp, signature: p.sig })),
    ).toBe(ErrorCode.PLAYBACK_DENIED);

    const ok = await t.service.mediaPlaylist({ ticketId: 't_1', height: 360, exp: p.exp, signature: p.sig });
    expect(ok).toContain('https://media.test/hls/v_1/360p/seg_00000.ts?signed');
    expect(ok).toMatch(/URI="https:\/\/api\.test\/api\/v1\/playback\/keys\/t_1\?exp=\d+&sig=[A-Za-z0-9_-]+"/);
    // Segment URLs are signed for THIS viewer's ticket, session and device.
    expect(t.storage.signMediaUrl).toHaveBeenCalledWith(
      expect.objectContaining({ ticketId: 't_1', userId: 'u_1', sessionId: 's_1', deviceId: 'd_1' }),
    );
  });
});

describe('live-ticket gate on the playlists and the key', () => {
  it('hands the derived key to a live HLS ticket', async () => {
    const t = build(liveTicket());
    const { exp, sig } = parts(t.signer.buildKeyUrl('t_1', Math.floor(future().getTime() / 1000)));
    const key = await t.service.contentKey({ ticketId: 't_1', exp, signature: sig });
    expect(key).toEqual(ManifestService.deriveContentKey(KEY_ROOT, 'v_1'));
    expect(key.length).toBe(16);
  });

  it.each([
    ['a revoked ticket', { status: 'REVOKED' }, ErrorCode.PLAYBACK_TICKET_EXPIRED],
    ['a released (rotated-away) ticket', { status: 'RELEASED' }, ErrorCode.PLAYBACK_TICKET_EXPIRED],
    ['a ticket past its expiry', { expiresAt: new Date(Date.now() - 1) }, ErrorCode.PLAYBACK_TICKET_EXPIRED],
    ['a logged-out session', { session: { status: 'REVOKED' } }, ErrorCode.SESSION_EXPIRED],
    ['a deauthorised device', { device: { status: 'REVOKED' } }, ErrorCode.DEVICE_NOT_AUTHORIZED],
    ['a Gumlet (web) grant pointed at our pipeline', { delivery: 'gumlet' }, ErrorCode.PLAYBACK_DENIED],
    [
      'a video whose ladder is not READY',
      { video: { ...liveTicket().video, mobileStatus: 'PROCESSING' } },
      ErrorCode.VIDEO_NOT_READY,
    ],
  ])('refuses the master, the media playlist and the key for %s', async (_label, overrides, expected) => {
    const t = build(liveTicket(overrides));
    const exp = Math.floor(future().getTime() / 1000);
    const master = parts(t.service.buildMasterUrl('t_1', new Date(exp * 1000)));
    expect(
      await codeOf(t.service.masterPlaylist({ ticketId: 't_1', exp: master.exp, signature: master.sig })),
    ).toBe(expected);
    const media = parts(t.signer.buildMediaUrl('t_1', 720, exp));
    expect(
      await codeOf(t.service.mediaPlaylist({ ticketId: 't_1', height: 720, exp: media.exp, signature: media.sig })),
    ).toBe(expected);
    const key = parts(t.signer.buildKeyUrl('t_1', exp));
    expect(await codeOf(t.service.contentKey({ ticketId: 't_1', exp: key.exp, signature: key.sig }))).toBe(expected);
    expect(t.storage.signMediaUrl).not.toHaveBeenCalled();
  });

  it('refuses everything for an unknown ticket id, even with a valid signature', async () => {
    const t = build(null);
    const { exp, sig } = parts(t.service.buildMasterUrl('t_1', future()));
    expect(await codeOf(t.service.masterPlaylist({ ticketId: 't_1', exp, signature: sig }))).toBe(
      ErrorCode.PLAYBACK_TICKET_EXPIRED,
    );
  });

  it('a quality ceiling on the ticket prunes the master and blocks a direct request above it', async () => {
    const t = build(liveTicket({ maxHeight: 360 }));
    const { exp, sig } = parts(t.service.buildMasterUrl('t_1', future()));
    const master = await t.service.masterPlaylist({ ticketId: 't_1', exp, signature: sig, maxHeight: 1080 });
    expect(master).toContain('RESOLUTION=640x360');
    expect(master).not.toContain('RESOLUTION=1280x720');
    const p = parts(t.signer.buildMediaUrl('t_1', 720, exp));
    expect(
      await codeOf(t.service.mediaPlaylist({ ticketId: 't_1', height: 720, exp: p.exp, signature: p.sig })),
    ).toBe(ErrorCode.PLAYBACK_DENIED);
  });
});

describe('ManifestService.tierOf (quality of a rendition is its short side)', () => {
  it('reads landscape and portrait rungs the same way', () => {
    expect(ManifestService.tierOf({ width: 1920, height: 1080 })).toBe(1080);
    expect(ManifestService.tierOf({ width: 720, height: 1280 })).toBe(720);
    expect(ManifestService.tierOf({ width: 480, height: 738 })).toBe(480);
    expect(ManifestService.tierOf({ width: null, height: 720 })).toBe(720);
  });
});
