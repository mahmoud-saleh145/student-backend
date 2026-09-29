/**
 * How hard the queue polls Redis.
 *
 * This file exists because of a bill. The platform runs on Upstash, which
 * charges per Redis **request**, and a BullMQ worker is not idle when it has
 * no work: each `Worker` blocks on the queue's marker key for `drainDelay`
 * seconds, and the moment that lapses it asks again. At the library default of
 * 5 seconds, four queues generate roughly
 *
 *     4 workers × (60 / 5) = 48 requests per minute ≈ 69,000 per day
 *
 * of pure "anything for me?" — before a single student has opened the app.
 * That alone exhausts a 500,000-request monthly allowance in about a week.
 *
 * `stalledInterval` is the second clock: every worker scans for jobs abandoned
 * by a crashed peer on that cadence, which is another request per queue.
 *
 * The cost of raising these is latency to *pick up* a job, and it is worth
 * being concrete about what that means per queue rather than applying one
 * number everywhere — which is why the two profiles below exist.
 *
 * None of this changes how fast a job runs once claimed, and none of it
 * changes behaviour when a job is enqueued while the worker is already awake:
 * BullMQ wakes immediately on the marker, so an idle worker with a 30-second
 * drain delay still starts a newly enqueued job within milliseconds. The delay
 * is only the worst case after a missed notification.
 */

const seconds = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

/**
 * For work a person is waiting on: a push notification, a transcode the
 * teacher just kicked off. Still six times cheaper than the default.
 */
export const RESPONSIVE_WORKER = {
  drainDelay: seconds(process.env.QUEUE_DRAIN_DELAY_SECONDS, 30),
  stalledInterval: seconds(process.env.QUEUE_STALLED_INTERVAL_SECONDS, 60) * 1000,
} as const;

/**
 * For work nobody is watching: the maintenance sweep and the nightly rollup
 * are driven by their own schedules, so the pickup delay is invisible.
 */
export const BACKGROUND_WORKER = {
  drainDelay: seconds(process.env.QUEUE_BACKGROUND_DRAIN_DELAY_SECONDS, 60),
  stalledInterval: seconds(process.env.QUEUE_BACKGROUND_STALLED_INTERVAL_SECONDS, 300) * 1000,
} as const;
