-- D5 settlement before erasure (Phase 6 §4.2).
--
-- PREPARED ONLY. NOT APPLIED to Production. Apply only after review, with
-- `npm run prisma:deploy` from a release build, BEFORE the API code that
-- reads these columns is deployed.
--
-- ADDITIVE AND BACKWARDS COMPATIBLE: new nullable columns and one index on
-- account_deletion_requests. No rows are touched, nothing is dropped or
-- renamed, and the running API (which never selects these columns) is
-- unaffected while the migration applies.
--
-- What they are for: a deletion request whose wallet still holds money stops
-- before erasure (settlementRequiredAt), keeps its identity while it waits,
-- and continues only after an authorized administrator confirms the physical
-- settlement (settledAt/settledById/settledAmount/settlementTxId, the last
-- referencing the wallet_transactions row that recorded the debit).

-- AlterTable
ALTER TABLE "account_deletion_requests"
  ADD COLUMN "settlementRequiredAt" TIMESTAMP(3),
  ADD COLUMN "outstandingAmount" DECIMAL(12,2),
  ADD COLUMN "settledAt" TIMESTAMP(3),
  ADD COLUMN "settledById" TEXT,
  ADD COLUMN "settledAmount" DECIMAL(12,2),
  ADD COLUMN "settlementTxId" TEXT;

-- CreateIndex
CREATE INDEX "account_deletion_requests_settlementRequiredAt_idx"
  ON "account_deletion_requests"("settlementRequiredAt");
