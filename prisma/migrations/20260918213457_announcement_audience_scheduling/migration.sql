-- CreateEnum
CREATE TYPE "AnnouncementStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AnnouncementFrequency" AS ENUM ('ONCE', 'DAILY', 'WEEKLY', 'MONTHLY');

-- AlterTable
ALTER TABLE "announcements" ADD COLUMN     "audienceRule" JSONB,
ADD COLUMN     "dayOfMonth" INTEGER,
ADD COLUMN     "endsOn" TIMESTAMP(3),
ADD COLUMN     "frequency" "AnnouncementFrequency" NOT NULL DEFAULT 'ONCE',
ADD COLUMN     "lastOccurrenceAt" TIMESTAMP(3),
ADD COLUMN     "maxOccurrences" INTEGER,
ADD COLUMN     "nextOccurrenceAt" TIMESTAMP(3),
ADD COLUMN     "occurrenceCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "sendAtLocal" TEXT,
ADD COLUMN     "startsOn" TIMESTAMP(3),
ADD COLUMN     "status" "AnnouncementStatus" NOT NULL DEFAULT 'DRAFT',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Africa/Cairo',
ADD COLUMN     "weekdays" INTEGER[];

-- CreateTable
CREATE TABLE "announcement_dispatches" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "occurrenceAt" TIMESTAMP(3) NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "createdCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "announcement_dispatches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "announcement_dispatches_occurrenceAt_idx" ON "announcement_dispatches"("occurrenceAt");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_dispatches_announcementId_occurrenceAt_key" ON "announcement_dispatches"("announcementId", "occurrenceAt");

-- CreateIndex
CREATE INDEX "announcements_status_nextOccurrenceAt_idx" ON "announcements"("status", "nextOccurrenceAt");

-- AddForeignKey
ALTER TABLE "announcement_dispatches" ADD CONSTRAINT "announcement_dispatches_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
