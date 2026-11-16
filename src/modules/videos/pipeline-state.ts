import { createHash } from 'node:crypto';

import { isTerminalGumletFailure } from './gumlet-failure';

/**
 * The three independent states of one video, and the identities of the jobs
 * that drive them.
 *
 * A `videos` row carries three separate lifecycles that must never be read as
 * one:
 *
 *   SOURCE   the original file in R2          (`sourceKey`, `sourceSizeBytes`)
 *   GUMLET   the managed DRM pipeline (web)   (`status`, `gumlet*`, `drm*`)
 *   MOBILE   our own AES-128 HLS ladder       (`mobile*`, `hlsPrefix`, renditions)
 *
 * `Video.status` is the GUMLET/web lifecycle (plus "upload not finished yet").
 * It says nothing about the mobile ladder, and `mobileStatus` says nothing
 * about Gumlet. Everything here is a pure function of the row, so the API, the
 * worker, the dashboard contract and the tests all derive the same answer.
 */

// ---------------------------------------------------------------------------
// Job identity
// ---------------------------------------------------------------------------

/**
 * Bump when the mobile ladder's output format changes in a way that makes old
 * output unusable (not for tuning). Part of the job identity.
 */
export const MOBILE_HLS_PROFILE_VERSION = 1;

/**
 * The BullMQ job id of one mobile processing intent.
 *
 * Derived from the database row (video + profile + generation), never from a
 * clock, so every process that looks at the same intent computes the same id
 * and BullMQ collapses the duplicates into one job. A new intent (a retry, a
 * recovery after a failed job) bumps the generation and therefore gets a new
 * id.
 *
 * Exactly three colon-separated parts: BullMQ rejects custom ids with any
 * other number of colons.
 */
export function mobileJobIdFor(videoId: string, generation: number): string {
  return `mobile-hls:${videoId}:p${MOBILE_HLS_PROFILE_VERSION}g${generation}`;
}

/**
 * The job id of the web/Gumlet job queued when an upload is confirmed.
 *
 * Every upload attempt mints a fresh source key, so the key identifies "this
 * file of this video". A finalisation request that is retried (a dropped
 * response, a double click, two browser tabs) therefore maps to the SAME job
 * and cannot start the Gumlet ingest twice.
 */
export function uploadTranscodeJobIdFor(videoId: string, sourceKey: string): string {
  const digest = createHash('sha256').update(sourceKey).digest('hex').slice(0, 16);
  return `transcode:${videoId}:src${digest}`;
}

/** BullMQ states in which a job is still going to run (or is running). */
export function isLiveJobState(state: string | null | undefined): boolean {
  return (
    state === 'waiting' ||
    state === 'active' ||
    state === 'delayed' ||
    state === 'prioritized' ||
    state === 'waiting-children'
  );
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

export type SourceState = 'NONE' | 'UPLOADING' | 'VERIFIED';

/**
 * VERIFIED only once `completeUpload` has seen the object in R2 and recorded
 * its length. A key alone means an upload was started, not that bytes arrived.
 */
export function sourceStateOf(video: { sourceKey: string | null; sourceSizeBytes: bigint | number | null }): SourceState {
  if (!video.sourceKey) return 'NONE';
  return video.sourceSizeBytes === null || video.sourceSizeBytes === undefined ? 'UPLOADING' : 'VERIFIED';
}

// ---------------------------------------------------------------------------
// Gumlet
// ---------------------------------------------------------------------------

/**
 * NOT_APPLICABLE  legacy video, never routed to Gumlet
 * WAITING_UPLOAD  the source is not confirmed yet
 * PENDING         accepted, waiting for a worker to submit it to Gumlet
 * SUBMITTED       Gumlet has the asset; it has not reported progress yet
 * PROCESSING      Gumlet is transcoding / packaging (or DRM proof is pending)
 * READY           playable with verified DRM
 * FAILED          the submission or the asset failed
 */
export type GumletPipelineState =
  | 'NOT_APPLICABLE'
  | 'WAITING_UPLOAD'
  | 'PENDING'
  | 'SUBMITTED'
  | 'PROCESSING'
  | 'READY'
  | 'FAILED';

export function gumletStateOf(video: {
  status: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletStatus: string | null;
}): GumletPipelineState {
  if (video.drmProvider !== 'gumlet') return 'NOT_APPLICABLE';
  if (video.status === 'READY' || video.status === 'ARCHIVED') {
    return isTerminalGumletFailure(video.gumletStatus) ? 'FAILED' : 'READY';
  }
  if (video.status === 'FAILED') return 'FAILED';
  if (isTerminalGumletFailure(video.gumletStatus)) return 'FAILED';
  if (video.status === 'UPLOADING') return 'WAITING_UPLOAD';
  if (!video.gumletAssetId) return 'PENDING';
  if (!video.gumletStatus || video.gumletStatus === 'queued' || video.gumletStatus === 'pre-queued') {
    return 'SUBMITTED';
  }
  return 'PROCESSING';
}

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

/** READY, with a prefix and at least one rendition: what the manifest needs. */
export function mobileLadderReady(video: {
  mobileStatus?: string | null;
  hlsPrefix?: string | null;
  renditions: unknown[];
}): boolean {
  return video.mobileStatus === 'READY' && Boolean(video.hlsPrefix) && video.renditions.length > 0;
}

/**
 * The Gumlet/web states in which a READY mobile ladder may still be served.
 *
 * FAILED / QUEUED / PROCESSING are verdicts about the GUMLET pipeline only: a
 * rejected asset, an ingest still running. They say nothing about the mobile
 * ladder, which was produced from the same verified source by a different
 * system.
 *
 * UPLOADING and ARCHIVED are different in kind and are NOT listed: UPLOADING
 * means the source itself is being (re)sent, and ARCHIVED is a deliberate
 * staff decision to take the lecture down. Neither is overridden by a ladder.
 */
const MOBILE_SERVABLE_DESPITE = new Set(['FAILED', 'QUEUED', 'PROCESSING']);

/**
 * Whether the mobile ladder alone is enough to play this video: Gumlet is not
 * READY, for a reason that is Gumlet's own, and the mobile ladder is complete.
 */
export function mobileLadderCanCarry(video: {
  status: string;
  mobileStatus?: string | null;
  hlsPrefix?: string | null;
  renditions: unknown[];
}): boolean {
  return MOBILE_SERVABLE_DESPITE.has(video.status) && mobileLadderReady(video);
}

/**
 * The video status a STUDENT client is shown.
 *
 * The apps gate their "Watch" button on this single field. Reporting the raw
 * Gumlet state to a native app would hide a lecture it can actually play
 * (Gumlet rejected the file, the mobile ladder is READY). So a client that
 * will be served the mobile ladder sees READY in exactly that case; every
 * other client and every other case sees the raw state, unchanged.
 *
 * This only decides what is DISPLAYED. The ticket endpoint re-checks
 * everything with the real device binding before it grants anything.
 */
export function studentFacingVideoStatus(
  video: { status: string; mobileStatus?: string | null; hlsPrefix?: string | null; renditions: unknown[] },
  client: { mobileHls: boolean },
): string {
  return client.mobileHls && mobileLadderCanCarry(video) ? 'READY' : video.status;
}
