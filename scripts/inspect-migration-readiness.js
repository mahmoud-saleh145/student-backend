/**
 * READ-ONLY production inspection for the migration safety review.
 *
 * Every statement here is a SELECT. Nothing in this file writes, and it is not
 * part of the application - it exists so the migration decision is made against
 * the real database rather than against assumptions.
 *
 * Usage:  node scripts/inspect-migration-readiness.js
 * It reads DATABASE_URL from the environment and never prints a credential.
 */
const { PrismaClient } = require('@prisma/client');

const db = new PrismaClient();

async function main() {
  const out = (k, v) => console.log(`  ${k.padEnd(46)} ${v}`);

  // --- server ---------------------------------------------------------------
  const version = await db.$queryRawUnsafe(
    `SELECT version() AS v, current_database() AS db`,
  );
  out('PostgreSQL', version[0].v.split(',')[0]);
  out('database', version[0].db);

  // --- table sizes (locking exposure) ---------------------------------------
  const counts = await db.$queryRawUnsafe(`
    SELECT relname AS table, n_live_tup AS approx_rows
      FROM pg_stat_user_tables
     WHERE relname IN ('videos','universities','faculties','academic_structures')
     ORDER BY relname
  `);
  console.log('\n  Approximate row counts (locking exposure):');
  for (const c of counts) out(c.table, c.approx_rows);

  // --- columns must NOT exist yet ------------------------------------------
  const gumlet = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name = 'videos' AND column_name LIKE '%umlet%'
  `);
  out('\nvideos gumlet columns present (expect 0)', gumlet[0].n);

  const acad = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_name IN ('universities','faculties')
       AND column_name IN ('defaultAcademicSystem','academicSystemOverride')
  `);
  out('academic columns present (expect 0)', acad[0].n);

  // --- how many rows would the academic backfill touch? --------------------
  const fac = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE "deletedAt" IS NULL)::int AS live
      FROM faculties
  `);
  out('faculties total / live', `${fac[0].total} / ${fac[0].live}`);

  const uni = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS total FROM universities
  `);
  out('universities total', uni[0].total);

  // Colleges whose ladder already diverges - these are the ONLY rows the
  // backfill will write an override to. Anything more than a handful means the
  // migration carries a behaviour change that deserves a human look.
  const diverging = await db.$queryRawUnsafe(`
    WITH ranked AS (
      SELECT s."universityId" AS uid, s.kind AS kind,
             row_number() OVER (PARTITION BY s."universityId"
                                ORDER BY s."createdAt" ASC, s.id ASC) AS rn
        FROM "academic_structures" s
       WHERE s."universityId" IS NOT NULL
         AND s."isActive" = true
         AND s."scopeKey" = 'university:' || s."universityId"
    ),
    eff AS (
      SELECT f.id AS faculty_id,
             COALESCE(
               (SELECT s.kind FROM "academic_structures" s
                 WHERE s."facultyId" = f.id AND s."isActive" = true
                 ORDER BY s."createdAt" ASC, s.id ASC LIMIT 1),
               (SELECT s.kind FROM "academic_structure_faculties" x
                 JOIN "academic_structures" s ON s.id = x."structureId"
                WHERE x."facultyId" = f.id AND s."isActive" = true LIMIT 1),
               (SELECT s.kind FROM "academic_structures" s
                 WHERE s."universityId" = f."universityId" AND s."isActive" = true
                   AND s."scopeKey" = 'university:' || f."universityId"
                 ORDER BY s."createdAt" ASC, s.id ASC LIMIT 1),
               'YEAR'::"AcademicStructureKind"
             ) AS effective_kind,
             COALESCE((SELECT r.kind FROM ranked r WHERE r.uid = f."universityId" AND r.rn = 1),
                      'YEAR'::"AcademicStructureKind") AS inherited_default
        FROM faculties f
       WHERE f."deletedAt" IS NULL
    )
    SELECT count(*)::int AS diverging FROM eff WHERE effective_kind <> inherited_default
  `);
  out('faculties the backfill WILL override', diverging[0].diverging);

  // --- videos: confirm the legacy population that must be preserved ----------
  const vid = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'READY')::int AS ready
      FROM videos WHERE "deletedAt" IS NULL
  `);
  out('videos total / READY (must be untouched)', `${vid[0].total} / ${vid[0].ready}`);

  // --- advisory lock / long txn check ---------------------------------------
  const blockers = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS n
      FROM pg_stat_activity
     WHERE state <> 'idle' AND pid <> pg_backend_pid()
  `);
  out('other active (non-idle) sessions', blockers[0].n);
}

main()
  .catch((e) => {
    console.error('  INSPECTION FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());