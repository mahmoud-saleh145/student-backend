import { AcademicStructureKind } from '@prisma/client';

/**
 * The one place a college's academic progression system is decided.
 *
 * A "system" is which vocabulary a college's ladder is expressed in:
 *
 *   YEAR  — نظام الفرق.  "First Year", "Second Year", "Third Year", …
 *   LEVEL — نظام الليفلز. "Level 000", "Level 100", "Level 200", …
 *
 * It is NOT a statement about the university. A government university may run a
 * level-based college and a private university may run a year-based one; the
 * only thing that decides it is the configuration an Admin has written.
 *
 * The resolution is the whole business rule, in one line:
 *
 *   college.academicSystemOverride ?? university.defaultAcademicSystem
 *
 * Every layer — the student-facing year/level endpoint, registration
 * validation, course validation and the admin screen — goes through
 * `resolveAcademicSystem` in `CatalogService` rather than re-deriving the rule.
 * Several slightly different copies of this is exactly how the admin UI and the
 * student app come to disagree about what a college is.
 */

/** The value a resolution may take, with the reason it was chosen. */
export type AcademicSystemSource = 'COLLEGE_OVERRIDE' | 'UNIVERSITY_DEFAULT';

export interface AcademicSystemResolution {
  /** The vocabulary this college's ladder is expressed in. */
  system: AcademicStructureKind;
  /**
   * Which of the two configuration points decided it.
   *
   * Not decoration: the admin screen has to be able to say "Inherited — Levels"
   * rather than "Levels", otherwise an Admin cannot tell a deliberate override
   * from a default they never chose.
   */
  source: AcademicSystemSource;
  universityId: string | null;
  facultyId: string | null;
  /** The university's own default, kept so the UI can show what it inherited. */
  universityDefault: AcademicStructureKind | null;
  /** The college's stored override, or null when it inherits. */
  facultyOverride: AcademicStructureKind | null;
}

/** The raw columns this reads. Named so it cannot be confused with the result. */
export interface AcademicSystemInputs {
  facultyOverride?: AcademicStructureKind | null;
  universityDefault?: AcademicStructureKind | null;
  universityId?: string | null;
  facultyId?: string | null;
}

/**
 * Resolves the effective system from the two stored values.
 *
 * Pure, so every caller shares one implementation and the business rule can be
 * tested directly without a database. `CatalogService.resolveAcademicSystem`
 * loads the rows and delegates here.
 *
 * `universityDefault` is required to be a real value. When it is missing the
 * resolution is refused rather than guessed: silently defaulting to YEAR would
 * hand a level-based college its students' year list mislabelled as years, and
 * the mistake would be invisible until someone read the data. A university with
 * no default is a configuration error, and the caller turns it into one.
 */
export function resolveAcademicSystem(
  inputs: AcademicSystemInputs,
): AcademicSystemResolution {
  const { facultyOverride = null, universityDefault = null } = inputs;
  const universityId = inputs.universityId ?? null;
  const facultyId = inputs.facultyId ?? null;

  // An override wins, and it wins even if it happens to equal the default —
  // the stored value is the Admin's decision and is reported as one. (The
  // database additionally refuses to STORE a redundant override; this function
  // stays tolerant so a row written before that trigger existed is still
  // reported as the explicit choice it is.)
  if (facultyOverride) {
    return {
      system: facultyOverride,
      source: 'COLLEGE_OVERRIDE',
      universityId,
      facultyId,
      universityDefault,
      facultyOverride,
    };
  }

  if (!universityDefault) {
    throw new AcademicSystemConfigurationError({
      universityId,
      facultyId,
    });
  }

  return {
    system: universityDefault,
    source: 'UNIVERSITY_DEFAULT',
    universityId,
    facultyId,
    universityDefault,
    facultyOverride: null,
  };
}

/**
 * Thrown when neither configuration point can produce an answer.
 *
 * A distinct class rather than a generic validation error because callers treat
 * it differently: the admin screen shows it as "fix the configuration", while
 * the student screen shows it as "this college is not set up yet". Both are
 * better than silently picking a system.
 */
export class AcademicSystemConfigurationError extends Error {
  readonly universityId: string | null;
  readonly facultyId: string | null;

  constructor(input: { universityId: string | null; facultyId: string | null }) {
    super(
      'no academic system is configured: the university has no default and the college has no override',
    );
    this.name = 'AcademicSystemConfigurationError';
    this.universityId = input.universityId;
    this.facultyId = input.facultyId;
  }
}

/**
 * The label vocabulary, in both languages the dashboard uses.
 *
 * Kept beside the resolver rather than in the UI so the meaning of a system is
 * defined once. `academicSystemLabel` is what an admin form and a student form
 * both render.
 */
export function academicSystemNoun(system: AcademicStructureKind): {
  en: string;
  ar: string;
} {
  return system === AcademicStructureKind.LEVEL
    ? { en: 'Level', ar: 'المستوى' }
    : { en: 'Year', ar: 'الفرقة' };
}

/** Plural, for "how many levels/years does this ladder have". */
export function academicSystemNounPlural(system: AcademicStructureKind): {
  en: string;
  ar: string;
} {
  return system === AcademicStructureKind.LEVEL
    ? { en: 'Levels', ar: 'المستويات' }
    : { en: 'Years', ar: 'الفروق' };
}

/**
 * The full system name, for a dropdown that must not read as ambiguous.
 *
 * "Year-based" on its own could be mistaken for a calendar year, and "Type" was
 * the label that caused that confusion in the first place.
 */
export function academicSystemLabel(system: AcademicStructureKind): {
  en: string;
  ar: string;
} {
  return system === AcademicStructureKind.LEVEL
    ? { en: 'Level-based (نظام الليفلز)', ar: 'نظام الليفلز' }
    : { en: 'Year-based (نظام الفرق)', ar: 'نظام الفرق' };
}
