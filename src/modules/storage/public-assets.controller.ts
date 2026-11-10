import { Controller, Get, Optional, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { expressIpForHops, MAX_TRUST_PROXY_HOPS } from '../../common/net/client-ip';

import {
  PUBLIC_ASSET_ORIGIN_LIMIT,
  PUBLIC_ASSET_ORIGIN_MAX_CLIENTS,
  PUBLIC_ASSET_ORIGIN_WINDOW_MS,
  PublicAssetRateLimiter,
} from './public-asset-rate-limiter';
import { isPublicAssetKey, MAX_IMAGE_BYTES, StorageService } from './storage.service';

/**
 * Public images: thumbnails, covers and avatars.
 *
 * Why this exists
 * ---------------
 * Every image in object storage used to be handed to clients as an *unsigned*
 * URL on the media gate (`MEDIA_CDN_BASE_URL/<key>`). The gate exists to serve
 * paid video and documents to one verified viewer, so it refuses anything
 * without a signature (`403 x-deny-reason: unsigned`) — and even a signed
 * response carries `cross-origin-resource-policy: same-site` for a request
 * with no Origin, which is what a plain `<img>` sends, so the dashboard's
 * browser would block it anyway. The result was that no R2 thumbnail, cover or
 * avatar has ever rendered in production; course images only work because
 * they moved to Cloudinary.
 *
 * This route is the public door those images need: the API reads the media
 * bucket with its own credentials and serves the bytes with cross-origin
 * headers and a long cache lifetime. No bucket permission changes, no Worker
 * deploy, no signature — because these images are public by design.
 *
 * What it will not serve
 * ----------------------
 * An allow-list of namespaces (`PUBLIC_ASSET_PREFIXES`), never the bucket.
 * HLS renditions, captions, source uploads, video poster frames and every
 * Library document stay behind the gate. A key outside the list is answered
 * 404, the same as a missing object, so the route cannot be used to probe
 * what the bucket holds.
 *
 * Keys carry a UUID, so a URL never changes meaning: the response is
 * immutable and cacheable for a year, by the browser and by any shared cache.
 */
@ApiExcludeController()
@Controller('assets')
export class PublicAssetsController {
  /**
   * One limiter per process. `@SkipThrottle()` keeps the Redis-backed global
   * throttler off this route on purpose; this in-memory one replaces it.
   */
  private readonly limiter: PublicAssetRateLimiter;

  constructor(
    private readonly storage: StorageService,
    @Optional() limiter?: PublicAssetRateLimiter,
  ) {
    this.limiter =
      limiter ??
      new PublicAssetRateLimiter(
        PUBLIC_ASSET_ORIGIN_LIMIT,
        PUBLIC_ASSET_ORIGIN_WINDOW_MS,
        PUBLIC_ASSET_ORIGIN_MAX_CLIENTS,
      );
  }

  @Get('*key')
  @Public()
  @SkipThrottle()
  @RawResponse()
  async serve(
    @Param('key') keyParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const decision = this.limiter.hit(publicAssetClientKey(req));
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      res.setHeader('Cache-Control', 'no-store');
      throw new AppException(ErrorCode.RATE_LIMITED, {
        message: 'Too many image requests. Retry shortly.',
      });
    }

    const objectKey = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;

    if (!isPublicAssetKey(objectKey)) {
      throw new AppException(ErrorCode.NOT_FOUND, { message: 'Asset not found' });
    }

    const ifNoneMatch = req.headers['if-none-match'];
    const headOnly = req.method === 'HEAD';

    // HEAD and a revalidation need the metadata, not the bytes. Answering
    // either used to download the whole image from R2 and throw it away.
    if (headOnly || ifNoneMatch) {
      const head = await this.storage.headPublicObject('media', objectKey);
      if (!head || head.size > MAX_IMAGE_BYTES) {
        throw new AppException(ErrorCode.NOT_FOUND, { message: 'Asset not found' });
      }
      PublicAssetsController.setPublicHeaders(res, objectKey, head.contentType, head.etag);
      if (head.etag && etagMatches(ifNoneMatch, head.etag)) {
        res.status(304).end();
        return;
      }
      if (headOnly) {
        res.setHeader('Content-Length', String(head.size));
        res.status(200).end();
        return;
      }
    }

    const object = await this.storage.getPublicObject('media', objectKey);
    if (!object) {
      throw new AppException(ErrorCode.NOT_FOUND, { message: 'Asset not found' });
    }

    PublicAssetsController.setPublicHeaders(res, objectKey, object.contentType, object.etag);
    res.setHeader('Content-Length', String(object.body.length));
    res.status(200).send(object.body);
  }

  private static setPublicHeaders(
    res: Response,
    objectKey: string,
    storedType: string | null,
    etag: string | null,
  ): void {
    res.setHeader('Content-Type', PublicAssetsController.contentTypeFor(objectKey, storedType));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Any page may embed these; that is what "public" means here.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Asset-Source', 'origin');
    if (etag) res.setHeader('ETag', etag);
  }

  /**
   * The type is decided by the key's extension, which the upload route chose
   * from the validated content type. The stored metadata is only a fallback
   * for a key written by an older route; it is never allowed to turn an image
   * namespace into something a browser would execute.
   */
  static contentTypeFor(objectKey: string, stored: string | null): string {
    const lower = objectKey.toLowerCase();
    if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
    if (lower.endsWith('.png')) return 'image/png';
    if (lower.endsWith('.webp')) return 'image/webp';
    if (lower.endsWith('.gif')) return 'image/gif';
    if (stored && stored.startsWith('image/')) return stored;
    return 'application/octet-stream';
  }
}

/**
 * Which client a public image request is counted against.
 *
 * Not `req.ip` by default: in production that is TRUST_PROXY_HOPS = 1 entries
 * from the right of X-Forwarded-For, which on Render is Render's own internal
 * balancer — one address shared by every visitor, which would turn a per-client
 * limit into a single global one. With PUBLIC_ASSET_CLIENT_IP_HOPS set to the
 * number of entries the platform itself appends (3 on Render), the key is the
 * address Cloudflare observed. Counted from the RIGHT, so anything a client
 * writes into X-Forwarded-For sits further left and is never chosen.
 */
export function publicAssetClientKey(req: Request): string {
  const hops = Number(process.env.PUBLIC_ASSET_CLIENT_IP_HOPS);
  if (Number.isInteger(hops) && hops >= 1 && hops <= MAX_TRUST_PROXY_HOPS) {
    const raw = req.headers['x-forwarded-for'];
    const forwarded = (Array.isArray(raw) ? raw.join(',') : (raw ?? ''))
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .slice(-200);
    const ip = expressIpForHops(req.socket?.remoteAddress ?? null, forwarded, hops);
    if (ip) return `ip:${ip}`;
  }
  return `ip:${req.ip ?? 'unknown'}`;
}

/** RFC 9110 weak comparison, as If-None-Match requires; `*` matches any. */
export function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const values = (Array.isArray(header) ? header.join(',') : header).split(',');
  const bare = (value: string) => value.trim().replace(/^W\//, '');
  const target = bare(etag);
  return values.some((candidate) => {
    const value = candidate.trim();
    return value === '*' || bare(value) === target;
  });
}
