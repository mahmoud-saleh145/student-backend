import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
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
  @Type(() => Number) @IsInt() @Min(3600) JWT_REFRESH_TTL = 2592000;
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

  // --- storage --------------------------------------------------------------
  @IsOptional() @IsString() R2_ACCOUNT_ID?: string;
  @IsOptional() @IsString() R2_ACCESS_KEY_ID?: string;
  @IsOptional() @IsString() R2_SECRET_ACCESS_KEY?: string;
  @IsString() R2_BUCKET_MEDIA = 'edu-media-dev';
  @IsString() R2_BUCKET_UPLOADS = 'edu-uploads-dev';
  @IsString() R2_REGION = 'auto';
  @IsOptional() @IsString() R2_ENDPOINT?: string;

  @IsOptional() @IsString() MEDIA_CDN_BASE_URL?: string;

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

  // --- throttling -----------------------------------------------------------
  @Type(() => Number) @IsInt() @Min(1) THROTTLE_TTL = 60;
  @Type(() => Number) @IsInt() @Min(1) THROTTLE_LIMIT = 120;
  @Type(() => Number) @IsInt() @Min(1) THROTTLE_AUTH_LIMIT = 10;

  // --- observability --------------------------------------------------------
  @IsString() LOG_LEVEL = 'info';
  @toBool() @IsBoolean() LOG_PRETTY = false;
  @IsOptional() @IsString() SENTRY_DSN?: string;
}

/** Secrets that must never survive into a production deploy unchanged. */
const PLACEHOLDER_PATTERN = /CHANGE_ME|changeme|your[-_]?secret|placeholder/i;

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
    if (config.MEDIA_LOCAL_ORIGIN) {
      throw new Error(
        'MEDIA_LOCAL_ORIGIN must not be enabled in production — it proxies video ' +
          'through the API process. Use the Cloudflare Worker instead.',
      );
    }
  }

  return config;
}
