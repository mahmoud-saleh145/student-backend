-- Library material audience: several academic years/levels per material.
--
-- ADDITIVE. One new join table, two foreign keys, one index, and a backfill
-- that copies every existing single-year row into it. No column is dropped,
-- renamed or rewritten: `library_materials.academicYearId` stays, and the
-- service keeps it equal to the material's first (lowest-order) linked year so
-- every reader deployed today keeps working against this schema.
--
--   * a material with `academicYearId` set gets exactly one link (that year);
--   * a material with `academicYearId` NULL — "all years" — gets no link, and
--     "no link" is what the service reads as "all years";
--   * the soft-deleted legacy row is copied too, so a restore sees the same
--     year it had.
--
-- The year/level is a browsing filter only. Nothing about eligibility
-- (`library_material_departments`, `departmentScope`) is touched.

-- CreateTable
CREATE TABLE "library_material_academic_years" (
    "materialId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_material_academic_years_pkey" PRIMARY KEY ("materialId","academicYearId")
);

-- CreateIndex: "which materials are filed under this year" is the filter query.
CREATE INDEX "library_material_academic_years_academicYearId_idx" ON "library_material_academic_years"("academicYearId");

-- AddForeignKey
ALTER TABLE "library_material_academic_years"
  ADD CONSTRAINT "library_material_academic_years_materialId_fkey"
  FOREIGN KEY ("materialId") REFERENCES "library_materials"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: deleting a rung unfiles the material from it (the legacy
-- column's SET NULL did the same), never blocks the deletion.
ALTER TABLE "library_material_academic_years"
  ADD CONSTRAINT "library_material_academic_years_academicYearId_fkey"
  FOREIGN KEY ("academicYearId") REFERENCES "academic_years"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every single-year material becomes a one-link material. Rows whose
-- year no longer exists (none in production, but a stale id would otherwise
-- violate the foreign key) are left as "all years", which is what the dangling
-- column already meant to every reader.
INSERT INTO "library_material_academic_years" ("materialId", "academicYearId")
SELECT m."id", m."academicYearId"
FROM "library_materials" m
JOIN "academic_years" y ON y."id" = m."academicYearId"
WHERE m."academicYearId" IS NOT NULL
ON CONFLICT DO NOTHING;
