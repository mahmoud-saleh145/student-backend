-- D3 remediation (WRITES PRODUCTION DATA - run only with explicit authorisation,
-- per course, after a human has reviewed the candidate report).
--
-- It does not change any enrollment. It records, in the course's open archive
-- record, the ids a reviewer has confirmed were pending re-requests, in the
-- exact key the fixed restore reads (PENDING_APPROVAL_SNAPSHOT_KEY). Restoring
-- the course afterwards, from the dashboard, then returns those rows to
-- PENDING_APPROVAL and every other row as before. Idempotent: it refuses to
-- run on a record that already has the key or was already restored.
--
-- Replace :archive_record_id and the id list from the reviewed report.
BEGIN;
UPDATE archive_records
SET snapshot = jsonb_set(COALESCE(snapshot, '{}'::jsonb),
                         '{pendingApprovalEnrollmentIds}',
                         to_jsonb(ARRAY['<enrollment_id_1>', '<enrollment_id_2>']::text[]))
WHERE id = '<archive_record_id>'
  AND entity = 'course'
  AND "restoredAt" IS NULL
  AND NOT COALESCE(snapshot ? 'pendingApprovalEnrollmentIds', false);
-- Expect exactly: UPDATE 1. Anything else: ROLLBACK and investigate.
SELECT id, snapshot -> 'pendingApprovalEnrollmentIds' FROM archive_records WHERE id = '<archive_record_id>';
COMMIT;   -- or ROLLBACK
--
-- Rollback (before the course is restored): remove the key again.
--   UPDATE archive_records SET snapshot = snapshot - 'pendingApprovalEnrollmentIds'
--   WHERE id = '<archive_record_id>' AND "restoredAt" IS NULL;
