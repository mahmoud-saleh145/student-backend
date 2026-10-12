-- Strict DRM-only playback + automatic Gumlet ingestion.
--
-- PREPARED ONLY. NOT APPLIED to Production. Apply only after review.
--
-- WHY A MIGRATION IS ESSENTIAL
--
-- Playback must not trust `drmProvider` alone. That column is a routing flag
-- written by our own ingest code; it proves we INTENDED to use Gumlet, not that
-- the asset exists or that its manifest is CENC-encrypted. The rule "a student
-- may only play a verified-DRM video" needs a value that is set ONLY after a
-- real check against the provider, and is cleared when that check stops being
-- true. There is no way to derive that from the existing columns.
--
-- All three columns are ADDITIVE: nothing is dropped, renamed or retyped, and
-- no existing row is rewritten. Two are nullable with no default
-- (`drmVerifiedAt`, `drmBlockedReason`); the third, `drmRequested`, is
-- `NOT NULL DEFAULT false` so that existing rows read `false` rather than NULL
-- (a NULL there could not express "never requested DRM"). On PostgreSQL 11+ an
-- `ADD COLUMN ... NOT NULL DEFAULT <constant>` is a metadata-only change - no
-- table rewrite - so it is fast even on a large `videos` table.
--
-- The consequences of those defaults are deliberate:
--   * every existing row reads `drmVerifiedAt = NULL` => NOT verified =>
--     playback is denied. Existing videos fail closed the moment this is
--     applied, which is the intended security posture.
--   * every existing row reads `drmRequested = false` => the platform never
--     claimed to have asked for DRM on their behalf.
--   * no backfill can grant playback to a video that was never checked.
--
-- Applying this while the deployed build still runs `main` changes no behaviour:
-- that code references none of the three columns.
ALTER TABLE "videos" ADD COLUMN "drmVerifiedAt" TIMESTAMP(3),
ADD COLUMN "drmBlockedReason" TEXT,
ADD COLUMN "drmRequested" BOOLEAN NOT NULL DEFAULT false;

-- Supports the reconciliation sweep, which scans for videos that are on the
-- Gumlet path but not verified (or verified too long ago).
CREATE INDEX "videos_drmVerifiedAt_idx" ON "videos" ("drmVerifiedAt");
CREATE INDEX "videos_drmProvider_drmVerifiedAt_idx" ON "videos" ("drmProvider", "drmVerifiedAt");

-- ---------------------------------------------------------------------------
-- ROLLBACK
-- ---------------------------------------------------------------------------
-- DROP INDEX "videos_drmProvider_drmVerifiedAt_idx";
-- DROP INDEX "videos_drmVerifiedAt_idx";
-- ALTER TABLE "videos" DROP COLUMN "drmRequested",
--   DROP COLUMN "drmBlockedReason",
--   DROP COLUMN "drmVerifiedAt";
--
-- Safe at any time: dropping these columns only removes the ability to prove
-- DRM was verified. It cannot un-encrypt anything, and it cannot re-open
-- playback on its own.