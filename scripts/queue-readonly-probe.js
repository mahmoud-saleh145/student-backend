/**
 * READ-ONLY production queue inspection.
 *
 * Counts only. It never reads, prints, or mutates a job payload, and never
 * touches a queue. Used to answer one question before touching the worker:
 * is anything in flight right now?
 */
const Redis = require('ioredis');
const { hostname } = require('os');

const REDIS_PREFIX = process.env.REDIS_PREFIX || 'edu';
const QUEUE = 'video-processing';
const PREFIX = `${REDIS_PREFIX}:${QUEUE}`;

(async () => {
  const r = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });
  await r.connect();

  // LLEN / ZCARD / SCARD are read-only and return counts, never contents.
  const waiting = await r.llen(`${PREFIX}:wait`);
  const active = await r.llen(`${PREFIX}:active`);
  const paused = await r.scard(`${PREFIX}:paused`);
  const delayed = await r.zcard(`${PREFIX}:delayed`);
  const prioritized = await r.zcard(`${PREFIX}:prioritized`);

  console.log('=== queue depth (counts only, no payloads) ===');
  console.log(`  queue          : ${REDIS_PREFIX}:${QUEUE}`);
  console.log(`  waiting        : ${waiting}`);
  console.log(`  ACTIVE (in flight): ${active}`);
  console.log(`  delayed        : ${delayed}`);
  console.log(`  prioritized    : ${prioritized}`);
  console.log(`  paused         : ${paused}`);

  const hbKey = `${REDIS_PREFIX}:worker:heartbeat`;
  const ttl = await r.ttl(hbKey);
  console.log('\n=== worker heartbeat ===');
  console.log(`  key present    : ${(await r.exists(hbKey)) === 1}`);
  console.log(`  ttl remaining  : ${ttl}s  (0 or negative = expired)`);
  // host/ffmpeg flags only - no identifiers, no user data.
  const raw = await r.get(hbKey);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      console.log(`  host           : ${p.host}`);
      console.log(`  ffmpeg         : ${p.ffmpeg}`);
      console.log(`  ffprobe        : ${p.ffprobe}`);
      console.log(`  beatsAt        : ${p.beatsAt ?? p.at ?? 'n/a'}`);
    } catch {
      console.log('  (payload not JSON; omitted)');
    }
  }

  console.log(`\n  this machine   : ${hostname()}`);
  console.log(
    `  in flight now  : ${active === 0 ? 'NO - safe to stop' : 'YES - ' + active + ' active job(s)'}`,
  );

  await r.quit();
})().catch((e) => {
  console.error('probe failed:', e.message);
  process.exitCode = 1;
});