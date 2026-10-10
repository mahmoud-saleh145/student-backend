-- Adds the GENERAL/PROGRAMS split to departments.
--
-- Schema only. The demo hierarchy this migration originally carried (a third
-- 'Engineering' faculty plus 'Preparatory Engineering', 'Civil Engineering',
-- 'Architecture', 'Program / Department A/B' and their ladders) has been
-- removed: production already holds the real Mansoura University engineering
-- faculties ('Faculty of Engineering (General)' and 'Faculty of Engineering
-- (Programs)'), so applying it would have inserted a duplicate faculty and
-- five duplicate departments alongside live data.
--
-- ADD COLUMN ... NOT NULL DEFAULT in one statement is safe on populated data:
-- Postgres 11+ stores the default in the table metadata and backfills
-- existing rows atomically, so every pre-existing department reads back as
-- 'GENERAL' with no NULL window and no table rewrite.

BEGIN;

CREATE TYPE "StudyType" AS ENUM ('GENERAL', 'PROGRAMS');
ALTER TABLE "departments" ADD COLUMN "studyType" "StudyType" NOT NULL DEFAULT 'GENERAL';
CREATE INDEX "departments_facultyId_studyType_isActive_idx" ON "departments" ("facultyId", "studyType", "isActive");

-- Production departments are already classified by faculty: the Programs
-- faculty's departments are the program branches and must resolve to a LEVEL
-- ladder, everything else stays on the YEAR ladder (see
-- catalog.service.ts assertDepartmentStructureKind). Scoped by faculty id so
-- this is a no-op on any other dataset.

UPDATE "departments" AS d
SET "studyType" = 'PROGRAMS'
FROM "faculties" AS f
WHERE f.id = d."facultyId"
  AND f.name = 'Faculty of Engineering (Programs)'
  AND f."deletedAt" IS NULL
  AND d."deletedAt" IS NULL
  AND d."studyType" <> 'PROGRAMS';

COMMIT;