-- Per-student, per-video play-limit adjustments (admin "Manage Views").
-- Additive only: a new table, no change to any existing column, so the
-- currently deployed API keeps working before and after this runs.

CREATE TABLE "video_play_allowances" (
    "userId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "allowedPlays" INTEGER,
    "countFrom" TIMESTAMP(3),
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "video_play_allowances_pkey" PRIMARY KEY ("userId","videoId"),
    CONSTRAINT "video_play_allowances_allowed_plays_check" CHECK ("allowedPlays" IS NULL OR ("allowedPlays" >= 0 AND "allowedPlays" <= 1000))
);

CREATE INDEX "video_play_allowances_videoId_idx" ON "video_play_allowances"("videoId");

ALTER TABLE "video_play_allowances" ADD CONSTRAINT "video_play_allowances_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_play_allowances" ADD CONSTRAINT "video_play_allowances_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "videos"("id") ON DELETE CASCADE ON UPDATE CASCADE;
