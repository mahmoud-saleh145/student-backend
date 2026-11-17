-- The "new video" notification, as a durable state on the lecture's video.
--
-- A lecture can become playable through two independent pipelines (the Gumlet
-- asset, the mobile HLS ladder), in a process and at a moment when the
-- notification often must not go out yet: the lesson is still a draft, or
-- only one pipeline has finished. So what is owed is recorded here, and
-- sending it is a separate, repeatable step.
--
--   NULL     nothing owed (not playable yet, or it predates this mechanism)
--   PENDING  playable, students not told yet
--   SENDING  one process holds the claim and is writing the notifications
--   MOBILE   told only the students who can play it in the app
--   DONE     told, or recorded as not needing it (final)
--
-- Additive: two nullable columns and one small index. Code that does not know
-- them ignores them.
ALTER TABLE "videos"
  ADD COLUMN "newVideoAnnounceState"   TEXT,
  ADD COLUMN "newVideoAnnounceStateAt" TIMESTAMP(3);

-- Every lecture that has ALREADY been processed is not news. Without this, the
-- first later event on an old lecture - its Gumlet asset repaired, a mobile
-- re-encode - could announce it to the whole course as a new video.
--
-- This is the only statement in the release that writes to existing rows. It
-- sets the two new columns and nothing else (`updatedAt` is maintained by the
-- application, not by a trigger, so it does not move), and it is idempotent.
UPDATE "videos"
   SET "newVideoAnnounceState"   = 'DONE',
       "newVideoAnnounceStateAt" = COALESCE("processedAt", "mobileProcessedAt", "updatedAt")
 WHERE "newVideoAnnounceState" IS NULL
   AND (
        "status" IN ('READY', 'ARCHIVED')
     OR "mobileStatus" = 'READY'
     OR "processedAt" IS NOT NULL
     OR "mobileProcessedAt" IS NOT NULL
   );

-- What the reconciler looks for: the few rows that are PENDING or SENDING.
CREATE INDEX "videos_newVideoAnnounceState_idx" ON "videos"("newVideoAnnounceState");
