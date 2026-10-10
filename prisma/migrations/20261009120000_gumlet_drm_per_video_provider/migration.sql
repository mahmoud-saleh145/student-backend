-- -----------------------------------------------------------------------------
-- Gumlet DRM: optional per-video playback provider.
--
-- WHAT THIS MIGRATION DOES
--
--   Video.drmProvider          new, NULLABLE, no default
--   Video.gumletAssetId        new, NULLABLE
--   Video.gumletWorkspaceId    new, NULLABLE
--   Video.gumletStatus         new, NULLABLE
--   Video.gumletError          new, NULLABLE
--   Video.gumletUpdatedAt      new, NULLABLE
--
-- WHY EVERY COLUMN IS NULLABLE WITH NO DEFAULT
--
--   Every existing Video row keeps drmProvider = NULL, which the code treats as
--   "legacy R2/AES-128 HLS". A NULL default is what makes this migration
--   behaviour-preserving: after it runs, nothing about existing playback
--   changes, and no existing video can be swept onto a new delivery path by a
--   configuration mistake.
--
--   The alternative - a DEFAULT or a backfill - would either enable Gumlet for
--   the whole library (unacceptable: the manifest format changes from HLS to
--   DASH and requires a valid asset) or leave a column that lies about intent.
--
-- SAFETY
--
--   * Additive only. No column is dropped, renamed or retyped.
--   * No table is rewritten, so this is fast even on a large `videos` table.
--   * No index is added: gumlet_asset_id is only read after a video row is
--     already loaded by primary key, so an index would be dead weight.
--   * Rollback is the matching DROP COLUMN set at the bottom of this file.
--
-- NOT EXECUTED as part of this change. Apply with:
--   npx prisma migrate deploy
-- -----------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "videos" ADD COLUMN "drmProvider" TEXT,
ADD COLUMN "gumletAssetId" TEXT,
ADD COLUMN "gumletWorkspaceId" TEXT,
ADD COLUMN "gumletStatus" TEXT,
ADD COLUMN "gumletError" TEXT,
ADD COLUMN "gumletUpdatedAt" TIMESTAMP(3);

-- -----------------------------------------------------------------------------
-- Rollback (only if the integration is abandoned):
--
--   ALTER TABLE "videos" DROP COLUMN "drmProvider",
--   DROP COLUMN "gumletAssetId",
--   DROP COLUMN "gumletWorkspaceId",
--   DROP COLUMN "gumletStatus",
--   DROP COLUMN "gumletError",
--   DROP COLUMN "gumletUpdatedAt";
-- -----------------------------------------------------------------------------