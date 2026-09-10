-- =============================================================================
-- Admin/Teacher dashboard support.
--
-- Every statement here is additive. No existing column is dropped, retyped or
-- made stricter, and every new column on an existing table is either nullable
-- or carries a default that reproduces the behaviour in place before this
-- migration ran:
--
--   access_codes."targetType"        -> 'COURSE'  (what every existing code is)
--   access_codes."grantedSectionIds" -> '{}'      (empty = no snapshot taken,
--                                                  which the service reads as
--                                                  "the whole course", i.e. the
--                                                  old behaviour)
--   enrollments."coversAllSections"  -> true      (what every existing
--                                                  enrollment already means)
--
-- The one non-trivial step is promoting access_codes."batchId" from a loose
-- uuid to a real foreign key. Existing batch ids are backfilled into
-- code_batches BEFORE the constraint is added, so no historical row is
-- orphaned and no code loses its batch.
-- =============================================================================

-- --- Enums -------------------------------------------------------------------

CREATE TYPE "CodeTargetType" AS ENUM ('COURSE', 'SECTION', 'TEACHER');
CREATE TYPE "SectionGrantSource" AS ENUM ('CODE', 'PAYMENT', 'ADMIN');
CREATE TYPE "SupportTicketStatus" AS ENUM ('OPEN', 'PENDING', 'RESOLVED', 'CLOSED');
CREATE TYPE "SupportTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');
CREATE TYPE "SupportTicketCategory" AS ENUM ('GENERAL', 'TECHNICAL', 'PAYMENT', 'ACCESS', 'CONTENT', 'OTHER');

-- --- Subjects ----------------------------------------------------------------

CREATE TABLE "subjects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "subjects_name_key" ON "subjects"("name");
CREATE INDEX "subjects_isActive_sortOrder_idx" ON "subjects"("isActive", "sortOrder");

ALTER TABLE "courses" ADD COLUMN "subjectId" TEXT;
CREATE INDEX "courses_subjectId_idx" ON "courses"("subjectId");
ALTER TABLE "courses"
    ADD CONSTRAINT "courses_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "subjects"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Code batches ------------------------------------------------------------

CREATE TABLE "code_batches" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "targetType" "CodeTargetType" NOT NULL,
    "courseId" TEXT,
    "sectionId" TEXT,
    "teacherId" TEXT,
    "targetNameSnapshot" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "prefix" TEXT,
    "priceAmount" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'EGP',
    "expiresAt" TIMESTAMP(3),
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "code_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "code_batches_createdAt_idx" ON "code_batches"("createdAt");
CREATE INDEX "code_batches_targetType_idx" ON "code_batches"("targetType");

ALTER TABLE "code_batches"
    ADD CONSTRAINT "code_batches_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Access code targeting ---------------------------------------------------

ALTER TABLE "access_codes"
    ADD COLUMN "targetType" "CodeTargetType" NOT NULL DEFAULT 'COURSE',
    ADD COLUMN "sectionId" TEXT,
    ADD COLUMN "teacherId" TEXT,
    ADD COLUMN "grantedSectionIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "grantedCourseIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    ADD COLUMN "priceAmount" DECIMAL(12,2),
    ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'EGP';

-- Backfill: every distinct pre-existing batchId becomes a real batch row, so
-- the foreign key added below cannot orphan a single historical code.
INSERT INTO "code_batches" (
    "id", "name", "targetType", "courseId", "targetNameSnapshot",
    "quantity", "note", "createdById", "createdAt", "updatedAt"
)
SELECT
    c."batchId",
    NULL,
    'COURSE'::"CodeTargetType",
    MIN(c."courseId"),
    COALESCE(MIN(co."title"), 'Unscoped'),
    COUNT(*)::int,
    MIN(c."note"),
    MIN(c."issuedById"),
    MIN(c."createdAt"),
    CURRENT_TIMESTAMP
FROM "access_codes" c
LEFT JOIN "courses" co ON co."id" = c."courseId"
WHERE c."batchId" IS NOT NULL
GROUP BY c."batchId";

CREATE INDEX "access_codes_targetType_status_idx" ON "access_codes"("targetType", "status");
CREATE INDEX "access_codes_sectionId_idx" ON "access_codes"("sectionId");
CREATE INDEX "access_codes_teacherId_idx" ON "access_codes"("teacherId");

ALTER TABLE "access_codes"
    ADD CONSTRAINT "access_codes_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "course_sections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "access_codes"
    ADD CONSTRAINT "access_codes_teacherId_fkey"
    FOREIGN KEY ("teacherId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "access_codes"
    ADD CONSTRAINT "access_codes_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "code_batches"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Section-level entitlement ----------------------------------------------

ALTER TABLE "enrollments"
    ADD COLUMN "coversAllSections" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "enrollment_section_grants" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "sectionId" TEXT NOT NULL,
    "source" "SectionGrantSource" NOT NULL DEFAULT 'CODE',
    "codeId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "enrollment_section_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "enrollment_section_grants_enrollmentId_sectionId_key"
    ON "enrollment_section_grants"("enrollmentId", "sectionId");
CREATE INDEX "enrollment_section_grants_sectionId_idx"
    ON "enrollment_section_grants"("sectionId");

ALTER TABLE "enrollment_section_grants"
    ADD CONSTRAINT "enrollment_section_grants_enrollmentId_fkey"
    FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "enrollment_section_grants"
    ADD CONSTRAINT "enrollment_section_grants_sectionId_fkey"
    FOREIGN KEY ("sectionId") REFERENCES "course_sections"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Support -----------------------------------------------------------------

CREATE TABLE "support_tickets" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "category" "SupportTicketCategory" NOT NULL DEFAULT 'GENERAL',
    "status" "SupportTicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "SupportTicketPriority" NOT NULL DEFAULT 'NORMAL',
    "courseId" TEXT,
    "assignedToId" TEXT,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastMessageBy" TEXT,
    "unreadForStaff" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "support_tickets_reference_key" ON "support_tickets"("reference");
CREATE INDEX "support_tickets_status_lastMessageAt_idx" ON "support_tickets"("status", "lastMessageAt");
CREATE INDEX "support_tickets_userId_createdAt_idx" ON "support_tickets"("userId", "createdAt");
CREATE INDEX "support_tickets_assignedToId_status_idx" ON "support_tickets"("assignedToId", "status");

ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "support_tickets"
    ADD CONSTRAINT "support_tickets_assignedToId_fkey"
    FOREIGN KEY ("assignedToId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "support_messages" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorRole" "UserRole" NOT NULL,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_messages_ticketId_createdAt_idx" ON "support_messages"("ticketId", "createdAt");

ALTER TABLE "support_messages"
    ADD CONSTRAINT "support_messages_ticketId_fkey"
    FOREIGN KEY ("ticketId") REFERENCES "support_tickets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "support_messages"
    ADD CONSTRAINT "support_messages_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Default platform settings ----------------------------------------------
--
-- Seeded here rather than in code so a fresh install and an upgrade agree.
-- Values match the behaviour already in force, so applying this migration
-- changes nothing operationally until an administrator edits them.

INSERT INTO "platform_settings" ("key", "value", "description", "createdAt", "updatedAt")
VALUES
  ('student.deviceLimit', '1'::jsonb,
   'How many devices a student account may bind at once.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('student.allowAcademicYearChange', 'false'::jsonb,
   'Whether students may change their own academic year from the app.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('teacher.canDeleteLectures', 'false'::jsonb,
   'Whether teachers may delete lectures in their own courses.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('teacher.canDeleteVideos', 'false'::jsonb,
   'Whether teachers may delete videos in their own courses.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('teacher.canEditVideoUrls', 'false'::jsonb,
   'Whether teachers may replace video sources in their own courses.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('teacher.canEditCoursePrices', 'false'::jsonb,
   'Whether teachers may change the price of their own courses.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('contact.phone', '""'::jsonb,
   'Public support phone number.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('contact.whatsapp', '""'::jsonb,
   'Public WhatsApp number.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('contact.facebook', '""'::jsonb,
   'Public Facebook page URL.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  ('contact.email', '""'::jsonb,
   'Public support email address.', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
