-- =============================================================================
-- Post-migration verification: academic systems after the university-default /
-- college-override migration.
--
-- READ-ONLY. Six SELECTs, no DDL, no DML, no locks.
-- Run in the Neon SQL Editor against production, or:
--   psql "$DIRECT_URL" -f inspect-academic-systems.sql
--
-- Use the DIRECT (non `-pooler`) host if you want a consistent snapshot while
-- the API is serving traffic.
--
-- Read sections 3 and 4 before deciding whether anything needs doing. Neither
-- returning rows is a failure: section 3 is the expected state for a database
-- where no college has been overridden yet, and section 4 lists the colleges
-- that need a human decision rather than a guess.
-- =============================================================================

-- Two separate booleans rather than one `AND`: a WHERE clause cannot guard a
-- subquery (it is resolved at parse time), so folding them together would need a
-- self-join and would report "false" ambiguously if the table were missing.
\echo '=== 1. Did the migration apply? ==='
SELECT to_regclass('public.universities') IS NOT NULL AS universities_table,
       EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_name = 'universities'
              AND column_name = 'defaultAcademicSystem'
       ) AS default_column_added,
       EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_name = 'faculties'
              AND column_name = 'academicSystemOverride'
       ) AS override_column_added;

\echo '=== 2. Effective system per college, with the source spelled out ==='
-- The whole model in one table. `source` is the answer to "will changing the
-- university default affect this college?": UNIVERSITY_DEFAULT means yes,
-- COLLEGE_OVERRIDE means no.
SELECT u.name                                       AS university,
       u."defaultAcademicSystem"                    AS university_default,
       f.name                                       AS college,
       f."academicSystemOverride"                  AS college_override,
       COALESCE(f."academicSystemOverride",
                u."defaultAcademicSystem")          AS effective_system,
       CASE WHEN f."academicSystemOverride" IS NULL THEN 'inherits university'
            ELSE 'OVERRIDE (immune to university changes)' END AS source
  FROM "faculties" f
  JOIN "universities" u ON u.id = f."universityId"
 WHERE f."deletedAt" IS NULL
 ORDER BY u.name, f.name;

\echo '=== 3. Colleges that override ==='
-- Non-zero is NORMAL after the migration: it backfills only the colleges whose
-- ladder already differed from their university's default, so that their recorded
-- behaviour keeps matching reality. Read section 2 to see which is which.
SELECT COUNT(*) AS overriding_colleges
  FROM "faculties"
 WHERE "academicSystemOverride" IS NOT NULL
   AND "deletedAt" IS NULL;

\echo '=== 4. Stale overrides: stored value now equals the university default ==='
-- Harmless but misleading. It records no decision, yet survives the next change
-- of the university default and then means something nobody chose. Reported so
-- an Admin can clear it; not an error.
SELECT u.name AS university,
       f.name AS college,
       f."academicSystemOverride" AS stale_value
  FROM "faculties" f
  JOIN "universities" u ON u.id = f."universityId"
 WHERE f."academicSystemOverride" IS NOT NULL
   AND f."academicSystemOverride" = u."defaultAcademicSystem"
   AND f."deletedAt" IS NULL
 ORDER BY u.name, f.name;

\echo '=== 5. Ladder/vocabulary mismatches ==='
-- A college whose configured system disagrees with the vocabulary of the ladder
-- that actually governs it. The API refuses to create one of these, but a row can
-- predate the check, be written by hand, or result from an administrator changing
-- a university's default without reconfiguring its ladder. The symptom is a
-- student offered years under a levels question, or the reverse.
--
-- Resolved with the SAME precedence the application applies, INCLUDING the
-- `academic_structure_faculties` pin. An earlier version of this query looked
-- only at faculty- and university-owned structures and reported a false
-- MISMATCH for every college whose ladder arrives via a pin — which is exactly
-- how this deployment stores both its colleges.
WITH governing AS (
    SELECT f.id AS faculty_id,
           -- Department ladders first, then the pin, then faculty-owned, then
           -- university-owned, then the platform fallback. Matching
           -- `CatalogService.resolveAcademicStructure`.
           (SELECT s.kind FROM "academic_structures" s
             WHERE s."isActive" AND s."facultyId" = f.id
             ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1)                      AS faculty_kind,
           (SELECT s.kind FROM "academic_structure_faculties" x
              JOIN "academic_structures" s ON s.id = x."structureId"
             WHERE x."facultyId" = f.id AND s."isActive" LIMIT 1)                 AS pin_kind,
           (SELECT s.kind FROM "academic_structures" s
             WHERE s."isActive" AND s."scopeKey" = 'university:' || f."universityId"
             ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1)                      AS university_kind,
           (SELECT s.kind FROM "academic_structures" s
             WHERE s."isActive" AND s."scopeKey" = 'platform'
             ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1)                      AS platform_kind
      FROM "faculties" f
     WHERE f."deletedAt" IS NULL
)
SELECT u.name AS university,
       f.name AS college,
       COALESCE(f."academicSystemOverride", u."defaultAcademicSystem") AS configured_system,
       g.governing_kind                                                   AS ladder_kind,
       CASE g.source
         WHEN 'faculty' THEN 'college-owned structure'
         WHEN 'pin'     THEN 'explicit pin'
         WHEN 'university' THEN 'university-owned structure'
         ELSE 'platform fallback'
       END AS ladder_comes_from,
       CASE WHEN g.governing_kind = COALESCE(f."academicSystemOverride", u."defaultAcademicSystem")
            THEN 'ok' ELSE 'MISMATCH' END AS verdict
  FROM "faculties" f
  JOIN "universities" u ON u.id = f."universityId"
  CROSS JOIN LATERAL (
      SELECT
          COALESCE(g.faculty_kind, g.pin_kind, g.university_kind, g.platform_kind) AS governing_kind,
          CASE
              WHEN g.faculty_kind IS NOT NULL THEN 'faculty'
              WHEN g.pin_kind     IS NOT NULL THEN 'pin'
              WHEN g.university_kind IS NOT NULL THEN 'university'
              ELSE 'platform'
          END AS source
        FROM governing g
       WHERE g.faculty_id = f.id
  ) g
 WHERE g.governing_kind IS NOT NULL
   AND g.governing_kind <> COALESCE(f."academicSystemOverride", u."defaultAcademicSystem")
 ORDER BY u.name, f.name;

\echo '=== 6. Students filed on a rung their college no longer governs ==='
-- The only question here that could indicate real damage. Each row is a student
-- whose academicYear sits outside their college's effective ladder — they would
-- need reassigning by an Admin. Expected 0 after the migration; if it is not,
-- stop and report before changing anything.
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
SELECT u.name AS university,
       f.name AS college,
       count(sp.id) AS students_outside_their_ladder
  FROM "student_profiles" sp
  JOIN governing g ON g.faculty_id = sp."facultyId"
  JOIN "faculties" f ON f.id = sp."facultyId"
  JOIN "universities" u ON u.id = f."universityId"
  LEFT JOIN "academic_years" ay ON ay.id = sp."academicYearId"
 WHERE g.structure_id IS NOT NULL
   AND (ay."structureId" IS NULL OR ay."structureId" <> g.structure_id)
 GROUP BY u.name, f.name
HAVING count(sp.id) > 0
 ORDER BY students_outside_their_ladder DESC;

-- =============================================================================
-- How to read the output
--
-- Section 2  The model working. "inherits university" follows it;
--            "OVERRIDE (immune to university changes)" does not.
--
-- Section 3  Non-zero is expected right after the migration: it records the
--            colleges that genuinely diverged before it. Only a college that is
--            NOT listed in section 2 as an override is a surprise.
--
-- Section 4  Cleared overrides, worth a look but harmless in the meantime.
--
-- Section 5  Colleges whose ladder contradicts their configuration. Fix by
--            setting the college's override or changing the ladder's kind
--            through the API, which validates the pair together. Do NOT edit
--            academic_structures directly. Empty is the expected state.
--
-- Section 6  The one that matters. Non-zero means real students are filed on a
--            rung their college no longer uses. Report it; do not auto-fix.
-- =============================================================================