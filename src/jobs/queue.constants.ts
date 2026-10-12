import type { NotificationKind } from '@prisma/client';

/**
 * Queue registry.
 *
 * Separate queues rather than one with job names, because they have very
 * different shapes: transcoding is long, CPU-bound and low-volume (one worker
 * per box), push is short, IO-bound and bursty (high concurrency). Sharing a
 * queue would let a 40-minute transcode starve notification delivery.
 */
export const QUEUE_NAMES = {
  video: 'video-processing',
  push: 'push-delivery',
  maintenance: 'maintenance',
  analytics: 'analytics',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

// ---------------------------------------------------------------------------
// Video processing
// ---------------------------------------------------------------------------

export interface TranscodeJobData {
  videoId: string;
  sourceKey: string;
  /**
   * The lecture the file was UPLOADED to. Nullable because a reused asset can
   * outlive that lecture, in which case the row's owner is gone and there is no
   * single lecture the job "belongs" to.
   *
   * It is deliberately NOT an "attach to this lecture" instruction: the job is
   * keyed by `videoId`, and processing must never create or move an attachment.
   * Reuse enqueues nothing at all.
   */
  lessonId: string | null;
  courseId: string;
  /** Requested ladder; renditions above the source height are skipped. */
  ladder: number[];
  encrypt: boolean;
  requestedById?: string;
}

export const VIDEO_JOBS = {
  transcode: 'transcode',
  cleanup: 'cleanup-source',
} as const;

// ---------------------------------------------------------------------------
// Push delivery
// ---------------------------------------------------------------------------

export type PushJobData =
  | {
      type: 'single';
      userId: string;
      notificationId: string;
      kind: NotificationKind;
    }
  | {
      type: 'bulk';
      userIds: string[];
      kind: NotificationKind;
      title: string;
      titleAr?: string;
      body: string;
      bodyAr?: string;
      route?: string | null;
    };

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

export const MAINTENANCE_JOBS = {
  expireEnrollments: 'expire-enrollments',
  expireCodes: 'expire-codes',
  expireTickets: 'expire-playback-tickets',
  reclaimStreamSlots: 'reclaim-stream-slots',
  pruneSessions: 'prune-sessions',
  pruneIdempotency: 'prune-idempotency',
  courseExpiryReminders: 'course-expiry-reminders',
  dispatchAnnouncements: 'dispatch-announcements',
  recoverStrandedVideos: 'recover-stranded-videos',
  /**
   * Re-checks DRM proof before the verification TTL can lapse.
   *
   * Without this, `DrmVerificationService.evaluate()` starts returning
   * VERIFICATION_STALE exactly `DRM_VERIFICATION_TTL_SECONDS` after the last
   * successful check and every lesson stops playing, with no operator action
   * anywhere to explain it. The refresh must go through the real verifier, so
   * this job re-verifies against the provider rather than extending a timestamp.
   */
  refreshDrmVerification: 'refresh-drm-verification',
} as const;

export interface MaintenanceJobData {
  triggeredBy?: 'schedule' | 'manual';
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export const ANALYTICS_JOBS = {
  rollupDaily: 'rollup-daily-course-stats',
} as const;

export interface AnalyticsJobData {
  /** ISO date (YYYY-MM-DD). Defaults to yesterday. */
  day?: string;
}

/** Shared default options — every queue gets bounded retention. */
export const DEFAULT_JOB_OPTIONS = {
  removeOnComplete: { age: 3600, count: 500 },
  removeOnFail: { age: 24 * 3600, count: 1000 },
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
};
