import { registerAs } from '@nestjs/config';

import { type EnvironmentVariables, NodeEnv } from './env.validation';

const env = () => process.env as unknown as EnvironmentVariables;

const num = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: unknown, fallback = false) =>
  v === undefined ? fallback : v === true || v === 'true' || v === '1';

export const appConfig = registerAs('app', () => ({
  env: (process.env.NODE_ENV ?? 'development') as NodeEnv,
  isProduction: process.env.NODE_ENV === 'production',
  isDevelopment: (process.env.NODE_ENV ?? 'development') === 'development',
  isTest: process.env.NODE_ENV === 'test',
  port: num(process.env.PORT, 3000),
  apiPrefix: process.env.API_PREFIX ?? 'api',
  apiVersion: process.env.API_VERSION ?? '1',
  publicUrl: process.env.PUBLIC_API_URL ?? 'http://localhost:3000',
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  trustProxy: bool(process.env.TRUST_PROXY),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  logPretty: bool(process.env.LOG_PRETTY),
}));

export const authConfig = registerAs('auth', () => ({
  accessSecret: process.env.JWT_ACCESS_SECRET!,
  refreshSecret: process.env.JWT_REFRESH_SECRET!,
  playbackSecret: process.env.JWT_PLAYBACK_SECRET!,
  accessTtl: num(process.env.JWT_ACCESS_TTL, 900),
  refreshTtl: num(process.env.JWT_REFRESH_TTL, 2592000),
  issuer: process.env.JWT_ISSUER ?? 'edu-platform',
  audience: process.env.JWT_AUDIENCE ?? 'edu-mobile',
  argon: {
    memoryCost: num(process.env.ARGON_MEMORY_COST, 19456),
    timeCost: num(process.env.ARGON_TIME_COST, 2),
    parallelism: num(process.env.ARGON_PARALLELISM, 1),
  },
  /** Account lockout after repeated failures. */
  maxFailedLogins: 8,
  lockoutMinutes: 15,
}));

export const deviceConfig = registerAs('device', () => ({
  limitPerStudent: num(process.env.DEVICE_LIMIT_PER_STUDENT, 1),
  autoBindFirst: bool(process.env.DEVICE_AUTO_BIND_FIRST, true),
  blockOnIntegrityFailure: bool(process.env.DEVICE_BLOCK_ON_INTEGRITY_FAILURE, true),
}));

export const playbackConfig = registerAs('playback', () => ({
  ticketTtl: num(process.env.PLAYBACK_TICKET_TTL, 300),
  heartbeatInterval: num(process.env.PLAYBACK_HEARTBEAT_INTERVAL, 30),
  heartbeatGrace: num(process.env.PLAYBACK_HEARTBEAT_GRACE, 90),
  maxConcurrentStreams: num(process.env.PLAYBACK_MAX_CONCURRENT_STREAMS, 1),
  ticketsPerHour: num(process.env.PLAYBACK_TICKETS_PER_HOUR, 60),
  captureStrikes: num(process.env.PLAYBACK_CAPTURE_STRIKES, 3),
}));

export const storageConfig = registerAs('storage', () => {
  const accountId = process.env.R2_ACCOUNT_ID;
  return {
    accountId,
    accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    region: process.env.R2_REGION ?? 'auto',
    endpoint:
      process.env.R2_ENDPOINT ||
      (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : undefined),
    buckets: {
      media: process.env.R2_BUCKET_MEDIA ?? 'edu-media-dev',
      uploads: process.env.R2_BUCKET_UPLOADS ?? 'edu-uploads-dev',
    },
    cdnBaseUrl: process.env.MEDIA_CDN_BASE_URL ?? '',
    signingKey: process.env.MEDIA_SIGNING_KEY!,
    /**
     * Serve media bytes from this API when no CDN is configured.
     *
     * The edge Worker is the production path and stays the default. This
     * exists because without it there is no third option: with no
     * MEDIA_CDN_BASE_URL the storage layer falls back to a presigned S3 URL
     * that is NOT bound to the viewer, which is both weaker and unusable
     * against a local MinIO the device cannot reach.
     *
     * The local origin applies the same checks as the Worker — same HMAC,
     * same ticket liveness, same quality ceiling, same forbidden prefixes —
     * so it is a transport change, not a security relaxation. It does not
     * scale (Node proxying video bytes) and is refused in production.
     */
    localOrigin:
      bool(process.env.MEDIA_LOCAL_ORIGIN, false) ||
      (!process.env.MEDIA_CDN_BASE_URL && process.env.NODE_ENV !== 'production'),
    /** MinIO and some S3 clones need path-style addressing. */
    forcePathStyle: !!process.env.R2_ENDPOINT?.includes('minio') || !accountId,
  };
});

export const videoConfig = registerAs('video', () => ({
  ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
  workDir: process.env.TRANSCODE_WORK_DIR ?? '/tmp/edu-transcode',
  ladder: (process.env.TRANSCODE_LADDER ?? '360,480,720,1080')
    .split(',')
    .map((h) => Number(h.trim()))
    .filter((h) => Number.isFinite(h) && h > 0)
    .sort((a, b) => a - b),
  segmentSeconds: num(process.env.HLS_SEGMENT_SECONDS, 6),
  encryptionEnabled: bool(process.env.HLS_ENCRYPTION_ENABLED, true),
  keyRoot: process.env.HLS_KEY_ROOT!,
  drm: {
    enabled: bool(process.env.DRM_ENABLED),
    widevineLicenseUrl: process.env.DRM_WIDEVINE_LICENSE_URL ?? null,
    fairplayLicenseUrl: process.env.DRM_FAIRPLAY_LICENSE_URL ?? null,
    fairplayCertUrl: process.env.DRM_FAIRPLAY_CERT_URL ?? null,
    providerToken: process.env.DRM_PROVIDER_TOKEN ?? null,
  },
}));

export const paymentConfig = registerAs('payment', () => ({
  provider: (process.env.PAYMENT_PROVIDER ?? 'none') as
    | 'none'
    | 'paymob'
    | 'stripe',
  currency: process.env.PAYMENT_CURRENCY ?? 'EGP',
  returnUrl: process.env.PAYMENT_RETURN_URL ?? 'eduplatform://payment/return',
  paymob: {
    apiKey: process.env.PAYMOB_API_KEY ?? '',
    integrationId: process.env.PAYMOB_INTEGRATION_ID ?? '',
    iframeId: process.env.PAYMOB_IFRAME_ID ?? '',
    hmacSecret: process.env.PAYMOB_HMAC_SECRET ?? '',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY ?? '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  },
  /** Default platform cut when a teacher has no configured share. */
  defaultPlatformSharePercent: 30,
}));

export const notificationConfig = registerAs('notification', () => ({
  provider: (process.env.PUSH_PROVIDER ?? 'expo') as 'expo' | 'none',
  expoAccessToken: process.env.EXPO_ACCESS_TOKEN ?? '',
  expoApiUrl: 'https://exp.host/--/api/v2/push/send',
  batchSize: 100,
}));

export const redisConfig = registerAs('redis', () => ({
  url: process.env.REDIS_URL ?? 'redis://localhost:6379',
  prefix: process.env.REDIS_PREFIX ?? 'edu',
}));

export const throttleConfig = registerAs('throttle', () => ({
  ttl: num(process.env.THROTTLE_TTL, 60),
  limit: num(process.env.THROTTLE_LIMIT, 120),
  authLimit: num(process.env.THROTTLE_AUTH_LIMIT, 10),
}));

export const configurations = [
  appConfig,
  authConfig,
  deviceConfig,
  playbackConfig,
  storageConfig,
  videoConfig,
  paymentConfig,
  notificationConfig,
  redisConfig,
  throttleConfig,
];

export type AppConfig = ReturnType<typeof appConfig>;
export type AuthConfig = ReturnType<typeof authConfig>;
export type DeviceConfig = ReturnType<typeof deviceConfig>;
export type PlaybackConfig = ReturnType<typeof playbackConfig>;
export type StorageConfig = ReturnType<typeof storageConfig>;
export type VideoConfig = ReturnType<typeof videoConfig>;
export type PaymentConfig = ReturnType<typeof paymentConfig>;
export type NotificationConfig = ReturnType<typeof notificationConfig>;
export type RedisConfig = ReturnType<typeof redisConfig>;
export type ThrottleConfig = ReturnType<typeof throttleConfig>;

export { env };
