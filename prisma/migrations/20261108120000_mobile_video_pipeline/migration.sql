-- Independent mobile video pipeline.
--
-- PREPARED ONLY. NOT APPLIED to Production. Apply with `npx prisma migrate
-- deploy` from the release commit BEFORE the API/worker code that reads these
-- columns is deployed. See docs/MOBILE_VIDEO_PIPELINE.md.
--
-- ADDITIVE and metadata-only in Postgres 11+: one enum, five nullable-or-
-- constant-default columns on `videos`, one constant-default column on
-- `playback_tickets`, one index. No row is rewritten. Every existing video
-- starts as NONE (not yet processed for mobile) and every existing ticket is
-- recorded as a Gumlet grant, which is what they all were.

-- CreateEnum
CREATE TYPE "MobileVideoStatus" AS ENUM ('NONE', 'QUEUED', 'PROCESSING', 'READY', 'FAILED');

-- AlterTable
ALTER TABLE "videos"
  ADD COLUMN "mobileStatus" "MobileVideoStatus" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "mobileError" TEXT,
  ADD COLUMN "mobileJobId" TEXT,
  ADD COLUMN "mobileProcessingStartedAt" TIMESTAMP(3),
  ADD COLUMN "mobileProcessedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "playback_tickets"
  ADD COLUMN "delivery" TEXT NOT NULL DEFAULT 'gumlet';

-- CreateIndex
CREATE INDEX "videos_mobileStatus_updatedAt_idx" ON "videos"("mobileStatus", "updatedAt");
