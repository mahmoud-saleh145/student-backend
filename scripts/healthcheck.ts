/* eslint-disable no-console */
/**
 * =============================================================================
 * Container healthcheck
 * =============================================================================
 *
 * One image runs two roles, and they are not healthy in the same way. Getting
 * this wrong is why the worker could not simply be deployed as a service and
 * ended up running on a laptop:
 *
 *   • The API listens on `PORT`, so `GET /api/v1/meta/health` answers.
 *   • The worker calls `createApplicationContext` and opens **no** HTTP
 *     listener at all. A healthcheck that fetches a port on the worker gets
 *     ECONNREFUSED forever, the container is permanently `unhealthy`, and an
 *     orchestrator that trusts that signal will restart it in a loop. The
 *     worker never transcodes anything and never says why.
 *
 * So the check follows the role:
 *
 *   API    → the public health endpoint.
 *   worker → its own heartbeat in Redis, the same key `/meta/health/deep`
 *            reports to an operator. A worker that has not checked in for three
 *            minutes is not processing anything, and that is exactly the state
 *            worth restarting.
 *
 * The worker check deliberately ignores the `ffmpeg`/`ffprobe` flags in the
 * heartbeat payload. A missing binary is a permanent, unfixable-by-restart
 * condition, and failing the check would only turn a clear diagnosis into a
 * crash loop. They are printed instead.
 *
 * Runs in the production image, so it uses compiled output:
 *   node dist/scripts/healthcheck.js
 */
import Redis from 'ioredis';

/**
 * Kept in step with WORKER_HEARTBEAT_KEY in src/jobs/worker-heartbeat.ts, and
 * pinned to it by test/unit/healthcheck.spec.ts.
 */
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat';

/**
 * Kept in step with WORKER_HEARTBEAT_TTL_SECONDS in
 * src/jobs/worker-heartbeat.ts, and pinned to it by test/unit/healthcheck.spec.ts.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 180;

export type Role = 'api' | 'worker';

/**
 * Which role this process is running.
 *
 * `RUN_WORKERS=true` is what src/worker.ts sets for *its own* process before the
 * module graph loads, because jobs.module.ts reads it to decide whether to
 * register the BullMQ processors.
 *
 * The catch, and the reason the container has to set it too: this script is a
 * separate process from the worker. It does not import src/worker.ts, so it never
 * inherits that assignment. A container that ran the worker without exporting
 * RUN_WORKERS would be classified as the API and asked to probe an HTTP port its
 * own process does not serve — reporting unhealthy while consuming jobs fine.
 * That failure is silent and wrong in the direction that hides a real outage, so
 * the variable is documented and set in docker-compose.yml rather than inferred.
 */
export function roleFromEnv(env: Record<string, unknown> = process.env): Role {
  return env.RUN_WORKERS === 'true' ? 'worker' : 'api';
}

export interface WorkerBeat {
  pid?: number;
  host?: string;
  startedAt?: string;
  at?: string;
  ffmpeg?: boolean;
  ffprobe?: boolean;
}

/**
 * True when a worker has checked in recently.
 *
 * Exported for its own sake rather than for the script: the rule "a beat older
 * than its own TTL means dead" is the whole point, and it is testable without a
 * Redis server.
 */
export function beatIsFresh(
  raw: string | null,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): boolean {
  if (!raw) return false;

  let beat: WorkerBeat;
  try {
    beat = JSON.parse(raw) as WorkerBeat;
  } catch {
    // A corrupt value is not evidence of life.
    return false;
  }
  if (!beat.at) return false;

  const ageSeconds = (nowMs - new Date(beat.at).getTime()) / 1000;
  // Slightly generous: a beat whose clock is a little ahead should not read as
  // stale, and the TTL already gives Redis its own expiry.
  return ageSeconds <= ttlSeconds + 5;
}

async function checkApi(): Promise<boolean> {
  const port = process.env.PORT ?? '3000';
  const url = `http://127.0.0.1:${port}/api/v1/meta/health`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkWorker(redisUrl: string, prefix: string): Promise<boolean> {
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true,
    connectTimeout: 5_000,
  });

  try {
    await client.connect();
    const raw = await client.get([prefix, WORKER_HEARTBEAT_KEY].join(':'));

    if (raw) {
      try {
        const beat = JSON.parse(raw) as WorkerBeat;
        // Diagnostics, not a verdict: see the note at the top of this file.
        console.error(
          `[healthcheck] worker pid ${beat.pid ?? '?'} on ${beat.host ?? '?'}, ` +
            `up since ${beat.startedAt ?? '?'}, ffmpeg=${beat.ffmpeg} ffprobe=${beat.ffprobe}`,
        );
        if (beat.ffmpeg === false || beat.ffprobe === false) {
          console.error(
            '[healthcheck] the worker cannot transcode: ffmpeg/ffprobe are not runnable in this image',
          );
        }
      } catch {
        /* a corrupt payload is reported as stale below */
      }
    }

    // TTL is a constant, not an env var: the key expires on its own in Redis, so
    // this only has to catch a key whose `at` is older than that expiry. Reading
    // it from the environment would let an operator believe they had widened the
    // window while the worker was still expiring the beat on its own schedule.
    return beatIsFresh(raw, WORKER_HEARTBEAT_TTL_SECONDS);
  } catch (e) {
    console.error(`[healthcheck] worker heartbeat unreadable: ${(e as Error).message}`);
    return false;
  } finally {
    client.disconnect();
  }
}

async function main(): Promise<void> {
  const role = roleFromEnv();

  if (role === 'api') {
    const ok = await checkApi();
    console.error(`[healthcheck] api ${ok ? 'ok' : 'unreachable'}`);
    process.exit(ok ? 0 : 1);
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error('[healthcheck] REDIS_URL is not set; cannot confirm the worker is alive');
    process.exit(1);
  }

  const ok = await checkWorker(redisUrl, process.env.REDIS_PREFIX ?? 'edu');
  console.error(`[healthcheck] worker ${ok ? 'ok' : 'no recent heartbeat'}`);
  process.exit(ok ? 0 : 1);
}

// Only run when invoked directly, so the helpers above stay unit-testable.
if (require.main === module) {
  void main();
}