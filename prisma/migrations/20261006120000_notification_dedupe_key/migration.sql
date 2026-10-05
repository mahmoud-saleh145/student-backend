-- Idempotency marker for generated notifications.
--
-- A reminder that is only *meant* to fire once per period still fires twice if
-- the job re-runs, retries, or is delivered twice, so the once-only guarantee
-- has to be enforced by the database rather than assumed from the cron
-- expression that triggered it. Writers use `skipDuplicates`, so a repeat run
-- inserts nothing instead of messaging the student again.
--
-- Nullable on purpose: Postgres permits any number of NULLs under a unique
-- index, so every existing notification and every ordinary broadcast is
-- unaffected and needs no backfill.
--
-- Operational note: this is a non-concurrent index build. On a large production
-- `notifications` table it takes a write lock for the duration, so if that table
-- is already big, run this deploy during a quiet window or build it separately
-- with CREATE UNIQUE INDEX CONCURRENTLY (which cannot run inside the
-- transaction Prisma wraps migrations in).
ALTER TABLE "notifications" ADD COLUMN "dedupeKey" TEXT;

CREATE UNIQUE INDEX "notifications_dedupeKey_key" ON "notifications"("dedupeKey");