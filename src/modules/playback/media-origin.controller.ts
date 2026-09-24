import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AppConfig } from '../../config/configuration';
import { StorageService } from '../storage/storage.service';

import { PlaybackService } from './playback.service';

/**
 * Media origin — the Cloudflare Worker's job, done in Node.
 *
 * Why this exists
 * ---------------
 * Segment URLs are signed with an HMAC over path + expiry + user + session +
 * device + ticket, and something has to verify that signature before serving
 * bytes. In production that something is the edge Worker
 * (docs/cloudflare-worker.js). Without a CDN there was previously no third
 * option: `signMediaUrl` fell back to a plain presigned S3 URL, which is
 * **not** bound to the viewer — anyone holding the string could replay it —
 * and which a phone cannot reach when the store is a local MinIO anyway. So
 * local playback did not work, and the one configuration where it appeared to
 * work was the least secure one.
 *
 * This controller closes that gap by applying the *same* checks the Worker
 * applies:
 *
 *   1. the HMAC must verify, in constant time, over the same canonical string;
 *   2. the URL must not have expired;
 *   3. the source/upload prefixes are refused outright, whatever the signature
 *      says — originals are never served to a player;
 *   4. the rendition height in the key must not exceed the granted ceiling;
 *   5. the playback ticket must still be live, and must belong to the `uid` in
 *      the URL.
 *
 * It is therefore a transport change, not a security relaxation. The one
 * difference from the Worker is step 5's failure mode: the Worker fails *open*
 * on a network error because it is talking to a remote API, whereas here the
 * check is a local database read, so it fails closed.
 *
 * What it is not
 * --------------
 * A production media path. Node streaming video competes with request handling
 * for the event loop and gets no edge caching — which is the whole reason the
 * Worker exists. `signMediaUrl` prefers `MEDIA_CDN_BASE_URL` whenever it is
 * set, and the local origin is off by default in production.
 */
@ApiExcludeController()
@Controller('playback/media')
export class MediaOriginController {
  private readonly isProduction: boolean;

  constructor(
    private readonly storage: StorageService,
    private readonly playback: PlaybackService,
    config: ConfigService,
  ) {
    this.isProduction = config.getOrThrow<AppConfig>('app').isProduction;
  }

  /**
   * `@Public` because a media player cannot attach a bearer token to the
   * segment requests it makes internally. Authorization comes from the
   * signature and the ticket instead, which is strictly more specific than a
   * bearer token: it names the video, the device and the session too.
   */
  @Get('*key')
  @Public()
  @RawResponse()
  async serve(
    @Param('key') keyParam: string | string[],
    @Query('exp') exp: string,
    @Query('uid') uid: string,
    @Query('sig') sig: string,
    @Query('sid') sid: string | undefined,
    @Query('did') did: string | undefined,
    @Query('tid') tid: string | undefined,
    @Query('mh') mh: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!this.storage.servesMediaLocally) {
      // A CDN is configured, so this route must not be a way around it.
      throw new AppException(ErrorCode.NOT_FOUND);
    }

    const objectKey = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;

    // Defence in depth, identical to the Worker: never serve the original
    // upload, whatever the signature says.
    if (
      !objectKey ||
      objectKey.startsWith('uploads/') ||
      objectKey.includes('/source/') ||
      objectKey.includes('..')
    ) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'forbidden_prefix' });
    }

    const expiresAt = Number(exp);
    const maxHeight = mh ? Number(mh) : 0;

    if (!Number.isFinite(expiresAt) || !uid || !sig) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'unsigned' });
    }

    const signatureValid = this.storage.verifyMediaSignature({
      objectKey,
      expiresAt,
      userId: uid,
      sessionId: sid,
      deviceId: did,
      ticketId: tid,
      maxHeight,
      signature: sig,
    });

    // verifyMediaSignature also rejects an elapsed expiry, so a single failure
    // covers both "forged" and "stale" — and says which to the log only.
    if (!signatureValid) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'bad_signature' });
    }

    // Server-chosen quality ceiling. The rendition is part of the object key,
    // so this cannot be bypassed by a player that ignores the manifest.
    if (maxHeight > 0) {
      const height = MediaOriginController.renditionHeight(objectKey);
      if (height !== null && height > maxHeight) {
        throw new AppException(ErrorCode.PLAYBACK_DENIED, { message: 'quality_ceiling' });
      }
    }

    // A valid signature proves who minted the URL, not that the grant survived
    // the last thirty seconds. The ticket may have been revoked, the device
    // unbound or the session ended since.
    if (tid) {
      const { live } = await this.playback.ticketLiveness(tid, uid);
      if (!live) {
        throw new AppException(ErrorCode.PLAYBACK_TICKET_EXPIRED, {
          message: 'ticket_revoked',
        });
      }
    }

    // Bucket-aware: a `library/…` key lives in the Library store, everything
    // else on `media`. This was hard-coded to 'media', so a Library document —
    // which is written to the Library bucket — could never be read back.
    const body = await this.storage.getObjectBuffer(
      StorageService.bucketForKey(objectKey),
      objectKey,
    );

    res.setHeader('Content-Type', MediaOriginController.contentTypeFor(objectKey));
    res.setHeader('Content-Length', String(body.length));
    // A signed URL encodes one viewer's grant. A shared cache serving it to a
    // second viewer would defeat the entire scheme.
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');

    if (!this.isProduction) {
      res.setHeader('X-Media-Origin', 'node-local');
    }

    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    res.status(200).send(body);
  }

  /** "hls/<videoId>/720p/seg00042.ts" → 720 */
  static renditionHeight(objectKey: string): number | null {
    const match = objectKey.match(/\/(\d{3,4})p\//);
    return match ? Number(match[1]) : null;
  }

  static contentTypeFor(objectKey: string): string {
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
}
