-- -----------------------------------------------------------------------------
-- Explicit faculty -> academic structure overrides.
--
-- Until now the ladder a faculty used was decided purely by inheritance:
-- department -> faculty -> university -> platform, resolved from `scopeKey`.
-- That cannot express "this faculty, wherever it sits, uses THAT ladder",
-- because:
--
--   * `AcademicStructure.facultyId` is OWNERSHIP and holds a single faculty,
--     while an override list is many faculties per structure; and
--   * the `academic_structures_single_owner_check` CHECK constraint forbids a
--     row carrying both `universityId` and `facultyId`, which is precisely the
--     combination needed to pin University A's faculty to University B's
--     ladder.
--
-- So the assignment gets its own table. Resolution order becomes:
--
--   department's own ladder
--     -> explicit faculty override (this table)
--     -> faculty-owned ladder
--     -> university-owned ladder
--     -> platform ladder
--
-- This migration is PURELY ADDITIVE. It creates one table, one unique index,
-- one plain index and two foreign keys. No existing table, column, index,
-- constraint or row is altered or removed, and the table starts empty — so
-- every unit resolves exactly as it did before until an Admin creates an
-- override. That is what "preserve existing behaviour for all current data"
-- means here: there is no backfill because the correct initial state is "no
-- overrides".
--
-- `facultyId` is UNIQUE across the whole table rather than unique per
-- structure. A faculty pinned to two ladders would have no defined answer, so
-- the database refuses it outright and reassignment moves the row.
--
-- `ON DELETE CASCADE` on both sides: an override is meaningless without either
-- end, and it carries no business record of its own (the audit log holds the
-- history). Note this cascades from the *structure* too, so deleting a ladder
-- releases its faculties back to inheritance rather than leaving dangling rows.
--
-- Every statement is `IF NOT EXISTS` / guarded so the file is re-runnable
-- against a partially applied database.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "academic_structure_faculties" (
    "id"          TEXT         NOT NULL,
    "structureId" TEXT         NOT NULL,
    "facultyId"   TEXT         NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "academic_structure_faculties_pkey" PRIMARY KEY ("id")
);

-- One override per faculty, platform-wide. This is the constraint that makes
-- resolution deterministic; the service checks first so the Admin sees a field
-- error, and this index has the last word if two Admins race.
CREATE UNIQUE INDEX IF NOT EXISTS "academic_structure_faculties_facultyId_key"
    ON "academic_structure_faculties" ("facultyId");

-- Listing a structure's own overrides is the admin screen's hot read.
CREATE INDEX IF NOT EXISTS "academic_structure_faculties_structureId_idx"
    ON "academic_structure_faculties" ("structureId");

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'academic_structure_faculties_structureId_fkey'
    ) THEN
        ALTER TABLE "academic_structure_faculties"
            ADD CONSTRAINT "academic_structure_faculties_structureId_fkey"
            FOREIGN KEY ("structureId") REFERENCES "academic_structures"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'academic_structure_faculties_facultyId_fkey'
    ) THEN
        ALTER TABLE "academic_structure_faculties"
            ADD CONSTRAINT "academic_structure_faculties_facultyId_fkey"
            FOREIGN KEY ("facultyId") REFERENCES "faculties"("id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
