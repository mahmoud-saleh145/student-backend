-- =============================================================================
-- OPTIONAL: trigram search acceleration
-- =============================================================================
--
-- Why this is not in prisma/migrations/
-- -------------------------------------
-- `CREATE EXTENSION` requires elevated privileges that several managed
-- Postgres providers do not grant to the application role. If this ran as part
-- of the normal migration chain, `prisma migrate deploy` would abort during a
-- deployment on those providers — turning a performance nicety into an outage.
-- So it lives here and is applied deliberately, by a DBA, once.
--
-- What it does
-- ------------
-- Search (src/modules/search) uses indexed `ILIKE '%term%'` matching. That is
-- the right default for this corpus: titles are short, the content is
-- bilingual Arabic/English, and students type partial words — all cases where
-- Postgres full-text search (which stems whole lexemes per-language) performs
-- worse, not better.
--
-- The cost of `ILIKE '%…%'` is that a plain B-tree cannot serve it: Postgres
-- falls back to a sequential scan. Below roughly 50 000 courses+lessons that
-- is a few milliseconds and nobody notices. Above it, latency grows linearly.
-- A GIN index over trigrams fixes exactly that, without changing a single
-- line of application code — the same queries simply get an index scan.
--
-- When to apply it
-- ----------------
-- When `EXPLAIN ANALYZE` on a search query shows a sequential scan taking more
-- than ~50 ms. Before that, the indexes cost write throughput and disk for no
-- measurable read benefit.
--
-- How to apply
-- ------------
--   psql "$DATABASE_URL" -f prisma/optional/001_search_trigram.sql
--
-- How to verify
-- -------------
--   EXPLAIN ANALYZE SELECT id FROM courses WHERE title ILIKE '%كيميا%';
-- should report `Bitmap Index Scan on courses_title_trgm_idx`.
--
-- Note: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. psql
-- runs each statement autocommitted by default, which is why this file is
-- applied with psql rather than through Prisma.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Course discovery ------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS courses_title_trgm_idx
  ON courses USING GIN (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS courses_title_ar_trgm_idx
  ON courses USING GIN ("titleAr" gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS courses_short_description_trgm_idx
  ON courses USING GIN ("shortDescription" gin_trgm_ops);

-- Lesson search ---------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS lessons_title_trgm_idx
  ON lessons USING GIN (title gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS lessons_title_ar_trgm_idx
  ON lessons USING GIN ("titleAr" gin_trgm_ops);

-- Teacher lookup --------------------------------------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_full_name_trgm_idx
  ON users USING GIN ("fullName" gin_trgm_ops);

-- Administrative student lookup by phone fragment ------------------------------
CREATE INDEX CONCURRENTLY IF NOT EXISTS users_phone_trgm_idx
  ON users USING GIN (phone gin_trgm_ops);
