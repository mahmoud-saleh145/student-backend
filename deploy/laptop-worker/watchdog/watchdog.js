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
 *     B. WATCHDOG_NETFAIL_THRESHOLD network-type mobile job FAILURES within
 *        WATCHDOG_NETFAIL_WINDOW_MIN (each one burns one of the job's two attempts).
 *   Pausing = writing the same Redis key, with the same shape, as the API's
 *   POST /videos/mobile/pause. The mobile processor reads it before each job and defers.
 *
 * HOW FAILURES ARE COUNTED (threshold B)
 *   A failure is an EVENT: one failed attempt of one job, identified by (job id, `atm`).
 *   BullMQ increments a job's `atm` (attempts made) exactly once per failed attempt and
 *   never otherwise. It stores NO timestamp for a failure that will be retried: the retry
 *   goes through the same `moveToDelayed` script as a pause deferral, which refreshes the
 *   job's `processedOn` every time the paused worker picks the job up and puts it back.
 *   `processedOn` is therefore NOT a failure time. (Before this fix it was used as one,
 *   so a failure from yesterday looked "recent" forever while processing stayed paused,
 *   and the watchdog would have re-paused as soon as anyone resumed.)
 *   Each event's time is, in order of preference:
 *     - `finishedOn`, which BullMQ writes when a job fails for the LAST time (genuine);
 *     - otherwise the moment this watchdog first saw that (job, atm) - at most one poll
 *       interval after the real failure, later only if Redis itself was unreachable.
 *   The events are kept in a small Redis ledger (<prefix>:watchdog:netfail-events), so a
 *   watchdog restart neither forgets a recent failure nor re-dates an old one. When the
 *   ledger is created for the first time, the failures already present are recorded as
 *   `baseline`: their real time is unknowable, they happened before this watchdog
 *   existed, and they never count as recent.
 *   An event can trip the threshold at most once (it is marked `tripped`). After an
 *   operator resumes, only failures that happen AFTER the trip count again, so the
 *   watchdog never re-pauses on the evidence a person has already reviewed.
 *   Deferrals (paused, upload priority, disk, encode slot) change neither `atm` nor
 *   `failedReason`, so they never create an event and never raise the count.
 *
 * WHAT IT NEVER DOES (by design)
 *   - It never resumes. Resuming is an explicit operator decision (POST /videos/mobile/resume
 *     or the operator script); there is no automatic resume policy.
 *   - It never touches the original upload queue (`video-processing`): new uploads and their
 *     Gumlet ingest are not affected by the pause flag at all.
 *   - It never interrupts a running encode, removes, moves or retries a job, or writes to the
 *     database or R2. A job already running when the pause lands finishes (or fails) normally,
 *     and the existing retry and recovery-sweep behaviour is unchanged. Its only Redis writes
 *     are the pause flag, its heartbeat and its own failure ledger.
 *   - It only pauses when historical mobile work is actually queued or running.
 *
 * A total outage also cuts the watchdog off from Redis, so it cannot write the flag DURING
 * the outage. It then pauses on the first tick at which Redis is reachable again, polling
 * every WATCHDOG_OUTAGE_POLL_SEC while an outage is in progress to keep that window short.
 *
 * Every decision (trip, pause, already-paused, recovery, skip, new failure seen) is logged as
 * one JSON line to stdout and to WATCHDOG_LOG.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
function loadConfig(env = process.env) {
  return {
    intervalSec: num(env.WATCHDOG_INTERVAL_SEC, 30),
    outagePollSec: num(env.WATCHDOG_OUTAGE_POLL_SEC, 10),
    outagePauseSec: num(env.WATCHDOG_OUTAGE_PAUSE_SEC, 600),
    pauseScope: env.WATCHDOG_PAUSE_SCOPE === 'all' ? 'all' : 'historical',
    netfailWindowMin: num(env.WATCHDOG_NETFAIL_WINDOW_MIN, 120),
    netfailThreshold: num(env.WATCHDOG_NETFAIL_THRESHOLD, 3),
    probeTimeoutMs: num(env.WATCHDOG_PROBE_TIMEOUT_MS, 10000),
    prefix: env.WATCHDOG_REDIS_PREFIX || env.REDIS_PREFIX || 'edu',
    dryRun: env.WATCHDOG_DRY_RUN === 'true',
    log: env.WATCHDOG_LOG || '/var/log/edu-watchdog/watchdog.log',
    maxTicks: num(env.WATCHDOG_MAX_TICKS, Infinity), // tests only
  };
}
function keysFor(prefix) {
  return {
    PAUSE_KEY: `${prefix}:mobile:transcode:paused`,
    HEARTBEAT_KEY: `${prefix}:watchdog:heartbeat`,
    LEDGER_KEY: `${prefix}:watchdog:netfail-events`,
    MQ: `${prefix}:bull:mobile-video-processing:`,
  };
}
const NETWORK_FAILURE = /socket hang up|aborted|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|TLS connection|network|Can't reach database|Unable to start a transaction|P1001|P1008|P1017|P2024/i;
/** The ledger is refreshed every tick; it only expires if the watchdog is gone for this long. */
const LEDGER_TTL_SEC = 14 * 24 * 3600;
const LEDGER_INIT = '__init__';

const withTimeout = (p, ms, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); })]).finally(() => clearTimeout(t));
};
const short = (e) => String((e && e.message) || e).split('\n').filter(Boolean).pop().replace(/[a-z0-9.-]+\.(neon\.tech|upstash\.io|r2\.cloudflarestorage\.com)[:0-9]*/gi, '<host>').slice(0, 160);
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/**
 * ONE atomic read of every queued / running / failed mobile job that carries a failure:
 * [id, failedReason, atm, finishedOn, ...]. It must be atomic: paused jobs move between
 * `delayed`, `wait` and `active` every deferral, and separate reads of those structures
 * can miss a job that moves in between - which would make an old failure look "first
 * seen now" on the next scan. A Lua script runs atomically (BullMQ itself relies on it).
 */
const SNAPSHOT_LUA = `
local mq = ARGV[1]
local out, seen = {}, {}
local function add(id)
  if seen[id] then return end
  seen[id] = true
  local f = redis.call('HMGET', mq .. id, 'failedReason', 'atm', 'finishedOn')
  if f[1] then
    out[#out + 1] = id; out[#out + 1] = f[1]; out[#out + 1] = f[2] or ''; out[#out + 1] = f[3] or ''
  end
end
for _, z in ipairs({'failed', 'delayed', 'prioritized'}) do
  for _, id in ipairs(redis.call('ZRANGE', mq .. z, 0, -1)) do add(id) end
end
for _, l in ipairs({'wait', 'active', 'paused'}) do
  for _, id in ipairs(redis.call('LRANGE', mq .. l, 0, -1)) do add(id) end
end
return out`;
async function failedJobsSnapshot(redis, mq) {
  const flat = (await redis.eval(SNAPSHOT_LUA, 0, mq)) || [];
  const jobs = [];
  for (let i = 0; i + 3 < flat.length; i += 4) jobs.push({ id: flat[i], reason: flat[i + 1], atm: flat[i + 2], finishedOn: flat[i + 3] });
  return jobs;
}

/**
 * Reads the mobile queue and the failure ledger, records failure events it has not seen
 * before, and classifies every network-type failure event:
 *   - recent:     its event time is inside the window (counted toward threshold B unless
 *                 it already tripped it once);
 *   - historical: older than the window, or a `baseline` event from before the ledger
 *                 existed (e.g. a failure awaiting its retry while processing was paused).
 * Read-only on the queue; writes only the ledger.
 */
async function scanNetworkFailures(redis, { keys, windowMin, now }) {
  const since = now - windowMin * 60_000;
  const jobs = await failedJobsSnapshot(redis, keys.MQ);

  const ledger = (await redis.hgetall(keys.LEDGER_KEY)) || {};
  const initialized = Boolean(ledger[LEDGER_INIT]);
  const writes = {};
  const live = new Set();
  const seen = []; // events recorded for the first time on this scan (genuinely new)
  const seeded = []; // events recorded as baseline (ledger created on this scan)

  for (const { id, reason, atm, finishedOn } of jobs) {
    if (!reason || !NETWORK_FAILURE.test(reason)) continue;
    const ev = `${id}#${Number(atm) || 0}`;
    live.add(ev);
    if (ledger[ev]) continue;
    let rec;
    if (Number(finishedOn) > 0) rec = { at: Number(finishedOn), src: 'finishedOn' };
    else if (!initialized) rec = { at: null, src: 'baseline' };
    else rec = { at: now, src: 'first-seen' };
    rec.reason = short(reason);
    ledger[ev] = writes[ev] = JSON.stringify(rec);
    (rec.src === 'baseline' ? seeded : seen).push(ev);
  }
  if (!initialized) ledger[LEDGER_INIT] = writes[LEDGER_INIT] = new Date(now).toISOString();
  if (Object.keys(writes).length) await redis.hset(keys.LEDGER_KEY, writes);

  // Forget events whose job is gone AND whose time is outside the window (or unknown).
  // An event of a job still in the queue is never forgotten: dropping it would let the
  // next scan record the same failure again as "new".
  const stale = [];
  const recent = [];
  const historical = [];
  for (const [ev, raw] of Object.entries(ledger)) {
    if (ev === LEDGER_INIT) continue;
    const rec = parse(raw) || { at: null };
    const isRecent = rec.at !== null && rec.at >= since;
    if (!live.has(ev) && !isRecent) { stale.push(ev); continue; }
    const [jobKey, attempt] = ev.split('#');
    const item = { event: ev, id: jobKey.split(':')[1], attempt: Number(attempt), reason: rec.reason, at: rec.at ? new Date(rec.at).toISOString() : null, src: rec.src, tripped: Boolean(rec.tripped), queued: live.has(ev) };
    (isRecent ? recent : historical).push(item);
  }
  if (stale.length) await redis.hdel(keys.LEDGER_KEY, ...stale);
  await redis.expire(keys.LEDGER_KEY, LEDGER_TTL_SEC);
  return { initialized, seen, seeded, recent, historical, untripped: recent.filter((e) => !e.tripped) };
}

/** Marks events as having tripped the threshold, so they never trip it again. */
async function markTripped(redis, keys, events) {
  if (!events.length) return;
  const raw = await redis.hmget(keys.LEDGER_KEY, ...events.map((e) => e.event));
  const writes = {};
  events.forEach((e, i) => { const rec = parse(raw[i]); if (rec) writes[e.event] = JSON.stringify({ ...rec, tripped: true }); });
  if (Object.keys(writes).length) await redis.hset(keys.LEDGER_KEY, writes);
}

/**
 * The watchdog's decision loop, independent of how it talks to the outside world:
 * `probes` = { redis, db, r2 } async functions that throw on failure, `redis` = an ioredis
 * client (or a compatible double), `log(event, data)`, `now()`.
 */
function createWatchdog({ redis, probes, cfg, keys = keysFor(cfg.prefix), log, now = () => Date.now() }) {
  const state = { outageSince: null, failing: [], pendingPause: null, trippedThisOutage: false, ticks: 0, startedAt: new Date(now()).toISOString(), netfail: null };

  async function pendingWork() {
    const [w, p, d, a] = await Promise.all([redis.llen(keys.MQ + 'wait'), redis.zcard(keys.MQ + 'prioritized'), redis.zcard(keys.MQ + 'delayed'), redis.llen(keys.MQ + 'active')]);
    return { wait: w, prioritized: p, delayed: d, active: a, total: w + p + d + a };
  }
  async function writePause(reason) {
    if (cfg.dryRun) { log('pause_dry_run', { reason }); return; }
    // Same key and shape as POST /videos/mobile/pause (scratch-guard writePauseState); no TTL.
    // SCOPE: this watchdog guards the historical backlog (it only ever pauses when
    // historical work is queued or running), so its pause holds `migration` /
    // `recovery` jobs and lets a new upload's own encode through. A pause without
    // a scope means "everything", which is what this used to write - and what
    // parked every newly uploaded lecture behind a backlog safety stop until a
    // person resumed it. Set WATCHDOG_PAUSE_SCOPE=all to get that back. A worker
    // build from before scopes existed ignores the field and holds everything.
    await redis.set(keys.PAUSE_KEY, JSON.stringify({ reason: reason.slice(0, 200), by: 'safety-watchdog', at: new Date(now()).toISOString(), scope: cfg.pauseScope }));
  }
  const safeBy = (json) => (parse(json) || {}).by || 'unknown';

  async function tick() {
    state.ticks += 1;
    const results = {};
    for (const [name, fn] of [['redis', probes.redis], ['db', probes.db], ['r2', probes.r2]]) {
      try { await fn(); results[name] = 'ok'; } catch (e) { results[name] = short(e); }
    }

    const failing = Object.entries(results).filter(([, v]) => v !== 'ok').map(([k]) => k);
    const t = now();
    if (failing.length) {
      if (!state.outageSince) { state.outageSince = t; log('outage_start', { failing, detail: results }); }
      else if (failing.join() !== state.failing.join()) log('outage_change', { failing, detail: results });
      const secs = Math.round((t - state.outageSince) / 1000);
      if (secs >= cfg.outagePauseSec && !state.pendingPause && !state.trippedThisOutage) {
        state.pendingPause = `auto-paused by safety watchdog: ${secs} s outage (${failing.join(', ')})`;
        state.trippedThisOutage = true; // once per outage
        log('threshold_outage', { seconds: secs, failing });
      }
    } else if (state.outageSince) {
      log('outage_end', { seconds: Math.round((t - state.outageSince) / 1000), note: 'connectivity restored; processing is NOT resumed automatically' });
      state.outageSince = null;
      state.trippedThisOutage = false;
    }
    state.failing = failing;

    if (results.redis !== 'ok') return results; // nothing more can be read or written until Redis is back

    // Threshold B: network-caused job FAILURE EVENTS within the window (see the header).
    try {
      const scan = await scanNetworkFailures(redis, { keys, windowMin: cfg.netfailWindowMin, now: t });
      if (scan.seeded.length) log('netfail_baseline', { note: 'failure ledger created; failures already present are historical (time unknown) and never count as recent', events: scan.seeded });
      if (scan.seen.length) log('netfail_seen', { events: scan.recent.filter((e) => scan.seen.includes(e.event)) });
      state.netfail = { newFailures: scan.untripped.length, recentFailures: scan.recent.length, historicalFailures: scan.historical.length, awaitingRetry: scan.historical.filter((e) => e.queued).length + scan.recent.filter((e) => e.queued).length };
      if (scan.untripped.length >= cfg.netfailThreshold && !state.pendingPause) {
        state.pendingPause = `auto-paused by safety watchdog: ${scan.untripped.length} network-caused mobile job failures in ${cfg.netfailWindowMin} min`;
        await markTripped(redis, keys, scan.untripped);
        log('threshold_network_failures', { count: scan.untripped.length, jobs: scan.untripped });
      }
    } catch (e) { log('netfail_scan_error', { error: short(e) }); }

    // Act on a tripped threshold as soon as Redis is reachable.
    let work = null;
    if (state.pendingPause) {
      try {
        const existing = await redis.get(keys.PAUSE_KEY);
        work = await pendingWork();
        if (existing) {
          log('already_paused', { by: safeBy(existing), reason: state.pendingPause });
        } else if (work.total === 0) {
          log('pause_skipped_no_historical_work', { reason: state.pendingPause, work });
        } else {
          await writePause(state.pendingPause);
          log('PAUSED', { reason: state.pendingPause, work, dryRun: cfg.dryRun });
        }
        state.pendingPause = null;
      } catch (e) { log('pause_write_error', { error: short(e), reason: state.pendingPause }); }
    }

    try {
      await redis.set(keys.HEARTBEAT_KEY, JSON.stringify({ at: new Date(t).toISOString(), startedAt: state.startedAt, ticks: state.ticks, probes: results, outageSince: state.outageSince && new Date(state.outageSince).toISOString(), netfail: state.netfail, cfg: { outagePauseSec: cfg.outagePauseSec, netfailThreshold: cfg.netfailThreshold, netfailWindowMin: cfg.netfailWindowMin, pauseScope: cfg.pauseScope, dryRun: cfg.dryRun } }), 'EX', 600);
    } catch { /* heartbeat is best effort */ }
    return results;
  }

  return { tick, state };
}

/** The container entry point: real clients, real probes, the loop. */
async function main() {
  process.removeAllListeners('warning');
  const CFG = loadConfig();
  const keys = keysFor(CFG.prefix);
  const NM = process.env.WATCHDOG_NODE_MODULES || '/app/node_modules';
  const Redis = require(`${NM}/ioredis`);
  const { PrismaClient } = require(`${NM}/@prisma/client`);
  const { S3Client, ListObjectsV2Command } = require(`${NM}/@aws-sdk/client-s3`);

  try { fs.mkdirSync(path.dirname(CFG.log), { recursive: true }); } catch { /* stdout still works */ }
  const log = (event, data = {}) => {
    const line = JSON.stringify({ at: new Date().toISOString(), event, ...data });
    console.log(line);
    try { fs.appendFileSync(CFG.log, line + '\n'); } catch { /* keep running */ }
  };

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

  const probes = {
    async redis() {
      if (redis.status !== 'ready') {
        // Not connected yet (startup) or reconnecting: wait for the client to be ready
        // rather than reporting a false outage on the first tick.
        if (redis.status === 'wait' || redis.status === 'end') redis.connect().catch(() => undefined);
        await withTimeout(new Promise((resolve) => redis.once('ready', resolve)), CFG.probeTimeoutMs, 'redis connect');
      }
      const pong = await withTimeout(redis.ping(), CFG.probeTimeoutMs, 'redis');
      if (pong !== 'PONG') throw new Error('unexpected PING reply');
    },
    async db() {
      try {
        await withTimeout(prisma.$queryRawUnsafe('select 1'), CFG.probeTimeoutMs, 'db');
        dbFailStreak = 0;
      } catch (e) {
        // A Prisma query on a silently dead connection never settles; after 3 timed-out
        // probes, start a fresh client (the old one is abandoned, never awaited).
        dbFailStreak += 1;
        if (dbFailStreak >= 3) { const old = prisma; prisma = new PrismaClient({ log: [] }); old.$disconnect().catch(() => undefined); dbFailStreak = 0; }
        throw e;
      }
    },
    async r2() {
      await withTimeout(s3.send(new ListObjectsV2Command({ Bucket: process.env.R2_BUCKET_MEDIA, Prefix: 'hls/', MaxKeys: 1 })), CFG.probeTimeoutMs, 'r2');
    },
  };

  const wd = createWatchdog({ redis, probes, cfg: CFG, keys, log });
  /** Liveness for the container health check: touched every tick, outage or not. */
  const alive = () => { try { fs.writeFileSync('/tmp/watchdog.alive', String(Date.now())); } catch { /* health check will notice */ } };

  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('stop', { signal: sig }); process.exit(0); });
  log('start', { cfg: { ...CFG, log: undefined }, pauseKey: keys.PAUSE_KEY.replace(/^[^:]+/, '<prefix>'), ledgerKey: keys.LEDGER_KEY.replace(/^[^:]+/, '<prefix>') });
  for (;;) {
    try { await wd.tick(); } catch (e) { log('tick_error', { error: short(e) }); }
    alive();
    if (wd.state.ticks >= CFG.maxTicks) break;
    await new Promise((r) => setTimeout(r, (wd.state.outageSince ? CFG.outagePollSec : CFG.intervalSec) * 1000));
  }
  log('stop', { ticks: wd.state.ticks });
  process.exit(0);
}

if (require.main === module) main();

module.exports = { createWatchdog, scanNetworkFailures, markTripped, loadConfig, keysFor, NETWORK_FAILURE, LEDGER_TTL_SEC, SNAPSHOT_LUA };
