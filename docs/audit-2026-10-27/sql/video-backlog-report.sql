-- Video backlog — READ-ONLY report (Phase 6 §8).
--
-- Owner decision (2026-10-30): the stuck UPLOADING/FAILED backlog is NOT to be
-- recovered. No `complete`, no `replace-failed-asset`, no retry or re-ingest,
-- no new Gumlet assets, no manual READY, no deletion. This file therefore
-- contains SELECT statements only. Run it read-only against the production
-- database (psql with a read-only role, or at minimum inside
-- `BEGIN TRANSACTION READ ONLY; ... ROLLBACK;`).
--
-- Why these rows cannot self-recover (code facts, verified on the branch):
--   * VideoRecoveryService.recoverStrandedVideos only ever touches QUEUED and
--     PROCESSING rows; UPLOADING and FAILED are outside every automatic path.
--   * The admin endpoints that would move them (complete / replace-failed-asset)
--     are manual-only and are not to be called, per the decision above.
--   * The dashboard lists these statuses distinctly, so they remain visible
--     without being touched.

-- ---------------------------------------------------------------------------
-- 1. The backlog, one row per stuck video.
--    sourceKey tells you whether the original upload still exists in R2
--    (check the key in the bucket; this query cannot see object storage).
--    gumletStatus/gumletError are the provider's last words, if any.
-- ---------------------------------------------------------------------------
SELECT
  v.id,
  v.status,
  c.title                            AS course_title,
  l.title                            AS lesson_title,
  v."sourceKey"                      AS source_key,
  pg_size_pretty(COALESCE(v."sourceSizeBytes", 0)::bigint) AS source_size,
  v."gumletAssetId"                  AS gumlet_asset_id,
  v."gumletStatus"                   AS gumlet_status,
  LEFT(COALESCE(v."gumletError", v."processingError", ''), 120) AS last_error,
  v."createdAt",
  v."updatedAt"
FROM videos v
LEFT JOIN lessons l  ON l.id = v."lessonId"
LEFT JOIN courses c  ON c.id = v."courseId"
WHERE v."deletedAt" IS NULL
  AND v.status IN ('UPLOADING', 'FAILED')
ORDER BY v.status, v."updatedAt" ASC;

-- ---------------------------------------------------------------------------
-- 2. Totals by status, for the report header.
-- ---------------------------------------------------------------------------
SELECT v.status, COUNT(*) AS count, MIN(v."updatedAt") AS oldest, MAX(v."updatedAt") AS newest
FROM videos v
WHERE v."deletedAt" IS NULL
  AND v.status IN ('UPLOADING', 'FAILED')
GROUP BY v.status;

-- ---------------------------------------------------------------------------
-- 3. Source availability split: rows with no sourceKey have nothing to
--    re-ingest from even if the decision were ever reversed.
-- ---------------------------------------------------------------------------
SELECT
  v.status,
  (v."sourceKey" IS NOT NULL) AS has_source_key,
  COUNT(*) AS count
FROM videos v
WHERE v."deletedAt" IS NULL
  AND v.status IN ('UPLOADING', 'FAILED')
GROUP BY v.status, (v."sourceKey" IS NOT NULL)
ORDER BY v.status;
