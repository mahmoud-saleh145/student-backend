/**
 * Historical mobile HLS safety watchdog.
 *
 * Runs as its own container next to the laptop worker (see docker-compose.watchdog.yml),
 * so it survives Claude Code sessions, terminal closes and worker restarts. It reuses the
 * worker image only for its Node runtime and client libraries; it starts no Nest app and
 * consumes no queue.
 *
 * WHAT IT DOES
 *   Every WATCHDOG_INTERVAL_SEC it probes the three things historical encoding needs:
 *     - the database   (a bounded `select 1` through Prisma),
 *     - Redis          (PING),
 *     - R2             (a 1-key List on the media bucket, read-only).
 *   It PAUSES historical mobile processing when either safety threshold is crossed:
 *     A. an outage (any probe failing) lasting WATCHDOG_OUTAGE_PAUSE_SEC or longer, or
 *     B. WATCHDOG_NETFAIL_THRESHOLD mobile jobs failing with a network-type reason within
 *        WATCHDOG_NETFAIL_WINDOW_MIN (each one burns one of the job's two attempts).
 *   Pausing = writing the same Redis key, with the same shape, as the API's
 *   POST /videos/mobile/pause. The mobile processor reads it before each job and defers.
 *
 * WHAT IT NEVER DOES (by design)
 *   - It never resumes. Resuming is an explicit operator decision (POST /videos/mobile/resume
 *     or the operator script); there is no automatic resume policy.
 *   - It never touches the original upload queue (`video-processing`): new uploads and their
 *     Gumlet ingest are not affected by the pause flag at all.
 *   - It never interrupts a running encode, removes, moves or retries a job, or writes to the
 *     database or R2. A job already running when the pause lands finishes (or fails) normally,
 *     and the existing retry and recovery-sweep behaviour is unchanged.
 *   - It only pauses when historical mobile work is actually queued or running.
 *
 * A total outage also cuts the watchdog off from Redis, so it cannot write the flag DURING
 * the outage. It then pauses on the first tick at which Redis is reachable again, polling
 * every WATCHDOG_OUTAGE_POLL_SEC while an outage is in progress to keep that window short.
 *
 * Every decision (trip, pause, already-paused, recovery, skip) is logged as one JSON line to
 * stdout and to WATCHDOG_LOG.
 */
'use strict';
process.removeAllListeners('warning');
const fs = require('node:fs');
const path = require('node:path');
const NM = process.env.WATCHDOG_NODE_MODULES || '/app/node_modules';
const Redis = require(`${NM}/ioredis`);
const { PrismaClient } = require(`${NM}/@prisma/client`);
const { S3Client, ListObjectsV2Command } = require(`${NM}/@aws-sdk/client-s3`);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const CFG = {
  intervalSec: num(process.env.WATCHDOG_INTERVAL_SEC, 30),
  outagePollSec: num(process.env.WATCHDOG_OUTAGE_POLL_SEC, 10),
  outagePauseSec: num(process.env.WATCHDOG_OUTAGE_PAUSE_SEC, 600),
  netfailWindowMin: num(process.env.WATCHDOG_NETFAIL_WINDOW_MIN, 120),
  netfailThreshold: num(process.env.WATCHDOG_NETFAIL_THRESHOLD, 3),
  probeTimeoutMs: num(process.env.WATCHDOG_PROBE_TIMEOUT_MS, 10000),
  prefix: process.env.WATCHDOG_REDIS_PREFIX || process.env.REDIS_PREFIX || 'edu',
  dryRun: process.env.WATCHDOG_DRY_RUN === 'true',
  log: process.env.WATCHDOG_LOG || '/var/log/edu-watchdog/watchdog.log',
  maxTicks: num(process.env.WATCHDOG_MAX_TICKS, Infinity), // tests only
};
const PAUSE_KEY = `${CFG.prefix}:mobile:transcode:paused`;
const HEARTBEAT_KEY = `${CFG.prefix}:watchdog:heartbeat`;
const MQ = `${CFG.prefix}:bull:mobile-video-processing:`;
const NETWORK_FAILURE = /socket hang up|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|TLS connection|network|Can't reach database|Unable to start a transaction|P1001|P1008|P1017|P2024/i;

try { fs.mkdirSync(path.dirname(CFG.log), { recursive: true }); } catch { /* stdout still works */ }
function log(event, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
  console.log(line);
  try { fs.appendFileSync(CFG.log, line + '\n'); } catch { /* keep running */ }
}
const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
};
const short = (e) => String((e && e.message) || e).split('\n').filter(Boolean).pop().replace(/[a-z0-9.-]+\.(neon\.tech|upstash\.io|r2\.cloudflarestorage\.com)[:0-9]*/gi, '<host>').slice(0, 160);

// --- clients ------------------------------------------------------------------
let prisma = new PrismaClient({ log: [] });
let dbFailStreak = 0;
const redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, connectTimeout: 8000, maxRetriesPerRequest: 1, enableOfflineQueue: false, retryStrategy: (n) => Math.min(n * 1000, 10000) });
redis.on('error', () => { /* probes report it */ });
redis.connect().catch(() => undefined);
const s3 = new S3Client({
  region: process.env.R2_REGION || 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: !!process.env.R2_ENDPOINT && !/r2\.cloudflarestorage\.com/.test(process.env.R2_ENDPOINT),
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
});

async function probeDb() {
  await withTimeout(prisma.$queryRawUnsafe('select 1'), CFG.probeTimeoutMs, 'db');
}
async function probeRedis() {
  if (redis.status !== 'ready') {
    // Not connected yet (startup) or reconnecting: wait for the client to be ready
    // rather than reporting a false outage on the first tick.
    if (redis.status === 'wait' || redis.status === 'end') redis.connect().catch(() => undefined);
    await withTimeout(new Promise((resolve) => redis.once('ready', resolve)), CFG.probeTimeoutMs, 'redis connect');
  }
  const pong = await withTimeout(redis.ping(), CFG.probeTimeoutMs, 'redis');
  if (pong !== 'PONG') throw new Error('unexpected PING reply');
}
async function probeR2() {
  await withTimeout(s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_MEDIA, Prefix: 'hls/', MaxKeys: 1 })), CFG.probeTimeoutMs, 'r2');
}

/** Historical mobile work queued or running (jobs wait / prioritized / delayed / active). */
async function pendingWork() {
  const [w, p, d, a] = await Promise.all([redis.llen(MQ + 'wait'), redis.zcard(MQ + 'prioritized'), redis.zcard(MQ + 'delayed'), redis.llen(MQ + 'active')]);
  return { wait: w, prioritized: p, delayed: d, active: a, total: w + p + d + a };
}

/** Mobile jobs whose latest failure was network-type, within the window (any state). */
async function recentNetworkFailures() {
  const since = Date.now() - CFG.netfailWindowMin * 60_000;
  const ids = new Set();
  for (const key of ['failed', 'delayed', 'prioritized']) {
    for (const id of await redis.zrange(MQ + key, 0, -1)) ids.add(id);
  }
  for (const id of await redis.lrange(MQ + 'wait', 0, -1)) ids.add(id);
  const hits = [];
  for (const id of ids) {
    const [reason, finishedOn, processedOn] = await redis.hmget(MQ + id, 'failedReason', 'finishedOn', 'processedOn');
    const when = Number(finishedOn || processedOn || 0);
    if (reason && NETWORK_FAILURE.test(reason) && when >= since) hits.push({ id: id.split(':')[1], reason: short(reason), at: new Date(when).toISOString() });
  }
  return hits;
}

async function pausedNow() {
  return redis.get(PAUSE_KEY);
}
async function writePause(reason) {
  if (CFG.dryRun) { log('pause_dry_run', { reason }); return; }
  // Same key and shape as POST /videos/mobile/pause (scratch-guard writePauseState); no TTL.
  await redis.set(PAUSE_KEY, JSON.stringify({ reason: reason.slice(0, 200), by: 'safety-watchdog', at: new Date().toISOString() }));
}

// --- state machine --------------------------------------------------------------
const state = { outageSince: null, failing: [], pendingPause: null, lastNetfailIds: '', ticks: 0, startedAt: new Date().toISOString() };

async function tick() {
  state.ticks += 1;
  const results = {};
  for (const [name, fn] of [['redis', probeRedis], ['db', probeDb], ['r2', probeR2]]) {
    try { await fn(); results[name] = 'ok'; } catch (e) { results[name] = short(e); }
  }
  // A Prisma query on a silently dead connection never settles; after 3 timed-out
  // probes, start a fresh client (the old one is abandoned, never awaited).
  if (results.db !== 'ok') { dbFailStreak += 1; if (dbFailStreak >= 3) { const old = prisma; prisma = new PrismaClient({ log: [] }); old.$disconnect().catch(() => undefined); dbFailStreak = 0; } } else dbFailStreak = 0;

  const failing = Object.entries(results).filter(([, v]) => v !== 'ok').map(([k]) => k);
  const now = Date.now();
  if (failing.length) {
    if (!state.outageSince) { state.outageSince = now; log('outage_start', { failing, detail: results }); }
    else if (failing.join() !== state.failing.join()) log('outage_change', { failing, detail: results });
    const secs = Math.round((now - state.outageSince) / 1000);
    if (secs >= CFG.outagePauseSec && !state.pendingPause && !state.trippedThisOutage) {
      state.pendingPause = `auto-paused by safety watchdog: ${secs} s outage (${failing.join(', ')})`;
      state.trippedThisOutage = true; // once per outage
      log('threshold_outage', { seconds: secs, failing });
    }
  } else if (state.outageSince) {
    log('outage_end', { seconds: Math.round((now - state.outageSince) / 1000), note: 'connectivity restored; processing is NOT resumed automatically' });
    state.outageSince = null;
    state.trippedThisOutage = false;
  }
  state.failing = failing;

  if (results.redis !== 'ok') return; // nothing more can be read or written until Redis is back

  // Threshold B: network-caused job failures within the window.
  try {
    const hits = await recentNetworkFailures();
    const sig = hits.map((h) => h.id).sort().join(',');
    if (hits.length >= CFG.netfailThreshold && !state.pendingPause && sig !== state.lastNetfailIds) {
      state.pendingPause = `auto-paused by safety watchdog: ${hits.length} network-caused mobile job failures in ${CFG.netfailWindowMin} min`;
      state.lastNetfailIds = sig;
      log('threshold_network_failures', { count: hits.length, jobs: hits });
    }
  } catch (e) { log('netfail_scan_error', { error: short(e) }); }

  // Act on a tripped threshold as soon as Redis is reachable.
  if (state.pendingPause) {
    try {
      const existing = await pausedNow();
      const work = await pendingWork();
      if (existing) {
        log('already_paused', { by: safeBy(existing), reason: state.pendingPause });
      } else if (work.total === 0) {
        log('pause_skipped_no_historical_work', { reason: state.pendingPause, work });
      } else {
        await writePause(state.pendingPause);
        log('PAUSED', { reason: state.pendingPause, work, dryRun: CFG.dryRun });
      }
      state.pendingPause = null;
    } catch (e) { log('pause_write_error', { error: short(e), reason: state.pendingPause }); }
  }

  try {
    await redis.set(HEARTBEAT_KEY, JSON.stringify({ at: new Date().toISOString(), startedAt: state.startedAt, ticks: state.ticks, probes: results, outageSince: state.outageSince && new Date(state.outageSince).toISOString(), cfg: { outagePauseSec: CFG.outagePauseSec, netfailThreshold: CFG.netfailThreshold, netfailWindowMin: CFG.netfailWindowMin, dryRun: CFG.dryRun } }), 'EX', 600);
  } catch { /* heartbeat is best effort */ }
}
function safeBy(json) { try { return JSON.parse(json).by; } catch { return 'unknown'; } }

/** Liveness for the container health check: touched every tick, outage or not. */
function alive() { try { fs.writeFileSync('/tmp/watchdog.alive', String(Date.now())); } catch { /* health check will notice */ } }

(async () => {
  log('start', { cfg: { ...CFG, log: undefined }, pauseKey: PAUSE_KEY.replace(/^[^:]+/, '<prefix>') });
  for (;;) {
    try { await tick(); } catch (e) { log('tick_error', { error: short(e) }); }
    alive();
    if (state.ticks >= CFG.maxTicks) break;
    await new Promise((r) => setTimeout(r, (state.outageSince ? CFG.outagePollSec : CFG.intervalSec) * 1000));
  }
  log('stop', { ticks: state.ticks });
  process.exit(0);
})();
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('stop', { signal: sig }); process.exit(0); });
