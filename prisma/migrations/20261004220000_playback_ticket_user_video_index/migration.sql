-- =============================================================================
-- playback_tickets: index for per-user, per-video watch accounting
--
-- `ProgressService.observePlayback` sums `watchedSeconds` and takes the furthest
-- `lastPositionSeconds` across every playback grant one user holds for a single
-- video, in order to credit progress from real playback rather than from
-- whatever the client reported.
--
-- The pre-existing indexes all lead with `userId + status`, `videoId`,
-- `status` or `playId`, so none of them narrows this query to one student's
-- grants for one video. PostgreSQL falls back to `userId, status, expiresAt`
-- and filters `videoId` per row, which means a student with a long playback
-- history scans every ticket they have ever been issued on every progress write.
--
-- This index is exactly the query's filter, so the sum becomes an index-only
-- scan bounded by the number of grants for that one video.
--
-- Additive only: no table, column or existing index is altered or removed, so
-- this is safe to apply online against a live database.
-- =============================================================================

CREATE INDEX IF NOT EXISTS "playback_tickets_userId_videoId_idx"
  ON "playback_tickets" ("userId", "videoId");