/**
 * DRY RUN of the academic migration against live production data.
 *
 * READ-ONLY. Every statement is a SELECT. This simulates, without applying,
 * exactly what migration 20261009000000 would do to the rows that exist today,
 * so the decision is made against real data rather than against the description
 * of that data.
 *
 * Nothing here writes, and no schema change is simulated on the server — the
 * migration's target columns do not exist yet, so the "after" state is computed
 * in the SELECT using the same expressions the migration uses.
 */
const { PrismaClient } = require('@prisma/client');

const db = new PrismaClient();

const Y = 'YEAR';
const L = 'LEVEL';

async function main() {
  const p = (s = '') => console.log(s);

  p('===============================================================');
  p(' STEP 1 — what the ADD COLUMN + section-1 UPDATE will set');
  p(' (universities.defaultAcademicSystem, currently absent)');
  p('===============================================================');

  // Section 1 verbatim: oldest active university-scoped structure wins.
  const uni = await db.$queryRawUnsafe(`
    WITH ranked AS (
      SELECT s."universityId" AS uid, s.kind AS kind,
             row_number() OVER (PARTITION BY s."universityId"
                                ORDER BY s."createdAt" ASC, s.id ASC) AS rn
        FROM "academic_structures" s
       WHERE s."universityId" IS NOT NULL
         AND s."isActive" = true
         AND s."scopeKey" = 'university:' || s."universityId"
    )
    SELECT u.name,
           u.id,
           COALESCE((SELECT r.kind FROM ranked r WHERE r.uid = u.id AND r.rn = 1),
                    'YEAR'::"AcademicStructureKind") AS will_be_default,
           CASE WHEN EXISTS (SELECT 1 FROM ranked r WHERE r.uid = u.id AND r.rn = 1)
                THEN 'derived from its own structure'
                ELSE 'falls back to column DEFAULT (YEAR)' END AS provenance,
           (SELECT count(*)::int FROM faculties f
             WHERE f."universityId" = u.id AND f."deletedAt" IS NULL) AS live_colleges
      FROM universities u
     ORDER BY u.name
  `);
  for (const r of uni) {
    p(`  ${String(r.name).padEnd(34)} -> ${r.will_be_default.padEnd(6)} ${r.provenance}  (${r.live_colleges} live college(s))`);
  }

  p('');
  p('===============================================================');
  p(' STEP 2 — which faculties the backfill will write an override to');
  p(' (section 2 predicate: effective_kind <> inherited_default)');
  p('===============================================================');

  const fac = await db.$queryRawUnsafe(`
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
      SELECT f.id AS faculty_id, f.name AS fname, u.name AS uname,
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
        JOIN universities u ON u.id = f."universityId"
       WHERE f."deletedAt" IS NULL
    )
    SELECT uname, fname, effective_kind, inherited_default,
           (effective_kind <> inherited_default) AS will_be_overridden
      FROM eff ORDER BY uname, fname
  `);
  for (const r of fac) {
    const verdict = r.will_be_overridden
      ? `OVERRIDE -> ${r.effective_kind}`
      : `left NULL (inherits ${r.inherited_default})`;
    p(`  ${String(r.uname).padEnd(26)} | ${String(r.fname).padEnd(34)} eff=${String(r.effective_kind).padEnd(5)} inh=${String(r.inherited_default).padEnd(5)} ${verdict}`);
  }
  const overrides = fac.filter((r) => r.will_be_overridden).length;
  p(`  --> rows written: ${overrides}   rows left NULL: ${fac.length - overrides}`);

  p('');
  p('===============================================================');
  p(' STEP 3 — data-loss / referential-integrity risk checks');
  p('===============================================================');

  const orphans = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM faculties f
     WHERE f."deletedAt" IS NULL
       AND NOT EXISTS (SELECT 1 FROM universities u WHERE u.id = f."universityId")
  `);
  p(`  orphan faculties (universityId -> no university) ......... ${orphans[0].n}`);
  p('    (trigger RAISEs if a faculty references a missing university)');

  const softDeleted = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM faculties WHERE "deletedAt" IS NOT NULL
  `);
  p(`  soft-deleted faculties (excluded from backfill) ........... ${softDeleted[0].n}`);

  const students = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS n FROM student_profiles
  `);
  p(`  student_profiles rows (section 6 diagnostic) .............. ${students[0].n}`);

  p('');
  p('===============================================================');
  p(' STEP 4 — diagnostic section 6 DRY RUN');
  p(' (students on a rung their college no longer governs)');
  p('===============================================================');

  const s6 = await db.$queryRawUnsafe(`
    WITH governing AS (
      SELECT f.id AS faculty_id,
             COALESCE(fs.id, us.id) AS structure_id
        FROM "faculties" f
        JOIN "universities" u ON u.id = f."universityId"
        LEFT JOIN LATERAL (
          SELECT s.id FROM "academic_structures" s
           WHERE s."isActive" = true
             AND s."scopeKey" IN ('faculty:' || f.id, 'university:' || f."universityId")
           ORDER BY CASE WHEN s."scopeKey" = 'faculty:' || f.id THEN 0 ELSE 1 END
           LIMIT 1
        ) fs ON true
        LEFT JOIN LATERAL (
          SELECT s.id FROM "academic_structures" s
           WHERE s."isActive" = true
             AND s."scopeKey" = 'university:' || f."universityId"
           LIMIT 1
        ) us ON true
       WHERE f."deletedAt" IS NULL
    )
    SELECT u.name AS university, f.name AS college, count(sp.id) AS outside
      FROM "student_profiles" sp
      JOIN governing g ON g.faculty_id = sp."facultyId"
      JOIN "faculties" f ON f.id = sp."facultyId"
      JOIN "universities" u ON u.id = f."universityId"
      LEFT JOIN "academic_years" ay ON ay.id = sp."academicYearId"
     WHERE g.structure_id IS NOT NULL
       AND (ay."structureId" IS NULL OR ay."structureId" <> g.structure_id)
     GROUP BY u.name, f.name
    HAVING count(sp.id) > 0
  `);
  p(`  rows returned: ${s6.length}  ${s6.length === 0 ? '(EXPECTED - safe)' : '(MISMATCH - STOP)'}`);
  for (const r of s6) p(`    ${r.university} | ${r.college} | ${r.outside} student(s)`);

  p('');
  p('===============================================================');
  p(' STEP 5 — diagnostic section 5 DRY RUN');
  p(' (configured system vs governing ladder kind)');
  p('===============================================================');

  // Same governing precedence as inspect-academic-systems.sql section 5. The two
  // post-migration columns do not exist yet, so the configured value is
  // computed from what the migration WILL write and judged in JS.
  const s5 = await db.$queryRawUnsafe(`
    WITH ranked AS (
      SELECT s."universityId" AS uid, s.kind AS kind,
             row_number() OVER (PARTITION BY s."universityId"
                                ORDER BY s."createdAt" ASC, s.id ASC) AS rn
        FROM "academic_structures" s
       WHERE s."universityId" IS NOT NULL AND s."isActive" = true
         AND s."scopeKey" = 'university:' || s."universityId"
    ),
    governing AS (
      SELECT f.id AS faculty_id,
             (SELECT s.kind FROM "academic_structures" s
               WHERE s."isActive" AND s."facultyId" = f.id
               ORDER BY s."createdAt" ASC, s.id ASC LIMIT 1) AS faculty_kind,
             (SELECT s.kind FROM "academic_structure_faculties" x
               JOIN "academic_structures" s ON s.id = x."structureId"
              WHERE x."facultyId" = f.id AND s."isActive" LIMIT 1) AS pin_kind,
             (SELECT s.kind FROM "academic_structures" s
               WHERE s."isActive" AND s."scopeKey" = 'university:' || f."universityId"
               ORDER BY s."createdAt" ASC, s.id ASC LIMIT 1) AS university_kind,
             (SELECT s.kind FROM "academic_structures" s
               WHERE s."isActive" AND s."scopeKey" = 'platform'
               ORDER BY s."createdAt" ASC, s.id ASC LIMIT 1) AS platform_kind
        FROM "faculties" f WHERE f."deletedAt" IS NULL
    )
    SELECT u.name AS university, f.name AS college,
           g.governing_kind,
           CASE g.source
             WHEN 'faculty' THEN 'college-owned structure'
             WHEN 'pin'     THEN 'explicit pin'
             WHEN 'university' THEN 'university-owned structure'
             ELSE 'platform fallback' END AS ladder_comes_from,
           COALESCE((SELECT r.kind FROM ranked r WHERE r.uid = u.id AND r.rn = 1),
                    'YEAR'::"AcademicStructureKind") AS will_be_university_default
      FROM "faculties" f
      JOIN "universities" u ON u.id = f."universityId"
      CROSS JOIN LATERAL (
        SELECT COALESCE(g.faculty_kind, g.pin_kind, g.university_kind, g.platform_kind) AS governing_kind,
               CASE WHEN g.faculty_kind IS NOT NULL THEN 'faculty'
                    WHEN g.pin_kind     IS NOT NULL THEN 'pin'
                    WHEN g.university_kind IS NOT NULL THEN 'university'
                    ELSE 'platform' END AS source
          FROM governing g WHERE g.faculty_id = f.id
      ) g
     WHERE g.governing_kind IS NOT NULL
     ORDER BY u.name, f.name
  `);

  // Apply the exact override the migration will write, then judge.
  let mismatch = 0;
  const ovr = new Map(
    fac.filter((r) => r.will_be_overridden).map((r) => [`${r.uname}|${r.fname}`, r.effective_kind]),
  );
  for (const r of s5) {
    const configured = ovr.get(`${r.university}|${r.college}`) ?? r.will_be_university_default;
    const ok = r.governing_kind === configured;
    if (!ok) mismatch++;
    p(`    ${ok ? 'ok      ' : 'MISMATCH'} ${String(r.university).padEnd(22)} | ${String(r.college).padEnd(34)} configured=${String(configured).padEnd(5)} ladder=${String(r.governing_kind).padEnd(5)} (${r.ladder_comes_from})`);
  }
  p(`  mismatches after backfill: ${mismatch}  ${mismatch === 0 ? '(EXPECTED - safe)' : '(REVIEW)'}`);

  p('');
  p('===============================================================');
  p(' STEP 6 — videos must be untouched by the academic migration');
  p('===============================================================');
  const vid = await db.$queryRawUnsafe(`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status='READY')::int AS ready,
           count(DISTINCT "lessonId")::int AS lessons
      FROM videos WHERE "deletedAt" IS NULL
  `);
  p(`  videos total/READY/distinct lessons: ${vid[0].total}/${vid[0].ready}/${vid[0].lessons}`);
  p('  the academic migration writes only to universities/faculties -> videos untouched');
}

main()
  .catch((e) => {
    console.error('  DRY RUN FAILED:', e.message);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());