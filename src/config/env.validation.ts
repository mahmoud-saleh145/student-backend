import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Staging = 'staging',
  Production = 'production',
  Test = 'test',
}

const toBool = () =>
  Transform(({ value }) => value === true || value === 'true' || value === '1');

/**
 * Boot-time environment contract.
 *
 * The process refuses to start when this fails. That is deliberate: a backend
 * that silently boots with a missing signing secret or a default password is a
 * far worse outcome than a crash at deploy time.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  @IsString()
  API_PREFIX = 'api';

  @IsString()
  API_VERSION = '1';

  @IsString()
  PUBLIC_API_URL = 'http://localhost:3000';

  @IsString()
  CORS_ORIGINS = '';

  @toBool()
  @IsBoolean()
  TRUST_PROXY = false;

  // --- database -------------------------------------------------------------
  @IsString()
  @MinLength(10)
  DATABASE_URL!: string;

  /// Migrations only — see the `directUrl` note in prisma/schema.prisma.
  ///
  /// Optional here on purpose: the API process itself never dials it, so a
  /// runtime-only deployment should not be forced to carry a credential it does
  /// not use. Prisma's CLI still requires it wherever migrations run.
  @IsOptional()
  @IsString()
  @MinLength(10)
  DIRECT_URL?: string;

  @IsOptional()
  @IsString()
  DATABASE_REPLICA_URL?: string;

  // --- redis ----------------------------------------------------------------
  @IsString()
  REDIS_URL = 'redis://localhost:6379';

  @IsString()
  REDIS_PREFIX = 'edu';

  // --- auth -----------------------------------------------------------------
  @IsString()
  @MinLength(32, { message: 'JWT_ACCESS_SECRET must be at least 32 characters' })
  JWT_ACCESS_SECRET!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_REFRESH_SECRET must be at least 32 characters' })
  JWT_REFRESH_SECRET!: string;

  @IsString()
  @MinLength(32, { message: 'JWT_PLAYBACK_SECRET must be at least 32 characters' })
  JWT_PLAYBACK_SECRET!: string;

  @Type(() => Number) @IsInt() @Min(60) JWT_ACCESS_TTL = 900;
  @Type(() => Number) @IsInt() @Min(2592000) JWT_REFRESH_TTL = 2592000;
  @Type(() => Number) @IsInt() @Min(0) @Max(300) JWT_REFRESH_REUSE_GRACE_SECONDS = 30;
  @IsString() JWT_ISSUER = 'edu-platform';
  @IsString() JWT_AUDIENCE = 'edu-mobile';

  @Type(() => Number) @IsInt() @Min(8192) ARGON_MEMORY_COST = 19456;
  @Type(() => Number) @IsInt() @Min(1) ARGON_TIME_COST = 2;
  @Type(() => Number) @IsInt() @Min(1) ARGON_PARALLELISM = 1;

  // --- device binding -------------------------------------------------------
  @Type(() => Number) @IsInt() @Min(1) @Max(10) DEVICE_LIMIT_PER_STUDENT = 1;
  @toBool() @IsBoolean() DEVICE_AUTO_BIND_FIRST = true;
  @toBool() @IsBoolean() DEVICE_BLOCK_ON_INTEGRITY_FAILURE = true;

  // --- playback -------------------------------------------------------------
  @Type(() => Number) @IsInt() @Min(30) @Max(3600) PLAYBACK_TICKET_TTL = 300;
  @Type(() => Number) @IsInt() @Min(5) PLAYBACK_HEARTBEAT_INTERVAL = 30;
  @Type(() => Number) @IsInt() @Min(15) PLAYBACK_HEARTBEAT_GRACE = 90;
  @Type(() => Number) @IsInt() @Min(1) @Max(10) PLAYBACK_MAX_CONCURRENT_STREAMS = 1;
  @Type(() => Number) @IsInt() @Min(1) PLAYBACK_TICKETS_PER_HOUR = 60;
  @Type(() => Number) @IsInt() @Min(1) PLAYBACK_CAPTURE_STRIKES = 3;

  // Read by config/configuration.ts. All three are anti-abuse rules, so the
  // client is never trusted with them; they were previously undeclared, which
  // meant `num()` silently swallowed a malformed value and used the default.
  @Type(() => Number) @IsInt() @Min(1) @Max(100) PLAYBACK_MAX_PLAYS_PER_VIDEO = 3;
  @Type(() => Number) @IsInt() @Min(0) @Max(86400) PLAYBACK_MIN_COUNTED_PLAY_SECONDS = 30;
  @Type(() => Number) @IsInt() @Min(60) @Max(86400) PLAYBACK_PLAY_RESUME_WINDOW = 45 * 60;

  // --- storage --------------------------------------------------------------
  @IsOptional() @IsString() R2_ACCOUNT_ID?: string;
  @IsOptional() @IsString() R2_ACCESS_KEY_ID?: string;
  @IsOptional() @IsString() R2_SECRET_ACCESS_KEY?: string;
  @IsString() R2_BUCKET_MEDIA = 'edu-media-dev';
  @IsString() R2_BUCKET_UPLOADS = 'edu-uploads-dev';
  /** Separate store for Library documents — see storageConfig.buckets. */
  @IsOptional() @IsString() R2_BUCKET_LIBRARY?: string;
  @IsString() R2_REGION = 'auto';
  @IsOptional() @IsString() R2_ENDPOINT?: string;

  @IsOptional() @IsString() MEDIA_CDN_BASE_URL?: string;

  // --- Cloudinary (course thumbnails) ---------------------------------------
  //
  // Course thumbnails are the one asset class that is public by design: they
  // appear on catalogue cards for signed-out visitors, so they want a plain
  // public https URL rather than the viewer-bound signed media above. They used
  // to live in R2, which cannot serve them — the media gate answers 403
  // `unsigned` to anything without a signature, and a signature means nothing
  // for a public image. Hence Cloudinary.
  //
  // All three are required together and optional as a set: absent, the
  // Cloudinary feature reports itself unconfigured and course thumbnails fall
  // back to R2 rather than crashing at boot. Never log the secret.
  @IsOptional() @IsString() CLOUDINARY_CLOUD_NAME?: string;
  @IsOptional() @IsString() CLOUDINARY_API_KEY?: string;
  @IsOptional() @IsString() CLOUDINARY_API_SECRET?: string;
  /**
   * Folder every course thumbnail is filed under. Defaults to
   * `courses`; changing it does not move assets already uploaded.
   */
  @IsOptional() @IsString() CLOUDINARY_COURSES_FOLDER = 'courses';

  /**
   * Serve media from this API instead of a CDN. See storageConfig.localOrigin.
   * Defaults on in non-production when no CDN is configured.
   */
  @toBool() @IsBoolean() @IsOptional() MEDIA_LOCAL_ORIGIN?: boolean;

  @IsString()
  @MinLength(32, { message: 'MEDIA_SIGNING_KEY must be at least 32 characters' })
  MEDIA_SIGNING_KEY!: string;

  // --- video processing -----------------------------------------------------
  @IsString() FFMPEG_PATH = 'ffmpeg';
  @IsString() FFPROBE_PATH = 'ffprobe';
  @IsString() TRANSCODE_WORK_DIR = '/tmp/edu-transcode';
  @IsString() TRANSCODE_LADDER = '360,480,720,1080';
  @Type(() => Number) @IsInt() @Min(2) @Max(20) HLS_SEGMENT_SECONDS = 6;
  @toBool() @IsBoolean() HLS_ENCRYPTION_ENABLED = true;

  @IsString()
  @MinLength(32, { message: 'HLS_KEY_ROOT must be at least 32 characters' })
  HLS_KEY_ROOT!: string;

  // --- DRM ------------------------------------------------------------------
  @toBool() @IsBoolean() DRM_ENABLED = false;
  @IsOptional() @IsString() DRM_WIDEVINE_LICENSE_URL?: string;
  @IsOptional() @IsString() DRM_FAIRPLAY_LICENSE_URL?: string;
  @IsOptional() @IsString() DRM_FAIRPLAY_CERT_URL?: string;
  @IsOptional() @IsString() DRM_PROVIDER_TOKEN?: string;
  @IsIn(['none', 'gumlet']) DRM_PROVIDER = 'none';

  // --- Gumlet DRM -----------------------------------------------------------
  // Required only when DRM_PROVIDER=gumlet. Names only here; values are supplied
  // by the operator and are never printed or returned to any client.
  @IsOptional() @IsString() GUMLET_API_KEY?: string;
  @IsOptional() @IsString() GUMLET_WORKSPACE_ID?: string;
  @IsOptional() @IsString() GUMLET_ORG_ID?: string;
  @IsOptional() @IsString() GUMLET_SIGN_SECRET?: string;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(3600)
  GUMLET_TOKEN_LIFETIME_SECONDS = 300;
  /** Comma-separated renditions to request for ABR assets, e.g. 720p,1080p. */
  @IsOptional() @IsString() GUMLET_RESOLUTIONS?: string;

  // --- payments -------------------------------------------------------------
  @IsString() PAYMENT_PROVIDER = 'none';
  @IsString() PAYMENT_CURRENCY = 'EGP';
  @IsString() PAYMENT_RETURN_URL = 'eduplatform://payment/return';
  @IsOptional() @IsString() PAYMOB_API_KEY?: string;
  @IsOptional() @IsString() PAYMOB_INTEGRATION_ID?: string;
  @IsOptional() @IsString() PAYMOB_IFRAME_ID?: string;
  @IsOptional() @IsString() PAYMOB_HMAC_SECRET?: string;
  @IsOptional() @IsString() STRIPE_SECRET_KEY?: string;
  @IsOptional() @IsString() STRIPE_WEBHOOK_SECRET?: string;

  // --- push -----------------------------------------------------------------
  @IsString() PUSH_PROVIDER = 'expo';
  @IsOptional() @IsString() EXPO_ACCESS_TOKEN?: string;

  /**
   * Active push tokens kept per account.
   *
   * Registration is otherwise unbounded, and every send fans out over the whole
   * active set: a single account holding thousands of tokens turns one
   * announcement into thousands of Expo messages, paid for by us and capped by
   * Expo's own rate limit. One token per real handset is the honest number; the
   * slack covers a reinstall that has not yet reaped its predecessor.
   */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  PUSH_MAX_ACTIVE_TOKENS_PER_USER = 8;

  // --- throttling -----------------------------------------------------------
  @Type(() => Number) @IsInt() @Min(1) THROTTLE_TTL = 60;
  @Type(() => Number) @IsInt() @Min(1) THROTTLE_LIMIT = 120;
  @Type(() => Number) @IsInt() @Min(1) THROTTLE_AUTH_LIMIT = 10;

  // --- observability --------------------------------------------------------
  @IsString() LOG_LEVEL = 'info';
  @toBool() @IsBoolean() LOG_PRETTY = false;
  @IsOptional() @IsString() SENTRY_DSN?: string;

  // --- queue polling ---------------------------------------------------------
  //
  // Read from jobs/queue.tuning.ts at module scope, which is why they cannot
  // come from ConfigService. Each helper there falls back to a default on a
  // value it cannot parse, so before this existed `QUEUE_DRAIN_DELAY_SECONDS=30s`
  // became 30 and the operator learned nothing until the Redis request bill
  // proved the setting had been ignored. Declared here, it is a boot failure.
  @Type(() => Number) @IsInt() @Min(1) @Max(3600) QUEUE_DRAIN_DELAY_SECONDS = 30;
  @Type(() => Number) @IsInt() @Min(1) @Max(3600) QUEUE_STALLED_INTERVAL_SECONDS = 60;
  @Type(() => Number) @IsInt() @Min(1) @Max(3600) QUEUE_BACKGROUND_DRAIN_DELAY_SECONDS = 60;
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(86400)
  QUEUE_BACKGROUND_STALLED_INTERVAL_SECONDS = 300;

  // --- process topology -----------------------------------------------------
  //
  // Not operator knobs in the usual sense: worker.ts sets RUN_WORKERS itself
  // before the module graph loads, because jobs.module.ts reads it to decide
  // whether to register the BullMQ processors. Declared so that a stray value
  // from the hosting platform's environment cannot quietly register a second
  // set of processors on the API and double-execute jobs.
  @IsIn(['true', 'false'])
  RUN_WORKERS = 'false';

  /**
   * Swagger is off in production unless this is exactly 'true'. Left as a
   * string comparison in main.ts so the opt-in cannot be widened by a truthy
   * value like `1`.
   */
  @IsIn(['true', 'false'])
  ENABLE_SWAGGER = 'false';

  // --- maintenance schedules ------------------------------------------------
  @IsString()
  @Matches(/^\S+(\s+\S+){4,5}$/, {
    message:
      'ANNOUNCEMENT_SWEEP_CRON must be a 5- or 6-field cron expression, e.g. "* * * * *"',
  })
  ANNOUNCEMENT_SWEEP_CRON = '* * * * *';
}

/** Secrets that must never survive into a production deploy unchanged. */
const PLACEHOLDER_PATTERN = /CHANGE_ME|changeme|your[-_]?secret|placeholder/i;

/**
 * The API's public origin, as the outside world reaches it.
 *
 * It is baked into every playback URL (master/media playlists and the AES key
 * endpoint are served by this API). Left at its localhost default on a hosted
 * deploy, every ticket handed a phone a manifest URL pointing at the phone
 * itself. Render sets RENDER_EXTERNAL_URL on every web service, so that is
 * used when PUBLIC_API_URL is not set explicitly.
 */
export function resolvePublicApiUrl(raw: Record<string, unknown> = process.env): string {
  const explicit = typeof raw.PUBLIC_API_URL === 'string' ? raw.PUBLIC_API_URL.trim() : '';
  if (explicit) return explicit.replace(/\/+$/, '');
  const render = typeof raw.RENDER_EXTERNAL_URL === 'string' ? raw.RENDER_EXTERNAL_URL.trim() : '';
  if (render) return render.replace(/\/+$/, '');
  return 'http://localhost:3000';
}

export function validateEnv(raw: Record<string, unknown>): EnvironmentVariables {
  const config = plainToInstance(EnvironmentVariables, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
  });

  if (errors.length > 0) {
    const detail = errors
      .map((e) => `  • ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  // A resume window at or below the ticket lifetime defeats the setting's only
  // purpose: the ticket would expire before the window that exists to absorb
  // that expiry, so a student who reads past the TTL starts a second play and
  // loses one of their three attempts to a technical failure.
  if (config.PLAYBACK_PLAY_RESUME_WINDOW <= config.PLAYBACK_TICKET_TTL) {
    throw new Error(
      `PLAYBACK_PLAY_RESUME_WINDOW (${config.PLAYBACK_PLAY_RESUME_WINDOW}s) must be greater than ` +
        `PLAYBACK_TICKET_TTL (${config.PLAYBACK_TICKET_TTL}s), otherwise a ticket expiring ` +
        'mid-lesson costs the student one of their counted plays.',
    );
  }

  if (config.NODE_ENV === NodeEnv.Production) {
    const guarded: (keyof EnvironmentVariables)[] = [
      'JWT_ACCESS_SECRET',
      'JWT_REFRESH_SECRET',
      'JWT_PLAYBACK_SECRET',
      'MEDIA_SIGNING_KEY',
      'HLS_KEY_ROOT',
    ];

    const offenders = guarded.filter((key) =>
      PLACEHOLDER_PATTERN.test(String(config[key] ?? '')),
    );
    if (offenders.length > 0) {
      throw new Error(
        `Refusing to start in production with placeholder secrets: ${offenders.join(', ')}. ` +
          'Generate real values with `openssl rand -base64 48`.',
      );
    }

    // Three distinct signing domains. Reusing one secret means a leaked
    // playback grant could be replayed as an access token.
    const secrets = new Set([
      config.JWT_ACCESS_SECRET,
      config.JWT_REFRESH_SECRET,
      config.JWT_PLAYBACK_SECRET,
    ]);
    if (secrets.size !== 3) {
      throw new Error(
        'JWT_ACCESS_SECRET, JWT_REFRESH_SECRET and JWT_PLAYBACK_SECRET must all differ.',
      );
    }

    if (!config.CORS_ORIGINS || config.CORS_ORIGINS.trim() === '*') {
      throw new Error('CORS_ORIGINS must be an explicit allow-list in production.');
    }

    if (!config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
      throw new Error('R2 credentials are required in production.');
    }

    // Media must go through the edge in production. Node proxying video bytes
    // competes with request handling and gets no edge caching, and a
    // deployment that ends up there by accident degrades quietly rather than
    // loudly — so it is refused at boot instead.
    if (!config.MEDIA_CDN_BASE_URL) {
      throw new Error(
        'MEDIA_CDN_BASE_URL is required in production: signed media URLs must be ' +
          'verified at the edge. See docs/MANUAL_STEPS.md step 8.',
      );
    }
    if (!raw.R2_BUCKET_LIBRARY) {
      console.error(
        '[config] R2_BUCKET_LIBRARY is not set: Library documents fall back into the uploads ' +
          'bucket, while the media Worker reads library/ keys from its LIBRARY binding ' +
          '(edu-library) — uploaded PDFs will not open. Set R2_BUCKET_LIBRARY=edu-library.',
      );
    }

    // Cloudinary is all-or-nothing: a partial set would produce an upload that
    // appears to succeed and a delivery URL that 404s, which is exactly the
    // "broken image" this move is meant to end. Refused at boot, and named
    // without echoing any value.
    const cloudinaryKeys = [
      'CLOUDINARY_CLOUD_NAME',
      'CLOUDINARY_API_KEY',
      'CLOUDINARY_API_SECRET',
    ] as const;
    const cloudinarySet = cloudinaryKeys.filter((key) => Boolean(raw[key]));
    if (cloudinarySet.length > 0 && cloudinarySet.length < cloudinaryKeys.length) {
      const missing = cloudinaryKeys.filter((key) => !raw[key]);
      throw new Error(
        `Cloudinary is configured but incomplete: ${missing.join(', ')} missing. ` +
          'Set all three or none.',
      );
    }
    if (cloudinarySet.length === 0) {
      console.error(
        '[config] Cloudinary is not configured: course thumbnails fall back to R2, whose media ' +
          'gate rejects unsigned requests with 403, so those images will not display. Set ' +
          'CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET.',
      );
    }

    const publicUrl = resolvePublicApiUrl(raw);
    if (!/^https:\/\//i.test(publicUrl) || /localhost|127\.0\.0\.1|10\.0\.2\.2/i.test(publicUrl)) {
      // Logged, not thrown: the same production-mode .env is also used to run
      // the API on a developer machine, where localhost is the right answer.
      // On a hosted deploy it means no phone can open any video.
      console.error(
        `[config] PUBLIC_API_URL resolves to "${publicUrl}". Protected playback will not work ` +
          'from a phone until it is the API\'s public https origin (e.g. ' +
          'https://student-backend-814y.onrender.com) — manifest and AES-key URLs are built from it.',
      );
    }
    if (config.MEDIA_LOCAL_ORIGIN) {
      throw new Error(
        'MEDIA_LOCAL_ORIGIN must not be enabled in production — it proxies video ' +
          'through the API process. Use the Cloudflare Worker instead.',
      );
    }
  }

  return config;
}
