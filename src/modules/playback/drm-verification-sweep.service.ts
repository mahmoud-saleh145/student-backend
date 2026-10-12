import { Injectable, Logger } from '@nestjs/common';

import { PrismaService, notDeleted } from '../../database/prisma.service';
import { DrmVerificationService } from './drm-verification.service';

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

  async sweep(options: { batchSize?: number } = {}): Promise<DrmSweepResult> {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? 25, 100));

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
      // Bounded: the sweep must never load the whole library into memory, and a
      // hard cap keeps one run from monopolising the provider.
      take: batchSize * 4,
      orderBy: { drmVerifiedAt: { sort: 'asc', nulls: 'first' } },
    });

    const ids = DrmVerificationSweepService.selectCandidates(
      ttlSeconds,
      margin,
      new Date(),
      candidates,
    );
    result.skippedFresh = candidates.length - ids.length;

    for (const id of ids.slice(0, batchSize)) {
      result.checked += 1;
      try {
        const verdict = await this.drmVerification.verify(id);
        if (verdict.playable) result.refreshed += 1;
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

  /** Exposed so the scheduler can compute the interval from the same TTL. */
  static defaultMarginSeconds(ttlSeconds: number): number {
    // Renew once the remaining life drops below a third of the TTL, with a floor
    // so a very small TTL still gets a sane window.
    return Math.max(60, Math.floor(ttlSeconds / 3));
  }
}
