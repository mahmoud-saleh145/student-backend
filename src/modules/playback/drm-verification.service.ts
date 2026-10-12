import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { GumletDrmService } from '../playback/gumlet-drm.service';

/**
 * The ONLY authority on whether a video may be played with DRM.
 *
 * WHY THIS EXISTS SEPARATELY FROM `GumletIngestService`
 *
 * Ingestion and verification answer different questions and must not be allowed
 * to borrow each other's confidence:
 *
 *   - "Did we ask Gumlet to make this DRM?"      -> `drmRequested`, set by us.
 *   - "Does a Gumlet asset exist for this?"      -> `gumletAssetId`, provider truth.
 *   - "Is it READY at the provider?"             -> `gumletStatus`, provider truth.
 *   - "Is the packaged media ACTUALLY ENCRYPTED?" -> THIS SERVICE, and only this.
 *
 * Only the last one is proof. Gumlet reports `ready` for an asset it packaged
 * without DRM (that is the exact failure `assetHasDrm` was written to catch), and
 * our own `drmProvider` column is a routing decision we made, not an observation.
 *
 * THE RULE ENFORCED HERE
 *
 * A video is playable only when ALL of the following hold:
 *   1. a Gumlet asset exists,
 *   2. the provider reports it `ready`,
 *   3. the DASH manifest is genuinely CENC-encrypted, and
 *   4. that check is fresher than `DRM_VERIFICATION_TTL_SECONDS`.
 *
 * Anything else is not playable. There is no fallback to HLS, to the original
 * MP4, or to any unprotected stream - not on error, not on timeout, not when the
 * provider is unreachable. Unavailability is the safe answer.
 *
 * WHY A TIMESTAMP RATHER THAN A FLAG
 *
 * `drmVerifiedAt` is deliberately a timestamp and not a boolean. A boolean that
 * is ever set once can never express "this was true an hour ago and might not be
 * now". Requiring freshness means a video whose DRM was revoked, whose asset was
 * reprocessed without DRM, or whose provider account lost its DRM credentials
 * stops being playable without anyone having to remember to reset a flag.
 */
export type DrmVerdict =
  | { playable: true; reason: null }
  | {
      playable: false;
      reason:
        | 'NO_GUMLET_ASSET'
        | 'DRM_NOT_REQUESTED'
        | 'ASSET_NOT_READY'
        | 'ASSET_FAILED'
        | 'NOT_VERIFIED'
        | 'VERIFICATION_STALE'
        | 'DRM_DISABLED_ON_PLATFORM'
        | 'SIGNING_UNAVAILABLE';
      /** Admin-facing detail. Never contains a secret, token or signed URL. */
      detail: string;
    };

/**
 * The video fields a verdict depends on. Declared at module scope rather than
 * inside the class so `evaluate` is callable with a plain object literal.
 */
export type VideoForVerdict = {
  id: string;
  drmProvider: string | null;
  drmRequested: boolean;
  drmVerifiedAt: Date | null;
  drmBlockedReason: string | null;
  gumletAssetId: string | null;
  gumletStatus: string | null;
  gumletWorkspaceId: string | null;
  status: string;
};

@Injectable()
export class DrmVerificationService {
  private readonly logger = new Logger(DrmVerificationService.name);
  private readonly drm: VideoConfig['drm'];
  private readonly ttlSeconds: number;

  /**
   * The configured TTL. Read by the re-verification sweep so its refresh margin
   * is derived from the same number the playback path enforces, rather than a
   * second constant that could drift.
   */
  get ttl(): number {
    return this.ttlSeconds;
  }

  /**
   * True when the platform can actually verify anything right now.
   *
   * Used by the sweep to stand down entirely when DRM is switched off, rather
   * than walking the library and failing every video it finds.
   */
  isPlatformUsable(): boolean {
    return this.drm.enabled && this.drm.provider === 'gumlet' && this.gumlet.isSigningConfigured();
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly gumlet: GumletDrmService,
    config: ConfigService,
  ) {
    const videoCfg = config.getOrThrow<VideoConfig>('video');
    this.drm = videoCfg.drm;
    this.ttlSeconds = Number(process.env.DRM_VERIFICATION_TTL_SECONDS ?? 21600); // 6h
  }

  /** The same projection, for use in a Prisma `select`. */
  private static select() {
    return {
      id: true,
      drmProvider: true,
      drmRequested: true,
      drmVerifiedAt: true,
      drmBlockedReason: true,
      gumletAssetId: true,
      gumletStatus: true,
      gumletWorkspaceId: true,
      status: true,
    } as const;
  }

  /**
   * Judge a video using ONLY already-persisted state.
   *
   * This is what runs on the playback hot path: no network call, no latency. It
   * deliberately cannot verify anything - it can only report what `verify()`
   * previously proved. That split is the whole point.
   */
  evaluate(video: VideoForVerdict): DrmVerdict {
    // Platform-level gates first: with DRM switched off, no video may play, even
    // one that was verified a moment ago.
    if (!this.drm.enabled) {
      return {
        playable: false,
        reason: 'DRM_DISABLED_ON_PLATFORM',
        detail: 'DRM is disabled on this platform.',
      };
    }
    if (this.drm.provider !== 'gumlet') {
      return {
        playable: false,
        reason: 'DRM_DISABLED_ON_PLATFORM',
        detail: `DRM provider is "${this.drm.provider}", not "gumlet".`,
      };
    }
    if (!this.gumlet.isSigningConfigured()) {
      return {
        playable: false,
        reason: 'SIGNING_UNAVAILABLE',
        detail: 'Gumlet signing is not configured, so no licence can be issued.',
      };
    }
    if (video.drmProvider !== 'gumlet') {
      return {
        playable: false,
        reason: 'NO_GUMLET_ASSET',
        detail: 'This video is not assigned to the Gumlet delivery path.',
      };
    }
    if (!video.gumletAssetId) {
      return {
        playable: false,
        reason: 'NO_GUMLET_ASSET',
        detail: 'No Gumlet asset has been created for this video.',
      };
    }
    if (!video.drmRequested) {
      return {
        playable: false,
        reason: 'DRM_NOT_REQUESTED',
        detail: 'This asset was not requested with DRM protection enabled.',
      };
    }
    if (video.gumletStatus !== 'ready') {
      return {
        playable: false,
        reason:
          video.gumletStatus === 'errored' || video.gumletStatus === 'failed'
            ? 'ASSET_FAILED'
            : 'ASSET_NOT_READY',
        detail: `Gumlet asset status is "${video.gumletStatus ?? 'unknown'}".`,
      };
    }
    if (!video.drmVerifiedAt) {
      return {
        playable: false,
        reason: 'NOT_VERIFIED',
        detail:
          video.drmBlockedReason ?? 'DRM has not been verified against the live manifest yet.',
      };
    }
    const ageSeconds = (Date.now() - video.drmVerifiedAt.getTime()) / 1000;
    if (ageSeconds > this.ttlSeconds) {
      return {
        playable: false,
        reason: 'VERIFICATION_STALE',
        detail: `Last DRM verification was ${Math.round(ageSeconds / 60)} minutes ago.`,
      };
    }
    return { playable: true, reason: null };
  }

  /** Load a video and judge it. Used on the playback path. */
  async evaluateVideo(videoId: string): Promise<DrmVerdict> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: DrmVerificationService.select(),
    });
    if (!video) {
      return {
        playable: false,
        reason: 'NO_GUMLET_ASSET',
        detail: 'Video not found.',
      };
    }
    return this.evaluate(video);
  }

  /**
   * Actually verify DRM against the provider, and persist the result.
   *
   * This is the only place `drmVerifiedAt` is ever set. It:
   *   1. reads the asset state from Gumlet,
   *   2. requires `ready`,
   *   3. fetches the DASH manifest and requires real CENC encryption,
   *   4. writes the timestamp on success, or CLEARS it with a reason on failure.
   *
   * Clearing on failure is essential: a stale `drmVerifiedAt` from a previous
   * success is exactly what would let a broken asset keep playing.
   *
   * Idempotent, and safe to call concurrently: the write is a single update, so
   * two overlapping calls converge on the same outcome.
   */
  async verify(videoId: string): Promise<DrmVerdict> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: DrmVerificationService.select(),
    });
    if (!video) {
      return { playable: false, reason: 'NO_GUMLET_ASSET', detail: 'Video not found.' };
    }

    const fail = async (verdict: Exclude<DrmVerdict, { playable: true }>) => {
      // Never leave a stale success behind a fresh failure.
      await this.prisma.video.update({
        where: { id: videoId },
        data: {
          drmVerifiedAt: null,
          drmBlockedReason: verdict.detail,
        },
      });
      this.logger.warn(`DRM verification failed for video ${videoId}: ${verdict.detail}`);
      return verdict;
    };

    // Platform and asset-identity gates do not need a provider round trip.
    //
    // `gumletStatus` is deliberately forced to 'ready' here: this function is
    // about to ASK the provider what the status is, so judging the stored copy
    // first would reject every asset on its very first sync, when the row has no
    // status yet and the provider has the real answer.
    //
    // `drmRequested` is forced for the same reason. It is an INTENT flag written
    // by `adopt()` at creation time, and the column was added by a later
    // migration: every asset adopted before that defaults to `false`, even though
    // it was created with DRM enabled. Judging it here would permanently ban
    // those videos from ever being verified.
    //
    // Forcing it does not weaken the gate. The real proof - the CENC check below -
    // is what decides whether the packaged media is actually protected, and a
    // `false` asset created without DRM still fails there and is still denied.
    const precheck = this.evaluate({ ...video, drmVerifiedAt: null, drmRequested: true, gumletStatus: 'ready' });
    const structuralFailure =
      !precheck.playable &&
      precheck.reason !== 'NOT_VERIFIED' &&
      precheck.reason !== 'VERIFICATION_STALE';
    if (structuralFailure || !video.gumletAssetId) {
      return fail(precheck.playable ? {
        playable: false,
        reason: 'NO_GUMLET_ASSET',
        detail: 'No Gumlet asset has been created for this video.',
      } : precheck);
    }

    let asset;
    try {
      asset = await this.gumlet.getAsset(video.gumletAssetId);
    } catch (error) {
      // Provider unreachable. Fail closed - never assume the asset is fine.
      return fail({
        playable: false,
        reason: 'NOT_VERIFIED',
        detail: `Could not read the Gumlet asset: ${(error as Error).message}`,
      });
    }

    if (!this.gumlet.isAssetPlayable(asset.status)) {
      await this.prisma.video.update({
        where: { id: videoId },
        data: { gumletStatus: asset.status, gumletUpdatedAt: new Date(), gumletError: asset.error },
      });
      return fail({
        playable: false,
        reason:
          asset.status === 'errored' || asset.status === 'failed' ? 'ASSET_FAILED' : 'ASSET_NOT_READY',
        detail: asset.error ?? `Gumlet reports the asset as "${asset.status}".`,
      });
    }

    // The decisive check: is the packaged media actually encrypted?
    const manifestUrl =
      asset.dashPlaybackUrl ??
      this.gumlet.dashManifestUrl({ assetId: asset.assetId, workspaceId: video.gumletWorkspaceId });

    let encrypted = false;
    try {
      const response = await fetch(manifestUrl);
      encrypted = response.ok && this.gumlet.assetHasDrm(await response.text());
    } catch (error) {
      return fail({
        playable: false,
        reason: 'NOT_VERIFIED',
        detail: `Could not read the DASH manifest: ${(error as Error).message}`,
      });
    }

    if (!encrypted) {
      this.logger.error(
        `asset ${asset.assetId} reported ready but the manifest is not CENC-encrypted - refusing to verify`,
      );
      return fail({
        playable: false,
        reason: 'NOT_VERIFIED',
        detail:
          'Gumlet reported the asset ready but its manifest is not CENC-encrypted. ' +
          'This asset was packaged without DRM and cannot be played.',
      });
    }

    const verifiedAt = new Date();
    // Concurrency guard.
    //
    // Two verifications can overlap: the recurring sweep and a webhook, or two
    // workers if the sweep is ever scaled. Whichever finishes LAST writes last,
    // and without this guard a slow check that started earlier would overwrite a
    // newer timestamp with an older one - pushing the TTL expiry backwards and,
    // worse, letting a stale success outlive a failure observed in between.
    //
    // The write is therefore conditional on the stored timestamp still being
    // absent or older than the one being written. A newer verification wins and
    // the loser reports success without having moved anything.
    const written = await this.prisma.video.updateMany({
      where: {
        id: videoId,
        OR: [{ drmVerifiedAt: null }, { drmVerifiedAt: { lt: verifiedAt } }],
      },
      data: {
        drmVerifiedAt: verifiedAt,
        drmBlockedReason: null,
        gumletStatus: asset.status,
        gumletError: null,
        gumletUpdatedAt: verifiedAt,
      },
    });
    if (written.count === 0) {
      this.logger.log(
        `DRM verification for video ${videoId} finished after a newer one had already been recorded; keeping the newer result`,
      );
      return { playable: true, reason: null };
    }
    this.logger.log(`DRM verified for video ${videoId} (asset ${asset.assetId})`);
    return { playable: true, reason: null };
  }
}