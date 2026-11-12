import { LibraryDepartmentScope, type Prisma } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';

/**
 * The Library audience as one value: who may see a material, and under which
 * years/levels each of them finds it when browsing.
 *
 * ── Two separate questions ──────────────────────────────────────────────────
 *
 * ELIGIBILITY (authorization) is university + faculty + department, read by
 * `LibraryEligibilityService` from `departmentScope` and
 * `library_material_departments`. For a per-year audience those links hold the
 * UNION of every year's departments, so eligibility is exactly what it was.
 *
 * BROWSING is the year/level filter. A material is filed under some rungs (or
 * none, which is "all years"); a department-scoped material filed under rungs
 * also says, per rung, which departments find it there
 * (`library_material_year_departments`). A student's own registered year is
 * never compared with any of this.
 *
 * ── The four shapes, all explicit ───────────────────────────────────────────
 *
 *   FACULTY,     ALL_YEARS       no links at all
 *   FACULTY,     SELECTED_YEARS  year links
 *   DEPARTMENTS, ALL_YEARS       department links
 *   DEPARTMENTS, SELECTED_YEARS  year links + department links (the union) +
 *                                one row per (year, department) pair
 *
 * "Same departments every year" is the last shape with every year listing the
 * same departments; there is no separate wildcard.
 *
 * Pure functions only, so every rule is unit-tested without a database.
 */

export const LIBRARY_YEAR_SCOPES = ['ALL_YEARS', 'SELECTED_YEARS'] as const;
export type LibraryYearScope = (typeof LIBRARY_YEAR_SCOPES)[number];

export interface AudienceMappingInput {
  academicYearId: string;
  departmentIds: string[];
}

/** The audience as the service validates and writes it. */
export interface AudienceInput {
  universityId: string | null;
  facultyId: string | null;
  departmentScope: LibraryDepartmentScope;
  /** Every department the material reaches (DEPARTMENTS): the union over its years. */
  departmentIds: string[];
  /** De-duplicated. Empty means "all years". */
  academicYearIds: string[];
  /**
   * DEPARTMENTS filed under specific years: the departments of each year, in
   * the order the years were sent. Empty for every other shape.
   */
  yearDepartments: AudienceMappingInput[];
  /**
   * True when the client sent `audienceMappings`, so a refusal is reported
   * beside the year group it concerns rather than on the legacy fields.
   */
  perYear: boolean;
}

/** What a client may send: every audience field, in either generation. */
export interface RawAudience {
  universityId: string | null;
  facultyId: string | null;
  departmentScope: LibraryDepartmentScope;
  departmentIds?: string[];
  academicYearId?: string | null;
  academicYearIds?: string[];
  yearScope?: LibraryYearScope;
  audienceMappings?: AudienceMappingInput[];
}

/**
 * Normalises the two ways a client can send the years into one list.
 *
 * `undefined` for both means "not sent"; the caller decides what that means.
 * Otherwise the list wins, then the legacy single id, and `null` for the
 * legacy id is an explicit clear.
 */
export function academicYearIdsFrom(input: {
  academicYearId?: string | null;
  academicYearIds?: string[];
}): string[] | undefined {
  if (input.academicYearIds !== undefined) return [...new Set(input.academicYearIds)];
  if (input.academicYearId !== undefined) return input.academicYearId ? [input.academicYearId] : [];
  return undefined;
}

const unique = (ids: readonly string[]) => [...new Set(ids)];
const sameSet = (a: readonly string[], b: readonly string[]) => {
  const x = new Set(a);
  const y = new Set(b);
  return x.size === y.size && [...x].every((id) => y.has(id));
};

/**
 * Turns whatever the client sent into one `AudienceInput`, refusing every
 * ambiguous shape. Relationship checks (does the department belong to the
 * faculty, is the rung on its ladder) come after, in the service.
 *
 *   - `audienceMappings` (non-empty) is the per-year form. It needs
 *     DEPARTMENTS scope; every group names one year and at least one
 *     department; no year twice. `departmentIds`/`academicYearIds`, when sent
 *     beside it, must agree with it (a client may send both); a disagreement
 *     is refused rather than guessed at.
 *   - Without it, the legacy form: `departmentIds` + the years. A DEPARTMENTS
 *     material filed under years then reaches the same departments under
 *     every year, written as one row per pair, exactly as the migration did
 *     for existing materials.
 *   - `yearScope`, when sent, must agree: ALL_YEARS carries no year, and
 *     SELECTED_YEARS at least one.
 */
export function normalizeAudience(raw: RawAudience): AudienceInput {
  const fields: Record<string, string[]> = {};
  const legacyYears = academicYearIdsFrom(raw) ?? [];
  const legacyDepartments = unique(raw.departmentIds ?? []);
  const mappings = raw.audienceMappings ?? [];
  const base = {
    universityId: raw.universityId,
    facultyId: raw.facultyId,
    departmentScope: raw.departmentScope,
  };

  if (mappings.length > 0) {
    if (raw.departmentScope !== LibraryDepartmentScope.DEPARTMENTS) {
      throw AppException.validation({
        audienceMappings: [
          'a whole-college material has no per-year departments; send academicYearIds instead',
        ],
      });
    }
    if (raw.yearScope !== undefined && raw.yearScope !== 'SELECTED_YEARS') {
      throw AppException.validation({
        yearScope: ['per-year departments need SELECTED_YEARS'],
      });
    }

    const seen = new Set<string>();
    const groups: AudienceMappingInput[] = [];
    mappings.forEach((group, index) => {
      const departmentIds = unique(group.departmentIds ?? []);
      if (!group.academicYearId) {
        fields[`audienceMappings.${index}.academicYearId`] = ['choose a year/level'];
      } else if (seen.has(group.academicYearId)) {
        fields[`audienceMappings.${index}.academicYearId`] = [
          'this year/level is already listed; add its departments to the first group',
        ];
      }
      if (departmentIds.length === 0) {
        fields[`audienceMappings.${index}.departmentIds`] = [
          'choose at least one department for this year/level',
        ];
      }
      seen.add(group.academicYearId);
      groups.push({ academicYearId: group.academicYearId, departmentIds });
    });
    if (Object.keys(fields).length > 0) throw AppException.validation(fields);

    const union = unique(groups.flatMap((group) => group.departmentIds));
    const years = groups.map((group) => group.academicYearId);
    if (legacyDepartments.length > 0 && !sameSet(legacyDepartments, union)) {
      fields.departmentIds = ['does not match audienceMappings; send the departments per year only'];
    }
    if (legacyYears.length > 0 && !sameSet(legacyYears, years)) {
      fields.academicYearIds = ['does not match audienceMappings; send the years per group only'];
    }
    if (Object.keys(fields).length > 0) throw AppException.validation(fields);

    return {
      ...base,
      departmentIds: union,
      academicYearIds: years,
      yearDepartments: groups,
      perYear: true,
    };
  }

  if (raw.yearScope === 'ALL_YEARS' && legacyYears.length > 0) {
    throw AppException.validation({
      academicYearIds: ['"all years" carries no year/level; clear the list or choose SELECTED_YEARS'],
    });
  }
  if (raw.yearScope === 'SELECTED_YEARS' && legacyYears.length === 0) {
    throw AppException.validation(
      raw.departmentScope === LibraryDepartmentScope.DEPARTMENTS
        ? { audienceMappings: ['add at least one year/level with its departments, or choose all years'] }
        : { academicYearIds: ['choose at least one year/level, or choose all years'] },
    );
  }

  return {
    ...base,
    departmentIds: legacyDepartments,
    academicYearIds: legacyYears,
    yearDepartments:
      raw.departmentScope === LibraryDepartmentScope.DEPARTMENTS && legacyDepartments.length > 0
        ? legacyYears.map((academicYearId) => ({
            academicYearId,
            departmentIds: [...legacyDepartments],
          }))
        : [],
    perYear: false,
  };
}

/** The rows a per-year audience is stored as. */
export function yearDepartmentRows(
  materialId: string,
  audience: Pick<AudienceInput, 'yearDepartments'>,
): { materialId: string; academicYearId: string; departmentId: string }[] {
  return audience.yearDepartments.flatMap((group) =>
    group.departmentIds.map((departmentId) => ({
      materialId,
      academicYearId: group.academicYearId,
      departmentId,
    })),
  );
}

/** A department id that can never exist, for "student has no department". */
const NO_DEPARTMENT = '__no_department__';

/**
 * The STUDENT year/level browsing filter, for a student of `departmentId`.
 *
 * A material matches the requested rung when:
 *   - it is filed under no rung ("all years": every year, this one included);
 *   - it is faculty-wide and filed under this rung;
 *   - it is department-scoped and lists the student's department under this
 *     rung. Being eligible through ANOTHER rung's departments is not enough:
 *     a material for "Level 000 -> MTE, Level 200 -> Electrical" is under
 *     Level 000 for MTE students only.
 *
 * It is ANDed with the eligibility rule in its own branch, so it can only
 * narrow what the student may see. The student's own registered year is not
 * an input, on purpose.
 */
export function studentYearFilter(
  academicYearId: string,
  departmentId: string | null,
): Prisma.LibraryMaterialWhereInput {
  return {
    OR: [
      { academicYears: { none: {} } },
      {
        departmentScope: LibraryDepartmentScope.FACULTY,
        academicYears: { some: { academicYearId } },
      },
      {
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        academicYears: {
          some: {
            academicYearId,
            departments: { some: { departmentId: departmentId ?? NO_DEPARTMENT } },
          },
        },
      },
    ],
  };
}

/**
 * Which of a material's rungs a given student finds it under, for labelling.
 *
 * `links` must have been loaded with their `departments` filtered to the
 * student's own department. A department-scoped, per-year material then shows
 * the student only the rungs that list their department, so it never
 * advertises a year under which they would not find it, and never reveals
 * another department's mapping. When that leaves nothing (an owner who is no
 * longer in scope) every rung is shown, as before.
 */
export function rungsForStudent<T extends { departments?: { departmentId: string }[] }>(
  links: T[] | undefined,
  departmentScope: LibraryDepartmentScope,
): T[] {
  // Tolerates a row loaded without the relation, like every year reader.
  const all = links ?? [];
  if (departmentScope !== LibraryDepartmentScope.DEPARTMENTS) return all;
  const mine = all.filter((link) => (link.departments ?? []).length > 0);
  return mine.length > 0 ? mine : all;
}
