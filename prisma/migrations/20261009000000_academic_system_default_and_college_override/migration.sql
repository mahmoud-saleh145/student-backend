-- -----------------------------------------------------------------------------
-- University default academic system + college-level override.
--
-- THE MODEL THIS ESTABLISHES
--
--   University.defaultAcademicSystem      -- the system's default (not nullable)
--            |
--            v
--   Faculty.academicSystemOverride         -- nullable; NULL means INHERIT
--            |
--            v
--   effective academic system for a college
--            |
--            v
--   the year/level list a student actually picks from
--
-- This is real inheritance, not a copy: a college with NULL follows its
-- university and changes with it, a college with a stored value does not.
--
-- WHY `Faculty.academicSystemOverride` IS NULL FOR ALMOST EVERY EXISTING ROW
--
-- The tempting backfill is "copy each university's value onto all its
-- colleges". That would be a silent, irreversible behaviour change: every
-- existing college would become an EXPLICIT override, and from that moment no
-- Admin could ever change a university's default again without editing each
-- college by hand. It is also unrecoverable, because after the copy there is
-- no way to tell a deliberate override from a copied one.
--
-- So the backfill in section 2 is narrow and evidence-based: it writes only to a
-- college whose CURRENT behaviour already diverges from its university, and
-- leaves NULL everywhere else. NULL reproduces today's behaviour exactly while
-- leaving the university-wide change available.
--
-- WHY `defaultAcademicSystem` IS BACKFILLED RATHER THAN LEFT AT ITS DEFAULT
--
-- The column is added NOT NULL DEFAULT 'YEAR', so the ADD is safe on populated
-- data with no NULL window. The DEFAULT would then be factually wrong for any
-- university that is demonstrably level-based today, so section 1 derives the
-- real value per university from the kind its own structures already carry.
-- A university whose configuration cannot be determined unambiguously keeps
-- the safe default and is listed by the diagnostic.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 1. University default
-- -----------------------------------------------------------------------------

ALTER TABLE "universities"
  ADD COLUMN IF NOT EXISTS "defaultAcademicSystem" "AcademicStructureKind" NOT NULL DEFAULT 'YEAR';

-- Derive the true value where it is unambiguous: a university that already owns
-- a YEAR or a LEVEL ladder is telling us its default, so honour it instead of
-- stamping YEAR over it.
--
-- Ordered oldest-first so a university with two active university-scoped
-- structures resolves deterministically to the same row the runtime resolver
-- would pick, rather than to whichever row Postgres happened to return.
WITH ranked AS (
    SELECT s."universityId" AS uid,
           s."kind"         AS kind,
           row_number() OVER (
               PARTITION BY s."universityId"
               ORDER BY s."createdAt" ASC, s."id" ASC
           ) AS rn
      FROM "academic_structures" s
     WHERE s."universityId" IS NOT NULL
       AND s."isActive" = true
       AND s."scopeKey" = 'university:' || s."universityId"
)
UPDATE "universities" u
   SET "defaultAcademicSystem" = r.kind
  FROM ranked r
 WHERE r.uid = u.id
   AND r.rn = 1;

-- -----------------------------------------------------------------------------
-- 2. College override
-- -----------------------------------------------------------------------------

-- Nullable, no default. NULL is the meaning of "inherits its university".
ALTER TABLE "faculties"
  ADD COLUMN IF NOT EXISTS "academicSystemOverride" "AcademicStructureKind";

-- WHY THERE IS A NARROW BACKFILL AFTER ALL
--
-- NOT "copy each university's value onto all its colleges" — that is the
-- mistake this column exists to prevent, and it is still refused. This writes
-- ONLY to a college whose CURRENT ladder kind already differs from the default
-- it is about to inherit, i.e. a college that does not in fact follow its
-- university today.
--
-- Without it, such a college would be silently mis-described. In production at
-- the time of writing, "Faculty of Engineering (Programs)" is pinned to a LEVEL
-- ladder (Level 000..400) while its university owns no structure at all and would
-- be stamped YEAR: the college would be *configured* year-based while every rung
-- it can offer is a level, and the API's own kind-vs-system check would then
-- refuse to let an administrator repair it.
--
-- The predicate is deliberately narrow and auditable:
--
--   * faculty-owned structure, else
--   * the structure an existing `academic_structure_faculties` pin points at
--     (that pin IS today's behaviour — it outranks inheritance), else
--   * the university's own structure.
--
-- A college whose effective kind EQUALS the default it will inherit is left NULL,
-- so it keeps following the university exactly as it does today. Overriding it
-- would have frozen it against future university-wide changes for no reason.
--
-- `inherited_default` READS THE COLUMN SECTION 1 JUST WROTE rather than
-- re-deriving it. The two formulations are equivalent — Section 1 assigns the
-- oldest active university-scoped structure's kind, or leaves the ADD COLUMN
-- default of 'YEAR', which is exactly what the previous subquery recomputed —
-- but re-deriving it silently duplicated the rule in two places, and the day
-- someone edited Section 1 this UPDATE would keep using the old one. Reading
-- the column means there is one definition of "a university's default" in this
-- file.
--
-- The join on `universities` is what makes that possible, and it also means a
-- faculty whose university has vanished is simply not updated: the UPDATE
-- matches on the joined row, so an orphan is left NULL rather than being stamped
-- with an assumption.
WITH effective AS (
    SELECT f.id AS faculty_id,
           COALESCE(
               (SELECT s.kind FROM "academic_structures" s
                 WHERE s."facultyId" = f.id AND s."isActive" = true
                 ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1),
               (SELECT s.kind
                  FROM "academic_structure_faculties" x
                  JOIN "academic_structures" s ON s.id = x."structureId"
                 WHERE x."facultyId" = f.id AND s."isActive" = true
                 LIMIT 1),
               (SELECT s.kind FROM "academic_structures" s
                 WHERE s."universityId" = f."universityId"
                   AND s."isActive" = true
                   AND s."scopeKey" = 'university:' || f."universityId"
                 ORDER BY s."createdAt" ASC, s."id" ASC LIMIT 1),
               'YEAR'::"AcademicStructureKind"
           ) AS effective_kind,
           u."defaultAcademicSystem" AS inherited_default
      FROM "faculties" f
      JOIN "universities" u ON u.id = f."universityId"
     WHERE f."deletedAt" IS NULL
)
UPDATE "faculties" f
   SET "academicSystemOverride" = e.effective_kind
  FROM effective e
 WHERE e.faculty_id = f.id
   AND e.effective_kind <> e.inherited_default;

-- -----------------------------------------------------------------------------
-- 3. Index supporting the admin listing
-- -----------------------------------------------------------------------------

-- "Show me every college that overrides its university" is the query the
-- Academic Structure screen runs, and without this it is a sequential scan of
-- every faculty on the platform.
CREATE INDEX IF NOT EXISTS "faculties_academicSystemOverride_idx"
    ON "faculties" ("academicSystemOverride")
    WHERE "academicSystemOverride" IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Guard against storing a redundant override
-- -----------------------------------------------------------------------------

-- An override is only meaningful when it is the OPPOSITE of the university's
-- default. Recording YEAR on a university that is already YEAR is not a
-- different configuration, it is a stale copy of the same one — and a stale
-- copy is exactly the failure this column's design exists to prevent, because
-- it survives a later change of the university's default and then means
-- something the Admin never asked for.
--
-- This needs a TRIGGER, not a CHECK constraint: a Postgres CHECK may not
-- contain a subquery, and comparing against the parent university is exactly a
-- subquery. The trigger is the database-side backstop; the service performs the
-- same check with a proper field error, because that is what an Admin should
-- actually see.
--
-- The trigger deliberately allows the redundant case when the stored value is
-- ALREADY what the check would reject. Without that, flipping a university's
-- default from YEAR to LEVEL would immediately invalidate every college that
-- had been pinned to YEAR, and the migration would fail on live data that was
-- perfectly legitimate a moment earlier. Only NEW or CHANGED override values
-- are judged.

CREATE OR REPLACE FUNCTION "faculties_reject_redundant_override"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    parent_default "AcademicStructureKind";
BEGIN
    IF NEW."academicSystemOverride" IS NULL THEN
        RETURN NEW;
    END IF;

    -- Unchanged on this write: the university's default may have moved under
    -- it, which is exactly the inheritance behaviour we want to allow.
    IF TG_OP = 'UPDATE'
       AND NEW."academicSystemOverride"
           IS NOT DISTINCT FROM OLD."academicSystemOverride" THEN
        RETURN NEW;
    END IF;

    SELECT "defaultAcademicSystem"
      INTO parent_default
      FROM "universities"
     WHERE id = NEW."universityId";

    IF parent_default IS NULL THEN
        RAISE EXCEPTION
            'Faculty % references university %, which does not exist', NEW.id, NEW."universityId";
    END IF;

    IF NEW."academicSystemOverride" = parent_default THEN
        RAISE EXCEPTION
            'Faculty % already inherits % from its university; store NULL to inherit',
            NEW.id, parent_default;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "faculties_reject_redundant_override_trigger" ON "faculties";

CREATE TRIGGER "faculties_reject_redundant_override_trigger"
    BEFORE INSERT OR UPDATE OF "academicSystemOverride" ON "faculties"
    FOR EACH ROW
    EXECUTE FUNCTION "faculties_reject_redundant_override"();

-- -----------------------------------------------------------------------------
-- 5. Read-only verification
-- -----------------------------------------------------------------------------
-- Nothing in this file needs SQL comments to run; the queries below are for an
-- operator to confirm the result. `inspect-academic-systems.sql` in the
-- repository root is the fuller version and runs the same checks in six
-- sections — that is the one to use, and these are kept here only so the file
-- is self-explanatory next to the statements they describe.
--
-- Colleges needing a decision are NOT part of this step. Section 2 already
-- resolves them: any college whose ladder genuinely differs from its
-- university's default is given an explicit override, and the rest are left NULL
-- to inherit. What is still worth reviewing afterwards is section 5 of
-- `inspect-academic-systems.sql` — a college whose LADDER and whose CONFIGURED
-- SYSTEM disagree, because changing a university default moves the
-- configuration and leaves the ladder alone.
-- -----------------------------------------------------------------------------

-- Every university, with its default and how many colleges inherit versus
-- override it.
-- SELECT u.name,
--        u."defaultAcademicSystem" AS university_default,
--        count(f.id) FILTER (WHERE f."academicSystemOverride" IS NOT NULL) AS overriding,
--        count(f.id) FILTER (WHERE f."academicSystemOverride" IS NULL)     AS inheriting
--   FROM "universities" u
--   LEFT JOIN "faculties" f ON f."universityId" = u.id AND f."deletedAt" IS NULL
--  GROUP BY u.id, u.name, u."defaultAcademicSystem"
--  ORDER BY u.name;

-- Colleges that ended up with an explicit override, and the evidence for it.
-- Each row should be a college whose ladder really did differ from its
-- university; a row whose `college_ladder_kind` matches its university's
-- `default` would mean the predicate in section 2 matched something it should
-- not have, which is a bug worth catching.
-- SELECT u.name AS university,
--        f.name AS college,
--        f."academicSystemOverride" AS override,
--        s.kind AS college_ladder_kind,
--        u."defaultAcademicSystem" AS university_default
--   FROM "academic_structures" s
--   JOIN "faculties"  f ON f.id = s."facultyId"
--   JOIN "universities" u ON u.id = f."universityId"
--  WHERE s."facultyId" IS NOT NULL
--    AND s."isActive" = true
--  ORDER BY u.name, f.name;

-- Universities that fell back to the 'YEAR' column default because nothing
-- recorded a kind for them. Expected on a database whose universities have no
-- structure of their own; each one inherits years, which is the status quo.
-- SELECT u.name
--   FROM "universities" u
--  WHERE u."defaultAcademicSystem" = 'YEAR'
--    AND NOT EXISTS (
--        SELECT 1 FROM "academic_structures" s
--         WHERE s."universityId" = u.id AND s."isActive" = true
--    )
--  ORDER BY u.name;