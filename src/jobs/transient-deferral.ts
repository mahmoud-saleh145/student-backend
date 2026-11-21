import { DelayedError, type Job } from 'bullmq';
import type { Logger } from '@nestjs/common';

/**
 * Deferring a job through an INFRASTRUCTURE outage without spending its attempts.
 *
 * WHY THIS EXISTS
 *
 * On 2026-11-20 the laptop worker lost DNS for the database for 5.5 hours
 * (Wi-Fi network without a working resolver). Every job that touched the
 * database failed with P1001. Each queue has 2 attempts with a 15 s backoff,
 * so a web job burned both attempts in ~20 s and a mobile job in ~8.5 min.
 * Nothing about the videos was wrong; the jobs were simply out of attempts,
 * and the 30-minute sweep kept minting new generations that failed the same
 * way. One Gumlet asset was created during the outage and never recorded.
 *
 * WHAT IT DOES
 *
 * A failure that says nothing about the video (database unreachable, Gumlet
 * unreachable, a Gumlet create whose answer was lost) moves the job back to
 * the delayed set with `moveToDelayed` + `DelayedError`. BullMQ does not count
 * that as an attempt. The delay grows exponentially with jitter, so a fleet of
 * jobs does not stampede the database the moment it returns.
 *
 * WHY IT IS BOUNDED
 *
 * Each kind has a total window measured from the first deferral of the
 * current streak. Past it the job falls back to its normal attempt handling,
 * so a permanently broken configuration still ends in a visible failure
 * instead of an infinite loop. Deferral never creates a job, so it cannot grow
 * the queue: the same job is simply due later.
 *
 * The streak state lives in the job's own data (`transientDeferral`), so it
 * survives a worker restart, and a streak older than `resetAfterMs` since its
 * last deferral starts over (a new outage days later gets a fresh window).
 */

export type TransientFailureKind =
  /** Prisma could not reach Neon (P1001/P1002/P1008/P1017/P2024, pool start). */
  | 'database'
  /** Gumlet asset creation got no answer; the asset may exist. Reconcile first. */
  | 'gumlet-outcome-unknown'
  /** Another attempt holds the creation claim for this video. */
  | 'gumlet-create-pending'
  /** Gumlet answered with a transient failure (timeout, 5xx, 429, DNS). */
  | 'provider';

export interface TransientDeferralState {
  kind: TransientFailureKind;
  /** First deferral of this streak (ISO). */
  since: string;
  /** Most recent deferral (ISO). */
  last: string;
  /** Deferrals in this streak. */
  count: number;
}

export interface TransientDeferralPolicy {
  /** First delay ceiling; doubles per deferral. */
  baseDelayMs: number;
  /** Ceiling of any single delay. */
  maxDelayMs: number;
  /** Total time a streak may defer before the job falls back to attempts. */
  maxWindowMs: number;
  /** A gap this long since the last deferral starts a new streak. */
  resetAfterMs: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Per kind. The database window is long because the outage it was built for
 * lasted 5.5 hours; 12 hours covers an overnight outage on the laptop host.
 * Gumlet kinds are shorter: they either reconcile within minutes or point at
 * a provider problem a human should see.
 */
export const TRANSIENT_DEFERRAL_POLICIES: Record<TransientFailureKind, TransientDeferralPolicy> = {
  database: { baseDelayMs: 30_000, maxDelayMs: 10 * MINUTE, maxWindowMs: 12 * HOUR, resetAfterMs: 30 * MINUTE },
  provider: { baseDelayMs: 30_000, maxDelayMs: 10 * MINUTE, maxWindowMs: 6 * HOUR, resetAfterMs: 30 * MINUTE },
  'gumlet-outcome-unknown': {
    // Gumlet lists a new asset within seconds; give it a minute, then look again.
    baseDelayMs: 60_000,
    maxDelayMs: 5 * MINUTE,
    maxWindowMs: 2 * HOUR,
    resetAfterMs: 30 * MINUTE,
  },
  'gumlet-create-pending': { baseDelayMs: 60_000, maxDelayMs: 5 * MINUTE, maxWindowMs: 2 * HOUR, resetAfterMs: 30 * MINUTE },
};

export type DeferralPlan =
  | { exhausted: false; delayMs: number; state: TransientDeferralState }
  | { exhausted: true; state: TransientDeferralState | null };

/**
 * Pure: decides the next delay, or that the streak's window is used up.
 *
 * Jitter is "equal jitter" (a random point in [w/2, w]) rather than full
 * jitter, so a deferral never comes back almost immediately and burns a
 * database connection attempt for nothing.
 */
export function planTransientDeferral(
  previous: TransientDeferralState | null | undefined,
  kind: TransientFailureKind,
  now: number,
  options: { policy?: TransientDeferralPolicy; random?: () => number } = {},
): DeferralPlan {
  const policy = options.policy ?? TRANSIENT_DEFERRAL_POLICIES[kind];
  const random = options.random ?? Math.random;

  const continues =
    previous &&
    previous.kind === kind &&
    Number.isFinite(Date.parse(previous.last)) &&
    now - Date.parse(previous.last) <= policy.resetAfterMs;

  const since = continues ? Date.parse(previous!.since) : now;
  const count = continues ? previous!.count : 0;

  if (now - since >= policy.maxWindowMs) {
    return { exhausted: true, state: continues ? previous! : null };
  }

  const window = Math.min(policy.baseDelayMs * 2 ** count, policy.maxDelayMs);
  const delayMs = Math.max(1000, Math.round(window / 2 + random() * (window / 2)));

  return {
    exhausted: false,
    delayMs,
    state: { kind, since: new Date(since).toISOString(), last: new Date(now).toISOString(), count: count + 1 },
  };
}

/** Job data shape this helper adds to. */
export interface WithTransientDeferral {
  transientDeferral?: TransientDeferralState | null;
}

/**
 * Defers `job` for `kind` if its window allows; otherwise returns `false` and
 * the caller continues with its normal failure handling (attempt + backoff).
 *
 * On success this THROWS `DelayedError` (what BullMQ requires after
 * `moveToDelayed`), so callers write `await deferOrFallThrough(...)` and
 * handle the `false` return.
 *
 * If Redis itself is unreachable the job cannot be moved; that is logged and
 * `false` is returned, which keeps today's behaviour (the attempt is spent)
 * rather than leaving the job in an undefined state.
 */
export async function deferForTransientFailure<T extends WithTransientDeferral>(args: {
  job: Job<T>;
  token: string | undefined;
  kind: TransientFailureKind;
  logger: Pick<Logger, 'warn' | 'error'>;
  /** What failed, already safe to log (no host names, no secrets). */
  detail: string;
  videoId?: string;
  now?: number;
  random?: () => number;
}): Promise<false> {
  const now = args.now ?? Date.now();
  const plan = planTransientDeferral(args.job.data?.transientDeferral, args.kind, now, { random: args.random });
  if (plan.exhausted) {
    args.logger.error(
      structured('TRANSIENT_DEFERRAL_EXHAUSTED', {
        job: args.job.id,
        video: args.videoId,
        kind: args.kind,
        since: plan.state?.since,
        deferrals: plan.state?.count,
        detail: args.detail,
      }) + '; falling back to the normal attempt handling',
    );
    return false;
  }
  if (!args.token) {
    // Without the lock token BullMQ refuses moveToDelayed; keep the old path.
    return false;
  }
  try {
    await args.job.updateData({ ...(args.job.data as T), transientDeferral: plan.state });
    await args.job.moveToDelayed(now + plan.delayMs, args.token);
  } catch (error) {
    args.logger.error(
      structured('TRANSIENT_DEFERRAL_FAILED', {
        job: args.job.id,
        video: args.videoId,
        kind: args.kind,
        error: (error as Error)?.message ?? String(error),
      }) + '; the attempt is spent instead',
    );
    return false;
  }
  noteDeferral(args.kind, now);
  args.logger.warn(
    structured('TRANSIENT_DEFERRAL', {
      job: args.job.id,
      video: args.videoId,
      kind: args.kind,
      delayS: Math.round(plan.delayMs / 1000),
      deferral: plan.state.count,
      since: plan.state.since,
      detail: args.detail,
    }) + '; no attempt used',
  );
  throw new DelayedError();
}

/** `EVENT key=value ...`: grep-able, one line, values without spaces quoted. */
export function structured(event: string, fields: Record<string, unknown>): string {
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const s = String(v);
      return `${k}=${/\s|"/.test(s) ? JSON.stringify(s) : s}`;
    });
  return [event, ...parts].join(' ');
}

// ---------------------------------------------------------------------------
// Process-wide counters for the heartbeat (observability only)
// ---------------------------------------------------------------------------

const counters: Record<TransientFailureKind, { count: number; lastAt: string | null }> = {
  database: { count: 0, lastAt: null },
  provider: { count: 0, lastAt: null },
  'gumlet-outcome-unknown': { count: 0, lastAt: null },
  'gumlet-create-pending': { count: 0, lastAt: null },
};

function noteDeferral(kind: TransientFailureKind, now: number): void {
  counters[kind].count += 1;
  counters[kind].lastAt = new Date(now).toISOString();
}

/** Deferrals made by this process since it started, per kind. */
export function transientDeferralCounters(): Record<TransientFailureKind, { count: number; lastAt: string | null }> {
  return JSON.parse(JSON.stringify(counters));
}
