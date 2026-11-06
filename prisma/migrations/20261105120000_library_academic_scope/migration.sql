-- Library academic scope (Phase 1).
--
-- PREPARED ONLY. NOT APPLIED to Production. Apply only after review, with
-- `npx prisma migrate deploy` from the release commit, BEFORE the API code that
-- reads these columns is deployed (Render auto-deploys `main`, so this runs
-- before the backend PR is merged). See
-- docs/runbooks/library-academic-scope-migration.md.
--
-- ADDITIVE: one enum, one column with a constant default (metadata-only in
-- Postgres 11+, no row is rewritten), two unique indexes on columns that are
-- already unique by `id`, one new empty table, and two constraints that every
-- existing row already satisfies:
--
--   * library_materials_placement_chk — live materials have a university and
--     a faculty. All live rows do; the one soft-deleted row passes through
--     `deletedAt IS NOT NULL`.
--   * library_packages.materialId NOT NULL — there are no package rows.
--
-- The previously deployed API keeps working against this schema: it names its
-- columns explicitly, never touches the new table, and cannot change a
-- department's faculty. Only writes that would now be invalid (a live material
-- without a university/faculty, a package without a material) are refused.

-- CreateEnum
CREATE TYPE "LibraryDepartmentScope" AS ENUM ('FACULTY', 'DEPARTMENTS');

-- AlterTable
ALTER TABLE "library_materials"
  ADD COLUMN "departmentScope" "LibraryDepartmentScope" NOT NULL DEFAULT 'FACULTY';

-- CreateIndex (targets of the composite foreign keys below)
CREATE UNIQUE INDEX "library_materials_id_facultyId_key" ON "library_materials"("id", "facultyId");
CREATE UNIQUE INDEX "departments_id_facultyId_key" ON "departments"("id", "facultyId");

-- CreateTable
CREATE TABLE "library_material_departments" (
    "materialId" TEXT NOT NULL,
    "facultyId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_material_departments_pkey" PRIMARY KEY ("materialId","departmentId")
);

-- CreateIndex
CREATE INDEX "library_material_departments_departmentId_idx" ON "library_material_departments"("departmentId");

-- AddForeignKey: the link's faculty is the material's faculty.
ALTER TABLE "library_material_departments"
  ADD CONSTRAINT "library_material_departments_materialId_facultyId_fkey"
  FOREIGN KEY ("materialId", "facultyId") REFERENCES "library_materials"("id", "facultyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: ...and the department belongs to that same faculty.
ALTER TABLE "library_material_departments"
  ADD CONSTRAINT "library_material_departments_departmentId_facultyId_fkey"
  FOREIGN KEY ("departmentId", "facultyId") REFERENCES "departments"("id", "facultyId")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Packages belong to exactly one material (no package rows exist).
ALTER TABLE "library_packages" DROP CONSTRAINT "library_packages_materialId_fkey";
ALTER TABLE "library_packages" ALTER COLUMN "materialId" SET NOT NULL;
ALTER TABLE "library_packages"
  ADD CONSTRAINT "library_packages_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "library_materials"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Live materials always carry a university and a faculty (decision F5/#5).
-- Not representable in the Prisma schema; Prisma does not introspect CHECK
-- constraints, so it causes no drift.
ALTER TABLE "library_materials"
  ADD CONSTRAINT "library_materials_placement_chk"
  CHECK ("deletedAt" IS NOT NULL OR ("universityId" IS NOT NULL AND "facultyId" IS NOT NULL));
