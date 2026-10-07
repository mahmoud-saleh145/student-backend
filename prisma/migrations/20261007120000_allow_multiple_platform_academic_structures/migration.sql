-- -----------------------------------------------------------------------------
-- Allow SEVERAL platform-wide academic structures.
--
-- The rule changed, and only for the platform scope.
--
-- Until now `scopeKey` carried a plain UNIQUE index, which made the table hold
-- at most one platform-wide structure: every platform-wide row has the same
-- denormalised key ('platform'), so the index rejected the second one. That was
-- deliberate — the original design wanted exactly one default ladder — and it is
-- exactly what we are changing now. An installation may legitimately keep more
-- than one platform-wide structure (a YEAR ladder and a LEVEL ladder, or a
-- second default kept alongside the first).
--
-- What must NOT change:
--
--   * A university, faculty or department may still have exactly ONE structure.
--     That is the whole reason `scopeKey` was introduced: Postgres treats NULLs
--     as distinct, so a UNIQUE over the three nullable owner columns would have
--     accepted two structures for the same unit.
--   * Every existing row is preserved. Nothing is deleted, renumbered or
--     rewritten; only the index is swapped.
--
-- How: replace the single-column UNIQUE with a PARTIAL unique index that
-- excludes the platform key. Postgres evaluates the WHERE clause as part of the
-- index, so 'platform' rows are simply not indexed for uniqueness and may
-- repeat, while every scoped key is still unique.
--
-- Order matters. The replacement index is created before the old one is dropped
-- so there is no window in which a concurrent write could insert a duplicate
-- scoped structure. `IF NOT EXISTS` keeps this re-runnable against a partially
-- applied database.
--
-- The application change that accompanies this migration is in
-- CatalogService.createAcademicStructure: it no longer runs the duplicate
-- pre-check for the platform scope. Because the index below is the backstop for
-- scoped duplicates, that check remains a user-facing field error rather than a
-- unique violation surfaced as a 500.
-- -----------------------------------------------------------------------------

-- Partial replacement, created first so uniqueness is never absent.
CREATE UNIQUE INDEX IF NOT EXISTS "academic_structures_scoped_scopeKey_key"
  ON "academic_structures" ("scopeKey")
  WHERE "scopeKey" <> 'platform';

-- Only now is the blanket index redundant: every key it covered uniquely is
-- covered by the partial index above, and 'platform' is intentionally exempt.
DROP INDEX IF EXISTS "academic_structures_scopeKey_key";

-- Read paths filter and join on scopeKey (structure resolution walks the
-- department -> faculty -> university -> platform chain). Dropping the unique
-- index above would otherwise leave that lookup unindexed, so the plain index
-- declared in schema.prisma is created here to match.
CREATE INDEX IF NOT EXISTS "academic_structures_scopeKey_idx"
  ON "academic_structures" ("scopeKey");
