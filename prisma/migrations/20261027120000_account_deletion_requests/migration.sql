-- Student-initiated account deletion with a 30-day cancellation period
-- (owner decision D5).
--
-- PREPARED ONLY. NOT APPLIED to Production. Apply only after review, with
-- `npm run prisma:deploy` from a release build, BEFORE the API code that
-- reads this table is deployed (the API's login path queries it).
--
-- ADDITIVE AND BACKWARDS COMPATIBLE:
--   * one new enum and one new table; no existing table, column or row is
--     changed, so the running API is unaffected until the new code ships
--   * no backfill
--
-- WHY A PARTIAL UNIQUE INDEX
--   A student may have many historical requests (cancelled, completed) but at
--   most ONE pending one. A plain unique index on "userId" would forbid a new
--   request after a cancellation; a unique index restricted to the PENDING
--   state is exactly the rule. Prisma cannot express it in schema.prisma, so
--   it is created here, the same way as the other partial indexes in this
--   repository. Do not let `prisma migrate dev` drop it: generate future
--   migrations with --create-only and remove any DROP INDEX for it.
--
-- REVISED 2026-10-28, still unapplied: added "failedAt" (erasure stopped
-- after repeated failures; see AccountDeletionService). Before this revision
-- the file had only been applied to a throwaway local test database.
--
-- ROLLBACK (only if no request has been created yet):
--   DROP TABLE "account_deletion_requests";
--   DROP TYPE "AccountDeletionStatus";

-- CreateEnum
CREATE TYPE "AccountDeletionStatus" AS ENUM ('PENDING', 'PROCESSING', 'CANCELLED', 'COMPLETED');

-- CreateTable
CREATE TABLE "account_deletion_requests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AccountDeletionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'app',
    "lastError" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "failedAt" TIMESTAMP(3),

    CONSTRAINT "account_deletion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_deletion_requests_status_scheduledFor_idx" ON "account_deletion_requests"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "account_deletion_requests_userId_status_idx" ON "account_deletion_requests"("userId", "status");

-- AddForeignKey
ALTER TABLE "account_deletion_requests" ADD CONSTRAINT "account_deletion_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One pending request per student (see header).
CREATE UNIQUE INDEX "account_deletion_requests_one_pending_per_user" ON "account_deletion_requests"("userId") WHERE "status" = 'PENDING';
