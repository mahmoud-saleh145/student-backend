-- Durable processing intent for the independent mobile pipeline.
--
-- ADDITIVE ONLY: four new columns on "videos", three nullable and one with a
-- constant default. No existing column, row, index or constraint is changed,
-- so builds that predate this migration (the running API and the laptop
-- worker image) keep working against the migrated database unchanged.
--
-- PostgreSQL adds a column with a constant default as a metadata-only change:
-- no table rewrite and no long lock on "videos".
ALTER TABLE "videos"
  ADD COLUMN "mobileRequestedAt" TIMESTAMP(3),
  ADD COLUMN "mobileEnqueuedAt"  TIMESTAMP(3),
  ADD COLUMN "mobileGeneration"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mobileTrigger"     TEXT;
