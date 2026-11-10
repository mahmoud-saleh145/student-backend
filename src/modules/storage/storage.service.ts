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
 *  - `media`    — HLS renditions, thumbnails, avatars, captions, AND course
 *                 attachments. Fronted by the Cloudflare Worker and subject to
 *                 the whole protected-media delivery path.
 *  - `uploads`  — raw source files a client hands us before processing (video
 *                 originals). Never served directly.
 *  - `library`  — Library documents. Separate so that paid PDFs do not consume
 *                 the capacity budgeted for protected video, and so the two can
 *                 be sized, priced and lifecycle-managed independently.
 *
 * Attachments belong in `media`, not `uploads`. Every reader resolves them
 * through `bucketForKey`, which sends anything that is not `library/` to the
 * media store — the Worker's key-prefix switch and MediaOriginController:161
 * agree. An attachment written to `uploads` was looked up in `edu-media`, never
 * found, and served as `404 x-deny-reason: not_found` behind a perfectly valid
 * signature. This bullet used to list them under `uploads`, which is what let
 * the write path drift away from every reader.
 */
export type Bucket = 'media' | 'uploads' | 'library';

/**
 * The ceiling for a Library document and for a course material alike.
 *
 * Defined here rather than in the controller so the gate that SIZES an upload
 * and the gate that ACCEPTS one cannot drift apart. `presignUpload` binds only
 * `host` into its signature — no length, and R2 ignores
 * `x-amz-content-length-range` — so a `sizeBytes` in a request body is a claim,
 * not a measurement. The measurement happens here, at registration.
 *
 * Unchanged at 200 MB. This constant exists to make the existing limit shared,
 * not to lower it.
 */
export const MAX_DOCUMENT_BYTES = 200 * 1024 * 1024;

/**
 * Ceiling for every image upload (course, part and library thumbnails, the
 * library cover, the library default). Shared by the upload routes that read
 * it from Content-Length and by the registration checks that HEAD the object.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Namespaces the public asset route (`GET /assets/*`) serves without a
 * signature: images that are public by design. Everything else in the media
 * bucket — HLS renditions, captions, source uploads, video poster frames —
 * stays behind the signed media gate. An allow-list, so a new namespace is
 * private until someone decides otherwise.
 */
export const PUBLIC_ASSET_PREFIXES = [
  'thumbnails/courses/',
  'thumbnails/library/',
  'avatars/',
] as const;

export function isPublicAssetKey(objectKey: string): boolean {
  if (!objectKey || objectKey.includes('..') || objectKey.startsWith('/')) return false;
  return PUBLIC_ASSET_PREFIXES.some((prefix) => objectKey.startsWith(prefix));
}

/** What the public asset route needs to answer one GET. */
export interface StoredObject {
  body: Buffer;
  contentType: string | null;
  etag: string | null;
}

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
    /** The material's own cover, which its parts inherit when they have none. */
    libraryCover: (materialId: string, ext: string) =>
      `thumbnails/library/${materialId}/cover/${randomUUID()}${ext}`,
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

  /** `thumbnails/library/<materialId>/…` — library part thumbnails and the cover. */
  static libraryThumbnailPrefix(materialId: string): string {
    return `thumbnails/library/${materialId}/`;
  }

  /** `thumbnails/library/<materialId>/cover/…` — only the material's cover. */
  static libraryCoverPrefix(materialId: string): string {
    return `thumbnails/library/${materialId}/cover/`;
  }

  /**
   * `thumbnails/library/…` — every library image. The widest namespace a
   * material cover may be registered under, used only when the material has no
   * id yet (creation); an edit checks the per-material prefix.
   */
  static LIBRARY_THUMBNAIL_ROOT = 'thumbnails/library/';

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

  /**
   * A short-lived, server-to-server read URL for ONE private object.
   *
   * Deliberately not `signMediaUrl`. That produces a *viewer-bound* CDN URL
   * carrying `uid`/`sid`/`tid` and verified by the edge Worker
   * (docs/cloudflare-worker.js) - correct for a student streaming a lesson,
   * wrong for a third-party transcoder fetching an original.
   *
   * The Worker denies the source namespace outright ("never serve the source
   * upload, whatever the signature says", cloudflare-worker.js:112-117), so
   * handing it a `source/videos/...` URL means handing the transcoder a URL the
   * edge is designed to refuse. That is why asset creation succeeded and then
   * failed immediately with ERR_ASSET_NOT_FOUND: Gumlet could not fetch the
   * input at all, and no encoding was ever attempted.
   *
   * This is a plain SigV4 presign straight at the private bucket. It grants
   * read on exactly one key, expires, and never touches the CDN. Nothing
   * becomes public, no viewer rule is weakened, and the `/source/` deny rule
   * stays exactly as it is.
   */
  async presignIngestionUrl(params: {
    bucket: Bucket;
    objectKey: string;
    expiresIn?: number;
  }): Promise<string> {
    this.assertConfigured();

    const expiresIn = params.expiresIn ?? 3600;

    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucketName(params.bucket), Key: params.objectKey }),
      { expiresIn },
    );
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

  /**
   * The object's ACTUAL size, refusing anything that is missing or too large.
   *
   * Exists because a presigned PUT cannot enforce a ceiling on its own.
   * `presignUpload` signs `host` and nothing else; R2 does not honour
   * `x-amz-content-length-range`; so a client may declare any `sizeBytes` it
   * likes, upload whatever it actually has, and register the object. The
   * registration DTOs cap `sizeBytes` at `@Min(0)` and cannot catch that,
   * because the number they are checking is the attacker's own.
   *
   * So the size is read back from storage with a HEAD, which is the only value
   * nobody supplied. That number is what callers must persist.
   *
   * Fails closed. `objectSize` returns `null` both for "no such object" and
   * for "storage did not answer" — the two are indistinguishable from here —
   * and treating an unverifiable upload as valid is the same failure as
   * trusting the declared size. So `null` refuses rather than registers.
   *
   * @param bucket the bucket the object was WRITTEN to, not one inferred from
   *   the key. Reading the wrong bucket reports a missing object and turns a
   *   legitimate upload into a 5xx, so callers pass the write site's bucket.
   */
  async assertUploadWithinLimit(params: {
    bucket: Bucket;
    objectKey: string;
    maxBytes: number;
    /** The request field to blame, so the error lands where the client looks. */
    field?: string;
  }): Promise<number> {
    const size = await this.objectSize(params.bucket, params.objectKey);

    if (size === null) {
      throw new AppException(ErrorCode.UPLOAD_FAILED, {
        message:
          'The uploaded file could not be found in storage. It may have failed to ' +
          'upload, or storage could not be reached. Try the upload again.',
        fields: params.field ? { [params.field]: ['not found in storage'] } : undefined,
      });
    }

    if (size > params.maxBytes) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        message: `The uploaded file is larger than the ${params.maxBytes / 1024 / 1024} MB limit.`,
        fields: params.field
          ? { [params.field]: [`the uploaded file is ${size} bytes, over the ${params.maxBytes} byte limit`] }
          : undefined,
      });
    }

    return size;
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
   * The URL of a public image, built without touching storage.
   *
   * Public images (`PUBLIC_ASSET_PREFIXES`) are served by this API's own
   * `GET /assets/<key>` route, which reads the media bucket with the bucket
   * credentials. That is deliberately NOT the media gate: the gate refuses
   * anything unsigned (`403 unsigned`) and, for a plain `<img>` that sends no
   * Origin, answers with `cross-origin-resource-policy: same-site`, which the
   * dashboard's browser then blocks. Every R2 thumbnail, cover and avatar used
   * to be handed out as an unsigned gate URL, which is why none of them ever
   * rendered in production; course images escaped only by moving to
   * Cloudinary.
   *
   * Synchronous and static so serialisers without a StorageService instance
   * (user rows, course cards) can resolve a stored key the same way. Returns
   * null for a key outside the public namespaces, or when `PUBLIC_API_URL` is
   * not set, so callers fall through to their own fallback.
   */
  static publicAssetUrlSync(objectKey: string | null | undefined): string | null {
    if (!objectKey || !isPublicAssetKey(objectKey)) return null;
    const api = (process.env.PUBLIC_API_URL ?? '').replace(/\/+$/, '');
    if (!api) return null;
    const prefix = process.env.API_PREFIX ?? 'api';
    const version = process.env.API_VERSION ?? '1';
    return `${api}/${prefix}/v${version}/assets/${objectKey.split('/').map(encodeURIComponent).join('/')}`;
  }

  /**
   * A stored avatar is either a full URL (legacy, or an external picture) or
   * an `avatars/…` key from `POST /storage/uploads/avatar`. A key is resolved
   * to the public asset route; anything that is neither is not an image.
   */
  static resolveAvatarUrl(stored: string | null | undefined): string | null {
    if (!stored) return null;
    if (/^https?:\/\//i.test(stored)) return stored;
    return StorageService.publicAssetUrlSync(stored);
  }

  /**
   * Public URL for a non-sensitive image (thumbnails, covers, avatars).
   *
   * Resolution order: a Cloudinary key is returned as its delivery URL; a key
   * in a public namespace becomes a `GET /assets/<key>` URL on this API (see
   * `publicAssetUrlSync`); anything else keeps the historical behaviour — an
   * unsigned CDN URL when a CDN is configured (which the gate refuses, so no
   * caller should reach it with a new key), else a 24-hour presigned read.
   */
  async publicAssetUrl(objectKey: string | null): Promise<string | null> {
    if (!objectKey) return null;

    // Course images live in Cloudinary and are public there, so their delivery
    // URL is returned untouched. Everything below builds an R2 URL and has
    // nothing to say about a key from another provider.
    const cloudinaryUrl = this.cloudinary.resolveStoredKey(objectKey);
    if (cloudinaryUrl) return cloudinaryUrl;

    const publicUrl = StorageService.publicAssetUrlSync(objectKey);
    if (publicUrl) return publicUrl;

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

  /**
   * One whole object for the public asset route, or null when it does not
   * exist. Images are capped at `MAX_IMAGE_BYTES` on the way in, so holding
   * one in memory is bounded; anything larger is refused rather than streamed,
   * because nothing that large belongs in a public namespace.
   */
  async getPublicObject(bucket: Bucket, objectKey: string): Promise<StoredObject | null> {
    this.assertConfigured();
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }),
      );
      if ((response.ContentLength ?? 0) > MAX_IMAGE_BYTES) {
        throw new AppException(ErrorCode.NOT_FOUND, { message: 'asset_too_large' });
      }
      const bytes = await response.Body?.transformToByteArray();
      if (!bytes) return null;
      return {
        body: Buffer.from(bytes),
        contentType: response.ContentType ?? null,
        etag: response.ETag ?? null,
      };
    } catch (error) {
      if (error instanceof AppException) throw error;
      const name = (error as { name?: string }).name;
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
        ?.httpStatusCode;
      if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return null;
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Deletion
  // ---------------------------------------------------------------------------

  async deleteObject(bucket: Bucket, objectKey: string): Promise<void> {
    await this.client
      .send(new DeleteObjectCommand({ Bucket: this.bucketName(bucket), Key: objectKey }))
      .catch((e) => this.logger.warn(`delete failed for ${objectKey}: ${e.message}`));
  }

  /**
   * Remove every source object of ONE video except the one that is current.
   *
   * WHY THIS EXISTS
   * ---------------
   * Every upload attempt mints a FRESH object key (`videoSource` embeds a
   * random UUID) and points the row at it. A retried upload therefore leaves
   * the previous attempt's object behind, unreferenced by the database and
   * invisible to every other reader of the bucket. For an 8 GB lecture that is
   * 8 GB of somebody's money, per retry.
   *
   * The objects that accumulate are exactly the ones a FAILED attempt left
   * behind - the very case this whole flow has to survive. An upload that
   * fails after the bytes landed (Cloudflare R2 answers a committed PUT with
   * `InternalError`/500 - it documents that code as "retry the request") used
   * to leave the file in the bucket AND the row pointing at nothing, because
   * the client never got to call `complete`.
   *
   * WHY IT IS SAFE
   * --------------
   * The scope is the video's OWN prefix, `source/videos/<videoId>/`, and the
   * key that is being kept is passed in. Nothing outside that prefix is
   * touched, no other video's source is reachable from here, and the object
   * that the row currently points at is explicitly preserved.
   *
   * The caller runs this only once the CURRENT object has been confirmed in
   * storage, so the file that survives is the one that is about to be
   * processed.
   *
   * @returns the keys that were removed, for the server-side log.
   */
  async pruneSupersededSources(videoId: string, keepObjectKey: string): Promise<string[]> {
    this.assertConfigured();

    const bucket = this.bucketName('uploads');
    const prefix = `source/videos/${videoId}/`;
    const removed: string[] = [];
    let token: string | undefined;

    do {
      const listing = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );

      const stale = (listing.Contents ?? [])
        .map((o) => o.Key)
        .filter((key): key is string => Boolean(key) && key !== keepObjectKey);

      if (stale.length > 0) {
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: stale.map((Key) => ({ Key })) },
          }),
        );
        removed.push(...stale);
      }

      token = listing.IsTruncated ? listing.NextContinuationToken : undefined;
    } while (token);

    if (removed.length > 0) {
      this.logger.log(
        `pruned ${removed.length} superseded source object(s) for video ${videoId}, keeping ${keepObjectKey}`,
      );
    }

    return removed;
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
