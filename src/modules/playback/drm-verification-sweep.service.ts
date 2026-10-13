import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, notDeleted } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { DrmVerificationService } from './drm-verification.service';

/** Videos re-verified per sweep run when no batch size is given. */
export const SWEEP_DEFAULT_BATCH_SIZE = 25;
/** Tries per provider request during a sweep (transient failures only). */
export const SWEEP_VERIFY_ATTEMPTS = 2;
/**
 * How many candidate rows (id + proof time only) one sweep loads to choose its
 * batch from. Rotation (below) is fair across everything inside this window;
 * a library with more Gumlet videos due at once than this would need a cursor.
 *
 * KNOWN LIMITATION, deliberately not papered over: while more than this many are
 * eligible, `take` cuts the list at a fixed point in a deterministic order, so
 * everything past the cut is starved permanently - rotation can only reorder the
 * rows it is handed. `sweep()` warns when the window saturates, so the condition
 * is visible rather than inferred from videos that never recover. A cursor or
 * keyset paging is the fix, and is deliberately not attempted here: it is a
 * change to the queue's selection semantics on a security-relevant path, and the
 * backlog it addresses (a platform-wide provider outage, or a first migration
 * over a large library) is better answered by fixing the provider.
 */
export const SWEEP_CANDIDATE_WINDOW = 1000;
/** Redis sorted set: due video id -> when a sweep last attempted it (ms). */
export const SWEEP_ATTEMPTS_KEY_PARTS = ['drm', 'sweep-attempts'] as const;

/**
 * Recurring DRM re-verification.
 *
 * WHY THIS EXISTS
 *
 * `drmVerifiedAt` is a proof with an expiry, not a permanent flag: after
 * `DRM_VERIFICATION_TTL_SECONDS` the playback path answers VERIFICATION_STALE and
 * refuses. That is the correct security posture - a proof must not outlive the
 * evidence - but it means the platform needs something to renew the proof. With
 * nothing doing so, every lesson silently stops playing six hours after it
 * worked, with no error a student or operator can act on.
 *
 * WHAT IT DOES, AND DELIBERATELY DOES NOT
 *
 * It calls the same `DrmVerificationService.verify()` the webhook and the admin
 * endpoint call. It cannot mark anything playable on its own: every write to
 * `drmVerifiedAt` still happens inside the verifier, and only after a real
 * provider read and a real CENC check of the DASH manifest. This job decides
 * *which* videos are worth re-checking and *when*; it never decides that one is
 * fine.
 *
 * The alternatives were both rejected: disabling the stale check would remove the
 * expiry that makes the proof meaningful, and lengthening the TTL to "effectively
 * infinite" is the same thing with extra steps.
 */
export interface DrmSweepResult {
  /** Videos whose stored proof was already inside the margin; not re-checked. */
  skippedFresh: number;
  /** Videos actually re-verified against the provider. */
  checked: number;
  /** Verification succeeded (or was already newer) - proof refreshed. */
  refreshed: number;
  /** Verification failed. The verifier has already cleared the proof. */
  failed: number;
  /** Transient error - neither refreshed nor failed, retried on the next sweep. */
  errored: number;
  /** Videos skipped because the platform itself is not configured for DRM. */
  skippedPlatform: number;
}

@Injectable()
export class DrmVerificationSweepService {
  private readonly logger = new Logger(DrmVerificationSweepService.name);

  /**
   * Renew the proof before it lapses.
   *
   * Refresh at `ttl - margin`, not at `ttl`. A video whose proof has already
   * expired is a student-facing outage for the length of one sweep interval, so
   * the work is done early enough that the gap is normally zero. The margin is
   * a fraction of the TTL rather than a constant so that raising the TTL for a
   * busy platform does not silently reintroduce a tight window.
   */
  readonly marginSeconds: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly drmVerification: DrmVerificationService,
    private readonly redis: RedisService,
  ) {
    this.marginSeconds = DrmVerificationSweepService.defaultMarginSeconds(
      this.drmVerification.ttl,
    );
  }

  /**
   * Select the videos worth re-checking.
   *
   * Exported for testing as a pure function of its arguments: the selection rule
   * is the part most likely to be got wrong, and it should be assertable without
   * a database.
   */
  static selectCandidates(
    ttlSeconds: number,
    marginSeconds: number,
    now: Date,
    rows: {
      id: string;
      drmVerifiedAt: Date | null;
    }[],
  ): string[] {
    const cutoff = now.getTime() - (ttlSeconds - marginSeconds) * 1000;
    return rows
      .filter((r) => r.drmVerifiedAt === null || r.drmVerifiedAt.getTime() <= cutoff)
      .map((r) => r.id);
  }

  /**
   * Whether THIS process is configured well enough to verify anything at all.
   *
   * The scheduler MUST consult this before taking the sweep lock, never after.
   * A process with DRM disabled can still win `acquireLock`, and it would then
   * release it having verified nothing - which excludes every other process for
   * a whole interval. That is not hypothetical: a worker container carrying
   * `DRM_ENABLED=false` held the production lock and skipped, so the sweep that
   * should have run never did.
   *
   * Pure and synchronous (it reads config that was already validated at boot),
   * so it is safe to call on the path that decides whether to take a lock.
   */
  isPlatformUsable(): boolean {
    return this.drmVerification.isPlatformUsable();
  }

  async sweep(options: { batchSize?: number } = {}): Promise<DrmSweepResult> {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? SWEEP_DEFAULT_BATCH_SIZE, 100));

    const ttlSeconds = this.drmVerification.ttl;
    const margin = this.marginSeconds;
    const result: DrmSweepResult = {
      skippedFresh: 0,
      checked: 0,
      refreshed: 0,
      failed: 0,
      errored: 0,
      skippedPlatform: 0,
    };

    // A platform without working DRM config cannot verify anything. Running the
    // sweep anyway would query every video and fail every one of them, which
    // would clear proofs that are merely waiting for configuration to return.
    const configured = this.drmVerification.isPlatformUsable();
    if (!configured) {
      this.logger.warn(
        'DRM re-verification skipped: the platform is not configured for Gumlet DRM (DRM_ENABLED / DRM_PROVIDER / signing). Existing proofs are left untouched.',
      );
      return { ...result, skippedPlatform: 1 };
    }

    // Only videos that are actually on the Gumlet path with a real asset are
    // candidates. A `drmProvider IS NOT NULL` filter would also exclude legacy
    // rows, which is correct: a legacy video has nothing to verify and must not
    // be dragged into the provider by this sweep.
    const candidates = await this.prisma.video.findMany({
      where: {
        ...notDeleted,
        drmProvider: 'gumlet',
        gumletAssetId: { not: null },
        status: 'READY',
      },
      select: { id: true, drmVerifiedAt: true },
      // Bounded: the sweep must never load the whole library into memory. Only
      // `batchSize` of these are verified per run, which is what keeps one run
      // from monopolising the provider.
      take: SWEEP_CANDIDATE_WINDOW,
      orderBy: [{ drmVerifiedAt: { sort: 'asc', nulls: 'first' } }, { id: 'asc' }],
    });

    const ids = DrmVerificationSweepService.selectCandidates(
      ttlSeconds,
      margin,
      new Date(),
      candidates,
    );
    result.skippedFresh = candidates.length - ids.length;

    // Saturation is the one thing that defeats the rotation below, so it is
    // reported rather than left to be discovered as "some videos never recover".
    // `take` cuts the list at a fixed point in a deterministic order, so while
    // more than a window's worth is due, everything past the cut is invisible to
    // this run AND to the Redis rotation, which can only reorder what it is
    // given. Rotation still guarantees fairness within the window.
    if (candidates.length >= SWEEP_CANDIDATE_WINDOW) {
      this.logger.warn(
        `DRM re-verification candidate window is saturated (${candidates.length} Gumlet videos eligible): ` +
          'rotation can only order the first window\'s worth, so eligible videos beyond it are not ' +
          're-verified until the backlog falls below the window. This is expected during a provider ' +
          'outage or a large first migration; it is a defect only if it persists afterwards.',
      );
    }

    for (const id of await this.chooseBatch(ids, batchSize)) {
      result.checked += 1;
      try {
        const verdict = await this.drmVerification.verify(id, { attempts: SWEEP_VERIFY_ATTEMPTS });
        if (verdict.playable) result.refreshed += 1;
        // The provider could not be asked: nothing was concluded or written,
        // so this is a retry-next-run, not a failed verification.
        else if (verdict.reason === 'VERIFICATION_UNAVAILABLE') result.errored += 1;
        else result.failed += 1;
      } catch (error) {
        // An unexpected throw is not the same as a failed verification. Leaving
        // the stored proof alone is the safe reading: we do not know that the
        // asset became unprotected, and we must not destroy a working proof on
        // the strength of a transient error.
        result.errored += 1;
        this.logger.warn(
          `DRM re-verification of video ${id} errored and will be retried: ${(error as Error).message}`,
        );
      }
    }

    if (ids.length > batchSize) {
      this.logger.log(
        `DRM re-verification: ${ids.length} due, processed ${batchSize}; the remainder is picked up on the next run`,
      );
    }

    this.logger.log(
      `DRM re-verification: ${result.refreshed} refreshed, ${result.failed} failed, ${result.errored} errored, ${result.skippedFresh} still fresh`,
    );
    return result;
  }

  /**
   * Which due videos this run verifies: the least recently ATTEMPTED first.
   *
   * Ordering by `drmVerifiedAt` alone starved the queue. Every blocked or
   * never-verified video has no proof, so all of them sort first - and in a
   * fixed order - and a failing check leaves them exactly there. With 25 or
   * more of them, every run re-checked the same 25 and nothing behind them
   * (other blocked videos, proofs about to lapse) was ever reached. Blocked
   * videos depend on this sweep to recover (the playback path does not
   * re-check a recorded failure), so that was a permanent outage for them.
   *
   * Attempt times live in Redis - not in the video row, which has no column
   * with that meaning - and are recorded BEFORE the batch is verified, so a run
   * that dies part-way still moves the rotation on. Videos never attempted
   * (including a proof that has just become due again: ids that are no longer
   * due are pruned) go first, in database order. Every due video inside the
   * candidate window is therefore attempted within ceil(due / batchSize) runs.
   * If Redis is unavailable the database order is used, as before.
   */
  private async chooseBatch(due: string[], batchSize: number): Promise<string[]> {
    if (due.length <= batchSize) return due;
    const key = this.redis.key(...SWEEP_ATTEMPTS_KEY_PARTS);
    try {
      const flat = await this.redis.client.zrange(key, 0, -1, 'WITHSCORES');
      const lastAttempt = new Map<string, number>();
      for (let i = 0; i + 1 < flat.length; i += 2) lastAttempt.set(flat[i], Number(flat[i + 1]));

      // Array.prototype.sort is stable: ties keep the database order.
      const chosen = [...due]
        .sort((a, b) => (lastAttempt.get(a) ?? -1) - (lastAttempt.get(b) ?? -1))
        .slice(0, batchSize);

      const dueSet = new Set(due);
      const stale = [...lastAttempt.keys()].filter((id) => !dueSet.has(id));
      const now = Date.now();
      const tx = this.redis.client.multi();
      if (stale.length > 0) tx.zrem(key, ...stale);
      tx.zadd(key, ...chosen.flatMap((id) => [now, id]));
      tx.expire(key, 7 * 24 * 3600);
      await tx.exec();
      return chosen;
    } catch (error) {
      this.logger.warn(
        `DRM re-verification rotation unavailable (${(error as Error).message}); using database order this run`,
      );
      return due.slice(0, batchSize);
    }
  }

  /** Exposed so the scheduler can compute the interval from the same TTL. */
  static defaultMarginSeconds(ttlSeconds: number): number {
    // Renew once the remaining life drops below a third of the TTL, with a floor
    // so a very small TTL still gets a sane window.
    return Math.max(60, Math.floor(ttlSeconds / 3));
  }
}
