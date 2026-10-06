-- =====================================================================
-- EduPlatform — READ-ONLY production schema diagnostic
-- Generated 2026-10-02 from prisma/schema.prisma
--   sha256(schema.prisma) = 60a034c75b9ac82fff7ae6e1000169b53f443b15082b0d10d5a6b7b4d77115c3
--   expected: 60 tables, 808 scalar columns, 41 enums
--
-- SAFE: contains only SELECT statements. No DDL, no DML, no locks.
-- Run in the Neon SQL Editor against the PRODUCTION branch, or:
--   psql "$DATABASE_URL" -f prod-schema-diagnostic.sql
-- =====================================================================

\echo '=== 1. MIGRATION HISTORY (_prisma_migrations) ==='
SELECT migration_name,
       to_char(finished_at,  'YYYY-MM-DD HH24:MI:SS') AS finished_at,
       to_char(rolled_back_at,'YYYY-MM-DD HH24:MI:SS') AS rolled_back_at,
       applied_steps_count,
       CASE WHEN finished_at IS NULL AND rolled_back_at IS NULL THEN 'IN PROGRESS / FAILED'
            WHEN rolled_back_at IS NOT NULL THEN 'ROLLED BACK'
            ELSE 'APPLIED' END AS state
FROM _prisma_migrations
ORDER BY migration_name;

\echo '=== 2. WHICH OF THE 8 REPO MIGRATIONS ARE NOT APPLIED ==='
WITH repo(migration_name) AS (VALUES
  ('20260101000000_init'),
  ('20260907120000_dashboard_admin'),
  ('20260918000000_wallet_credits'),
  ('20260918010000_course_parts_and_part_codes'),
  ('20260918014216_library'),
  ('20260918213457_announcement_audience_scheduling'),
  ('20260924100000_course_departments'),
  ('20260930000000_academic_structures_attachments_thumbnails_plays')
)
SELECT r.migration_name,
       CASE WHEN m.migration_name IS NULL THEN '*** PENDING ***'
            WHEN m.finished_at IS NULL THEN '*** FAILED / INCOMPLETE ***'
            ELSE 'applied' END AS status
FROM repo r
LEFT JOIN _prisma_migrations m ON m.migration_name = r.migration_name
ORDER BY r.migration_name;

\echo '=== 3. MISSING TABLES (expected by schema.prisma, absent in DB) ==='
WITH expected(t) AS (VALUES
  ('academic_structures'), ('academic_years'), ('access_code_redemptions'), ('access_codes'),
  ('announcement_dispatches'), ('announcements'), ('archive_records'), ('attachments'),
  ('audit_logs'), ('caption_tracks'), ('code_batches'), ('course_departments'),
  ('course_part_entitlements'), ('course_part_purchases'), ('course_parts'), ('course_prices'),
  ('course_sections'), ('course_teachers'), ('courses'), ('daily_course_stats'),
  ('departments'), ('device_change_requests'), ('devices'), ('enrollment_section_grants'),
  ('enrollments'), ('faculties'), ('idempotency_records'), ('lessons'),
  ('library_entitlements'), ('library_materials'), ('library_package_items'), ('library_packages'),
  ('library_parts'), ('library_purchases'), ('notification_preferences'), ('notifications'),
  ('payment_transactions'), ('payments'), ('platform_settings'), ('playback_tickets'),
  ('push_tokens'), ('recharge_revenue'), ('refresh_tokens'), ('revenue_ledger'),
  ('security_events'), ('sessions'), ('student_profiles'), ('subjects'),
  ('support_messages'), ('support_tickets'), ('teacher_profiles'), ('universities'),
  ('users'), ('video_plays'), ('video_renditions'), ('videos'),
  ('wallet_transactions'), ('wallets'), ('watch_events'), ('watch_progress')
)
SELECT e.t AS missing_table
FROM expected e
LEFT JOIN information_schema.tables i
       ON i.table_schema='public' AND i.table_name=e.t
WHERE i.table_name IS NULL
ORDER BY 1;

\echo '=== 4. MISSING COLUMNS (only for tables that DO exist) ==='
WITH expected(t,c) AS (VALUES
  ('academic_structures','createdAt'), ('academic_structures','departmentId'), ('academic_structures','facultyId'),
  ('academic_structures','id'), ('academic_structures','isActive'), ('academic_structures','kind'),
  ('academic_structures','scopeKey'), ('academic_structures','universityId'), ('academic_structures','updatedAt'),
  ('academic_years','createdAt'), ('academic_years','id'), ('academic_years','isActive'),
  ('academic_years','name'), ('academic_years','nameAr'), ('academic_years','order'),
  ('academic_years','structureId'), ('academic_years','updatedAt'), ('access_code_redemptions','codeId'),
  ('access_code_redemptions','courseId'), ('access_code_redemptions','creditedAmount'), ('access_code_redemptions','deviceKey'),
  ('access_code_redemptions','enrollmentId'), ('access_code_redemptions','id'), ('access_code_redemptions','ipAddress'),
  ('access_code_redemptions','redeemedAt'), ('access_code_redemptions','userId'), ('access_code_redemptions','walletTransactionId'),
  ('access_codes','accessDurationDays'), ('access_codes','accessDurationType'), ('access_codes','accessEndsAt'),
  ('access_codes','actualPaidAmount'), ('access_codes','batchId'), ('access_codes','code'),
  ('access_codes','courseId'), ('access_codes','coursePartId'), ('access_codes','createdAt'),
  ('access_codes','creditAmount'), ('access_codes','currency'), ('access_codes','discountAmount'),
  ('access_codes','discountPercent'), ('access_codes','discountType'), ('access_codes','expiresAt'),
  ('access_codes','faceValue'), ('access_codes','id'), ('access_codes','issuedById'),
  ('access_codes','kind'), ('access_codes','maxRedemptions'), ('access_codes','note'),
  ('access_codes','priceAmount'), ('access_codes','redeemedAt'), ('access_codes','redeemedByUserId'),
  ('access_codes','redemptionCount'), ('access_codes','reservedForUserId'), ('access_codes','revokedAt'),
  ('access_codes','revokedById'), ('access_codes','sectionId'), ('access_codes','status'),
  ('access_codes','targetType'), ('access_codes','teacherId'), ('access_codes','updatedAt'),
  ('announcement_dispatches','announcementId'), ('announcement_dispatches','createdCount'), ('announcement_dispatches','error'),
  ('announcement_dispatches','finishedAt'), ('announcement_dispatches','id'), ('announcement_dispatches','occurrenceAt'),
  ('announcement_dispatches','recipientCount'), ('announcement_dispatches','startedAt'), ('announcements','academicYearId'),
  ('announcements','audienceRule'), ('announcements','body'), ('announcements','bodyAr'),
  ('announcements','courseId'), ('announcements','createdAt'), ('announcements','createdById'),
  ('announcements','dayOfMonth'), ('announcements','endsOn'), ('announcements','frequency'),
  ('announcements','id'), ('announcements','lastOccurrenceAt'), ('announcements','maxOccurrences'),
  ('announcements','nextOccurrenceAt'), ('announcements','occurrenceCount'), ('announcements','publishedAt'),
  ('announcements','route'), ('announcements','sendAtLocal'), ('announcements','sendPush'),
  ('announcements','startsOn'), ('announcements','status'), ('announcements','timezone'),
  ('announcements','title'), ('announcements','titleAr'), ('announcements','universityId'),
  ('announcements','updatedAt'), ('archive_records','archivedAt'), ('archive_records','archivedById'),
  ('archive_records','courseId'), ('archive_records','entity'), ('archive_records','entityId'),
  ('archive_records','id'), ('archive_records','reason'), ('archive_records','restoredAt'),
  ('archive_records','restoredById'), ('archive_records','snapshot'), ('attachments','courseId'),
  ('attachments','createdAt'), ('attachments','deletedAt'), ('attachments','id'),
  ('attachments','isDownloadable'), ('attachments','isPreview'), ('attachments','isProtected'),
  ('attachments','kind'), ('attachments','lessonId'), ('attachments','mimeType'),
  ('attachments','objectKey'), ('attachments','pageCount'), ('attachments','sectionId'),
  ('attachments','sizeBytes'), ('attachments','sortOrder'), ('attachments','title'),
  ('attachments','titleAr'), ('attachments','updatedAt'), ('attachments','uploadedById'),
  ('audit_logs','action'), ('audit_logs','actorId'), ('audit_logs','actorRole'),
  ('audit_logs','after'), ('audit_logs','before'), ('audit_logs','createdAt'),
  ('audit_logs','entity'), ('audit_logs','entityId'), ('audit_logs','id'),
  ('audit_logs','ipAddress'), ('audit_logs','note'), ('audit_logs','requestId'),
  ('audit_logs','userAgent'), ('caption_tracks','createdAt'), ('caption_tracks','id'),
  ('caption_tracks','isDefault'), ('caption_tracks','label'), ('caption_tracks','language'),
  ('caption_tracks','objectKey'), ('caption_tracks','videoId'), ('code_batches','actualPaidAmount'),
  ('code_batches','courseId'), ('code_batches','coursePartId'), ('code_batches','createdAt'),
  ('code_batches','createdById'), ('code_batches','creditAmount'), ('code_batches','currency'),
  ('code_batches','discountAmount'), ('code_batches','discountPercent'), ('code_batches','discountType'),
  ('code_batches','expiresAt'), ('code_batches','faceValue'), ('code_batches','id'),
  ('code_batches','kind'), ('code_batches','name'), ('code_batches','note'),
  ('code_batches','prefix'), ('code_batches','priceAmount'), ('code_batches','quantity'),
  ('code_batches','sectionId'), ('code_batches','targetNameSnapshot'), ('code_batches','targetType'),
  ('code_batches','teacherId'), ('code_batches','updatedAt'), ('course_departments','courseId'),
  ('course_departments','createdAt'), ('course_departments','departmentId'), ('course_part_entitlements','courseId'),
  ('course_part_entitlements','coursePartId'), ('course_part_entitlements','createdAt'), ('course_part_entitlements','grantedAt'),
  ('course_part_entitlements','id'), ('course_part_entitlements','purchaseId'), ('course_part_entitlements','revokedAt'),
  ('course_part_entitlements','revokedById'), ('course_part_entitlements','revokedReason'), ('course_part_entitlements','source'),
  ('course_part_entitlements','updatedAt'), ('course_part_entitlements','userId'), ('course_part_purchases','accessCodeId'),
  ('course_part_purchases','courseId'), ('course_part_purchases','coursePartId'), ('course_part_purchases','coursePriceAtPurchase'),
  ('course_part_purchases','courseTitleSnapshot'), ('course_part_purchases','createdAt'), ('course_part_purchases','currency'),
  ('course_part_purchases','id'), ('course_part_purchases','idempotencyKey'), ('course_part_purchases','partTitleSnapshot'),
  ('course_part_purchases','platformAmount'), ('course_part_purchases','priceAtPurchase'), ('course_part_purchases','pricePercentAtPurchase'),
  ('course_part_purchases','pricingModelAtPurchase'), ('course_part_purchases','purchasedAt'), ('course_part_purchases','sharePercent'),
  ('course_part_purchases','teacherAmount'), ('course_part_purchases','teacherId'), ('course_part_purchases','userId'),
  ('course_part_purchases','walletTransactionId'), ('course_parts','courseId'), ('course_parts','createdAt'),
  ('course_parts','createdById'), ('course_parts','currency'), ('course_parts','deletedAt'),
  ('course_parts','description'), ('course_parts','id'), ('course_parts','isActive'),
  ('course_parts','priceAmount'), ('course_parts','pricePercent'), ('course_parts','pricingModel'),
  ('course_parts','sortOrder'), ('course_parts','status'), ('course_parts','thumbnailKey'),
  ('course_parts','title'), ('course_parts','titleAr'), ('course_parts','updatedAt'),
  ('course_prices','amount'), ('course_prices','changedById'), ('course_prices','compareAtAmount'),
  ('course_prices','courseId'), ('course_prices','createdAt'), ('course_prices','currency'),
  ('course_prices','effectiveFrom'), ('course_prices','effectiveTo'), ('course_prices','id'),
  ('course_prices','isCurrent'), ('course_prices','reason'), ('course_prices','version'),
  ('course_sections','courseId'), ('course_sections','createdAt'), ('course_sections','deletedAt'),
  ('course_sections','description'), ('course_sections','id'), ('course_sections','partId'),
  ('course_sections','sortOrder'), ('course_sections','status'), ('course_sections','title'),
  ('course_sections','titleAr'), ('course_sections','unlocksAt'), ('course_sections','updatedAt'),
  ('course_teachers','assignedById'), ('course_teachers','canEditContent'), ('course_teachers','canEditPricing'),
  ('course_teachers','canPublish'), ('course_teachers','canViewRevenue'), ('course_teachers','canViewStudents'),
  ('course_teachers','courseId'), ('course_teachers','createdAt'), ('course_teachers','id'),
  ('course_teachers','isLead'), ('course_teachers','revenueSharePercent'), ('course_teachers','teacherId'),
  ('course_teachers','updatedAt'), ('courses','academicYearId'), ('courses','accessDurationDays'),
  ('courses','accessDurationType'), ('courses','accessEndsAt'), ('courses','archivedAt'),
  ('courses','completionRequireContiguous'), ('courses','completionRuleType'), ('courses','completionThreshold'),
  ('courses','createdAt'), ('courses','createdById'), ('courses','deletedAt'),
  ('courses','description'), ('courses','facultyId'), ('courses','id'),
  ('courses','isFree'), ('courses','lessonCount'), ('courses','publishedAt'),
  ('courses','ratingCount'), ('courses','ratingSum'), ('courses','sectionCount'),
  ('courses','shortDescription'), ('courses','slug'), ('courses','status'),
  ('courses','studentCount'), ('courses','subjectId'), ('courses','thumbnailKey'),
  ('courses','title'), ('courses','titleAr'), ('courses','totalDurationSeconds'),
  ('courses','universityId'), ('courses','updatedAt'), ('daily_course_stats','courseId'),
  ('daily_course_stats','createdAt'), ('daily_course_stats','currency'), ('daily_course_stats','day'),
  ('daily_course_stats','id'), ('daily_course_stats','lessonsCompleted'), ('daily_course_stats','lessonsStarted'),
  ('daily_course_stats','newEnrollments'), ('daily_course_stats','revenueAmount'), ('daily_course_stats','uniqueViewers'),
  ('daily_course_stats','updatedAt'), ('daily_course_stats','watchSeconds'), ('departments','createdAt'),
  ('departments','deletedAt'), ('departments','facultyId'), ('departments','id'),
  ('departments','isActive'), ('departments','name'), ('departments','nameAr'),
  ('departments','sortOrder'), ('departments','updatedAt'), ('device_change_requests','createdAt'),
  ('device_change_requests','id'), ('device_change_requests','reason'), ('device_change_requests','requestedDeviceId'),
  ('device_change_requests','requestedDeviceKey'), ('device_change_requests','requestedDeviceName'), ('device_change_requests','reviewNote'),
  ('device_change_requests','reviewedAt'), ('device_change_requests','reviewedById'), ('device_change_requests','status'),
  ('device_change_requests','updatedAt'), ('device_change_requests','userId'), ('devices','appVersion'),
  ('devices','approvedAt'), ('devices','approvedById'), ('devices','attestationVerifiedAt'),
  ('devices','createdAt'), ('devices','deviceKey'), ('devices','firstSeenAt'),
  ('devices','id'), ('devices','integritySuspect'), ('devices','lastSeenAt'),
  ('devices','model'), ('devices','name'), ('devices','osVersion'),
  ('devices','platform'), ('devices','revokedAt'), ('devices','revokedReason'),
  ('devices','status'), ('devices','updatedAt'), ('devices','userId'),
  ('enrollment_section_grants','codeId'), ('enrollment_section_grants','createdAt'), ('enrollment_section_grants','enrollmentId'),
  ('enrollment_section_grants','id'), ('enrollment_section_grants','partId'), ('enrollment_section_grants','sectionId'),
  ('enrollment_section_grants','source'), ('enrollments','accessEndsAt'), ('enrollments','accessStartsAt'),
  ('enrollments','approvedAt'), ('enrollments','approvedById'), ('enrollments','completedLessons'),
  ('enrollments','courseId'), ('enrollments','coversAllSections'), ('enrollments','createdAt'),
  ('enrollments','id'), ('enrollments','lastAccessedAt'), ('enrollments','lastLessonId'),
  ('enrollments','method'), ('enrollments','revokedAt'), ('enrollments','revokedById'),
  ('enrollments','revokedReason'), ('enrollments','state'), ('enrollments','updatedAt'),
  ('enrollments','userId'), ('faculties','createdAt'), ('faculties','deletedAt'),
  ('faculties','id'), ('faculties','isActive'), ('faculties','name'),
  ('faculties','nameAr'), ('faculties','sortOrder'), ('faculties','universityId'),
  ('faculties','updatedAt'), ('idempotency_records','createdAt'), ('idempotency_records','expiresAt'),
  ('idempotency_records','key'), ('idempotency_records','response'), ('idempotency_records','scope'),
  ('idempotency_records','statusCode'), ('lessons','completionRequireContiguous'), ('lessons','completionRuleType'),
  ('lessons','completionThreshold'), ('lessons','courseId'), ('lessons','createdAt'),
  ('lessons','deletedAt'), ('lessons','description'), ('lessons','durationSeconds'),
  ('lessons','id'), ('lessons','isPreview'), ('lessons','kind'),
  ('lessons','sectionId'), ('lessons','sortOrder'), ('lessons','status'),
  ('lessons','title'), ('lessons','titleAr'), ('lessons','updatedAt'),
  ('library_entitlements','createdAt'), ('library_entitlements','grantedAt'), ('library_entitlements','id'),
  ('library_entitlements','libraryPartId'), ('library_entitlements','purchaseId'), ('library_entitlements','revokedAt'),
  ('library_entitlements','revokedById'), ('library_entitlements','revokedReason'), ('library_entitlements','source'),
  ('library_entitlements','updatedAt'), ('library_entitlements','userId'), ('library_materials','academicYearId'),
  ('library_materials','coverKey'), ('library_materials','createdAt'), ('library_materials','createdById'),
  ('library_materials','deletedAt'), ('library_materials','description'), ('library_materials','facultyId'),
  ('library_materials','id'), ('library_materials','isActive'), ('library_materials','publishedAt'),
  ('library_materials','sortOrder'), ('library_materials','status'), ('library_materials','subjectId'),
  ('library_materials','title'), ('library_materials','titleAr'), ('library_materials','universityId'),
  ('library_materials','updatedAt'), ('library_package_items','createdAt'), ('library_package_items','id'),
  ('library_package_items','libraryPartId'), ('library_package_items','packageId'), ('library_package_items','sortOrder'),
  ('library_packages','createdAt'), ('library_packages','currency'), ('library_packages','deletedAt'),
  ('library_packages','description'), ('library_packages','id'), ('library_packages','isActive'),
  ('library_packages','materialId'), ('library_packages','price'), ('library_packages','sortOrder'),
  ('library_packages','status'), ('library_packages','title'), ('library_packages','titleAr'),
  ('library_packages','updatedAt'), ('library_parts','createdAt'), ('library_parts','currency'),
  ('library_parts','deletedAt'), ('library_parts','description'), ('library_parts','id'),
  ('library_parts','isActive'), ('library_parts','isPreview'), ('library_parts','materialId'),
  ('library_parts','mimeType'), ('library_parts','objectKey'), ('library_parts','pageCount'),
  ('library_parts','price'), ('library_parts','sizeBytes'), ('library_parts','sortOrder'),
  ('library_parts','status'), ('library_parts','thumbnailKey'), ('library_parts','title'),
  ('library_parts','titleAr'), ('library_parts','updatedAt'), ('library_parts','uploadedById'),
  ('library_purchases','createdAt'), ('library_purchases','currency'), ('library_purchases','id'),
  ('library_purchases','idempotencyKey'), ('library_purchases','kind'), ('library_purchases','libraryPackageId'),
  ('library_purchases','libraryPartId'), ('library_purchases','materialTitleSnapshot'), ('library_purchases','priceAtPurchase'),
  ('library_purchases','purchasedAt'), ('library_purchases','titleSnapshot'), ('library_purchases','userId'),
  ('library_purchases','walletTransactionId'), ('notification_preferences','announcements'), ('notification_preferences','createdAt'),
  ('notification_preferences','id'), ('notification_preferences','newCourse'), ('notification_preferences','newLesson'),
  ('notification_preferences','payments'), ('notification_preferences','updatedAt'), ('notification_preferences','userId'),
  ('notifications','announcementId'), ('notifications','body'), ('notifications','bodyAr'),
  ('notifications','createdAt'), ('notifications','data'), ('notifications','id'),
  ('notifications','imageUrl'), ('notifications','kind'), ('notifications','read'),
  ('notifications','readAt'), ('notifications','route'), ('notifications','title'),
  ('notifications','titleAr'), ('notifications','userId'), ('payment_transactions','amount'),
  ('payment_transactions','createdAt'), ('payment_transactions','currency'), ('payment_transactions','id'),
  ('payment_transactions','paymentId'), ('payment_transactions','providerReference'), ('payment_transactions','rawPayload'),
  ('payment_transactions','status'), ('payment_transactions','type'), ('payments','amount'),
  ('payments','checkoutUrl'), ('payments','courseId'), ('payments','coursePriceId'),
  ('payments','createdAt'), ('payments','currency'), ('payments','enrollmentId'),
  ('payments','failedAt'), ('payments','failureCode'), ('payments','id'),
  ('payments','idempotencyKey'), ('payments','metadata'), ('payments','paidAt'),
  ('payments','provider'), ('payments','providerReference'), ('payments','refundedAmount'),
  ('payments','refundedAt'), ('payments','status'), ('payments','updatedAt'),
  ('payments','userId'), ('platform_settings','createdAt'), ('platform_settings','description'),
  ('platform_settings','key'), ('platform_settings','updatedAt'), ('platform_settings','updatedById'),
  ('platform_settings','value'), ('playback_tickets','captureAttempts'), ('playback_tickets','courseId'),
  ('playback_tickets','deviceId'), ('playback_tickets','expiresAt'), ('playback_tickets','id'),
  ('playback_tickets','ipAddress'), ('playback_tickets','issuedAt'), ('playback_tickets','lastHeartbeatAt'),
  ('playback_tickets','lastPositionSeconds'), ('playback_tickets','lessonId'), ('playback_tickets','maxHeight'),
  ('playback_tickets','playId'), ('playback_tickets','releasedAt'), ('playback_tickets','revokedAt'),
  ('playback_tickets','revokedReason'), ('playback_tickets','rotatedFromId'), ('playback_tickets','sessionId'),
  ('playback_tickets','startPositionSeconds'), ('playback_tickets','status'), ('playback_tickets','userAgent'),
  ('playback_tickets','userId'), ('playback_tickets','videoId'), ('playback_tickets','watchedSeconds'),
  ('playback_tickets','watermarkTag'), ('push_tokens','createdAt'), ('push_tokens','deviceKey'),
  ('push_tokens','failureCount'), ('push_tokens','id'), ('push_tokens','isActive'),
  ('push_tokens','lastUsedAt'), ('push_tokens','platform'), ('push_tokens','provider'),
  ('push_tokens','token'), ('push_tokens','updatedAt'), ('push_tokens','userId'),
  ('recharge_revenue','accessCodeId'), ('recharge_revenue','actualPaidAmount'), ('recharge_revenue','batchId'),
  ('recharge_revenue','batchNameSnapshot'), ('recharge_revenue','codeSnapshot'), ('recharge_revenue','createdAt'),
  ('recharge_revenue','creditAmount'), ('recharge_revenue','currency'), ('recharge_revenue','discountAmount'),
  ('recharge_revenue','discountPercent'), ('recharge_revenue','discountType'), ('recharge_revenue','faceValue'),
  ('recharge_revenue','id'), ('recharge_revenue','recognizedAt'), ('recharge_revenue','userId'),
  ('refresh_tokens','createdAt'), ('refresh_tokens','expiresAt'), ('refresh_tokens','familyId'),
  ('refresh_tokens','id'), ('refresh_tokens','replacedById'), ('refresh_tokens','revokedAt'),
  ('refresh_tokens','revokedReason'), ('refresh_tokens','sessionId'), ('refresh_tokens','tokenHash'),
  ('refresh_tokens','usedAt'), ('refresh_tokens','userId'), ('revenue_ledger','courseId'),
  ('revenue_ledger','courseTitleSnapshot'), ('revenue_ledger','createdAt'), ('revenue_ledger','currency'),
  ('revenue_ledger','grossAmount'), ('revenue_ledger','id'), ('revenue_ledger','paymentId'),
  ('revenue_ledger','platformAmount'), ('revenue_ledger','recognizedAt'), ('revenue_ledger','sharePercent'),
  ('revenue_ledger','teacherAmount'), ('revenue_ledger','teacherId'), ('security_events','courseId'),
  ('security_events','createdAt'), ('security_events','deviceKey'), ('security_events','id'),
  ('security_events','ipAddress'), ('security_events','lessonId'), ('security_events','message'),
  ('security_events','metadata'), ('security_events','occurredAt'), ('security_events','sessionId'),
  ('security_events','severity'), ('security_events','ticketId'), ('security_events','type'),
  ('security_events','userAgent'), ('security_events','userId'), ('security_events','videoId'),
  ('sessions','appVersion'), ('sessions','createdAt'), ('sessions','deviceId'),
  ('sessions','expiresAt'), ('sessions','id'), ('sessions','ipAddress'),
  ('sessions','lastSeenAt'), ('sessions','platform'), ('sessions','revokedAt'),
  ('sessions','revokedReason'), ('sessions','status'), ('sessions','userAgent'),
  ('sessions','userId'), ('student_profiles','academicYearId'), ('student_profiles','createdAt'),
  ('student_profiles','departmentId'), ('student_profiles','facultyId'), ('student_profiles','id'),
  ('student_profiles','notes'), ('student_profiles','studentNumber'), ('student_profiles','universityId'),
  ('student_profiles','updatedAt'), ('student_profiles','userId'), ('subjects','createdAt'),
  ('subjects','deletedAt'), ('subjects','id'), ('subjects','isActive'),
  ('subjects','name'), ('subjects','nameAr'), ('subjects','sortOrder'),
  ('subjects','updatedAt'), ('support_messages','authorId'), ('support_messages','authorRole'),
  ('support_messages','body'), ('support_messages','createdAt'), ('support_messages','id'),
  ('support_messages','isInternal'), ('support_messages','ticketId'), ('support_tickets','assignedToId'),
  ('support_tickets','category'), ('support_tickets','closedAt'), ('support_tickets','courseId'),
  ('support_tickets','createdAt'), ('support_tickets','id'), ('support_tickets','lastMessageAt'),
  ('support_tickets','lastMessageBy'), ('support_tickets','priority'), ('support_tickets','reference'),
  ('support_tickets','resolvedAt'), ('support_tickets','status'), ('support_tickets','subject'),
  ('support_tickets','unreadForStaff'), ('support_tickets','updatedAt'), ('support_tickets','userId'),
  ('teacher_profiles','bio'), ('teacher_profiles','bioAr'), ('teacher_profiles','createdAt'),
  ('teacher_profiles','id'), ('teacher_profiles','isPublic'), ('teacher_profiles','revenueSharePercent'),
  ('teacher_profiles','title'), ('teacher_profiles','titleAr'), ('teacher_profiles','updatedAt'),
  ('teacher_profiles','userId'), ('universities','code'), ('universities','createdAt'),
  ('universities','deletedAt'), ('universities','id'), ('universities','isActive'),
  ('universities','logoUrl'), ('universities','name'), ('universities','nameAr'),
  ('universities','sortOrder'), ('universities','updatedAt'), ('users','avatarUrl'),
  ('users','createdAt'), ('users','createdById'), ('users','credentialsChangedAt'),
  ('users','deletedAt'), ('users','email'), ('users','failedLoginCount'),
  ('users','fullName'), ('users','gender'), ('users','id'),
  ('users','lastLoginAt'), ('users','locale'), ('users','lockedUntil'),
  ('users','passwordHash'), ('users','phone'), ('users','role'),
  ('users','status'), ('users','updatedAt'), ('video_plays','attemptNumber'),
  ('video_plays','closedAt'), ('video_plays','id'), ('video_plays','lastActivityAt'),
  ('video_plays','startedAt'), ('video_plays','userId'), ('video_plays','videoId'),
  ('video_plays','watchedSeconds'), ('video_renditions','bitrateKbps'), ('video_renditions','createdAt'),
  ('video_renditions','height'), ('video_renditions','id'), ('video_renditions','playlistKey'),
  ('video_renditions','sizeBytes'), ('video_renditions','videoId'), ('video_renditions','width'),
  ('videos','audioCodec'), ('videos','courseId'), ('videos','createdAt'),
  ('videos','deletedAt'), ('videos','durationSeconds'), ('videos','encryptionKeyId'),
  ('videos','frameRate'), ('videos','height'), ('videos','hlsPrefix'),
  ('videos','id'), ('videos','isEncrypted'), ('videos','lessonId'),
  ('videos','masterPlaylistKey'), ('videos','processedAt'), ('videos','processingError'),
  ('videos','processingJobId'), ('videos','processingStartedAt'), ('videos','sourceKey'),
  ('videos','sourceMimeType'), ('videos','sourceSizeBytes'), ('videos','status'),
  ('videos','thumbnailKey'), ('videos','updatedAt'), ('videos','uploadedById'),
  ('videos','videoCodec'), ('videos','width'), ('wallet_transactions','accessCodeId'),
  ('wallet_transactions','amount'), ('wallet_transactions','balanceAfter'), ('wallet_transactions','balanceBefore'),
  ('wallet_transactions','createdAt'), ('wallet_transactions','currency'), ('wallet_transactions','direction'),
  ('wallet_transactions','id'), ('wallet_transactions','idempotencyKey'), ('wallet_transactions','metadata'),
  ('wallet_transactions','note'), ('wallet_transactions','performedByAdminId'), ('wallet_transactions','referenceId'),
  ('wallet_transactions','referenceType'), ('wallet_transactions','source'), ('wallet_transactions','type'),
  ('wallet_transactions','userId'), ('wallet_transactions','walletId'), ('wallets','balance'),
  ('wallets','createdAt'), ('wallets','currency'), ('wallets','id'),
  ('wallets','totalRecharged'), ('wallets','totalSpent'), ('wallets','updatedAt'),
  ('wallets','userId'), ('wallets','version'), ('watch_events','courseId'),
  ('watch_events','deltaSeconds'), ('watch_events','id'), ('watch_events','lessonId'),
  ('watch_events','occurredAt'), ('watch_events','platform'), ('watch_events','positionSeconds'),
  ('watch_events','qualityHeight'), ('watch_events','ticketId'), ('watch_events','type'),
  ('watch_events','userId'), ('watch_events','videoId'), ('watch_progress','completed'),
  ('watch_progress','completedAt'), ('watch_progress','courseId'), ('watch_progress','createdAt'),
  ('watch_progress','durationSeconds'), ('watch_progress','firstWatchedAt'), ('watch_progress','id'),
  ('watch_progress','lastWatchedAt'), ('watch_progress','lessonId'), ('watch_progress','percent'),
  ('watch_progress','positionSeconds'), ('watch_progress','updatedAt'), ('watch_progress','userId'),
  ('watch_progress','watchedSeconds')
)
SELECT e.t AS table_name, e.c AS missing_column
FROM expected e
JOIN information_schema.tables ti
      ON ti.table_schema='public' AND ti.table_name=e.t
LEFT JOIN information_schema.columns ic
      ON ic.table_schema='public' AND ic.table_name=e.t AND ic.column_name=e.c
WHERE ic.column_name IS NULL
ORDER BY 1,2;

\echo '=== 5. MISSING ENUM TYPES ==='
WITH expected(n) AS (VALUES
  ('AcademicStructureKind'), ('AccessDurationType'), ('AccountStatus'), ('AnnouncementFrequency'),
  ('AnnouncementStatus'), ('AttachmentKind'), ('AuditAction'), ('CodeKind'),
  ('CodeStatus'), ('CodeTargetType'), ('CompletionRuleType'), ('ContentStatus'),
  ('CourseStatus'), ('DeviceChangeStatus'), ('DeviceStatus'), ('DiscountType'),
  ('EnrollmentMethod'), ('EnrollmentState'), ('Gender'), ('LessonKind'),
  ('LibraryEntitlementSource'), ('LibraryPurchaseKind'), ('NotificationKind'), ('PartEntitlementSource'),
  ('PartPricingModel'), ('PaymentProvider'), ('PaymentStatus'), ('PlaybackTicketStatus'),
  ('SectionGrantSource'), ('SecurityEventType'), ('SecuritySeverity'), ('SessionStatus'),
  ('SupportTicketCategory'), ('SupportTicketPriority'), ('SupportTicketStatus'), ('UserRole'),
  ('VideoStatus'), ('WalletTxDirection'), ('WalletTxSource'), ('WalletTxType'),
  ('WatchEventType')
)
SELECT e.n AS missing_enum
FROM expected e
LEFT JOIN pg_type t ON t.typname = e.n AND t.typtype='e'
WHERE t.typname IS NULL
ORDER BY 1;

\echo '=== 6. OBJECTS THE PENDING 20260930 MIGRATION CREATES ==='
SELECT 'table academic_structures' AS object,
       to_regclass('public.academic_structures') IS NOT NULL AS present
UNION ALL SELECT 'table video_plays',
       to_regclass('public.video_plays') IS NOT NULL
UNION ALL SELECT 'enum AcademicStructureKind',
       EXISTS(SELECT 1 FROM pg_type WHERE typname='AcademicStructureKind' AND typtype='e')
UNION ALL SELECT 'column academic_years.structureId',
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='academic_years' AND column_name='structureId')
UNION ALL SELECT 'column attachments.sectionId',
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='attachments' AND column_name='sectionId')
UNION ALL SELECT 'column course_parts.thumbnailKey',
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='course_parts' AND column_name='thumbnailKey')
UNION ALL SELECT 'column library_parts.thumbnailKey',
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='library_parts' AND column_name='thumbnailKey')
UNION ALL SELECT 'column playback_tickets.playId',
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='playback_tickets' AND column_name='playId')
UNION ALL SELECT 'index academic_years_structureId_order_key',
       EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='academic_years_structureId_order_key')
UNION ALL SELECT 'OLD index academic_years_order_key (should be gone after)',
       EXISTS(SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='academic_years_order_key')
UNION ALL SELECT 'check academic_structures_single_owner_check',
       EXISTS(SELECT 1 FROM pg_constraint WHERE conname='academic_structures_single_owner_check')
UNION ALL SELECT 'check attachments_single_scope_check',
       EXISTS(SELECT 1 FROM pg_constraint WHERE conname='attachments_single_scope_check');

\echo '=== 7. WHICH DATABASE AM I CONNECTED TO (confirm it is production) ==='
SELECT current_database()                AS database,
       current_user                      AS role,
       inet_server_addr()                AS server_addr,
       version()                         AS pg_version,
       (SELECT count(*) FROM information_schema.tables
          WHERE table_schema='public' AND table_type='BASE TABLE') AS public_tables;

\echo '=== 8. ROW COUNTS ON THE TABLES THE MIGRATION TOUCHES ==='
SELECT 'academic_years'   AS t, count(*) FROM academic_years
UNION ALL SELECT 'attachments',      count(*) FROM attachments
UNION ALL SELECT 'course_parts',     count(*) FROM course_parts
UNION ALL SELECT 'library_parts',    count(*) FROM library_parts
UNION ALL SELECT 'playback_tickets', count(*) FROM playback_tickets
UNION ALL SELECT 'users',            count(*) FROM users
UNION ALL SELECT 'courses',          count(*) FROM courses;
