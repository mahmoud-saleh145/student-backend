-- =============================================================================
-- Academic structures, section attachments, part/library thumbnails, counted plays
--
-- Four independent changes in one migration because they ship together. Every
-- one of them is additive: no table is dropped, no column is removed, and the
-- only index that goes away is replaced in the same statement block by a
-- strictly better-scoped one. Existing rows are preserved throughout, and the
-- single backfill is deterministic.
--
-- Folder named with the real UTC clock so a Prisma-generated migration can
-- never sort into the middle of this sequence.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1. Academic structures: Years vs Levels, owned per catalogue unit
--
-- `academic_years` used to be one flat, platform-wide list whose `order` was
-- globally unique — so two colleges could not both have a rung numbered 1, and
-- there was nowhere to record whether a list meant "First Year" or "Level 1".
--
-- The list itself keeps its table and its primary keys. student_profiles,
-- courses and library_materials all point at `academic_years`, and none of
-- those foreign keys is touched here; that is deliberate, and it is why this
-- change does not ripple through the application.
--
-- What is new is a parent row that owns each list. Ownership is three nullable
-- FKs of which at most one is set, and `scopeKey` is the denormalised form of
-- that choice. The unique constraint lives on `scopeKey` and NOT on the three
-- FKs, because Postgres treats NULLs as distinct: a UNIQUE over nullable
-- columns would cheerfully accept two platform-wide structures, which is
-- exactly the duplicate this design has to prevent.
-- -----------------------------------------------------------------------------

CREATE TYPE "AcademicStructureKind" AS ENUM ('YEAR', 'LEVEL');

CREATE TABLE "academic_structures" (
  "id"           TEXT                    NOT NULL,
  "kind"         "AcademicStructureKind" NOT NULL DEFAULT 'YEAR',
  "universityId" TEXT,
  "facultyId"    TEXT,
  "departmentId" TEXT,
  "scopeKey"     TEXT                    NOT NULL,
  "isActive"     BOOLEAN                 NOT NULL DEFAULT true,
  "createdAt"    TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)            NOT NULL,

  CONSTRAINT "academic_structures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "academic_structures_scopeKey_key" ON "academic_structures"("scopeKey");
CREATE INDEX "academic_structures_universityId_idx" ON "academic_structures"("universityId");
CREATE INDEX "academic_structures_facultyId_idx"    ON "academic_structures"("facultyId");
CREATE INDEX "academic_structures_departmentId_idx" ON "academic_structures"("departmentId");

-- At most one owner. A row naming both a faculty and a department has no
-- meaningful scope, and `scopeKey` could not describe it. The application
-- enforces this too; the constraint is what stops a hand-edited row.
ALTER TABLE "academic_structures"
  ADD CONSTRAINT "academic_structures_single_owner_check"
  CHECK (
    (CASE WHEN "universityId" IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "facultyId"    IS NULL THEN 0 ELSE 1 END) +
    (CASE WHEN "departmentId" IS NULL THEN 0 ELSE 1 END) <= 1
  );

-- CASCADE: a structure describes its owning unit and has no meaning without
-- it. Units are normally deactivated rather than deleted, so this path is
-- rare; when it is taken, leaving orphaned ladders behind would be worse.
ALTER TABLE "academic_structures"
  ADD CONSTRAINT "academic_structures_universityId_fkey"
  FOREIGN KEY ("universityId") REFERENCES "universities"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "academic_structures"
  ADD CONSTRAINT "academic_structures_facultyId_fkey"
  FOREIGN KEY ("facultyId") REFERENCES "faculties"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "academic_structures"
  ADD CONSTRAINT "academic_structures_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The home for every list that exists today. Created unconditionally so a
-- fresh install has somewhere to put its first year, and with a fixed id so
-- this migration is re-runnable against a partially migrated database and so
-- the seed script can reference it without a lookup.
INSERT INTO "academic_structures"
  ("id", "kind", "universityId", "facultyId", "departmentId", "scopeKey", "isActive", "createdAt", "updatedAt")
VALUES
  ('acadstruct_platform_default', 'YEAR', NULL, NULL, NULL, 'platform', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("scopeKey") DO NOTHING;

-- Nullable first, backfilled, then tightened — the three-step that lets this
-- run against a populated table without a moment where the column is invalid.
ALTER TABLE "academic_years" ADD COLUMN "structureId" TEXT;

UPDATE "academic_years"
   SET "structureId" = (SELECT "id" FROM "academic_structures" WHERE "scopeKey" = 'platform')
 WHERE "structureId" IS NULL;

ALTER TABLE "academic_years" ALTER COLUMN "structureId" SET NOT NULL;

ALTER TABLE "academic_years"
  ADD CONSTRAINT "academic_years_structureId_fkey"
  FOREIGN KEY ("structureId") REFERENCES "academic_structures"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The point of the whole change: `order` becomes unique per structure instead
-- of per platform. Dropped only after the replacement is in place below, so
-- there is no window in which duplicates could be inserted.
CREATE UNIQUE INDEX "academic_years_structureId_order_key" ON "academic_years"("structureId", "order");
CREATE INDEX "academic_years_structureId_isActive_order_idx" ON "academic_years"("structureId", "isActive", "order");
DROP INDEX IF EXISTS "academic_years_order_key";


-- -----------------------------------------------------------------------------
-- 2. Section-level attachments
--
-- `attachments` could already belong to a lecture (`lessonId`) or to the whole
-- course (both scope columns null). A section had no way to carry its own
-- documents, which is the gap this closes.
-- -----------------------------------------------------------------------------

ALTER TABLE "attachments" ADD COLUMN "sectionId" TEXT;

CREATE INDEX "attachments_sectionId_idx" ON "attachments"("sectionId");

-- CASCADE: a section's own documents belong to the section and go with it.
-- Lecture attachments are unaffected — they already cascade from the lesson —
-- so deleting a section cannot strip documents that belong to its lectures
-- unless those lectures are themselves deleted.
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_sectionId_fkey"
  FOREIGN KEY ("sectionId") REFERENCES "course_sections"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- An attachment is scoped to a lecture, or to a section, or to neither, but
-- never to both: two scopes would mean two different access rules for one
-- file. Existing rows all satisfy this, since `sectionId` was just created.
ALTER TABLE "attachments"
  ADD CONSTRAINT "attachments_single_scope_check"
  CHECK ("lessonId" IS NULL OR "sectionId" IS NULL);


-- -----------------------------------------------------------------------------
-- 3. Part and library-part thumbnails
--
-- Courses and videos already had `thumbnailKey`, and library materials had
-- `coverKey`. Course parts and library parts had nothing, so a part could only
-- ever show its parent's image.
--
-- Nullable with no default on purpose: NULL means "not explicitly chosen", and
-- the service is what falls back to the parent's image and then to the library
-- default setting. Writing a default into the column would make an Admin's
-- explicit choice indistinguishable from an inherited one, and the next change
-- of the default would silently overwrite it.
-- -----------------------------------------------------------------------------

ALTER TABLE "course_parts"  ADD COLUMN "thumbnailKey" TEXT;
ALTER TABLE "library_parts" ADD COLUMN "thumbnailKey" TEXT;


-- -----------------------------------------------------------------------------
-- 4. Counted plays
--
-- The three-play rule needs a server-side count that survives a reinstall, so
-- it is a count of rows keyed on the account. The client never writes here.
--
-- A play is not a ticket. One play can span several tickets — a rotation
-- part-way through a long lesson, a resume after backgrounding, a retry after
-- the network dropped before playback began — and while a play is open and
-- recently active the next ticket joins it and consumes nothing. That is why
-- the counter cannot simply be COUNT(playback_tickets), and why `closedAt`
-- exists: it is the line between "same attempt" and "new attempt".
-- -----------------------------------------------------------------------------

CREATE TABLE "video_plays" (
  "id"             TEXT         NOT NULL,
  "userId"         TEXT         NOT NULL,
  "videoId"        TEXT         NOT NULL,
  "attemptNumber"  INTEGER      NOT NULL,
  "startedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "watchedSeconds" INTEGER      NOT NULL DEFAULT 0,
  "closedAt"       TIMESTAMP(3),

  CONSTRAINT "video_plays_pkey" PRIMARY KEY ("id")
);

-- The concurrency guarantee. Two simultaneous issue requests cannot both claim
-- attempt 3: one of them loses this index and retries against the new count,
-- so the limit cannot be beaten by racing the endpoint.
CREATE UNIQUE INDEX "video_plays_userId_videoId_attemptNumber_key"
  ON "video_plays"("userId", "videoId", "attemptNumber");

-- Serves both hot reads: "how many plays has this student used" and "is there
-- an open play to resume into".
CREATE INDEX "video_plays_userId_videoId_closedAt_idx" ON "video_plays"("userId", "videoId", "closedAt");
CREATE INDEX "video_plays_videoId_startedAt_idx"       ON "video_plays"("videoId", "startedAt");

ALTER TABLE "video_plays"
  ADD CONSTRAINT "video_plays_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "video_plays"
  ADD CONSTRAINT "video_plays_videoId_fkey"
  FOREIGN KEY ("videoId") REFERENCES "videos"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable: free/preview lessons are not counted at all, and every ticket
-- issued before this table existed predates counting. SET NULL rather than
-- CASCADE, so pruning play history can never delete ticket audit rows.
ALTER TABLE "playback_tickets" ADD COLUMN "playId" TEXT;

CREATE INDEX "playback_tickets_playId_idx" ON "playback_tickets"("playId");

ALTER TABLE "playback_tickets"
  ADD CONSTRAINT "playback_tickets_playId_fkey"
  FOREIGN KEY ("playId") REFERENCES "video_plays"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
