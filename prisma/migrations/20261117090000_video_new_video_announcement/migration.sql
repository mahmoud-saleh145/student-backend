-- The once-only "new video" notification.
--
-- A lecture can now become playable through two independent pipelines (the
-- Gumlet asset, the mobile HLS ladder). Whichever finishes first tells the
-- enrolled students, and it claims this column with a compare-and-set so the
-- other one says nothing. NULL = not announced yet.
--
-- Additive: one nullable column, no default, no index (it is only ever read
-- and written by primary key). Code that does not know the column ignores it.
ALTER TABLE "videos"
  ADD COLUMN "newVideoAnnouncedAt" TIMESTAMP(3);

-- Every lecture that has ALREADY been processed is not news. Without this, the
-- first later event on an old lecture - its Gumlet asset repaired, a mobile
-- re-encode - would announce it to the whole course as a new video.
--
-- This is the only statement in the release that writes to existing rows. It
-- sets the new column and nothing else (`updatedAt` is maintained by the
-- application, not by a trigger, so it does not move), and it is idempotent.
UPDATE "videos"
   SET "newVideoAnnouncedAt" = COALESCE("processedAt", "mobileProcessedAt", "updatedAt")
 WHERE "newVideoAnnouncedAt" IS NULL
   AND (
        "status" IN ('READY', 'ARCHIVED')
     OR "mobileStatus" = 'READY'
     OR "processedAt" IS NOT NULL
     OR "mobileProcessedAt" IS NOT NULL
   );
