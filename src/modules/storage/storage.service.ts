import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { StorageConfig } from '../../config/configuration';

import { CloudinaryService } from './cloudinary.service';

/**
 * The three object stores this platform uses.
 *
 *  - `media`    — HLS renditions, thumbnails, avatars, captions. Fronted by the
 *                 Cloudflare Worker and subject to the whole protected-video
 *                 delivery path.
 *  - `uploads`  — raw source files a client hands us before processing (video
 *                 originals, course attachments). Never served directly.
 *  - `library`  — Library documents. Separate so that paid PDFs do not consume
 *                 the capacity budgeted for protected video, and so the two can
 *                 be sized, priced and lifecycle-managed independently.
 */
export type Bucket = 'media' | 'uploads' | 'library';

export interface SignedUpload {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
  /** Headers the client must replay exactly, or the signature won't match. */
  requiredHeaders: Record<string, string>;
}

/**
 * Cloudflare R2 access.
 *
 * R2 is S3-compatible, so the AWS SDK works unchanged and MinIO can stand in
 * locally. Two delivery paths exist, and the difference matters:
 *
 *  1. **Presigned S3 URLs** (`presignDownload`). Simple, but the signature is
 *     bound only to the object and an expiry — anyone holding the URL can
 *     fetch it until it lapses. Used for non-sensitive assets (thumbnails)
 *     and as the development fallback for media.
 *
 *  2. **Edge-signed CDN URLs** (`signMediaUrl`). An HMAC over
 *     path + expiry + user + session, verified by a Cloudflare Worker in front
 *     of the bucket. This is what protected HLS uses: the signature is bound
 *     to the *viewer*, so a copied playlist URL fails at the edge even before
 *     it expires. The Worker source is in docs/cloudflare-worker.js.
 *
 * The bucket itself is always private. There is no public read path.
 */

/**
 * Rejects an object key that this API did not issue for this kind of asset.
 *
 * Presign responses hand the client an `objectKey`, and the client sends it
 * back when it registers the upload. Nothing checked that the key it sent back
 * belongs to the namespace its own presign endpoint writes to — and the key is
 * what every later URL is built from.
 *
 * That is why this is a security check and not tidiness. `publicAssetUrl`
 * produces an **unsigned** CDN URL, because it exists for images that are public
 * by design. So a `thumbnailKey` of `hls/<paidVideoId>/360p/index.m3u8` — a
 * namespace no thumbnail endpoint ever issues — would be turned into a
 * permanent public link to protected video, stepping around the playback ticket
 * and the viewer-bound signature entirely. The same trick reaches the original
 * uploads under `source/videos/`, and reaches a paid library document through
 * `objectKey`.
 *
 * The check is on the prefix rather than against a recorded key, because the
 * entity id is not always known yet: a part is created with its thumbnail in the
 * same insert, so there is no earlier row to compare against. Prefix checking
 * still removes every sensitive namespace, which is what matters.
 *
 * Free function rather than a method on the service: it is pure validation, and
 * hanging it on the S3 client would make every caller depend on that shape.
 */
export function assertObjectKeyInNamespace(
  objectKey: string,
  namespace: string,
  field: string,
): void {
  if (!objectKey.startsWith(namespace)) {
    throw new AppException(ErrorCode.VALIDATION_ERROR, {
      message:
        `${field} must be an object key issued for this asset, starting with "${namespace}". ` +
        'Upload the file through its presign endpoint and send back the key it returns.',
      details: { field, expectedPrefix: namespace },
    });
  }
}

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly cfg: StorageConfig;
  private readonly client: S3Client;

  constructor(config: ConfigService, private readonly cloudinary: CloudinaryService) {
    this.cfg = config.getOrThrow<StorageConfig>('storage');

    this.client = new S3Client({
      region: this.cfg.region,
      endpoint: this.cfg.endpoint,
      forcePathStyle: this.cfg.forcePathStyle,
      credentials: {
        accessKeyId: this.cfg.accessKeyId,
        secretAccessKey: this.cfg.secretAccessKey,
      },
      // R2 does not support the newer streaming checksums the SDK enables by
      // default; without this, multipart-ish uploads fail with 501.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  private bucketName(bucket: Bucket): string {
    // A lookup rather than a ternary: with three buckets a ternary silently
    // routes the unlisted one to the wrong store, which is precisely how
    // Library documents ended up written to `uploads` and read from `media`.
    return this.cfg.buckets[bucket];
  }

  /**
   * Which bucket an object key belongs to.
   *
   * The read path needs this because a signed media URL carries only the key —
   * and deliberately so: the key is already inside the HMAC, so deriving the
   * bucket from it costs nothing and adds no forgeable parameter. Adding a
   * `bucket` query argument would have meant changing the signature contract
   * shared with docs/cloudflare-worker.js, for no gain.
   *
   * Anything that is not a Library key stays on `media`, which is what every
   * caller assumed before this function existed.
   */
  static bucketForKey(objectKey: string): Bucket {
    return objectKey.startsWith('library/') ? 'library' : 'media';
  }

  get isConfigured(): boolean {
    return Boolean(this.cfg.accessKeyId && this.cfg.secretAccessKey);
  }

  // ---------------------------------------------------------------------------
  // Key construction
  // ---------------------------------------------------------------------------

  /**
   * Object keys are structured and opaque. They include a random component so
   * a key cannot be guessed from a course/lesson id, which matters because a
   * leaked presigned URL should not imply the ability to construct sibling
   * URLs.
   */
  static keys = {
    videoSource: (videoId: string, filename: string) =>
      `source/videos/${videoId}/${randomUUID()}${extname(filename).toLowerCase() || '.bin'}`,
    hlsPrefix: (videoId: string) => `hls/${videoId}/`,
    hlsMaster: (videoId: string) => `hls/${videoId}/master.m3u8`,
    hlsRendition: (videoId: string, height: number) =>
      `hls/${videoId}/${height}p/index.m3u8`,
    videoThumbnail: (videoId: string) => `thumbnails/videos/${videoId}.jpg`,
    courseThumbnail: (courseId: string, ext: string) =>
      `thumbnails/courses/${courseId}/${randomUUID()}${ext}`,
    /**
     * Part and library-part thumbnails.
     *
     * Filed under the parent's prefix so a course's or material's images stay
     * together, and each upload gets a fresh UUID rather than overwriting:
     * replacing a thumbnail must not break a URL a client already cached, and
     * the old object is deleted explicitly once the row points at the new one.
     */
    coursePartThumbnail: (courseId: string, partId: string, ext: string) =>
      `thumbnails/courses/${courseId}/parts/${partId}/${randomUUID()}${ext}`,
    libraryPartThumbnail: (materialId: string, partId: string, ext: string) =>
      `thumbnails/library/${materialId}/parts/${partId}/${randomUUID()}${ext}`,
    /** The fallback image applied to library parts that have none of their own. */
    libraryDefaultThumbnail: (ext: string) =>
      `thumbnails/library/_default/${randomUUID()}${ext}`,
    avatar: (userId: string, ext: string) => `avatars/${userId}/${randomUUID()}${ext}`,
    attachment: (courseId: string, filename: string) =>
      `attachments/${courseId}/${randomUUID()}${extname(filename).toLowerCase() || '.bin'}`,
    /**
     * Library documents live in their own namespace, not under a course.
     *
     * The Library is independent of courses in both directions, so filing a
     * paid library document under `attachments/<courseId>/` would tie its
     * lifecycle to a course it has nothing to do with — deleting that course's
     * prefix would take the document with it.
     */
    libraryDocument: (filename: string) =>
      `library/${randomUUID()}${extname(filename).toLowerCase() || '.bin'}`,
    caption: (videoId: string, language: string) =>
      `captions/${videoId}/${language}.vtt`,
  };

  // ---------------------------------------------------------------------------
  // Uploads
  // ---------------------------------------------------------------------------

  /**
   * Issues a presigned PUT so large video files go browser→R2 directly,
   * never through this API. Streaming a 2 GB lecture through Node would tie
   * up a worker for minutes and cap throughput at one upload per process.
   */
  // ---------------------------------------------------------------------------
  // Client-supplied object keys
  // ---------------------------------------------------------------------------

  /** `thumbnails/courses/<courseId>/…` — course and course-part thumbnails. */
  static courseThumbnailPrefix(courseId: string): string {
    return `thumbnails/courses/${courseId}/`;
  }

  /** `thumbnails/library/<materialId>/…` — library part and default thumbnails. */
  static libraryThumbnailPrefix(materialId: string): string {
    return `thumbnails/library/${materialId}/`;
  }

  /** `thumbnails/library/_default/…` — the site-wide fallback image. */
  static LIBRARY_DEFAULT_THUMBNAIL_PREFIX = 'thumbnails/library/_default/';

  /** `library/…` — paid Library documents, which live in their own bucket. */
  static LIBRARY_DOCUMENT_PREFIX = 'library/';

  /** `attachments/<courseId>/…` — course materials. */
  static attachmentPrefix(courseId: string): string {
    return `attachments/${courseId}/`;
  }

  async presignUpload(params: {
    bucket: Bucket;
    objectKey: string;
    contentType: string;
    maxBytes?: number;
    expiresIn?: number;
  }): Promise<SignedUpload> {
    this.assertConfigured();

    const expiresIn = params.expiresIn ?? 3600;

    const command = new PutObjectCommand({
      Bucket: this.bucketName(params.bucket),
      Key: params.objectKey,
      ContentType: params.contentType,
      // Binding the length range would be better, but R2 ignores
      // x-amz-content-length-range; size is verified on completion instead.
    });

    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn });

    return {
      uploadUrl,
      objectKey: params.objectKey,
      expiresIn,
      requiredHeaders: { 'Content-Type': params.contentType },
    };
  }

  /** Server-side upload, used by the transcoding worker for HLS output. */
  async putObject(params: {
    bucket: Bucket;
    objectKey: string;
    body: Buffer | string;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    this.assertConfigured();

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(params.bucket),
        Key: params.objectKey,
        Body: params.body,
        ContentType: params.contentType,
        CacheControl: params.cacheControl ?? 'private, max-age=31536000, immutable',
      }),
    );
  }

  /**
   * Uploads straight from a readable stream, without buffering in memory.
   *
   * Used by the Library's proxied upload: the bytes arrive on the request and
   * go out to R2 as they land, so a 200 MB document costs a socket rather than
   * 200 MB of heap. `contentLength` is required because S3 will not accept a
   * stream of unknown length without falling back to a multipart upload, and
   * the caller already has it from the Content-Length header.
   */
  async putStream(params: {
    bucket: Bucket;
    objectKey: string;
    body: Readable;
    contentLength: number;
    contentType: string;
    cacheControl?: string;
  }): Promise<void> {
    this.assertConfigured();

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(params.bucket),
        Key: params.objectKey,
        Body: params.body,
        ContentLength: params.contentLength,
        ContentType: params.contentType,
        CacheControl: params.cacheControl ?? 'private, max-age=31536000, immutable',
      }),
    );
  }

  /** Streams a local file up without buffering it in memory. */
  async putFile(params: {
    bucket: Bucket;
    objectKey: string;
    filePath: string;
    contentType: string;
    cacheControl?: string;
  }): Promise<{ sizeBytes: number }> {
    this.assertConfigured();

    const info = await stat(params.filePath);

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucketName(params.bucket),
        Key: params.objectKey,
        Body: createReadStream(params.filePath),
        ContentLength: info.size,
        ContentType: params.contentType,
        CacheControl: params.cacheControl ?? 'private, max-age=31536000, immutable',
        Metadata: { originalName: basename(params.filePath) },
      }),
    );

    return { sizeBytes: info.size };
  }

  // ---------------------------------------------------------------------------
  // Downloads
  // ---------------------------------------------------------------------------

  async presignDownload(params: {
    bucket: Bucket;
    objectKey: string;
    expiresIn?: number;
    /** Forces a filename in the browser's save dialog. */
    downloadFilename?: string;
  }): Promise<string> {
    this.assertConfigured();

    const command = new GetObjectCommand({
      Bucket: this.bucketName(params.bucket),
      Key: params.objectKey,
      ...(params.downloadFilename
        ? {
            ResponseContentDisposition: `attachment; filename="${encodeURIComponent(
              params.downloadFilename,
            )}"`,
          }
        : {}),
    });

    return getSignedUrl(this.client, command, { expiresIn: params.expiresIn ?? 300 });
  }

  async getObjectBuffer(bucket: Bucket, objectKey: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }),
    );
    const bytes = await response.Body?.transformToByteArray();
    if (!bytes) throw new AppException(ErrorCode.STORAGE_UNAVAILABLE);
    return Buffer.from(bytes);
  }

  /** Streams an object to a local file without holding it in memory. */
  async downloadToFile(bucket: Bucket, objectKey: string, destination: string): Promise<void> {
    this.assertConfigured();
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }),
    );
    const body = response.Body as NodeJS.ReadableStream | undefined;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
      throw new AppException(ErrorCode.STORAGE_UNAVAILABLE, {
        message: `Could not stream ${objectKey} from storage`,
      });
    }
    await pipeline(body, createWriteStream(destination));
  }

  async exists(bucket: Bucket, objectKey: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }),
      );
      return true;
    } catch {
      return false;
    }
  }

  async objectSize(bucket: Bucket, objectKey: string): Promise<number | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }),
      );
      return head.ContentLength ?? null;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Edge-signed media URLs (protected HLS + attachments)
  // ---------------------------------------------------------------------------

  /**
   * Signs a media path for the CDN edge.
   *
   * The signature covers the path, the expiry AND the viewer identity, so:
   *  - copying the URL to another account fails (uid mismatch);
   *  - copying it to another device fails (did mismatch);
   *  - it stops working at `exp` regardless.
   *
   * `path` must be the object key, not a full URL. The Worker reconstructs the
   * same string and compares HMACs in constant time.
   *
   * Without a CDN, the URL points at this API's own media origin
   * (`GET /playback/media/*`), which re-runs the Worker's checks in Node. That
   * keeps the URL viewer-bound in development instead of degrading to a plain
   * presigned S3 URL, which anyone holding the string could replay.
   */
  async signMediaUrl(params: {
    objectKey: string;
    expiresInSeconds: number;
    userId: string;
    sessionId?: string | null;
    deviceId?: string | null;
    ticketId?: string | null;
    /** Server-enforced quality ceiling; the Worker rejects higher renditions. */
    maxHeight?: number | null;
  }): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + params.expiresInSeconds;

    // Base: the CDN in production, this API's own origin otherwise. Both
    // verify the identical signature, so the URL shape below is the same.
    const base = this.cfg.cdnBaseUrl || this.localOriginBase();

    if (!base) {
      // Neither a CDN nor a local origin. Rather than hand out a presigned S3
      // URL that is not bound to the viewer, refuse: a playback request that
      // cannot be satisfied securely should fail, not degrade silently.
      this.logger.error(
        'No media origin configured: set MEDIA_CDN_BASE_URL (production) or ' +
          'MEDIA_LOCAL_ORIGIN=true with PUBLIC_API_URL (development).',
      );
      throw new AppException(ErrorCode.STORAGE_UNAVAILABLE, {
        message: 'Media delivery is not configured',
      });
    }

    const signature = this.computeMediaSignature({
      objectKey: params.objectKey,
      expiresAt,
      userId: params.userId,
      sessionId: params.sessionId ?? '',
      deviceId: params.deviceId ?? '',
      ticketId: params.ticketId ?? '',
      maxHeight: params.maxHeight ?? 0,
    });

    const url = new URL(params.objectKey, this.ensureTrailingSlash(base));
    url.searchParams.set('exp', String(expiresAt));
    url.searchParams.set('uid', params.userId);
    if (params.sessionId) url.searchParams.set('sid', params.sessionId);
    if (params.deviceId) url.searchParams.set('did', params.deviceId);
    if (params.ticketId) url.searchParams.set('tid', params.ticketId);
    if (params.maxHeight) url.searchParams.set('mh', String(params.maxHeight));
    url.searchParams.set('sig', signature);

    return url.toString();
  }

  /** True when this API is serving media bytes itself. */
  get servesMediaLocally(): boolean {
    return !this.cfg.cdnBaseUrl && this.cfg.localOrigin;
  }

  /**
   * Base URL of this API's own media origin.
   *
   * Returns '' when the local origin is disabled, which makes signMediaUrl
   * refuse rather than fall back to something weaker.
   */
  private localOriginBase(): string {
    if (!this.cfg.localOrigin) return '';
    const api = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
    if (!api) return '';
    const prefix = process.env.API_PREFIX ?? 'api';
    const version = process.env.API_VERSION ?? '1';
    return `${api}/${prefix}/v${version}/playback/media/`;
  }

  /**
   * Recomputes and compares a signature. Exposed so the API can verify
   * requests itself when the CDN is bypassed (local development, or a
   * deployment that proxies media through Node).
   */
  verifyMediaSignature(params: {
    objectKey: string;
    expiresAt: number;
    userId: string;
    sessionId?: string;
    deviceId?: string;
    ticketId?: string;
    maxHeight?: number;
    signature: string;
  }): boolean {
    if (params.expiresAt * 1000 <= Date.now()) return false;

    const expected = this.computeMediaSignature({
      objectKey: params.objectKey,
      expiresAt: params.expiresAt,
      userId: params.userId,
      sessionId: params.sessionId ?? '',
      deviceId: params.deviceId ?? '',
      ticketId: params.ticketId ?? '',
      maxHeight: params.maxHeight ?? 0,
    });

    // Length-safe constant-time comparison.
    if (expected.length !== params.signature.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i += 1) {
      diff |= expected.charCodeAt(i) ^ params.signature.charCodeAt(i);
    }
    return diff === 0;
  }

  private computeMediaSignature(parts: {
    objectKey: string;
    expiresAt: number;
    userId: string;
    sessionId: string;
    deviceId: string;
    ticketId: string;
    maxHeight: number;
  }): string {
    // Field order is part of the contract with the Worker. Newline-joined so
    // no field can be shifted into another ("a|b" vs "a" + "|b" ambiguity).
    const canonical = [
      parts.objectKey,
      parts.expiresAt,
      parts.userId,
      parts.sessionId,
      parts.deviceId,
      parts.ticketId,
      parts.maxHeight,
    ].join('\n');

    return createHmac('sha256', this.cfg.signingKey).update(canonical).digest('base64url');
  }

  /**
   * Public-ish URL for non-sensitive assets (avatars, video thumbnails).
   *
   * R2 keys are still signed here, with a long expiry and no viewer binding — a
   * leaked URL is not a security event. Note that with a CDN configured this
   * builds an *unsigned* URL to the media gate, which answers 403 `unsigned`;
   * that branch only works when no CDN is set. Course images no longer rely on
   * it at all, which is the reason they moved to Cloudinary.
   */
  async publicAssetUrl(objectKey: string | null): Promise<string | null> {
    if (!objectKey) return null;

    // Course images live in Cloudinary and are public there, so their delivery
    // URL is returned untouched. Everything below builds an R2 URL and has
    // nothing to say about a key from another provider.
    const cloudinaryUrl = this.cloudinary.resolveStoredKey(objectKey);
    if (cloudinaryUrl) return cloudinaryUrl;

    if (this.cfg.cdnBaseUrl) {
      return new URL(objectKey, this.ensureTrailingSlash(this.cfg.cdnBaseUrl)).toString();
    }

    if (!this.isConfigured) return null;

    return this.presignDownload({
      bucket: 'media',
      objectKey,
      expiresIn: 24 * 3600,
    });
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  async deleteObject(bucket: Bucket, objectKey: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }))
      .catch((e) => this.logger.warn(`delete failed for ${objectKey}: ${e.message}`));
  }

  /** Removes an entire prefix — used when a video's HLS output is replaced. */
  async deletePrefix(bucket: Bucket, prefix: string): Promise<number> {
    let removed = 0;
    let token: string | undefined;

    do {
      const listing = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucketName(bucket),
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );

      const objects = (listing.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k));

      if (objects.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucketName(bucket),
            Delete: { Objects: objects.map((Key) => ({ Key })) },
          }),
        );
        removed += objects.length;
      }

      token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
    } while (token);

    return removed;
  }

  async health(): Promise<boolean> {
    if (!this.isConfigured) return false;
    try {
      await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucketName('media'), MaxKeys: 1 }),
      );
      return true;
    } catch {
      return false;
    }
  }

  private assertConfigured(): void {
    if (!this.isConfigured) {
      throw new AppException(ErrorCode.STORAGE_UNAVAILABLE, {
        message: 'Object storage credentials are not configured (see R2_* env vars)',
      });
    }
  }

  private ensureTrailingSlash(url: string): string {
    return url.endsWith('/') ? url : `${url}/`;
  }
}
