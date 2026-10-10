/**
 * Production baseline fingerprint — READ-ONLY.
 *
 * Captures the exact state that a backup/restore point must reproduce. Run this
 * against production, then run the SAME script (or the Neon SQL Editor
 * queries in the report) against the backup branch and compare.
 *
 * Nothing here writes, locks, or modifies anything.
 */
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = new PrismaClient();
const DIR = path.join(process.cwd(), 'prisma', 'migrations');
const LABEL = process.argv[2] || 'production';

const out = [];
const say = (s = '') => {
  out.push(s);
  console.log(s);
};

(async () => {
  say(`# BASELINE FINGERPRINT - ${LABEL}`);
  say(`# generated: ${new Date().toISOString()}`);
  say();

  const v = await db.$queryRawUnsafe('SELECT version() AS v, current_database() AS db');
  say(`server   : ${v[0].v.split(',')[0]}`);
  say(`database : ${v[0].db}`);
  say();

  say('## ROW COUNTS (every table, exact)');
  const tables = await db.$queryRawUnsafe(`
    SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' AND table_type='BASE TABLE'
     ORDER BY table_name
  `);
  let total = 0;
  for (const t of tables) {
    const r = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS n FROM public."${t.table_name}"`,
    );
    total += r[0].n;
    say(`  ${String(r[0].n).padStart(8)}  ${t.table_name}`);
  }
  say(`  ${String(total).padStart(8)}  -- TOTAL ROWS`);
  say();

  say('## KEY BUSINESS ROWS');
  const key = await db.$queryRawUnsafe(`
    SELECT
      (SELECT count(*) FROM videos WHERE "deletedAt" IS NULL)                        AS videos_live,
      (SELECT count(*) FROM videos WHERE status='READY')                              AS videos_ready,
      (SELECT count(*) FROM "student_profiles")                                      AS students,
      (SELECT count(*) FROM users WHERE "deletedAt" IS NULL)                         AS users_live,
      (SELECT count(*) FROM courses WHERE "deletedAt" IS NULL)                       AS courses_live,
      (SELECT count(*) FROM universities)                                             AS universities,
      (SELECT count(*) FROM faculties WHERE "deletedAt" IS NULL)                     AS faculties_live,
      (SELECT count(*) FROM "academic_structures" WHERE "isActive")                  AS structures_active,
      (SELECT count(*) FROM "academic_structure_faculties")                           AS faculty_pins,
      (SELECT count(*) FROM "playback_tickets" WHERE "expiresAt" > now())            AS live_tickets
  `);
  for (const [k, val] of Object.entries(key[0])) say(`  ${String(val).padStart(6)}  ${k}`);
  say();

  say('## MIGRATION HISTORY (must be identical on the branch)');
  const m = await db.$queryRawUnsafe(`
    SELECT migration_name, checksum, finished_at IS NOT NULL AS finished
      FROM _prisma_migrations
     WHERE rolled_back_at IS NULL
     ORDER BY started_at
  `);
  say(`  applied migrations: ${m.length}`);
  for (const r of m) say(`    ${r.finished ? 'OK' : '??'} ${r.migration_name}  ${r.checksum.slice(0, 16)}...`);
  say();

  say('## CRITICAL STRUCTURE (the two migrations about to be applied)');
  const cols = await db.$queryRawUnsafe(`
    SELECT table_name, column_name
      FROM information_schema.columns
     WHERE table_schema='public'
       AND ((table_name='videos'        AND column_name LIKE '%umlet%')
         OR (table_name='universities' AND column_name='defaultAcademicSystem')
         OR (table_name='faculties'     AND column_name='academicSystemOverride'))
     ORDER BY table_name, column_name
  `);
  say(`  new columns present: ${cols.length}  (expected 0 before the release)`);
  for (const c of cols) say(`    ${c.table_name}.${c.column_name}`);
  say();

  const trig = await db.$queryRawUnsafe(`
    SELECT tgname FROM pg_trigger
     WHERE tgrelid='faculties'::regclass AND NOT tgisinternal
  `);
  say(`  triggers on faculties: ${trig.length} (expected 0 before the release)`);
  for (const t of trig) say(`    ${t.tgname}`);
  say();

  say('## CHECKSUMS OF THE TWO PENDING MIGRATIONS (must match after apply)');
  for (const n of [
    '20261009000000_academic_system_default_and_college_override',
    '20261009120000_gumlet_drm_per_video_provider',
  ]) {
    const f = path.join(DIR, n, 'migration.sql');
    const buf = fs.readFileSync(f);
    say(`  ${n}`);
    say(`    sha256(raw) = ${crypto.createHash('sha256').update(buf).digest('hex')}`);
    say(`    crlf count = ${(buf.toString('utf8').match(/\r\n/g) || []).length}  (must be 0)`);
  }

  fs.writeFileSync(path.join(process.cwd(), `baseline-${LABEL}.txt`), out.join('\n') + '\n');
  say();
  say(`written to baseline-${LABEL}.txt`);

  await db.$disconnect();
})();