import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { GumletDrmService, GumletRequestError } from '../playback/gumlet-drm.service';

/**
 * Reasons a fresh provider check can resolve. Everything else is either a
 * platform/configuration gate or a definitive stored failure, and asking the
 * provider again on the playback path would not change the answer.
 */
const REFRESHABLE_REASONS = new Set(['NOT_VERIFIED', 'VERIFICATION_STALE', 'DRM_NOT_REQUESTED', 'ASSET_NOT_READY']);

/** After the provider could not be reached for a video, don't ask again for this long. */
const UNAVAILABLE_BACKOFF_MS = 60_000;

/** Transient = the provider could not be asked. Unknown errors count as transient. */
export function isTransientProviderError(error: unknown): boolean {
  return !(error instanceof GumletRequestError) || error.transient;
}

/** Manifest statuses that describe the CDN, not the asset. 403/404/410 are definitive. */
export function isTransientManifestStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

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
        /** The provider could not be asked; nothing was concluded or written. */
        | 'VERIFICATION_UNAVAILABLE'
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
    this.graceSeconds = Number(process.env.DRM_VERIFICATION_GRACE_SECONDS ?? 86400); // 24h
  }

  /**
   * How long past the TTL an earlier successful proof is still honoured on the
   * playback path WHILE the provider cannot be reached. Never applies after a
   * definitive failure (which clears the proof) or to a video never verified.
   */
  private readonly graceSeconds: number;

  /** Per-process single flight: concurrent tickets for one video share one check. */
  private readonly inFlight = new Map<string, Promise<DrmVerdict>>();
  /** Per-process negative cache: videoId -> when the provider was last unreachable. */
  private readonly unavailableAt = new Map<string, number>();

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
   * Clearing on a DEFINITIVE failure is essential: a stale `drmVerifiedAt` from
   * a previous success is exactly what would let a broken asset keep playing.
   *
   * A TRANSIENT failure - the provider could not be asked (timeout, network,
   * 5xx, 429, rejected API credentials) - writes nothing and returns
   * VERIFICATION_UNAVAILABLE after `attempts` tries. It proves nothing about
   * the asset either way, so it must not erase a proof that was valid.
   *
   * Idempotent, and safe to call concurrently: the write is a single update, so
   * two overlapping calls converge on the same outcome.
   */
  async verify(videoId: string, options: { attempts?: number } = {}): Promise<DrmVerdict> {
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

    const attempts = Math.max(1, Math.min(options.attempts ?? 2, 3));
    const assetId = video.gumletAssetId;

    let asset;
    try {
      asset = await this.withRetry(attempts, () => this.gumlet.getAsset(assetId));
    } catch (error) {
      // Could not ASK the provider. That says nothing about the asset, so an
      // earlier proof is left exactly as it is (the caller decides whether a
      // bounded grace applies) - erasing it here turned every provider blip
      // into an immediate playback outage for the videos being re-verified.
      if (isTransientProviderError(error)) {
        return this.unavailable(videoId, `Could not read the Gumlet asset: ${(error as Error).message}`);
      }
      // Gumlet answered definitively (404/410 or an error body): no such asset.
      return fail({
        playable: false,
        reason: 'NO_GUMLET_ASSET',
        detail: `Gumlet has no usable asset for this video: ${(error as Error).message}`,
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

    let manifest: { status: number; ok: boolean; text: string };
    try {
      manifest = await this.withRetry(attempts, async () => {
        const m = await this.gumlet.fetchManifest(manifestUrl);
        if (!m.ok && isTransientManifestStatus(m.status)) {
          throw new GumletRequestError(`Manifest read failed with HTTP ${m.status}`, true, m.status);
        }
        return m;
      });
    } catch (error) {
      if (isTransientProviderError(error)) {
        return this.unavailable(videoId, `Could not read the DASH manifest: ${(error as Error).message}`);
      }
      throw error;
    }

    if (!manifest.ok) {
      // 403/404/410 from the CDN: the packaged media is not servable (this is
      // exactly how Gumlet answers for a deleted asset). Definitive.
      return fail({
        playable: false,
        reason: 'NOT_VERIFIED',
        detail: `The DASH manifest returned HTTP ${manifest.status}; this asset cannot be played.`,
      });
    }

    const encrypted = this.gumlet.assetHasDrm(manifest.text);
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

    // DRM intent. `drmRequested` may be established here ONLY from a record of
    // the request - ours (already true, written by adopt()) or the provider's
    // (`input.transformations.drm.type` names Widevine, the system the CENC
    // DASH manifest just proved). Assets adopted before the column existed read
    // `false` while Gumlet records them as created with DRM; without this, a
    // verified asset was still refused as DRM_NOT_REQUESTED on every ticket.
    // With neither record the asset stays unverified: encryption alone does not
    // say the platform asked for this asset to be protected.
    const providerRecordsDrm = (asset.drmSystems ?? []).includes('widevine');
    if (!video.drmRequested && !providerRecordsDrm) {
      return fail({
        playable: false,
        reason: 'DRM_NOT_REQUESTED',
        detail:
          asset.drmSystems === null
            ? 'Gumlet did not report which DRM systems this asset was created with, and DRM was never requested for it here.'
            : 'Gumlet records this asset as created without Widevine DRM, and DRM was never requested for it here.',
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
        // Established above from our own or the provider's record of the
        // request; always true for a row that reaches this write.
        drmRequested: true,
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
    } else {
      this.logger.log(`DRM verified for video ${videoId} (asset ${asset.assetId})`);
    }

    // Report exactly what the playback path will now decide for the row as
    // written, instead of a hard-coded success that could disagree with it.
    // (count === 0 means a NEWER success is stored; the same verdict holds.)
    return this.evaluate({
      ...video,
      drmRequested: true,
      drmVerifiedAt: verifiedAt,
      drmBlockedReason: null,
      gumletStatus: asset.status,
    });
  }

  /**
   * The playback-path gate: is this video playable RIGHT NOW, refreshing the
   * proof on demand if it has lapsed.
   *
   * This is what removes the dependency on any background process for
   * playback. Whatever process issues the ticket re-verifies a lapsed proof
   * itself (one provider check per video, shared by concurrent requests), so
   * playback works with no worker running at all.
   *
   *   * fresh proof                     -> playable, no provider call
   *   * lapsed/missing, check succeeds  -> playable (proof renewed)
   *   * lapsed, check fails definitively-> refused (proof cleared by verify)
   *   * lapsed, provider unreachable    -> playable ONLY if an earlier real
   *                                        proof is within TTL + grace and no
   *                                        definitive failure was recorded;
   *                                        otherwise refused
   *   * platform/config gates           -> refused, no provider call
   */
  async ensurePlayable(videoId: string): Promise<DrmVerdict> {
    const video = await this.prisma.video.findFirst({
      where: { id: videoId, ...notDeleted },
      select: DrmVerificationService.select(),
    });
    if (!video) return { playable: false, reason: 'NO_GUMLET_ASSET', detail: 'Video not found.' };

    const current = this.evaluate(video);
    if (current.playable || !REFRESHABLE_REASONS.has(current.reason)) return current;

    const recentlyUnavailable = (this.unavailableAt.get(videoId) ?? 0) > Date.now() - UNAVAILABLE_BACKOFF_MS;
    const refreshed: DrmVerdict = recentlyUnavailable
      ? { playable: false, reason: 'VERIFICATION_UNAVAILABLE', detail: 'Provider recently unreachable.' }
      : await this.singleFlight(videoId);

    if (refreshed.playable || refreshed.reason !== 'VERIFICATION_UNAVAILABLE') return refreshed;

    if (this.withinGrace(video)) {
      this.logger.warn(
        `Provider unreachable; honouring the earlier DRM proof of video ${videoId} within the grace window`,
      );
      return { playable: true, reason: null };
    }
    return current;
  }

  /** One provider check per video at a time in this process; one attempt on the playback path. */
  private singleFlight(videoId: string): Promise<DrmVerdict> {
    const existing = this.inFlight.get(videoId);
    if (existing) return existing;
    const run = this.verify(videoId, { attempts: 1 })
      .then((verdict) => {
        if (verdict.reason === 'VERIFICATION_UNAVAILABLE') this.unavailableAt.set(videoId, Date.now());
        else this.unavailableAt.delete(videoId);
        return verdict;
      })
      .finally(() => this.inFlight.delete(videoId));
    this.inFlight.set(videoId, run);
    return run;
  }

  /**
   * An earlier REAL proof, no recorded definitive failure, every structural
   * gate still satisfied, and not older than TTL + grace.
   */
  private withinGrace(video: VideoForVerdict): boolean {
    if (!video.drmVerifiedAt || !video.drmRequested || video.drmBlockedReason) return false;
    // Re-run every non-time gate (platform, signing, provider, asset, status).
    if (!this.evaluate({ ...video, drmVerifiedAt: new Date() }).playable) return false;
    const ageSeconds = (Date.now() - video.drmVerifiedAt.getTime()) / 1000;
    return ageSeconds <= this.ttlSeconds + this.graceSeconds;
  }

  private unavailable(videoId: string, detail: string): DrmVerdict {
    this.logger.warn(`DRM verification for video ${videoId} could not reach the provider: ${detail}`);
    return { playable: false, reason: 'VERIFICATION_UNAVAILABLE', detail };
  }

  /** Retries TRANSIENT provider failures with a short linear backoff; definitive ones are thrown at once. */
  private async withRetry<T>(attempts: number, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        if (attempt >= attempts || !isTransientProviderError(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }
}