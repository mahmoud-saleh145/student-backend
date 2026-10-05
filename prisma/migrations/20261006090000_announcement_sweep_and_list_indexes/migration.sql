-- Indexes for two query paths that had none.

-- The abandoned-claim sweep runs on every dispatcher tick and looks for
-- `finishedAt IS NULL AND startedAt < cutoff`. `finishedAt` leads because
-- unfinished claims are a transient minority (they exist only between a claim
-- and the moment it is settled), and Postgres sorts NULLs first, so the sweep
-- reads one small contiguous range. Without this the sweep sequentially scans
-- every claim ever made on every tick, and this table is never pruned.
CREATE INDEX "announcement_dispatches_finishedAt_startedAt_idx"
  ON "announcement_dispatches"("finishedAt", "startedAt");

-- Admin announcement listing filters on `status` and orders by `createdAt`.
-- With `status` leading, the filter narrows and the sort is served by the index
-- instead of falling back to a sort over the whole table.
CREATE INDEX "announcements_status_createdAt_idx"
  ON "announcements"("status", "createdAt");