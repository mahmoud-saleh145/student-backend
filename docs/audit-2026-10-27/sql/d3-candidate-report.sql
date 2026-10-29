-- D3 candidate report  (READ-ONLY: SELECT only; safe to run against production
-- once separately authorised). Prepared 2026-10-29.
--
-- Which rows: enrollments that a restore would bring back ACTIVE although they
-- may have been a pending re-request when the course was archived. That can
-- only happen for an archive made BEFORE the 2026-10-28 fix, i.e. an open
-- (not yet restored) archive record whose snapshot has no
-- "pendingApprovalEnrollmentIds" key. Archives made after the fix record the
-- pending ids and restore them correctly, so they are excluded here (the
-- earlier one-line check in OWNER_DECISIONS D3 did not exclude them, and it
-- also counted every approved student; it is a superset of this report).
--
-- How each row is classified, from the audit log (entity 'enrollment',
-- entityId = enrollment id), looking only at events up to the archive time:
--   last_request_at  = latest ENROLLMENT_CREATE with after.state = PENDING_APPROVAL
--                      (EnrollmentsService.joinWithApproval: a student asking)
--   last_grant_at    = latest ACCESS_GRANT (EnrollmentsService.grantByAdmin:
--                      an administrator approving / granting)
--   last_revoke_at   = latest ACCESS_REVOKE (reject or revoke)
--   RESTORE_AS_PENDING_APPROVAL  a request is newer than the last approval
--   APPROVED_RESTORE_AS_ACTIVE   the last approval is at least as new as any request
--   MANUAL_REVIEW                no audit evidence either way (older than the audit
--                                trail, or created by another path) - decide by hand
--
-- Output contains user ids, not names or phone numbers. Handle it as personal
-- data anyway: do not paste it into tickets, chats or documentation.
WITH open_archive AS (
  SELECT DISTINCT ON (a."entityId")
         a."entityId"  AS course_id,
         a.id          AS archive_record_id,
         a."archivedAt" AS archived_at,
         COALESCE(a.snapshot ? 'pendingApprovalEnrollmentIds', false) AS has_recorded_ids
  FROM archive_records a
  WHERE a.entity = 'course' AND a."restoredAt" IS NULL
  ORDER BY a."entityId", a."archivedAt" DESC
),
candidates AS (
  SELECT e.id, e."courseId", e."userId", e."approvedAt", e."approvedById", e."accessEndsAt",
         e."revokedAt", e."createdAt", e."updatedAt", oa.archive_record_id, oa.archived_at
  FROM enrollments e
  JOIN courses c       ON c.id = e."courseId" AND c.status = 'ARCHIVED' AND c."deletedAt" IS NULL
  JOIN open_archive oa ON oa.course_id = c.id AND NOT oa.has_recorded_ids
  WHERE e.state = 'ARCHIVED'
    AND e.method = 'ADMIN_APPROVAL'
    AND e."approvedAt" IS NOT NULL
)
SELECT
  cand."courseId"            AS course_id,
  c.title                    AS course_title,
  cand.archive_record_id,
  cand.archived_at,
  cand.id                    AS enrollment_id,
  cand."userId"              AS user_id,
  cand."approvedAt"          AS approved_at,
  cand."approvedById"        AS approved_by_id,
  cand."accessEndsAt"        AS access_ends_at,
  cand."revokedAt"           AS revoked_at,
  req."createdAt"            AS last_request_at,
  grt."createdAt"            AS last_grant_at,
  rvk."createdAt"            AS last_revoke_at,
  CASE
    WHEN req."createdAt" IS NOT NULL AND (grt."createdAt" IS NULL OR req."createdAt" > grt."createdAt")
      THEN 'RESTORE_AS_PENDING_APPROVAL'
    WHEN grt."createdAt" IS NOT NULL
      THEN 'APPROVED_RESTORE_AS_ACTIVE'
    ELSE 'MANUAL_REVIEW'
  END                        AS proposed_classification
FROM candidates cand
JOIN courses c ON c.id = cand."courseId"
LEFT JOIN LATERAL (
  SELECT al."createdAt" FROM audit_logs al
  WHERE al.entity = 'enrollment' AND al."entityId" = cand.id
    AND al.action = 'ENROLLMENT_CREATE' AND al.after ->> 'state' = 'PENDING_APPROVAL'
    AND al."createdAt" <= cand.archived_at
  ORDER BY al."createdAt" DESC LIMIT 1) req ON true
LEFT JOIN LATERAL (
  SELECT al."createdAt" FROM audit_logs al
  WHERE al.entity = 'enrollment' AND al."entityId" = cand.id
    AND al.action = 'ACCESS_GRANT' AND al."createdAt" <= cand.archived_at
  ORDER BY al."createdAt" DESC LIMIT 1) grt ON true
LEFT JOIN LATERAL (
  SELECT al."createdAt" FROM audit_logs al
  WHERE al.entity = 'enrollment' AND al."entityId" = cand.id
    AND al.action = 'ACCESS_REVOKE' AND al."createdAt" <= cand.archived_at
  ORDER BY al."createdAt" DESC LIMIT 1) rvk ON true
ORDER BY cand."courseId", proposed_classification, cand.id;
