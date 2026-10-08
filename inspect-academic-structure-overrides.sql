-- =============================================================================
-- Does production need a data backfill for academic_structure_faculties?
--
-- READ-ONLY. Six SELECTs, no DDL, no DML, no locks.
-- Run in the Neon SQL Editor against production, or:
--   psql "$DATABASE_URL" -f inspect-academic-structure-overrides.sql
--
-- Read section 3 first. If it returns 0, no backfill is required and nothing
-- further is needed. Sections 4-6 only matter if it does not.
-- =============================================================================

\echo '=== 1. Is the new table there yet? ==='
SELECT to_regclass('public.academic_structure_faculties') IS NOT NULL AS table_exists;

\echo '=== 2. Migration history: what has production actually applied? ==='
-- Needs the _prisma_migrations table, which every Prisma-managed database has.
-- (A table reference is resolved at parse time, so this cannot be guarded by a
-- WHERE clause; against a hand-built database this one section errors and the
-- rest still runs.)
SELECT migration_name,
       to_char(finished_at, 'YYYY-MM-DD HH24:MI') AS finished_at,
       CASE WHEN rolled_back_at IS NOT NULL THEN 'ROLLED BACK'
            WHEN finished_at IS NULL        THEN 'FAILED / IN PROGRESS'
            ELSE 'applied' END AS state
FROM _prisma_migrations
WHERE migration_name >= '20261007'
ORDER BY migration_name;

\echo '=== 3. THE BACKFILL QUESTION: how many faculty-OWNED structures exist? ==='
-- These are the rows the old `AcademicStructure.facultyId` design produced.
-- 0  -> no backfill is required, and nothing below matters.
-- >0 -> read section 4 before deciding; the default answer is still "no".
SELECT count(*) AS faculty_owned_structures
FROM academic_structures
WHERE "facultyId" IS NOT NULL;

\echo '=== 4. If any exist, exactly which ones, and would a pin change anything? ==='
SELECT s.id            AS structure_id,
       s."scopeKey",
       s.kind,
       s."isActive",
       f.id            AS faculty_id,
       f.name          AS faculty_name,
       u.name          AS faculty_university,
       -- A pin would only ever CHANGE behaviour for a faculty that also has a
       -- department holding its own structure, because the pin outranks it.
       (SELECT count(*)
          FROM departments d
          JOIN academic_structures ds ON ds."departmentId" = d.id
         WHERE d."facultyId" = f.id) AS departments_with_own_structure
FROM academic_structures s
JOIN faculties  f ON f.id = s."facultyId"
JOIN universities u ON u.id = f."universityId"
WHERE s."facultyId" IS NOT NULL
ORDER BY u.name, f.name;

\echo '=== 5. Department-owned structures (the rows a pin would outrank) ==='
SELECT s.id AS structure_id, s."scopeKey", d.name AS department, f.name AS faculty
FROM academic_structures s
JOIN departments d ON d.id = s."departmentId"
JOIN faculties   f ON f.id = d."facultyId"
WHERE s."departmentId" IS NOT NULL
ORDER BY f.name, d.name;

\echo '=== 6. Sanity: the ladders in use, so nothing above is read out of context ==='
SELECT s."scopeKey",
       s.kind,
       s."isActive",
       count(y.id) FILTER (WHERE y."isActive") AS active_entries
FROM academic_structures s
LEFT JOIN academic_years y ON y."structureId" = s.id
GROUP BY s.id, s."scopeKey", s.kind, s."isActive"
ORDER BY s."scopeKey";

-- =============================================================================
-- How to read section 3
--
-- NO BACKFILL IS REQUIRED, whatever the count. Ownership and override are
-- separate mechanisms, and a faculty-owned structure keeps working untouched:
-- `resolveAcademicStructure` still puts `faculty:<id>` in its candidate chain,
-- so that faculty resolves to its own ladder exactly as it did before this
-- migration. The new table's correct initial state is empty.
--
-- Copying those rows into academic_structure_faculties would be a BEHAVIOUR
-- CHANGE, not a migration. The explicit pin sits ABOVE a department's own
-- structure in the resolution order, while faculty ownership sits below it. So
-- for any faculty in section 4 whose `departments_with_own_structure` is > 0,
-- inserting a pin would silently move those departments onto the faculty's
-- ladder. That is why this is a query to read rather than an UPDATE to run.
--
-- The only thing production needs is the schema:
--   npx prisma migrate deploy
-- =============================================================================
