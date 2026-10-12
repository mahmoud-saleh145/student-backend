/**
 * Migration planning for existing videos onto the Gumlet DRM path.
 *
 * WHY THIS IS A SEPARATE MODULE
 *
 * `GumletIngestService` knows how to get ONE video onto Gumlet. It says nothing
 * about which videos *should* be migrated, in what order, or which must be left
 * alone. Those are batch-level decisions, and putting them inside the single-video
 * service is how a backfill quietly adopts a video nobody asked for.
 *
 * So this module is deliberately PURE. It takes plain row data and returns a
 * decision. It performs no I/O, touches no Prisma, calls no Gumlet API and reads
 * no environment variable. That makes every rule below directly unit-testable,
 * and it means a bug here can never partially apply - the worst outcome of a
 * planning bug is a wrong *report*, not a wrong database.
 *
 * The single most important property: `plan()` NEVER returns an action for a
 * video that is not already fully migrated or already a safe candidate. Anything
 * doubtful is `skip` with a stated reason, and `reason` is what the report shows.
 */

/** The subset of `Video` this planner needs. Deliberately narrow and plain. */
export interface VideoRow {
  id: string;
  status: string;
  /** null = legacy R2 + AES-128 HLS. 'gumlet' = Gumlet. Anything else = unknown. */
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletStatus: string | null;
  /** The uploaded original. Null means there is nothing to hand to Gumlet. */
  sourceKey: string | null;
  /** Legacy HLS artefacts. Present means it currently plays. */
  masterPlaylistKey: string | null;
  deletedAt: Date | null;
}

export type MigrationAction =
  /** Create a Gumlet asset and adopt this video onto it. */
  | 'adopt'
  /** Already on Gumlet. Re-check status; never create a second asset. */
  | 'verify'
  /**
   * A video on legacy whose Gumlet asset died permanently. Discards the dead
   * asset id so a fresh asset can be built. ONLY produced when the caller
   * explicitly opts in - it is the one action that discards provider state.
   */
  | 'replace'
  /** Do nothing. `reason` says why. */
  | 'skip';

export type SkipReason =
  | 'ALREADY_MIGRATED_READY'
  | 'SOFT_DELETED'
  | 'NO_SOURCE_OBJECT'
  | 'NO_LEGACY_PLAYBACK'
  | 'ALREADY_PROCESSING'
  | 'UNKNOWN_PROVIDER'
  | 'NOT_SAFE_TO_MIGRATE'
  | 'REPLACE_FAILED_GUMLET_ASSET'
  | 'REPAIR_FAILED_GUMLET_ASSET';

export interface MigrationPlan {
  videoId: string;
  action: MigrationAction;
  reason: SkipReason | 'CANDIDATE_LEGACY_READY' | 'CANDIDATE_GUMLET_PENDING';
  /** Human-readable, safe to print. Never contains a secret. */
  detail: string;
  /** True when the row needs no write at all. */
  noOp: boolean;
}

/**
 * Ordering.
 *
 * Videos that already have a Gumlet asset come FIRST. Two reasons:
 *
 *   1. They are the cheapest work - no asset is created, so no billing and no
 *      chance of a duplicate asset from a half-finished earlier attempt.
 *   2. They are the highest-value verification. A video already adopted is
 *      exactly the population that proves whether the integration works at all,
 *      and it does so without touching a single student-visible row.
 *
 * Everything else is ordered oldest-first by id so a resumed run makes the same
 * choices in the same order as the run it is continuing.
 */
const ACTION_PRIORITY: Record<MigrationAction, number> = {
  verify: 0,
  adopt: 1,
  replace: 2,
  skip: 3,
};

/**
 * Decide what to do with one video.
 *
 * Pure. No I/O, no side effects, no throwing on unexpected data - an unexpected
 * row becomes a `skip` with a reason, never an exception, because a migration
 * must not abort halfway because one row is odd.
 */
export function planVideo(
  video: VideoRow,
  options?: { allowAssetReplacement?: boolean; allowGumletProviderReplacement?: boolean },
): MigrationPlan {
  const base = { videoId: video.id };

  // Soft-deleted. Touching these would resurrect content a staff member removed.
  if (video.deletedAt) {
    return {
      ...base,
      action: 'skip',
      reason: 'SOFT_DELETED',
      detail: 'Row is soft-deleted; it is not part of the active catalogue.',
      noOp: true,
    };
  }

  // THE DUPLICATE-ASSET GUARD.
  //
  // If a `gumletAssetId` is stored, an asset already exists at the provider.
  // Creating another one is the only way this tool could double-bill or
  // double-ingest a video, so every branch below this point is non-creating
  // UNLESS the caller explicitly opts into replacement and the stored asset is
  // a terminal failure (see below).
  //
  // This deliberately does NOT require `drmProvider === 'gumlet'`. A row with a
  // leftover asset id and a null provider is an inconsistent row (a failed
  // switch, or a hand edit), and it is exactly the case where blindly adopting
  // would create a second asset. Verifying is the only safe action for it.
  if (video.gumletAssetId) {
    const ready = video.drmProvider === 'gumlet' && video.status === 'READY';

    // REPLACEMENT, the single opt-in escape hatch.
    //
    // Only for a video that is still being delivered by legacy, that is
    // currently READY (i.e. genuinely playing), and whose asset reached a
    // terminal failure. Such an asset will never recover, so re-syncing it
    // forever accomplishes nothing - it just re-reads the same dead status.
    // Replacing is the only way forward, and it is gated three ways over:
    // the caller must ask for it, the video must be on legacy, and the asset
    // must be terminally dead.
    const terminalFailure = video.gumletStatus === 'errored' || video.gumletStatus === 'failed';
    // A stored source is what a replacement is built from. Without one the plan
    // should be "skip" (report it) rather than "replace" (fail later), so the
    // condition is checked here as a planning concern, not only at execution.
    const hasSource = Boolean(video.sourceKey);
    if (
      options?.allowAssetReplacement === true &&
      video.drmProvider !== 'gumlet' &&
      video.status === 'READY' &&
      hasSource &&
      terminalFailure
    ) {
      return {
        ...base,
        action: 'replace',
        reason: 'REPLACE_FAILED_GUMLET_ASSET',
        detail:
          `Gumlet asset ${video.gumletAssetId} ended as "${video.gumletStatus}" and cannot recover. ` +
          'Replacement explicitly requested; the dead asset id will be discarded and a fresh asset ' +
          'created from the same stored source. Legacy playback continues until the new asset is verified.',
        noOp: false,
      };
    }

    // REPAIR of a video already routed to Gumlet.
    //
    // A separate, separately-gated hatch. This video is on the Gumlet path and
    // already dark: the asset is terminally failed, so there is no live delivery
    // to protect and no unprotected fallback to weaken. Without this path there
    // is NO supported way out - `sync()` re-reads the same dead status forever -
    // which is how six published lessons ended up permanently unplayable.
    //
    // Still gated on an explicit per-call opt-in and a terminal failure, and
    // `replaceFailedAsset()` re-asserts both, plus configuration and source
    // presence, before it writes anything.
    if (
      options?.allowGumletProviderReplacement === true &&
      video.drmProvider === 'gumlet' &&
      hasSource &&
      terminalFailure
    ) {
      return {
        ...base,
        action: 'replace',
        reason: 'REPAIR_FAILED_GUMLET_ASSET',
        detail:
          `Gumlet asset ${video.gumletAssetId} ended as "${video.gumletStatus}" while this video was on the Gumlet path, so it is not playable. ` +
          'Repair explicitly requested; the dead asset id will be discarded and a fresh asset created from the same stored source.',
        noOp: false,
      };
    }

    return {
      ...base,
      action: 'verify',
      reason: ready ? 'ALREADY_MIGRATED_READY' : 'CANDIDATE_GUMLET_PENDING',
      detail: ready
        ? 'Already on Gumlet and READY; re-check only. No asset will be created.'
        : terminalFailure && video.drmProvider !== 'gumlet'
          ? `Gumlet asset ${video.gumletAssetId} ended as "${video.gumletStatus}" and will not recover on its own. ` +
            'Legacy playback is preserved. Re-run with --replace-errored-assets to build a replacement.'
          : `An asset id is already stored (Gumlet status "${video.gumletStatus ?? 'unknown'}"). ` +
            'Will sync the existing asset and never create a second one.',
      noOp: ready,
    };
  }

  // Provider set to 'gumlet' but no asset id. A half-finished adoption may
  // already have created an asset at the provider that was never recorded here,
  // so creating one now could duplicate it. Blocked for a human rather than
  // guessed at.
  if (video.drmProvider === 'gumlet' && !video.gumletAssetId) {
    return {
      ...base,
      action: 'skip',
      reason: 'NOT_SAFE_TO_MIGRATE',
      detail:
        'drmProvider is "gumlet" but no asset id is stored. A previous adoption may have ' +
        'created an asset that was never recorded. Resolve this by hand before migrating.',
      noOp: true,
    };
  }

  // A provider value we do not recognise. `resolvePlaybackTarget` treats anything
  // that is not exactly 'gumlet' as legacy, so a typo'd provider would silently
  // keep serving HLS. Worth surfacing rather than overwriting.
  if (video.drmProvider !== null && video.drmProvider !== 'gumlet') {
    return {
      ...base,
      action: 'skip',
      reason: 'UNKNOWN_PROVIDER',
      detail: `Unrecognised drmProvider "${video.drmProvider}"; refusing to guess what it means.`,
      noOp: true,
    };
  }

  // Legacy video. From here on it is a candidate, subject to the checks below.

  // No uploaded original means nothing to hand to Gumlet. Adopting would either
  // fail at the provider or, worse, create an empty asset.
  if (!video.sourceKey) {
    return {
      ...base,
      action: 'skip',
      reason: 'NO_SOURCE_OBJECT',
      detail: 'No stored source object, so there is nothing for Gumlet to ingest.',
      noOp: true,
    };
  }

  // Never overwrite a row that is mid-transcode on the legacy pipeline. The
  // local worker owns it and would fight the migration.
  if (video.status === 'PROCESSING' || video.status === 'QUEUED' || video.status === 'UPLOADING') {
    return {
      ...base,
      action: 'skip',
      reason: 'ALREADY_PROCESSING',
      detail: `Legacy status "${video.status}" is in flight on the ffmpeg pipeline; leave it to the worker.`,
      noOp: true,
    };
  }

  // Has no legacy playback artefacts and is not READY: a broken legacy row.
  // Adopting it would switch a video that never played onto a path that also
  // cannot play yet, which is a regression, not a migration.
  if (!video.masterPlaylistKey && video.status !== 'READY') {
    return {
      ...base,
      action: 'skip',
      reason: 'NO_LEGACY_PLAYBACK',
      detail:
        `Legacy status "${video.status}" with no HLS artefacts. This lesson does not play ` +
        'today, so migrating it is a repair, not a migration. Fix it on the legacy path first.',
      noOp: true,
    };
  }

  // The ordinary case: a working legacy video with a source object. Safe to adopt.
  return {
    ...base,
    action: 'adopt',
    reason: 'CANDIDATE_LEGACY_READY',
    detail: 'Legacy video with a stored source; eligible for Gumlet adoption.',
    noOp: false,
  };
}

/**
 * Plan a whole batch, then order it.
 *
 * `limit` bounds how many videos one run touches. It is applied AFTER ordering so
 * a resumed run picks up exactly where the previous one stopped rather than
 * re-deciding the batch.
 */
export function planBatch(
  rows: VideoRow[],
  limit?: number,
  options?: { allowAssetReplacement?: boolean; allowGumletProviderReplacement?: boolean },
): MigrationPlan[] {
  const plans = rows.map((row) => planVideo(row, options));
  plans.sort((a, b) => {
    const byAction = ACTION_PRIORITY[a.action] - ACTION_PRIORITY[b.action];
    if (byAction !== 0) return byAction;
    return a.videoId < b.videoId ? -1 : a.videoId > b.videoId ? 1 : 0;
  });
  return typeof limit === 'number' && limit > 0 ? plans.slice(0, limit) : plans;
}

/** Roll a plan list up into the counts the report prints. */
export function summarize(plans: MigrationPlan[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const p of plans) {
    counts[p.reason] = (counts[p.reason] ?? 0) + 1;
  }
  return counts;
}