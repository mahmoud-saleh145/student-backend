import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VideoStatus } from '@prisma/client';

import type { VideoConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { GumletDrmService } from '../playback/gumlet-drm.service';
import { StorageService } from '../storage/storage.service';
import { GumletIngestService } from './gumlet-ingest.service';
import { MigrationPlan, VideoRow, planBatch, summarize } from './gumlet-migration.plan';

/**
 * Batch migration of existing videos onto the Gumlet DRM path.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * This is NOT a second implementation of Gumlet adoption. It has no signing code,
 * no asset-API client and no CENC check of its own. It delegates every one of
 * those to the same `GumletDrmService` and `GumletIngestService` that the upload
 * flow and the dashboard use. That is the whole point: a migration that used a
 * second copy of the adoption logic could pass its own tests while disagreeing
 * with production about what "ready" means.
 *
 * The only things this file adds are the batch-level concerns that
 * `GumletIngestService` deliberately does not have: a read-only dry run, bounded
 * batches, resume, retries with backoff, and a report.
 *
 * WHY MIGRATION IS SAFE HERE
 *
 * `GumletIngestService.adopt()` sets `status = PROCESSING` on adoption and only
 * returns a video to READY once Gumlet reports ready AND the manifest is
 * confirmed CENC-encrypted. A video mid-migration therefore does not play, but
 * it never plays UNPROTECTED: `resolvePlaybackTarget` refuses a Gumlet video
 * outright rather than degrading it to HLS. The legacy R2 objects are never
 * deleted, so a rollback is a provider flip plus a re-transcode.
 *
 * WHAT A MIGRATION DOES NOT DO
 *
 *   * It never touches student authorisation, entitlement, device or session
 *     logic. Those run identically before and after a migration; only the
 *     manifest and licence a ticket points at change.
 *   * It never deletes a source object, a rendition or a legacy asset.
 *   * It never runs against production without an explicit confirm token, and it
 *     refuses to start at all if Gumlet is not fully configured - a half-migrated
 *     library is far worse than an unmigrated one.
 */

/** Reasons an individual video failed, kept stable so the report can group them. */
export type MigrationFailureReason =
  | 'GUMLET_ASSET_API_ERROR'
  | 'RATE_LIMITED'
  | 'NETWORK_ERROR'
  | 'STORAGE_NOT_CONFIGURED'
  | 'SOURCE_UNAVAILABLE'
  | 'NOT_CONFIGURED'
  | 'UNKNOWN';

export interface VideoOutcome {
  videoId: string;
  action: MigrationPlan['action'];
  result: 'ADOPTED' | 'VERIFIED_READY' | 'PENDING' | 'SKIPPED' | 'FAILED';
  /** Safe to print. Never a secret, token or signed URL. */
  detail: string;
  gumletStatus: string | null;
  attempts: number;
  failureReason?: MigrationFailureReason;
}

export interface MigrationReport {
  dryRun: boolean;
  startedAt: string;
  finishedAt: string;
  totalRows: number;
  planned: number;
  outcomes: VideoOutcome[];
  summary: Record<string, number>;
  skipped: Record<string, number>;
  failures: Record<string, number>;
  /** True when every non-skip video ended playable. */
  allPlayable: boolean;
}

/** Classify a thrown error without leaking its contents into the report. */
/**
 * Make an error message safe to print.
 *
 * Provider error bodies echo the input URL they were given, and for an ingestion
 * failure that URL IS a signed R2 URL carrying `X-Amz-Signature` and
 * `X-Amz-Credential`. Anything URL-shaped is therefore replaced rather than
 * truncated, so a diagnostic that is worth keeping cannot become a credential
 * leak. The classification above happens on the RAW message; only the printable
 * form is sanitised.
 */
function sanitizeError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
    .slice(0, 200);
}

function classifyFailure(message: string): MigrationFailureReason {
  const m = message.toLowerCase();
  // Storage is checked FIRST. Its error text also contains "not configured",
  // so the generic rule below used to absorb it and report a missing-Gumlet-
  // credentials problem for what was actually a missing R2 credential. That
  // misdiagnosis is what made the first replacement attempt clear an asset id
  // and then stop.
  if (m.includes('object storage') || m.includes('r2_')) return 'STORAGE_NOT_CONFIGURED';
  if (m.includes('source object is missing') || m.includes('no stored source')) {
    return 'SOURCE_UNAVAILABLE';
  }
  if (m.includes('not configured') || m.includes('gumlet_asset') || m.includes('gumlet signing')) {
    return 'NOT_CONFIGURED';
  }
  if (m.includes('429') || m.includes('rate limit') || m.includes('too many requests')) {
    return 'RATE_LIMITED';
  }
  if (
    m.includes('fetch failed') ||
    m.includes('econnreset') ||
    m.includes('etimedout') ||
    m.includes('enotfound') ||
    m.includes('network')
  ) {
    return 'NETWORK_ERROR';
  }
  if (m.includes('gumlet') || m.includes('asset')) return 'GUMLET_ASSET_API_ERROR';
  return 'UNKNOWN';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class GumletMigrationService {
  private readonly logger = new Logger(GumletMigrationService.name);
  private readonly drm: VideoConfig['drm'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly gumlet: GumletDrmService,
    private readonly ingest: GumletIngestService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.drm = config.getOrThrow<VideoConfig>('video').drm;
  }

  /**
   * Everything the operator needs to know before starting, computed without
   * changing anything.
   *
   * This is the check that answers "is it safe to run at all?". A migration that
   * starts while signing is unconfigured would move videos onto a path that
   * cannot serve them, so `preflight()` reports that as a blocker and `run()`
   * refuses on it.
   */
  preflight(): {
    ok: boolean;
    blockers: string[];
    warnings: string[];
    assetApiConfigured: boolean;
    signingConfigured: boolean;
    drmEnabled: boolean;
    storageConfigured: boolean;
  } {
    const blockers: string[] = [];
    const warnings: string[] = [];

    const assetApiConfigured = this.gumlet.isAssetApiConfigured();
    const signingConfigured = this.gumlet.isSigningConfigured();
    const drmEnabled = this.drm.enabled;
    // Object storage is what the transcoder actually fetches the source from.
    // Its absence was invisible here, so a run passed preflight and only failed
    // once `adopt()` tried to sign an R2 URL - after `replaceFailedAsset()` had
    // already discarded the previous asset id. Checked first and explicitly.
    const storageConfigured = this.storage.isConfigured;

    if (!storageConfigured) {
      blockers.push(
        'Object storage is not configured: R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required to hand the source to Gumlet. No asset can be created without them.',
      );
    }
    if (!assetApiConfigured) {
      blockers.push(
        'Gumlet asset API is not configured: GUMLET_API_KEY and GUMLET_WORKSPACE_ID are both required to create an asset.',
      );
    }
    if (!signingConfigured) {
      // Adoption could technically proceed, but a migrated video could not be
      // played, so it is treated as a blocker rather than a warning.
      blockers.push(
        'Gumlet signing is not configured: GUMLET_ORG_ID and GUMLET_SIGN_SECRET are required or migrated videos cannot be served.',
      );
    }
    if (this.drm.provider !== 'gumlet') {
      blockers.push(
        `DRM_PROVIDER is "${this.drm.provider}", not "gumlet". Migrated videos would be refused at playback time.`,
      );
    }
    if (!drmEnabled) {
      blockers.push(
        'DRM_ENABLED is false. resolvePlaybackTarget refuses any Gumlet-backed video while this is false, so migrating now would take working lessons offline.',
      );
    }

    if (drmEnabled && storageConfigured && assetApiConfigured && signingConfigured && this.drm.provider === 'gumlet') {
      warnings.push(
        'Live checks are NOT performed by this service. Asset status and CENC encryption are confirmed by GumletIngestService.sync(), which runs for every adopted video.',
      );
    }

    return {
      ok: blockers.length === 0,
      blockers,
      warnings,
      assetApiConfigured,
      signingConfigured,
      drmEnabled,
      storageConfigured,
      // Deliberately no secret-derived value of any kind. Whether signing is
      // configured is the only fact an operator needs, and a fingerprint - even a
      // truncated HMAC - is derived from the secret and does not belong in
      // routine output.
    };
  }

  /**
   * Read every video row and plan it. No writes, no Gumlet traffic.
   */
  async plan(
    limit?: number,
    options?: {
      allowAssetReplacement?: boolean;
      allowGumletProviderReplacement?: boolean;
      onlyVideoIds?: string[];
    },
  ): Promise<MigrationPlan[]> {
    const only = options?.onlyVideoIds;
    const rows = await this.prisma.video.findMany({
      // A targeted run touches ONLY the named videos. This exists so an operator
      // can migrate or repair one lesson without re-verifying every healthy
      // Gumlet video on the platform - re-syncing a healthy video is not free,
      // because `sync()` will demote it to FAILED if the manifest check blips.
      where: { ...notDeleted, ...(only?.length ? { id: { in: only } } : {}) },
      select: {
        id: true,
        status: true,
        drmProvider: true,
        gumletAssetId: true,
        gumletStatus: true,
        sourceKey: true,
        masterPlaylistKey: true,
        deletedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return planBatch(rows as VideoRow[], limit, {
      allowAssetReplacement: options?.allowAssetReplacement,
      allowGumletProviderReplacement: options?.allowGumletProviderReplacement,
    });
  }

  /**
   * A dry run reports exactly what a real run would do and changes nothing.
   *
   * It is deliberately the same code path as `run()` up to the point of action,
   * so a dry run cannot drift from the behaviour it is predicting.
   */
  async dryRun(
    limit?: number,
    options?: {
      allowAssetReplacement?: boolean;
      allowGumletProviderReplacement?: boolean;
      onlyVideoIds?: string[];
    },
  ): Promise<MigrationReport> {
    const startedAt = new Date();
    // NOTE: no preflight gate here, deliberately. Reading the plan is safe and
    // useful even when migration is impossible, and the blockers belong in the
    // report. Only `run()` refuses on a failed preflight.
    const plans = await this.plan(limit, options);

    const outcomes: VideoOutcome[] = plans.map((p) => ({
      videoId: p.videoId,
      action: p.action,
      result: p.action === 'skip' ? 'SKIPPED' : p.noOp ? 'VERIFIED_READY' : 'PENDING',
      detail: p.detail,
      gumletStatus: null,
      attempts: 0,
    }));

    return {
      dryRun: true,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalRows: plans.length,
      planned: plans.filter((p) => p.action !== 'skip').length,
      outcomes,
      summary: summarize(plans),
      skipped: {},
      failures: {},
      allPlayable: false,
    };
  }

  /**
   * Migrate a bounded batch of videos.
   *
   * Resume is a property of the DATA, not of this process: a video that already
   * carries a `gumletAssetId` plans as `verify`, so re-running after an
   * interruption re-checks it instead of creating a second asset. Killing this
   * process at any point and running it again is therefore safe, and there is no
   * checkpoint file to corrupt.
   *
   * Batches are bounded and each video is attempted independently, so one
   * failure never stops the rest; that is what makes partial completion useful
   * rather than merely survivable.
   */
  async run(options?: {
    limit?: number;
    maxAttempts?: number;
    baseDelayMs?: number;
    allowAssetReplacement?: boolean;
    /**
     * Repair a video whose asset failed while it was ALREADY routed to Gumlet.
     * Separate from `allowAssetReplacement` because it is a genuinely different
     * act: the other flag replaces a dead asset on a video still served by
     * legacy, this one replaces a dead asset on a video that is already dark.
     * Off by default; the CLI sets it only from an explicit flag.
     */
    allowGumletProviderReplacement?: boolean;
    onlyVideoIds?: string[];
    onOutcome?: (o: VideoOutcome) => void;
  }): Promise<MigrationReport> {
    const startedAt = new Date();
    const pre = this.preflight();
    if (!pre.ok) {
      // Refuse rather than half-migrate. The operator fixes config and re-runs.
      // Only the blocker text is echoed: it is written by this file, names
      // environment variables, and contains no value.
      throw new Error(`Refusing to migrate: ${pre.blockers.join(' ')}`);
    }

    const maxAttempts = options?.maxAttempts ?? 3;
    const baseDelayMs = options?.baseDelayMs ?? 2000;
    const plans = await this.plan(options?.limit, {
      allowAssetReplacement: options?.allowAssetReplacement === true,
    allowGumletProviderReplacement: options?.allowGumletProviderReplacement === true,
      onlyVideoIds: options?.onlyVideoIds,
    });
    const outcomes: VideoOutcome[] = [];

    for (const plan of plans) {
      if (plan.action === 'skip') {
        const outcome: VideoOutcome = {
          videoId: plan.videoId,
          action: plan.action,
          result: 'SKIPPED',
          detail: plan.detail,
          gumletStatus: null,
          attempts: 0,
        };
        outcomes.push(outcome);
        options?.onOutcome?.(outcome);
        continue;
      }

      const outcome = await this.runOne(
        plan,
        maxAttempts,
        baseDelayMs,
        options?.allowGumletProviderReplacement === true,
      );
      outcomes.push(outcome);
      options?.onOutcome?.(outcome);
    }

    const failures: Record<string, number> = {};
    const skipped: Record<string, number> = {};
    for (const o of outcomes) {
      if (o.result === 'FAILED') {
        failures[o.failureReason ?? 'UNKNOWN'] = (failures[o.failureReason ?? 'UNKNOWN'] ?? 0) + 1;
      }
      if (o.result === 'SKIPPED') {
        const p = plans.find((x) => x.videoId === o.videoId);
        const key = p?.reason ?? 'UNKNOWN';
        skipped[key] = (skipped[key] ?? 0) + 1;
      }
    }

    const actionable = outcomes.filter((o) => o.action !== 'skip');
    return {
      dryRun: false,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      totalRows: plans.length,
      planned: actionable.length,
      outcomes,
      summary: summarize(plans),
      skipped,
      failures,
      allPlayable: actionable.every((o) => o.result === 'ADOPTED' || o.result === 'VERIFIED_READY'),
    };
  }

  /**
   * One video, with bounded retries and exponential backoff.
   *
   * A retried `adopt()` is still safe: once the first attempt has written a
   * `gumletAssetId`, every subsequent `adopt()` call short-circuits to `sync()`.
   * Retrying therefore cannot create a duplicate asset, which is the whole reason
   * the idempotency guard lives in `GumletIngestService` rather than here.
   */
  private async runOne(
    plan: MigrationPlan,
    maxAttempts: number,
    baseDelayMs: number,
    allowGumletProviderReplacement = false,
  ): Promise<VideoOutcome> {
    let lastError = '';
    let lastStatus: string | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // The SAME methods the dashboard calls. No migration-specific path.
        const result =
          plan.action === 'verify'
            ? await this.ingest.sync(plan.videoId)
            : plan.action === 'replace'
              ? await this.ingest.replaceFailedAsset(plan.videoId, {
                  allowGumletProviderReplacement,
                })
              : await this.ingest.adopt(plan.videoId);

        lastStatus = result.status;

        if (result.status === 'ready') {
          return {
            videoId: plan.videoId,
            action: plan.action,
            result: 'ADOPTED',
            detail:
              plan.action === 'verify'
                ? 'Already on Gumlet; sync confirmed the asset is ready and CENC-encrypted.'
                : plan.action === 'replace'
                  ? 'Replacement asset created and already ready + CENC-encrypted.'
                  : 'Adopted onto Gumlet. Playback stays refused until Gumlet reports ready and the manifest is CENC-encrypted.',
            gumletStatus: result.status,
            attempts: attempt,
          };
        }

        if (result.status === 'errored' || result.status === 'failed') {
          // A terminal provider outcome. Retrying will not help, so record it and
          // move on rather than burning the batch on a poison row.
          return {
            videoId: plan.videoId,
            action: plan.action,
            result: 'FAILED',
            detail: `Gumlet reported "${result.status}". Resolve in the Gumlet dashboard, then re-run; the row is recoverable.`,
            gumletStatus: result.status,
            attempts: attempt,
            failureReason: 'GUMLET_ASSET_API_ERROR',
          };
        }

        // Still processing. That is a success for a batch runner - adoption is
        // asynchronous and the dashboard's existing 5s poll finishes the job.
        return {
          videoId: plan.videoId,
          action: plan.action,
          result: 'PENDING',
          detail: `Gumlet is still processing (status "${result.status}"). It becomes playable once ready + CENC-confirmed; re-run or let the dashboard poll.`,
          gumletStatus: result.status,
          attempts: attempt,
        };
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        const reason = classifyFailure(lastError);

        if (reason === 'NOT_CONFIGURED' || reason === 'STORAGE_NOT_CONFIGURED') {
          // Configuration will not fix itself between attempts, so retrying is
          // pointless. The reason is reported distinctly and the sanitised
          // message is kept, because "some credential is missing" without saying
          // which is what made this failure expensive to diagnose the first time.
          return {
            videoId: plan.videoId,
            action: plan.action,
            result: 'FAILED',
            detail:
              reason === 'STORAGE_NOT_CONFIGURED'
                ? `Object storage is not configured; no asset was created and no row was changed. (${sanitizeError(lastError)})`
                : `Gumlet is not configured; refused rather than partially migrating. (${sanitizeError(lastError)})`,
            gumletStatus: lastStatus,
            attempts: attempt,
            failureReason: reason,
          };
        }

        if (attempt === maxAttempts) break;

        // Exponential backoff. Rate limits get the longest wait because that is
        // the one failure where retrying quickly makes it worse.
        const delay = reason === 'RATE_LIMITED' ? baseDelayMs * 4 * attempt : baseDelayMs * 2 ** (attempt - 1);
        this.logger.warn(
          `video ${plan.videoId} attempt ${attempt}/${maxAttempts} failed (${reason}); retrying in ${delay}ms`,
        );
        await sleep(delay);
      }
    }

    return {
      videoId: plan.videoId,
      action: plan.action,
      result: 'FAILED',
      // The message is classified but NOT echoed: it can contain a signed
      // ingestion URL from the provider.
      detail: `Failed after ${maxAttempts} attempts (${classifyFailure(lastError)}). The row is unchanged or recoverable; re-run to retry.`,
      gumletStatus: lastStatus,
      attempts: maxAttempts,
      failureReason: classifyFailure(lastError),
    };
  }

  /** Count rows for the report header. Read-only. */
  async census(): Promise<{ total: number; byStatus: Record<string, number> }> {
    const grouped = await this.prisma.video.groupBy({
      by: ['status'],
      where: { ...notDeleted },
      _count: { _all: true },
    });
    return {
      total: grouped.reduce((n, g) => n + g._count._all, 0),
      byStatus: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
    };
  }

  /** Only used by the rollback runbook. Deliberately not wired to any endpoint. */
  async countOnGumlet(): Promise<number> {
    return this.prisma.video.count({
      where: { ...notDeleted, drmProvider: 'gumlet', status: VideoStatus.READY },
    });
  }
}