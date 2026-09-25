import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PlaybackTicketStatus, SessionStatus } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AppConfig, PlaybackConfig, VideoConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { StorageService } from '../storage/storage.service';

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

  private buildKeyUrl(ticketId: string, exp: number): string {
    const sig = this.sign(`key:${ticketId}:${exp}`);
    const base = this.app.publicUrl.replace(/\/$/, '');
    return `${base}/${this.app.apiPrefix}/v${this.app.apiVersion}/playback/keys/${ticketId}?exp=${exp}&sig=${sig}`;
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

    const renditions = ticket.video.renditions
      .filter((r) => r.height <= ceiling)
      .sort((a, b) => a.height - b.height);

    // Never return an empty ladder: if the ceiling is below every rendition,
    // serve the smallest one rather than a playlist the player can't use.
    const usable =
      renditions.length > 0
        ? renditions
        : ticket.video.renditions.slice(-1);

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

    if (ticket.maxHeight && params.height > ticket.maxHeight) {
      throw new AppException(ErrorCode.PLAYBACK_DENIED, {
        message: 'Requested rendition exceeds the granted ceiling',
      });
    }

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

      if (line.startsWith('#EXT-X-KEY')) {
        out.push(
          line.replace(
            /URI="[^"]*"/,
            `URI="${this.buildKeyUrl(params.ticketId, params.exp)}"`,
          ),
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
  }): Promise<Buffer> {
    this.verify(`key:${params.ticketId}:${params.exp}`, params.signature, params.exp);

    const ticket = await this.requireLiveTicket(params.ticketId);

    if (!ticket.video.isEncrypted) {
      throw new AppException(ErrorCode.VIDEO_UNAVAILABLE, {
        message: 'This asset is not encrypted',
      });
    }

    return ManifestService.deriveContentKey(this.videoCfg.keyRoot, ticket.videoId);
  }

  /** Shared with the transcoding worker so both sides derive the same key. */
  static deriveContentKey(keyRoot: string, videoId: string): Buffer {
    return createHmac('sha256', keyRoot).update(`hls-key:${videoId}`).digest().subarray(0, 16);
  }

  /** Deterministic per-segment IV base, also shared with the worker. */
  static deriveIv(videoId: string): string {
    return createHmac('sha256', `iv:${videoId}`)
      .update(videoId)
      .digest('hex')
      .slice(0, 32);
  }
}
