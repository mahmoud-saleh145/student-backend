import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MobileVideoStatus, PlaybackTicketStatus, SessionStatus } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AppConfig, PlaybackConfig, VideoConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../storage/storage.service';

import {
  deriveContentKeyV1,
  deriveContentKeyV2,
  deriveIvV1,
  parseEncryptionKeyId,
  type ParsedKeyId,
} from './hls-keys';

/**
 * Dynamic HLS manifest generation.
 *
 * ── Why the API serves playlists instead of R2 ────────────────────────────
 * A packaged HLS playlist is written once, at transcode time, and contains
 * fixed URIs for its segments and its AES key. That is fundamentally at odds
 * with per-session authorization: you cannot bake a per-viewer signature into
 * a file that every viewer shares.
 *
 * Serving the playlists from the API solves it cleanly:
 *   • every segment URI is signed for THIS viewer and expires with the ticket;
 *   • the AES key URI is bound to the ticket, so the key cannot be fetched
 *     without a live, authorized playback session;
 *   • the quality ceiling is applied by omitting renditions from the master
 *     playlist, so a client cannot request a rendition it wasn't granted;
 *   • revoking a ticket kills playback at the next segment fetch, not
 *     whenever a pre-signed URL happens to lapse.
 *
 * Playlists are a few kilobytes of text. The segments — the actual bytes —
 * still come straight from R2/CDN and never touch this process.
 *
 * ── Why the URLs are self-authenticating ──────────────────────────────────
 * Native players do not reliably forward Authorization headers to segment and
 * key requests (iOS AVPlayer in particular). So the manifest, segment and key
 * URLs each carry their own HMAC signature over the ticket id and an expiry.
 * `playbackHeaders` is therefore empty by design.
 * ─────────────────────────────────────────────────────────────────────────
 */
/** Kept in step with VideoProcessor.runFfmpeg's encoder settings. */
export const HLS_CODECS = 'avc1.640029,mp4a.40.2';

@Injectable()
export class ManifestService {
  private readonly logger = new Logger(ManifestService.name);
  private readonly app: AppConfig;
  private readonly cfg: PlaybackConfig;
  private readonly videoCfg: VideoConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
    this.cfg = config.getOrThrow<PlaybackConfig>('playback');
    this.videoCfg = config.getOrThrow<VideoConfig>('video');
  }

  // ---------------------------------------------------------------------------
  // URL construction
  // ---------------------------------------------------------------------------

  /** Absolute, signed master-playlist URL handed to the player in the ticket. */
  buildMasterUrl(ticketId: string, expiresAt: Date): string {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    const sig = this.sign(`master:${ticketId}:${exp}`);
    const base = this.app.publicUrl.replace(/\/$/, '');
    return `${base}/${this.app.apiPrefix}/v${this.app.apiVersion}/playback/manifest/${ticketId}/master.m3u8?exp=${exp}&sig=${sig}`;
  }

  private buildMediaUrl(ticketId: string, height: number, exp: number): string {
    const sig = this.sign(`media:${ticketId}:${height}:${exp}`);
    const base = this.app.publicUrl.replace(/\/$/, '');
    return `${base}/${this.app.apiPrefix}/v${this.app.apiVersion}/playback/manifest/${ticketId}/${height}.m3u8?exp=${exp}&sig=${sig}`;
  }

  /**
   * The key URL for one media playlist. A v1 video has one key for every
   * rendition, so its URL names only the ticket (unchanged since v1: same
   * canonical, same query). A v2 video has a key per rendition: its URL also
   * names the rendition (`r=<height>`) and the signature covers it under its
   * own `key2:` label, so a client cannot re-point a signed URL at another
   * rendition's key.
   */
  private buildKeyUrl(ticketId: string, exp: number, renditionHeight?: number): string {
    const base = this.app.publicUrl.replace(/\/$/, '');
    const path = `${base}/${this.app.apiPrefix}/v${this.app.apiVersion}/playback/keys/${ticketId}`;
    if (renditionHeight === undefined) {
      return `${path}?exp=${exp}&sig=${this.sign(`key:${ticketId}:${exp}`)}`;
    }
    const sig = this.sign(`key2:${ticketId}:${renditionHeight}:${exp}`);
    return `${path}?exp=${exp}&r=${renditionHeight}&sig=${sig}`;
  }

  /**
   * The key scheme of an encrypted video, from its `encryptionKeyId`. A row
   * with no id is v1, exactly as every encrypted row was read before v2
   * existed. A row whose id is present but malformed (or names another video)
   * is refused: serving a key derived by guesswork would hand out the wrong
   * bytes at best.
   */
  private keySchemeOf(video: { id: string; isEncrypted: boolean; encryptionKeyId?: string | null }): ParsedKeyId {
    if (!video.encryptionKeyId) return { version: 1 };
    const parsed = parseEncryptionKeyId(video.encryptionKeyId, video.id);
    if (!parsed) {
      this.logger.error(`video ${video.id}: unrecognised encryptionKeyId; refusing to serve its key`);
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video cannot be decrypted for playback',
      });
    }
    return parsed;
  }

  private sign(canonical: string): string {
    return createHmac('sha256', this.videoCfg.keyRoot)
      .update(canonical)
      .digest('base64url');
  }

  private verify(canonical: string, signature: string, exp: number): void {
    if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
      throw new AppException(ErrorCode.PLAYBACK_TICKET_EXPIRED, {
        message: 'Manifest link expired',
      });
    }

    const expected = this.sign(canonical);
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);

    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'Invalid manifest signature',
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Ticket validation
  // ---------------------------------------------------------------------------

  /**
   * Re-validates the grant on every playlist fetch.
   *
   * A player re-requests the media playlist periodically, so this is where a
   * revoked ticket, a logged-out session or a revoked device actually stops
   * playback — typically within one segment duration.
   */
  private async requireLiveTicket(ticketId: string) {
    const ticket = await this.prisma.playbackTicket.findUnique({
      where: { id: ticketId },
      include: {
        video: {
          include: { renditions: { orderBy: { height: 'desc' } } },
        },
        session: { select: { status: true } },
        device: { select: { status: true } },
      },
    });

    if (!ticket) {
      throw new AppException(ErrorCode.PLAYBACK_TICKET_EXPIRED, {
        message: 'Unknown playback ticket',
      });
    }

    if (ticket.status !== PlaybackTicketStatus.ACTIVE) {
      throw new AppException(ErrorCode.PLAYBACK_TICKET_EXPIRED, {
        message: `Ticket is ${ticket.status}`,
      });
    }

    if (ticket.expiresAt.getTime() <= Date.now()) {
      throw new AppException(ErrorCode.PLAYBACK_TICKET_EXPIRED);
    }

    if (ticket.session && ticket.session.status !== SessionStatus.ACTIVE) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, {
        message: 'Session ended during playback',
      });
    }

    if (ticket.device && ticket.device.status !== 'ACTIVE') {
      throw new AppException(ErrorCode.DEVICE_NOT_AUTHORIZED, {
        message: 'Device was deauthorized during playback',
      });
    }

    // ---- PIPELINE GATE ------------------------------------------------------
    //
    // These endpoints serve the AES-128 HLS ladder from OUR OWN storage. Only a
    // grant that was MINTED for that pipeline may use them: `delivery` is
    // written by PlaybackService from the bound device at mint time, so a
    // Gumlet ticket - which is what every web session holds - cannot be pointed
    // at a manifest URL to pull the ladder, whatever its signature says.
    //
    // Ticket liveness alone is not sufficient. A ticket stays ACTIVE for its
    // full TTL, so this runs on EVERY manifest, media-playlist and key request
    // and an already-issued grant stops at the next segment boundary, not at
    // expiry. The ladder itself must still be READY: a video whose mobile output
    // was replaced or failed after the ticket was minted is refused here too.
    if (ticket.delivery !== 'hls') {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'This playback grant is not for the HLS pipeline',
        details: { delivery: ticket.delivery },
      });
    }
    if (ticket.video.mobileStatus !== MobileVideoStatus.READY || !ticket.video.hlsPrefix) {
      throw new AppException(ErrorCode.VIDEO_NOT_READY, {
        message: 'This video is still being prepared for mobile playback',
        details: { mobileStatus: ticket.video.mobileStatus },
      });
    }

    return ticket;
  }

  // ---------------------------------------------------------------------------
  // Master playlist
  // ---------------------------------------------------------------------------

  async masterPlaylist(params: {
    ticketId: string;
    exp: number;
    signature: string;
    /** Client-requested ceiling; never allowed to exceed the ticket's. */
    maxHeight?: number;
  }): Promise<string> {
    this.verify(`master:${params.ticketId}:${params.exp}`, params.signature, params.exp);

    const ticket = await this.requireLiveTicket(params.ticketId);

    // The ticket's ceiling wins. A client asking for 1080p on a 480p grant
    // gets 480p — the ceiling is an authorization decision, not a preference.
    const ceiling = Math.min(
      params.maxHeight ?? Number.MAX_SAFE_INTEGER,
      ticket.maxHeight ?? Number.MAX_SAFE_INTEGER,
    );

    // A rendition's quality is the length of its SHORT side (a portrait 720p
    // rung is 720 wide and 1280 tall), so the ceiling is compared with that,
    // not with the stored height.
    const renditions = ticket.video.renditions
      .filter((r) => ManifestService.tierOf(r) <= ceiling)
      .sort((a, b) => ManifestService.tierOf(a) - ManifestService.tierOf(b));

    // Never return an empty ladder: if the ceiling is below every rendition,
    // serve the smallest one rather than a playlist the player can't use.
    const usable =
      renditions.length > 0
        ? renditions
        : [...ticket.video.renditions].sort((a, b) => ManifestService.tierOf(a) - ManifestService.tierOf(b)).slice(0, 1);

    if (usable.length === 0) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'No renditions available for this video',
      });
    }

    const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];

    for (const rendition of usable) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${rendition.bitrateKbps * 1000},` +
          `AVERAGE-BANDWIDTH=${Math.round(rendition.bitrateKbps * 900)},` +
          `RESOLUTION=${rendition.width}x${rendition.height},` +
          // Must describe what the worker actually encodes: libx264
          // `-profile:v high -level 4.1` (avc1.640029) + AAC-LC. The previous
          // value advertised Main@3.1, which AVPlayer and ExoPlayer can use to
          // reject or mis-select a variant.
          `CODECS="${HLS_CODECS}"`,
      );
      lines.push(this.buildMediaUrl(params.ticketId, rendition.height, params.exp));
    }

    return `${lines.join('\n')}\n`;
  }

  // ---------------------------------------------------------------------------
  // Media playlist
  // ---------------------------------------------------------------------------

  async mediaPlaylist(params: {
    ticketId: string;
    height: number;
    exp: number;
    signature: string;
  }): Promise<string> {
    this.verify(
      `media:${params.ticketId}:${params.height}:${params.exp}`,
      params.signature,
      params.exp,
    );

    const ticket = await this.requireLiveTicket(params.ticketId);

    const rendition = ticket.video.renditions.find((r) => r.height === params.height);
    if (!rendition) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: `Rendition ${params.height}p does not exist for this video`,
      });
    }

    if (ticket.maxHeight && ManifestService.tierOf(rendition) > ticket.maxHeight) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'Requested rendition exceeds the granted ceiling',
      });
    }

    // v1: one ticket-scoped key URL for every rendition (as always).
    // v2: a key per rendition, so the URL is scoped to THIS rendition.
    const keyUrl = ticket.video.isEncrypted
      ? this.keySchemeOf(ticket.video).version === 2
        ? this.buildKeyUrl(params.ticketId, params.exp, rendition.height)
        : this.buildKeyUrl(params.ticketId, params.exp)
      : null;

    const stored = await this.storage.getObjectBuffer('media', rendition.playlistKey);
    const source = stored.toString('utf8');

    const prefix = rendition.playlistKey.replace(/[^/]+$/, '');
    const remainingSeconds = Math.max(
      30,
      Math.ceil((ticket.expiresAt.getTime() - Date.now()) / 1000),
    );

    // Rewrite in one pass: segment URIs become per-viewer signed URLs, and the
    // key URI is repointed at this ticket's key endpoint.
    const out: string[] = [];

    for (const raw of source.split('\n')) {
      const line = raw.trimEnd();

      // Every key line is repointed, whichever form the encoder wrote (one line
      // at the top, or one per segment).
      if (line.startsWith('#EXT-X-KEY')) {
        out.push(
          keyUrl === null
            ? line
            : line.replace(/URI="[^"]*"/g, `URI="${keyUrl}"`),
        );
        continue;
      }

      if (!line || line.startsWith('#')) {
        out.push(line);
        continue;
      }

      // A bare line is a segment URI, relative to the playlist.
      const segmentKey = line.startsWith('http') ? null : `${prefix}${line}`;

      if (!segmentKey) {
        out.push(line);
        continue;
      }

      out.push(
        await this.storage.signMediaUrl({
          objectKey: segmentKey,
          expiresInSeconds: remainingSeconds,
          userId: ticket.userId,
          sessionId: ticket.sessionId,
          deviceId: ticket.deviceId,
          ticketId: ticket.id,
          maxHeight: ticket.maxHeight,
        }),
      );
    }

    return `${out.join('\n')}\n`;
  }

  // ---------------------------------------------------------------------------
  // AES-128 key delivery
  // ---------------------------------------------------------------------------

  /**
   * Returns the 16-byte content key for a live ticket.
   *
   * The key is *derived*, never stored: HMAC(HLS_KEY_ROOT, videoId) truncated
   * to 128 bits. A database dump therefore contains no content keys, and
   * rotating HLS_KEY_ROOT invalidates every packaged asset at once (which is
   * why rotating it requires a re-transcode — documented in MANUAL_STEPS).
   *
   * Delivery is gated on the ticket still being live, so revoking a ticket
   * denies the key even to a player that already has the playlist.
   */
  async contentKey(params: {
    ticketId: string;
    exp: number;
    signature: string;
    /** `r` of a v2 key URL: the rendition height the key belongs to. */
    rendition?: number;
  }): Promise<Buffer> {
    // The signature is checked first, against the canonical the URL claims
    // (v1 `key:` or v2 `key2:`); the video's own scheme must then agree, so a
    // v1-style URL never yields a v2 key and vice versa.
    const v2Url = params.rendition !== undefined;
    this.verify(
      v2Url
        ? `key2:${params.ticketId}:${params.rendition}:${params.exp}`
        : `key:${params.ticketId}:${params.exp}`,
      params.signature,
      params.exp,
    );

    const ticket = await this.requireLiveTicket(params.ticketId);

    if (!ticket.video.isEncrypted) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This asset is not encrypted',
      });
    }

    const scheme = this.keySchemeOf(ticket.video);
    if (scheme.version === 1) {
      if (v2Url) {
        throw new AppException(ErrorCode.PLAYBACK_DENIED, { message: 'Key link does not match this asset' });
      }
      return deriveContentKeyV1(this.videoCfg.keyRoot, ticket.videoId);
    }

    if (!v2Url) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, { message: 'Key link does not match this asset' });
    }
    // The rendition must exist and be inside the ticket's quality ceiling: a
    // grant capped at 480p does not receive the 720p key.
    const rendition = ticket.video.renditions.find((r) => r.height === params.rendition);
    if (!rendition) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, { message: 'Unknown rendition for this asset' });
    }
    const tier = ManifestService.tierOf(rendition);
    if (ticket.maxHeight && tier > ticket.maxHeight) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'Requested rendition exceeds the granted ceiling',
      });
    }
    const root = this.videoCfg.keyRoots[scheme.rootId];
    if (!root) {
      this.logger.error(`video ${ticket.videoId}: key root "${scheme.rootId}" is not configured on this API`);
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This video cannot be decrypted for playback',
      });
    }
    return deriveContentKeyV2(root, ticket.videoId, tier);
  }

  /** The quality a rendition represents: its short side (portrait rungs are taller than wide). */
  static tierOf(rendition: { width?: number | null; height: number }): number {
    return rendition.width ? Math.min(rendition.width, rendition.height) : rendition.height;
  }

  /** The v1 key, shared with the worker so both sides derive the same bytes. Unchanged since v1. */
  static deriveContentKey(keyRoot: string, videoId: string): Buffer {
    return deriveContentKeyV1(keyRoot, videoId);
  }

  /**
   * The v1 IV: ONE fixed IV per video, written into ffmpeg's keyinfo (not a
   * per-segment IV, despite the old comment). Unchanged since v1. v2 encodes
   * write no IV, so every segment is encrypted with its sequence number.
   */
  static deriveIv(videoId: string): string {
    return deriveIvV1(videoId);
  }
}
