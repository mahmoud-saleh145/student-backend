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
--    already has the table. The CREATE statements use IF NOT EXISTS / IF EXISTS;
--    the two `ADD CONSTRAINT` statements cannot - PostgreSQL has no
--    `ADD CONSTRAINT IF NOT EXISTS` - so this file is not safe to re-run by hand.
--    Re-running is unnecessary: Prisma applies each migration exactly once and
--    runs the whole file in one transaction, so a failed apply leaves no
--    partial state behind.
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
-- THERE IS NO DOWN-MIGRATION. RECOVERY IS A RESTORE, NOT A REVERSE.
--
-- The obvious reverse is destructive and must not be scripted:
--
--   DROP TABLE IF EXISTS "lesson_videos";
--   UPDATE "videos" SET "lessonId" = NULL WHERE "lessonId" IS NULL;
--   ALTER TABLE "videos" ALTER COLUMN "lessonId" SET NOT NULL;
--
-- is wrong twice over. The UPDATE is a no-op that looks like a safety check.
-- And `SET NOT NULL` is refused as soon as any video has a NULL lessonId -
-- which this very release causes routinely, both through the ON DELETE SET NULL
-- below and through `VideosService.detachFromLesson`, which nulls the origin
-- pointer when the uploading lecture is detached. Because the DROP runs FIRST,
-- a script in this order destroys every reuse mapping before discovering it
-- cannot finish, and there is no way back from that.
--
-- THE RECOMMENDED ORDER ON REGRET
--
-- 1. Roll the CODE back. This is safe and is almost always sufficient: the
--    previous build ignores this table and these columns entirely. The one
--    consequence to accept is that a REUSED video becomes invisible to the old
--    build's lesson detail, because it reads `Lesson.video` only.
-- 2. Keep the Neon branch taken before the release. Restoring the DATABASE from
--    it is the only way to undo the data, and it is a PITR/branch restore, not
--    a `DROP`.
-- 3. Only if the schema itself must be reverted, run the guards below first.
--
-- GUARDS - run these BEFORE any DDL. They read only, and must all return 0:
--
--   -- (a) videos with no origin lecture. SET NOT NULL would be refused.
--   SELECT count(*) FROM "videos" WHERE "lessonId" IS NULL;
--
--   -- (b) genuine reuse mappings, i.e. this lecture is not where the asset was
--   --     uploaded. Dropping lesson_videos would destroy them.
--   SELECT count(*) FROM "lesson_videos" lv
--     JOIN "videos" v ON v."id" = lv."videoId"
--    WHERE v."lessonId" IS DISTINCT FROM lv."lessonId";
--
-- Any non-zero result means stop and restore from the branch instead.
--
-- ONLY if (a) is 0, and having accepted the loss of (b), revert in this order -
-- DDL LAST, so that a refusal costs nothing:
--
--   ALTER TABLE "videos" ALTER COLUMN "lessonId" SET NOT NULL;
--   ALTER TABLE "videos" DROP CONSTRAINT IF EXISTS "videos_lessonId_fkey";
--   ALTER TABLE "videos" ADD CONSTRAINT "videos_lessonId_fkey"
--     FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--   DROP TABLE IF EXISTS "lesson_videos";
--
-- Reverting also RE-ARMS THE HAZARD THIS MIGRATION REMOVED: under CASCADE
-- again, deleting a lecture once more destroys an asset that other lectures are
-- still playing. That is a further reason to roll the code back rather than
-- reverse the schema.

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