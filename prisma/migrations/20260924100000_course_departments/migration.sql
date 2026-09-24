-- =============================================================================
-- Course ↔ Department
--
-- The hierarchy the dashboard presents is University → College → Department,
-- but a course could only ever record the first two: there was no department
-- relation on `courses` at all, singular or plural. This adds the missing
-- many-to-many, because a course is routinely offered to several departments
-- of the same college.
--
-- Purely additive. No existing table is altered, no existing row is touched,
-- and no column is dropped — a course with no departments is valid and keeps
-- behaving exactly as it does today.
--
-- Folder named with the real UTC clock so a Prisma-generated migration can
-- never sort into the middle of this sequence.
-- =============================================================================

CREATE TABLE "course_departments" (
  "courseId"     TEXT         NOT NULL,
  "departmentId" TEXT         NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "course_departments_pkey" PRIMARY KEY ("courseId", "departmentId")
);

-- Answers "every course in this department" without scanning the table. The
-- primary key already covers lookups from the course side.
CREATE INDEX "course_departments_departmentId_idx" ON "course_departments"("departmentId");

-- Removing a course takes its department links with it: the link has no
-- meaning without the course, and nothing else references it.
ALTER TABLE "course_departments"
  ADD CONSTRAINT "course_departments_courseId_fkey"
  FOREIGN KEY ("courseId") REFERENCES "courses"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT, matching departments → faculties. Departments are deactivated,
-- never deleted; an attempt to hard-delete one that still carries courses
-- should fail loudly rather than silently strip a course's structure.
ALTER TABLE "course_departments"
  ADD CONSTRAINT "course_departments_departmentId_fkey"
  FOREIGN KEY ("departmentId") REFERENCES "departments"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
