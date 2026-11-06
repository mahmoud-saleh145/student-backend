import { AcademicStructureKind } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService, notDeleted } from '../../database/prisma.service';

import type { CatalogService } from './catalog.service';

/**
 * Where a course or a Library material sits in the academic hierarchy, and
 * whether that placement is coherent.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * These two checks used to be private methods of `CoursesAdminService`. The
 * Library needs the same rules — a college belongs to its university, every
 * department belongs to the college, General and Programs departments are never
 * combined, a year/level rung belongs to the ladder that governs the unit — so
 * they were moved here VERBATIM and the course service now delegates to them.
 *
 * ── Course behaviour is unchanged ───────────────────────────────────────────
 *
 * With no options (`COURSE_PLACEMENT`, the default) the queries, their order,
 * their conditions and every message are exactly what the course service ran
 * before. `test/unit/academic-placement-equivalence.spec.ts` pins that. Every
 * Library-only rule is behind an option and is off by default.
 *
 * Free functions over `prisma`/`catalog` rather than an injectable, so the
 * course service keeps its constructor (eleven unit tests build it by hand).
 */

type PlacementPrisma = Pick<PrismaService, 'faculty' | 'department' | 'academicYear' | 'university'>;
type PlacementCatalog = Pick<CatalogService, 'resolveAcademicStructure'>;

export interface PlacementOptions {
  /**
   * Refuse inactive faculties, departments and rungs, and check the university
   * exists, is active and is not deleted. Library only: the course path has
   * never required it and must not start now.
   */
  requireActive?: boolean;
  /** Refuse a placement without both a university and a faculty. Library only. */
  requireUniversityAndFaculty?: boolean;
  /** The noun used in messages. `course` reproduces the course text exactly. */
  entityLabel?: 'course' | 'material';
}

/** Exactly the behaviour `CoursesAdminService` had before the move. */
export const COURSE_PLACEMENT: PlacementOptions = Object.freeze({
  requireActive: false,
  requireUniversityAndFaculty: false,
  entityLabel: 'course',
});

/** The Library's stricter rules (decision F5: university and faculty required). */
export const LIBRARY_PLACEMENT: PlacementOptions = Object.freeze({
  requireActive: true,
  requireUniversityAndFaculty: true,
  entityLabel: 'material',
});

export interface StructureInput {
  universityId?: string | null;
  facultyId?: string | null;
  departmentIds?: string[] | null;
}

export interface YearInput extends StructureInput {
  academicYearId?: string | null;
}

/**
 * The university/college/department part of a placement.
 *
 * The dashboard filters each select by its parent, but a filtered dropdown is a
 * convenience, not a constraint: the API accepts whatever is posted. Throws one
 * VALIDATION_ERROR carrying every field problem found.
 */
export async function checkAcademicStructure(
  prisma: PlacementPrisma,
  input: StructureInput,
  options: PlacementOptions = COURSE_PLACEMENT,
): Promise<void> {
  const fields: Record<string, string[]> = {};

  const facultyId = input.facultyId ?? null;
  const universityId = input.universityId ?? null;
  const departmentIds = [...new Set(input.departmentIds ?? [])];

  if (options.requireUniversityAndFaculty) {
    if (!universityId) fields.universityId = ['choose a university'];
    if (!facultyId) fields.facultyId = ['choose a college'];
  }

  if (options.requireActive && universityId) {
    const university = await prisma.university.findFirst({
      where: { id: universityId, ...notDeleted },
      select: { id: true, isActive: true },
    });
    if (!university) fields.universityId = ['university not found'];
    else if (!university.isActive) fields.universityId = ['this university is inactive'];
  }

  const faculty = facultyId
    ? await prisma.faculty.findFirst({
        where: { id: facultyId, ...notDeleted },
        select: options.requireActive
          ? { id: true, universityId: true, isActive: true }
          : { id: true, universityId: true },
      })
    : null;

  if (facultyId && !faculty) {
    fields.facultyId = ['college not found'];
  } else if (faculty && universityId && faculty.universityId !== universityId) {
    fields.facultyId = ['does not belong to the selected university'];
  } else if (
    options.requireActive &&
    faculty &&
    (faculty as { isActive?: boolean }).isActive === false
  ) {
    fields.facultyId = ['this college is inactive'];
  }

  if (departmentIds.length > 0) {
    if (!facultyId) {
      // A department is only meaningful under a college. Accepting one
      // without a parent would store a hierarchy that cannot be rendered.
      fields.departmentIds = ['choose a college before choosing departments'];
    } else {
      const found = await prisma.department.findMany({
        where: { id: { in: departmentIds }, ...notDeleted },
        select: options.requireActive
          ? { id: true, facultyId: true, studyType: true, isActive: true }
          : { id: true, facultyId: true, studyType: true },
      });

      if (new Set(found.map((d) => d.studyType)).size > 1) {
        fields.departmentIds = ['General and Programs departments cannot be combined'];
      }

      const missing = departmentIds.filter((id) => !found.some((d) => d.id === id));
      const foreign = found.filter((d) => d.facultyId !== facultyId);

      if (missing.length > 0) {
        fields.departmentIds = ['one or more departments do not exist'];
      } else if (foreign.length > 0) {
        fields.departmentIds = [
          'one or more departments do not belong to the selected college',
        ];
      } else if (
        options.requireActive &&
        found.some((d) => (d as { isActive?: boolean }).isActive === false)
      ) {
        fields.departmentIds = ['one or more departments are inactive'];
      }
    }
  }

  if (Object.keys(fields).length > 0) {
    throw AppException.validation(fields);
  }
}

/**
 * A rung must belong to the ladder that actually governs the unit.
 *
 * Resolution goes through `CatalogService.resolveAcademicStructure` rather than
 * a second copy of the department -> faculty -> university -> platform
 * precedence. An entity offered to several departments must use a rung that
 * belongs to every selected department's ladder.
 */
export async function checkYearInLadder(
  prisma: PlacementPrisma,
  catalog: PlacementCatalog,
  input: YearInput,
  options: PlacementOptions = COURSE_PLACEMENT,
): Promise<void> {
  const academicYearId = input.academicYearId;
  if (!academicYearId) return;

  const label = options.entityLabel ?? 'course';

  const departmentIds = [...new Set(input.departmentIds ?? [])].sort();
  const departmentId = departmentIds[0];
  for (const additionalDepartment of departmentIds.slice(1)) {
    await checkYearInLadder(
      prisma,
      catalog,
      { ...input, departmentIds: [additionalDepartment] },
      options,
    );
  }

  const structure = await catalog.resolveAcademicStructure({
    departmentId: departmentId ?? null,
    facultyId: departmentId ? null : (input.facultyId ?? null),
    universityId: departmentId || input.facultyId ? null : (input.universityId ?? null),
  });

  // No ladder anywhere up the chain: there is nothing to belong to, and the
  // row cannot be rendered by anything that lists years.
  if (!structure) {
    throw AppException.validation({
      academicYearId: [`no academic structure covers this ${label}; create one first`],
    });
  }

  const rung = await prisma.academicYear.findFirst({
    where: options.requireActive
      ? { id: academicYearId, structureId: structure.id, isActive: true }
      : { id: academicYearId, structureId: structure.id },
    select: { id: true },
  });

  if (!rung) {
    throw AppException.validation({
      academicYearId: [
        structure.kind === AcademicStructureKind.LEVEL
          ? `that level is not part of this ${label} academic structure`
          : `that year is not part of this ${label} academic structure`,
      ],
    });
  }
}
