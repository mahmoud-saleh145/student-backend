BEGIN;

CREATE TYPE "StudyType" AS ENUM ('GENERAL', 'PROGRAMS');
ALTER TABLE "departments" ADD COLUMN "studyType" "StudyType" NOT NULL DEFAULT 'GENERAL';
CREATE INDEX "departments_facultyId_studyType_isActive_idx" ON "departments" ("facultyId", "studyType", "isActive");

-- Add the requested hierarchy without reclassifying existing students or courses.
DO $$
DECLARE u TEXT; f TEXT; d TEXT; st TEXT; branch RECORD; rung INTEGER;
BEGIN
  SELECT id INTO u FROM universities WHERE name = 'Mansoura University' AND "deletedAt" IS NULL LIMIT 1;
  IF u IS NULL THEN
    u := 'uni_mansoura';
    INSERT INTO universities (id, name, "nameAr", code, "updatedAt") VALUES (u, 'Mansoura University', 'جامعة المنصورة', 'MANSOURA', NOW());
  END IF;
  SELECT id INTO f FROM faculties WHERE "universityId" = u AND name = 'Engineering' AND "deletedAt" IS NULL LIMIT 1;
  IF f IS NULL THEN
    f := 'fac_mansoura_engineering';
    INSERT INTO faculties (id, "universityId", name, "nameAr", "updatedAt") VALUES (f, u, 'Engineering', 'الهندسة', NOW());
  END IF;
  FOR branch IN SELECT * FROM (VALUES
    ('preparatory', 'Preparatory Engineering', 'إعدادي هندسة', 'GENERAL', 1, 1),
    ('civil', 'Civil Engineering', 'الهندسة المدنية', 'GENERAL', 2, 4),
    ('architecture', 'Architecture', 'الهندسة المعمارية', 'GENERAL', 2, 4),
    ('program_a', 'Program / Department A', 'برنامج أ', 'PROGRAMS', 0, 4),
    ('program_b', 'Program / Department B', 'برنامج ب', 'PROGRAMS', 0, 4)
  ) AS branches(key, name, arabic, type, first_rung, last_rung)
  LOOP
    SELECT id INTO d FROM departments WHERE "facultyId" = f AND name = branch.name LIMIT 1;
    IF d IS NULL THEN
      d := 'dept_mansoura_' || branch.key;
      INSERT INTO departments (id, "facultyId", name, "nameAr", "studyType", "updatedAt") VALUES (d, f, branch.name, branch.arabic, branch.type::"StudyType", NOW());
    ELSE
      -- Refuse to silently move live students into a different study type.
      IF EXISTS (SELECT 1 FROM departments WHERE id = d AND "studyType" <> branch.type::"StudyType") THEN
        RAISE EXCEPTION 'Study type conflict for department %', d;
      END IF;
    END IF;
    st := 'structure_mansoura_' || branch.key;
    IF EXISTS (SELECT 1 FROM academic_structures WHERE "departmentId" = d) THEN
      RAISE EXCEPTION 'Existing department ladder requires review: %', d;
    END IF;
    INSERT INTO academic_structures (id, kind, "departmentId", "scopeKey", "updatedAt") VALUES (st, CASE WHEN branch.type = 'PROGRAMS' THEN 'LEVEL'::"AcademicStructureKind" ELSE 'YEAR'::"AcademicStructureKind" END, d, 'department:' || d, NOW());
    FOR rung IN branch.first_rung..branch.last_rung LOOP
      INSERT INTO academic_years (id, "structureId", "order", name, "nameAr", "updatedAt") VALUES (
        st || '_' || rung, st, CASE WHEN branch.type = 'PROGRAMS' THEN rung + 1 ELSE rung END,
        CASE WHEN branch.type = 'PROGRAMS' THEN 'Level ' || LPAD((rung * 100)::TEXT, 3, '0') ELSE (ARRAY['First Year', 'Second Year', 'Third Year', 'Fourth Year'])[rung] END,
        CASE WHEN branch.type = 'PROGRAMS' THEN 'المستوى ' || LPAD((rung * 100)::TEXT, 3, '0') ELSE (ARRAY['الفرقة الأولى', 'الفرقة الثانية', 'الفرقة الثالثة', 'الفرقة الرابعة'])[rung] END,
        NOW());
    END LOOP;
  END LOOP;
END $$;

COMMIT;
