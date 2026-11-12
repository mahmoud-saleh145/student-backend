-- Library material audience: departments chosen per year/level.
--
-- ADDITIVE. One new table, its keys and indexes, and a backfill. Nothing is
-- dropped, renamed or rewritten: `library_material_departments` keeps every
-- department the material reaches (the union over its years), and that union
-- is still the ONLY thing eligibility reads. `library_material_academic_years`
-- keeps every year the material is filed under, and "no year link" still means
-- "all years".
--
-- A row (material, year, department) says: a student of that department finds
-- the material when browsing that year/level. It is a browsing rule, never an
-- authorization rule; a student's own registered year is never compared.
--
-- The two composite foreign keys hold the shape in the database itself:
--   * the year must be one the material is filed under;
--   * the department must be one the material reaches, which in turn (through
--     `library_material_departments`' own keys) belongs to the material's
--     faculty.
-- A faculty-wide material has no department links, so it can carry no rows;
-- an "all years" material has no year links, so it can carry none either.
-- Removing a year or a department link removes its rows (CASCADE).

CREATE TABLE "library_material_year_departments" (
    "materialId" TEXT NOT NULL,
    "academicYearId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "library_material_year_departments_pkey" PRIMARY KEY ("materialId","academicYearId","departmentId")
);

-- "Which materials does this department find under this year" is the filter query.
CREATE INDEX "library_material_year_departments_academicYearId_department_idx"
  ON "library_material_year_departments"("academicYearId", "departmentId");

-- Supports the cascade from a removed department link.
CREATE INDEX "library_material_year_departments_materialId_departmentId_idx"
  ON "library_material_year_departments"("materialId", "departmentId");

ALTER TABLE "library_material_year_departments"
  ADD CONSTRAINT "library_material_year_departments_materialId_academicYearI_fkey"
  FOREIGN KEY ("materialId", "academicYearId")
  REFERENCES "library_material_academic_years"("materialId", "academicYearId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "library_material_year_departments"
  ADD CONSTRAINT "library_material_year_departments_materialId_departmentId_fkey"
  FOREIGN KEY ("materialId", "departmentId")
  REFERENCES "library_material_departments"("materialId", "departmentId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: a department-scoped material filed under specific years reached
-- the same departments under every one of those years. Write exactly that, so
-- every existing material keeps its effective audience:
--   years {Level 000, Level 100} x departments {MTE, Electrical}
--   -> Level 000 -> MTE, Electrical; Level 100 -> MTE, Electrical.
-- Faculty-wide and "all years" materials get no rows; they need none.
-- Soft-deleted rows are included so a restore sees the same audience.
INSERT INTO "library_material_year_departments" ("materialId", "academicYearId", "departmentId")
SELECT y."materialId", y."academicYearId", d."departmentId"
FROM "library_material_academic_years" y
JOIN "library_material_departments" d ON d."materialId" = y."materialId"
JOIN "library_materials" m ON m."id" = y."materialId"
WHERE m."departmentScope" = 'DEPARTMENTS'
ON CONFLICT DO NOTHING;
