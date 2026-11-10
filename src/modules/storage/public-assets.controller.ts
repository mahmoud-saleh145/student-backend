import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { Public } from '../../common/decorators/public.decorator';
import { RawResponse } from '../../common/decorators/raw-response.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

import { isPublicAssetKey, StorageService } from './storage.service';

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
  constructor(private readonly storage: StorageService) {}

  @Get('*key')
  @Public()
  @SkipThrottle()
  @RawResponse()
  async serve(
    @Param('key') keyParam: string | string[],
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const objectKey = Array.isArray(keyParam) ? keyParam.join('/') : keyParam;

    if (!isPublicAssetKey(objectKey)) {
      throw new AppException(ErrorCode.NOT_FOUND, { message: 'Asset not found' });
    }

    const object = await this.storage.getPublicObject('media', objectKey);
    if (!object) {
      throw new AppException(ErrorCode.NOT_FOUND, { message: 'Asset not found' });
    }

    res.setHeader('Content-Type', PublicAssetsController.contentTypeFor(objectKey, object.contentType));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Any page may embed these; that is what "public" means here.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (object.etag) res.setHeader('ETag', object.etag);

    const ifNoneMatch = req.headers['if-none-match'];
    if (object.etag && ifNoneMatch && ifNoneMatch === object.etag) {
      res.status(304).end();
      return;
    }

    res.setHeader('Content-Length', String(object.body.length));

    if (req.method === 'HEAD') {
      res.status(200).end();
      return;
    }

    res.status(200).send(object.body);
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
