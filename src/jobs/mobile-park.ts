import type { Job, Queue } from 'bullmq';

/**
 * "Park and release": how a held mobile job waits WITHOUT being taken again.
 *
 * A job held by the operator pause used to be deferred for a minute at a
 * time: every minute the worker TOOK it (lock, `attemptsStarted` + 1), read
 * the pause flag and put it back. Each take is a moment in which a dropped
 * connection costs the job a stall or an attempt, and a held job was taken
 * sixty times an hour for as long as the hold lasted.
 *
 * Now a hold is enforced in two ways, neither of which takes the job:
 *
 *   - a FULL pause pauses the BullMQ queue itself, so no worker takes
 *     anything from it;
 *   - a HISTORICAL hold (the back catalogue waits, new uploads run) PARKS
 *     each historical job: on its single take it is moved to the delayed set
 *     with a due time years away. Nothing takes it again until the operator
 *     releases the hold, which promotes exactly the parked jobs.
 *
 * A parked job is recognised by its due time alone: nothing else in this
 * queue is ever delayed by more than minutes (deferrals) or hours (retry
 * backoff), so "due more than a year from now" cannot be anything else.
 */

/** How far ahead a parked job is due: effectively "until released". */
export const MOBILE_PARK_MS = 10 * 365 * 24 * 3600_000;

/** A delayed job due later than this from now is a parked one. */
export const MOBILE_PARKED_AFTER_MS = 365 * 24 * 3600_000;

/**
 * BullMQ 5 (verified against 5.81.3, `commands/includes/getDelayedScore.lua`)
 * scores the delayed set as `dueTimestamp * 0x1000 + counter`, the counter
 * keeping FIFO order among jobs due in the same millisecond (at most 4095).
 */
export const BULLMQ_DELAYED_SCORE_FACTOR = 0x1000;

/** The due time (epoch ms) encoded in a delayed-set score. */
export function dueTimeFromDelayedScore(score: number): number {
  return Math.floor(score / BULLMQ_DELAYED_SCORE_FACTOR);
}

/** The lowest delayed-set score that marks a job as parked at `now`. */
export function parkedScoreFloor(now: number): number {
  return (now + MOBILE_PARKED_AFTER_MS) * BULLMQ_DELAYED_SCORE_FACTOR;
}

/** The parts of a BullMQ Queue the park bookkeeping needs. */
type ParkQueue = Pick<Queue, 'client' | 'keys' | 'getJob'>;

/**
 * Ids of every parked job in the queue, read straight from the delayed set
 * (id + score). The whole set is read and filtered here, through the part of
 * BullMQ's client interface every adapter implements; this queue's delayed
 * set holds at most the back catalogue (hundreds), never a hot path.
 */
export async function listParkedJobIds(queue: ParkQueue, now = Date.now()): Promise<string[]> {
  const client = await queue.client;
  const flat = await client.zrange(queue.keys.delayed, 0, -1, { WITHSCORES: true });
  const floor = parkedScoreFloor(now);
  const ids: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (Number(flat[i + 1]) >= floor) ids.push(flat[i]);
  }
  return ids;
}

/** How many jobs are parked right now. */
export async function countParkedJobs(queue: ParkQueue, now = Date.now()): Promise<number> {
  return (await listParkedJobIds(queue, now)).length;
}

export interface PromoteParkedResult {
  /** Parked jobs moved back to the queue (waiting, prioritized, or paused). */
  promoted: string[];
  /** Listed as parked but no longer delayed when promoted (someone else got there first). */
  skipped: string[];
}

/**
 * Releases every PARKED job: each goes back to the queue with its id, data,
 * options, priority and counters unchanged (`Job#promote`). Delayed jobs that
 * are not parked - a deferral, a retry backoff - are not touched: they are
 * not in the score range read here.
 *
 * Throws on a Redis error. Already-promoted jobs are reported, not thrown,
 * so a second release after a partial one converges.
 */
export async function promoteParkedJobs(queue: ParkQueue, now = Date.now()): Promise<PromoteParkedResult> {
  const ids = await listParkedJobIds(queue, now);
  const result: PromoteParkedResult = { promoted: [], skipped: [] };
  for (const id of ids) {
    const job = (await queue.getJob(id)) as Job | undefined;
    if (!job) {
      result.skipped.push(id);
      continue;
    }
    try {
      await job.promote();
      result.promoted.push(id);
    } catch (error) {
      // BullMQ refuses a job that is no longer in the delayed set; that is the
      // only refusal that means "nothing to do". Anything else is real.
      const client = await queue.client;
      if ((await client.zscore(queue.keys.delayed, id)) === null) {
        result.skipped.push(id);
        continue;
      }
      throw error;
    }
  }
  return result;
}
