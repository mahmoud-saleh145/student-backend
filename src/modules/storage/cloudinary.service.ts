import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v2 as cloudinarySdk, type UploadApiResponse } from 'cloudinary';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Cloudinary, for the one asset class that is public by design.
 *
 * Course thumbnails were the odd one out in the storage architecture. Everything
 * else in R2 is private and served through the edge gate, which refuses any
 * request without a viewer-bound signature — deliberately, because it is
 * protecting paid video and paid documents. A course thumbnail is the opposite:
 * it sits on a catalogue card that signed-out visitors load.
 *
 * That mismatch is why they displayed as broken. `publicAssetUrl` mints an
 * unsigned URL when a CDN is configured, and the gate answers `403` with
 * `x-deny-reason: unsigned` (docs/cloudflare-worker.js:127). The upload
 * succeeded because uploads go straight to R2 with bucket credentials; only the
 * read was refused. Neither signature nor DRM nor a viewer binding means
 * anything for a public image, so the asset left the signed pipeline entirely.
 *
 * What is stored is the **public ID**, not the delivery URL. A column called
 * `thumbnailKey` holding a URL would be a different convention from every other
 * object in this codebase, and Cloudinary's main advantage is that a delivery
 * URL is derived: the same public ID can serve a different size or format later
 * without a migration or a rewrite. The provider is carried in the key itself
 * (`cloudinary:`) so `publicAssetUrl` can tell the two worlds apart without
 * guessing, and so a folder rename cannot orphan what is already stored.
 */

/** Marks a stored object key as living in Cloudinary rather than R2. */
export const CLOUDINARY_KEY_PREFIX = 'cloudinary:';

export interface CloudinaryConfig {
  enabled: boolean;
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  coursesFolder: string;
}

/** What the upload route returns to the dashboard, and what it stores. */
export interface CourseThumbnailUpload {
  /** What goes in `Course.thumbnailKey`. */
  objectKey: string;
  /** Public https URL, for callers that want to render without a second call. */
  url: string;
}

@Injectable()
export class CloudinaryService {
  private readonly logger = new Logger(CloudinaryService.name);
  private readonly cfg: CloudinaryConfig;

  constructor(config: ConfigService) {
    this.cfg = config.getOrThrow<CloudinaryConfig>('cloudinary');

    // Configured once at boot rather than per upload: the SDK is a module-level
    // singleton, and leaving it unset between calls is how a second test or a
    // second tenant ends up uploading to the wrong cloud.
    if (this.cfg.enabled) {
      cloudinarySdk.config({
        cloud_name: this.cfg.cloudName,
        api_key: this.cfg.apiKey,
        api_secret: this.cfg.apiSecret,
        secure: true,
      });
    }
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  /**
   * Folder every course image is minted into, e.g. `courses`.
   *
   * Exposed because the delete path has to confirm an asset belongs to the
   * course being edited before destroying it, and reaching into the service's
   * private config to do that would be worse than a getter.
   */
  get coursesFolder(): string {
    return this.cfg.coursesFolder;
  }

  /**
   * The stored key for a course thumbnail's public ID.
   *
   * Exported as a function rather than inlined because the write path and the
   * read path must agree on the format exactly.
   */
  static keyFor(publicId: string): string {
    return `${CLOUDINARY_KEY_PREFIX}${publicId}`;
  }

  /** True when a stored object key names a Cloudinary asset. */
  static isCloudinaryKey(objectKey: string): boolean {
    return objectKey.startsWith(CLOUDINARY_KEY_PREFIX);
  }

  /** The public ID back out of a stored key. */
  static publicIdFrom(objectKey: string): string | null {
    return CloudinaryService.isCloudinaryKey(objectKey)
      ? objectKey.slice(CLOUDINARY_KEY_PREFIX.length)
      : null;
  }

  /**
   * The public delivery URL for a public ID.
   *
   * `f_auto,q_auto` are the two transformations that matter here and neither
   * changes bytes on disk: `f_auto` serves WebP or AVIF to clients that ask for
   * them at the original URL, and `q_auto` picks a quality per request. A
   * thumbnail is exactly the asset class these were built for, and leaving them
   * off is how a 3 MB phone photo becomes a 3 MB catalogue card.
   *
   * Deliberately NOT signed: an unsigned delivery URL is the entire reason this
   * asset left R2.
   */
  deliveryUrl(publicId: string): string {
    return cloudinarySdk.url(publicId, {
      resource_type: 'image',
      secure: true,
      transformation: [{ fetch_format: 'auto', quality: 'auto' }],
    });
  }

  /** Resolves a stored `Course.thumbnailKey` to something an `<img>` can load. */
  resolveStoredKey(objectKey: string | null | undefined): string | null {
    if (!objectKey) return null;
    const publicId = CloudinaryService.publicIdFrom(objectKey);
    return publicId ? this.deliveryUrl(publicId) : null;
  }

  /**
   * Uploads one course thumbnail.
   *
   * The body arrives as a Buffer rather than a stream. These are capped at
   * 10 MB by the route's `requireLength`, and Cloudinary's upload API wants the
   * complete payload to decide a format anyway — so buffering here costs a
   * bounded amount and buys a much simpler, fully testable call. Streaming a
   * 10 MB image would be optimising the wrong thing.
   *
   * The public ID is minted per upload, exactly as the R2 key used to be, so
   * replacing an image cannot invalidate a URL a client already cached. The old
   * asset is then deleted explicitly by the caller — there is no lifecycle rule
   * to collect it.
   */
  async uploadCourseThumbnail(params: {
    courseId: string;
    body: Buffer;
    contentType: string;
  }): Promise<CourseThumbnailUpload> {
    if (!this.cfg.enabled) {
      throw AppException.validation({
        file: ['course images are not configured on this deployment'],
      });
    }

    // Relative to `folder`, which Cloudinary prepends itself. Passing both an
    // absolute public_id *and* a folder is how you get `courses/courses/…`.
    const publicId = `${params.courseId}/${randomUUID()}`;

    let result: UploadApiResponse;
    try {
      // `upload_stream` rather than `upload(buffer)`: the typed overloads only
      // accept a path or a data URI, and piping a Buffer through a stream is
      // both the documented shape and the one that cannot be defeated by a
      // buffer large enough to matter.
      result = await new Promise<UploadApiResponse>((resolve, reject) => {
        const stream = cloudinarySdk.uploader.upload_stream(
          {
            public_id: publicId,
            resource_type: 'image',
            folder: this.cfg.coursesFolder,
            // The public ID already carries a fresh UUID, so nothing is
            // overwritten and a cached URL keeps resolving.
            overwrite: false,
            type: 'upload',
          },
          (error, uploaded) => {
            if (error) reject(error as Error);
            else if (uploaded) resolve(uploaded);
            else reject(new Error('Cloudinary returned no result'));
          },
        );

        Readable.from(params.body).pipe(stream);
      });
    } catch (error) {
      // The SDK's own error carries the HTTP status. Cloudinary answers 401 for
      // bad credentials, which is the misconfiguration most likely to be
      // encountered here and the one worth naming.
      const status = (error as { http_code?: number }).http_code;
      this.logger.error(`Cloudinary upload failed (${status ?? 'no status'})`);
      throw new AppException(ErrorCode.STORAGE_UNAVAILABLE, {
        message:
          status === 401 || status === 403
            ? 'Image storage rejected the request: check the Cloudinary credentials'
            : 'The image could not be stored',
      });
    }

    // Cloudinary returns the public ID *including* the folder it prepended. The
    // fallback has to match that shape or a response without `public_id` would
    // store a key that resolves to nothing.
    const storedPublicId = result.public_id ?? `${this.cfg.coursesFolder}/${publicId}`;

    return {
      objectKey: CloudinaryService.keyFor(storedPublicId),
      url: result.secure_url ?? this.deliveryUrl(storedPublicId),
    };
  }

  /**
   * Removes an asset when a thumbnail is replaced or cleared.
   *
   * Best-effort, like every other cleanup in this codebase: the row has already
   * moved, so a failure here is an orphaned asset, never a lost one.
   *
   * Only ever called for a key in this provider's namespace — see
   * `isCloudinaryKey` at the call site — so this can never be pointed at an R2
   * object key or, worse, at a paid video path.
   */
  async deleteByKey(objectKey: string | null | undefined): Promise<void> {
    const publicId = CloudinaryService.publicIdFrom(objectKey ?? '');
    if (!publicId || !this.cfg.enabled) return;

    // `invalidate: true` drops the asset and its derived renditions. Without it
    // Cloudinary keeps the derivatives and only forgets the original.
    await cloudinarySdk.uploader
      .destroy(publicId, { resource_type: 'image', invalidate: true })
      .catch((error: unknown) => {
        this.logger.warn(
          `Cloudinary delete failed for ${publicId}: ${(error as Error).message}`,
        );
      });
  }
}
