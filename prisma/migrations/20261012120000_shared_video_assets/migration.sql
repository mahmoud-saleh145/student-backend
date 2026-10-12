-- Shared video assets: one `Video` row, many lectures.
--
-- PREPARED ONLY. NOT APPLIED to Production. Apply only after review.
--
-- WHY A MIGRATION IS ESSENTIAL
--
-- `videos.lessonId` was `UNIQUE NOT NULL` with `ON DELETE CASCADE`. That encodes
-- "an asset belongs to exactly one lecture, and destroying that lecture destroys
-- the asset". Reusing a video therefore had exactly two possible expressions:
-- overwrite `lessonId` (which detaches it from the lecture it was uploaded to
-- and silently changes every other lecture's media), or duplicate the file.
-- Neither is acceptable, so the constraint itself has to change.
--
-- THE DESIGN
--
-- `Video` stays exactly what it is: the single record that owns the upload, the
-- R2 source object, the Gumlet asset ID, the DRM/CENC state and the processing
-- status. `lessonId` becomes the *origin* lecture (where the upload was
-- authored) rather than the *only* lecture. Nothing about ingestion, DRM,
-- playback tickets or the worker changes shape, and no existing row is rewritten.
--
-- A new `lesson_videos` table attaches one shared asset to one lecture. Reuse
-- costs one small row. It does not re-upload bytes, does not create a second
-- Gumlet asset, and cannot fork the asset's metadata.
--
-- SAFETY OF THE DATA CHANGES
--
-- 1. The new table is created and backfilled with one row per existing video,
--    so every lesson that "had" its video still has it through the new table.
--    Reuse can therefore never be applied to a lecture that already has one.
-- 2. The UNIQUE index on `videos.lessonId` is deliberately KEPT. It is what
--    keeps `Lesson.video` a singular Prisma relation, so every existing
--    `include: { video: … }` query keeps compiling and keeps meaning "the video
--    this lecture owns". Only the NOT NULL is dropped.
-- 3. Dropping NOT NULL and relaxing the foreign key are the last two statements,
--    after the table exists, so no statement can fail against a database that
--    already has the table. `IF EXISTS` keeps it re-runnable.
-- 4. The FK change is the security-relevant one. While it was CASCADE, deleting
--    the origin lecture - or its whole course - silently destroyed an asset that
--    other courses were still playing. `SET NULL` means deleting a lecture drops
--    only its attachment rows and can never destroy shared media. `SET NULL` also
--    makes it safe to leave `lessonId` nullable, which is what allows a reused
--    asset to outlive the lecture it was uploaded from.
--
-- The backfill is idempotent (`ON CONFLICT DO NOTHING`) and touches only rows
-- that are provably safe: a video with a non-null `lessonId`.
--
-- ROLLBACK
--
--   DROP TABLE IF EXISTS "lesson_videos";
--   UPDATE "videos" SET "lessonId" = NULL WHERE "lessonId" IS NULL;
--   ALTER TABLE "videos" ALTER COLUMN "lessonId" SET NOT NULL;
--   ALTER TABLE "videos" DROP CONSTRAINT IF EXISTS "videos_lessonId_fkey";
--   ALTER TABLE "videos" ADD CONSTRAINT "videos_lessonId_fkey"
--     FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 1. The association table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "lesson_videos" (
    "lessonId"    TEXT        NOT NULL,
    "videoId"     TEXT        NOT NULL,
    "sortOrder"   INTEGER     NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lesson_videos_pkey" PRIMARY KEY ("lessonId", "videoId")
);

-- Reverse lookup: "which lectures use this asset?" This is the query that decides
-- whether detaching the video from one lecture may safely destroy the asset, so
-- it is on the hot path of every delete and must not degrade to a scan.
CREATE INDEX IF NOT EXISTS "lesson_videos_videoId_idx" ON "lesson_videos" ("videoId");

-- Referential integrity.
--   * FROM "lessons": deleting a lecture removes its attachments and nothing else.
--   * FROM "videos":  deleting the asset removes every attachment to it.
ALTER TABLE "lesson_videos"
    ADD CONSTRAINT "lesson_videos_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_videos"
    ADD CONSTRAINT "lesson_videos_videoId_fkey"
    FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 2. Backfill: every existing video is attached to the lecture that owns it.
-- ---------------------------------------------------------------------------
INSERT INTO "lesson_videos" ("lessonId", "videoId", "sortOrder", "createdAt")
SELECT "lessonId", "id", 0, COALESCE("createdAt", CURRENT_TIMESTAMP)
FROM "videos"
WHERE "lessonId" IS NOT NULL
ON CONFLICT ("lessonId", "videoId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. `lessonId` becomes nullable. The UNIQUE index stays (see header).
-- ---------------------------------------------------------------------------
ALTER TABLE "videos" ALTER COLUMN "lessonId" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 4. CASCADE -> SET NULL, so deleting a lecture can no longer destroy an asset
--    that other lectures are still using.
-- ---------------------------------------------------------------------------
ALTER TABLE "videos" DROP CONSTRAINT IF EXISTS "videos_lessonId_fkey";
ALTER TABLE "videos" ADD CONSTRAINT "videos_lessonId_fkey"
    FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE CASCADE;