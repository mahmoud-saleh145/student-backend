import { Injectable } from '@nestjs/common';
import { AcademicStructureKind, AuditAction, type UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';

import {
  AcademicSystemConfigurationError,
  resolveAcademicSystem,
  type AcademicSystemResolution,
} from './academic-system';

/** Catalogue data changes a few times a year; cache it hard. */
const CACHE_TTL_SECONDS = 15 * 60;

/**
 * Academic structure.
 *
 * These four endpoints are hit by every registration screen before the student
 * has a token, so they are public and aggressively cached. Every mutation
 * busts the whole `catalog:*` namespace — the data is small and correctness
 * matters more than a few extra reads after an edit.
 */
/** The four rows the catalogue is made of. */
export type CatalogEntity = 'university' | 'faculty' | 'department' | 'academicYear';

/**
 * Which unit an academic structure belongs to. At most one field is set; all
 * three null means the platform-wide structure, which is the fallback every
 * unit inherits until it defines its own.
 */
export interface AcademicScope {
  universityId?: string | null;
  facultyId?: string | null;
  departmentId?: string | null;
}

/** The scopeKey of the structure every unit falls back to. */
export const PLATFORM_SCOPE_KEY = 'platform';

/**
 * Derives the unique key the database enforces one-structure-per-unit with.
 *
 * `scopeKey` exists because Postgres treats NULLs as distinct, so a UNIQUE
 * over the three nullable FKs would accept two platform-wide structures. This
 * function is the only place the key is built; the column is never written
 * from outside the service.
 */
export function academicScopeKey(scope: AcademicScope): string {
  if (scope.departmentId) return `department:${scope.departmentId}`;
  if (scope.facultyId) return `faculty:${scope.facultyId}`;
  if (scope.universityId) return `university:${scope.universityId}`;
  return PLATFORM_SCOPE_KEY;
}

/**
 * Rejects a scope naming more than one owner.
 *
 * A structure owned by both a faculty and a department has no meaning and no
 * representable `scopeKey`. The CHECK constraint in the migration is the
 * backstop; this is the error the Admin actually sees.
 */
export function assertSingleAcademicOwner(scope: AcademicScope): void {
  const owners = [scope.universityId, scope.facultyId, scope.departmentId].filter(
    (v) => v != null && v !== '',
  );
  if (owners.length > 1) {
    throw AppException.validation({
      scope: [
        'an academic structure belongs to one unit: a university, a faculty or a department',
      ],
    });
  }
}

@Injectable()
export class CatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads (public)
  // ---------------------------------------------------------------------------

  async universities() {
    return this.redis.remember('catalog:universities', CACHE_TTL_SECONDS, () =>
      this.prisma.university.findMany({
        where: { isActive: true, ...notDeleted },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, nameAr: true, logoUrl: true },
      }),
    );
  }

  async faculties(universityId: string) {
    return this.redis.remember(
      `catalog:faculties:${universityId}`,
      CACHE_TTL_SECONDS,
      () =>
        this.prisma.faculty.findMany({
          where: { universityId, isActive: true, ...notDeleted },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, universityId: true, name: true, nameAr: true },
        }),
    );
  }

  async departments(facultyId: string, studyType?: 'GENERAL' | 'PROGRAMS') {
    return this.redis.remember(
      `catalog:departments:${facultyId}:${studyType ?? 'all'}`,
      CACHE_TTL_SECONDS,
      () =>
        this.prisma.department.findMany({
          where: {
            facultyId,
            ...(studyType ? { studyType } : {}),
            isActive: true,
            ...notDeleted,
          },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            facultyId: true,
            studyType: true,
            name: true,
            nameAr: true,
          },
        }),
    );
  }

  /**
   * The year/level list a student picks from.
   *
   * With no scope this returns the platform-wide list, which is what every
   * registration screen showed before structures existed — so the endpoint's
   * old contract is unchanged for old callers. Passing a unit returns that
   * unit's own list, falling back up the hierarchy when it has none.
   */
  async academicYears(scope: AcademicScope = {}) {
    assertSingleAcademicOwner(scope);
    const cacheKey = `catalog:academic-years:${academicScopeKey(scope)}`;

    return this.redis.remember(cacheKey, CACHE_TTL_SECONDS, async () => {
      const structure = await this.resolveAcademicStructure(scope);
      if (!structure) return [];

      const entries = await this.prisma.academicYear.findMany({
        where: { structureId: structure.id, isActive: true },
        orderBy: { order: 'asc' },
        select: { id: true, order: true, name: true, nameAr: true },
      });

      // `kind` rides along so the UI can label the control "Year" or "Level"
      // without a second request and without guessing from the names.
      return entries.map((e) => ({ ...e, kind: structure.kind }));
    });
  }

  /**
   * The student's picker payload: the resolved system AND the entries.
   *
   * One endpoint rather than two, because the two answers must agree and the
   * student app has no way to reconcile them. It renders the label from
   * `academicSystem.system` and lists `academicYears`; a client that mixes the
   * two up shows a student "Level 000" under a "Which year are you in?" heading.
   *
   * `academicSystem` is null only when no system is configured at all, which the
   * UI shows as "this college is not set up yet" — an explicit state, not a
   * silent guess.
   *
   * `ladderMatchesSystem` reports whether the ladder that actually governs this
   * unit is expressed in the configured vocabulary. It is false after an
   * administrator changes a university's default without reconfiguring its
   * ladder — the rungs keep their old names, and nothing is renamed for them.
   *
   * `system` deliberately stays the CONFIGURED value even when it disagrees with
   * the ladder. An earlier version silently rewrote it to the ladder's kind,
   * which made the picker self-consistent and the configuration invisible: the
   * admin who changed the default saw a working screen and no warning. Reporting
   * the disagreement is what lets the admin screen tell them.
   */
  async academicSelection(scope: AcademicScope): Promise<{
    academicSystem: AcademicSystemResolution | null;
    academicYears: Awaited<ReturnType<CatalogService['academicYears']>>;
    /**
     * The vocabulary the governing ladder's own entries are written in.
     *
     * Null when there is no ladder at all. Clients use it to label the control
     * so the entries never appear under a heading that contradicts them.
     */
    ladderKind: AcademicStructureKind | null;
    /** False means the configuration and the ladder disagree. See above. */
    ladderMatchesSystem: boolean;
  }> {
    assertSingleAcademicOwner(scope);

    let academicSystem: AcademicSystemResolution | null = null;
    try {
      academicSystem = await this.resolveAcademicSystem(scope);
    } catch (error) {
      // A missing configuration must not take the whole picker down: the
      // entries may still be readable and the admin needs to see them to
      // diagnose the problem. The null says "no system", which is the signal
      // the UI turns into a clear message.
      if (!(error instanceof AppException)) throw error;
    }

    const academicYears = await this.academicYears(scope);
    const ladderKind = academicYears[0]?.kind ?? null;

    return {
      academicSystem,
      academicYears,
      ladderKind,
      // No ladder, or no configuration: nothing to disagree about.
      ladderMatchesSystem:
        academicSystem === null || ladderKind === null
          ? true
          : ladderKind === academicSystem.system,
    };
  }

  /**
   * Refuses a structure whose `kind` contradicts the college's configured system.
   *
   * The structure's `kind` says what its own entries are called; the college's
   * system says what that college uses. When an Admin sets up a LEVEL college
   * but attaches a YEAR ladder, the student would be shown "First Year" under a
   * levels question. Catching it at write time keeps the stored data honest
   * instead of relying on every reader to notice.
   */
  private async assertStructureKindMatchesSystem(
    scope: AcademicScope,
    kind: AcademicStructureKind,
  ): Promise<void> {
    // The platform-wide structure belongs to nobody, so there is no configured
    // system for it to contradict. It is the ladder every unit falls back to
    // before any of them has said anything, and refusing to create one would
    // leave a fresh install with nowhere to put its first year.
    if (!scope.universityId && !scope.facultyId && !scope.departmentId) return;

    let resolution: AcademicSystemResolution;
    try {
      resolution = await this.resolveAcademicSystem(scope);
    } catch (error) {
      // A unit whose system is not configured yet gets to choose its own kind.
      // The configuration error is real, but it is about the system, not about
      // this ladder: refusing here would deadlock a new unit into being
      // un-creatable — you cannot configure a system on a unit that has no
      // ladder yet, and you cannot create a ladder on a unit with no system.
      // The mismatch surfaces the moment the system is set, which is the first
      // moment it can be reported meaningfully.
      //
      // A unit that does not exist is the same situation from here: the
      // existence check belongs to the caller that actually has to write the
      // row, and it runs before this.
      if (error instanceof AcademicSystemConfigurationError) return;
      if (error instanceof AppException) return;
      throw error;
    }

    if (resolution.system === kind) return;

    throw AppException.validation({
      kind: [
        resolution.source === 'COLLEGE_OVERRIDE'
          ? `this college is configured to use ${
              resolution.system === AcademicStructureKind.LEVEL ? 'levels' : 'years'
            }, so its ladder must be a ${kind === AcademicStructureKind.LEVEL ? 'level' : 'year'} ladder`
          : `this university is configured to use ${
              resolution.system === AcademicStructureKind.LEVEL ? 'levels' : 'years'
            }, so its ladder must be a ${kind === AcademicStructureKind.LEVEL ? 'level' : 'year'} ladder`,
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // Academic structures
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Academic system (YEAR vs LEVEL)
  // ---------------------------------------------------------------------------

  /**
   * The one resolver for "which system does this college use".
   *
   * Loads the two configuration points and hands them to the pure rule in
   * `academic-system.ts`. Every caller in the codebase goes through here, so the
   * admin screen, the student picker and the registration validator cannot
   * disagree about a college.
   *
   * Accepts a department scope as a convenience — a student picks a department
   * long before they know which college it belongs to, and a department's
   * system is its college's system. Departments do not override anything.
   */
  async resolveAcademicSystem(scope: AcademicScope): Promise<AcademicSystemResolution> {
    assertSingleAcademicOwner(scope);

    if (scope.departmentId) {
      const department = await this.prisma.department.findUnique({
        where: { id: scope.departmentId },
        select: {
          facultyId: true,
          faculty: {
            select: {
              id: true,
              academicSystemOverride: true,
              university: { select: { id: true, defaultAcademicSystem: true } },
            },
          },
        },
      });
      if (!department) throw AppException.notFound('department', scope.departmentId);

      return this.resolveAcademicSystemForFaculty({
        facultyId: department.faculty.id,
        facultyOverride: department.faculty.academicSystemOverride,
        universityId: department.faculty.university.id,
        universityDefault: department.faculty.university.defaultAcademicSystem,
      });
    }

    if (scope.facultyId) {
      const faculty = await this.prisma.faculty.findUnique({
        where: { id: scope.facultyId },
        select: {
          id: true,
          academicSystemOverride: true,
          university: { select: { id: true, defaultAcademicSystem: true } },
        },
      });
      if (!faculty) throw AppException.notFound('faculty', scope.facultyId);

      return this.resolveAcademicSystemForFaculty({
        facultyId: faculty.id,
        facultyOverride: faculty.academicSystemOverride,
        universityId: faculty.university.id,
        universityDefault: faculty.university.defaultAcademicSystem,
      });
    }

    if (scope.universityId) {
      // A university has no override of its own, so this is the default by
      // definition. The university scope exists for the admin screen, which asks
      // "what is this university's default?" directly.
      const university = await this.prisma.university.findUnique({
        where: { id: scope.universityId },
        select: { id: true, defaultAcademicSystem: true },
      });
      if (!university) throw AppException.notFound('university', scope.universityId);

      return resolveAcademicSystem({
        universityId: university.id,
        facultyId: null,
        facultyOverride: null,
        universityDefault: university.defaultAcademicSystem,
      });
    }

    // The platform fallback. There is no university to inherit from, so this is
    // only reachable by a caller that asked for no scope at all.
    throw new AcademicSystemConfigurationError({ universityId: null, facultyId: null });
  }

  /**
   * The faculty branch, shared by the faculty and department scopes.
   *
   * Translates the configuration error into an `AppException` carrying the
   * offending ids, so an Admin gets a field error naming the unit to fix rather
   * than a 500.
   */
  private resolveAcademicSystemForFaculty(input: {
    facultyId: string;
    facultyOverride: AcademicStructureKind | null;
    universityId: string;
    universityDefault: AcademicStructureKind | null;
  }): AcademicSystemResolution {
    try {
      return resolveAcademicSystem({
        facultyId: input.facultyId,
        facultyOverride: input.facultyOverride,
        universityId: input.universityId,
        universityDefault: input.universityDefault,
      });
    } catch (error) {
      if (error instanceof AcademicSystemConfigurationError) {
        throw AppException.validation(
          {
            academicSystem: [
              'no academic system is configured for this college: set its university default, or set an override on the college',
            ],
          },
          'Academic structure is not configured',
        );
      }
      throw error;
    }
  }

  /**
   * Department ladders take precedence so preparatory years and program levels
   * remain separate. Otherwise use the faculty override, then the owning
   * faculty, university and platform ladder in that order.
   *
   * NOTE: this answers "which LADDER supplies the entries", which is a separate
   * question from `resolveAcademicSystem` ("whether that ladder is expressed in
   * years or in levels"). They are kept apart on purpose — see
   * `assertStructureKindMatchesSystem`.
   */
  async resolveAcademicStructure(scope: AcademicScope) {
    assertSingleAcademicOwner(scope);

    const candidates: string[] = [];
    /** The faculty whose override applies, if any. */
    let overrideFacultyId: string | null = null;

    if (scope.departmentId) {
      candidates.push(`department:${scope.departmentId}`);
      const dept = await this.prisma.department.findUnique({
        where: { id: scope.departmentId },
        select: { facultyId: true, faculty: { select: { universityId: true } } },
      });
      if (dept) {
        // A department inherits its faculty's override as it inherits
        // everything else from the faculty.
        overrideFacultyId = dept.facultyId;
        candidates.push(`faculty:${dept.facultyId}`);
        candidates.push(`university:${dept.faculty.universityId}`);
      }
    } else if (scope.facultyId) {
      overrideFacultyId = scope.facultyId;
      candidates.push(`faculty:${scope.facultyId}`);
      const faculty = await this.prisma.faculty.findUnique({
        where: { id: scope.facultyId },
        select: { universityId: true },
      });
      if (faculty) candidates.push(`university:${faculty.universityId}`);
    } else if (scope.universityId) {
      candidates.push(`university:${scope.universityId}`);
    }

    candidates.push(PLATFORM_SCOPE_KEY);

    // One query, then pick in precedence order — cheaper than up to four
    // round trips, and the list is tiny.
    //
    // Ordered oldest-first so that when several platform-wide structures exist
    // the fallback is the default ladder created by the migration, not whichever
    // row Postgres happened to return. Without this the inherited list could
    // change between two identical requests.
    const found = await this.prisma.academicStructure.findMany({
      where: { scopeKey: { in: candidates }, isActive: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, kind: true, scopeKey: true },
    });

    const departmentStructure = scope.departmentId
      ? found.find((f) => f.scopeKey === `department:${scope.departmentId}`)
      : undefined;
    if (departmentStructure) return departmentStructure;

    if (overrideFacultyId) {
      const override = await this.prisma.academicStructureFaculty.findUnique({
        where: { facultyId: overrideFacultyId },
        select: {
          structure: { select: { id: true, kind: true, scopeKey: true, isActive: true } },
        },
      });
      // A deactivated structure is not a valid answer — the faculty falls back
      // to inheritance rather than being left with an empty year list.
      if (override?.structure.isActive) {
        const { isActive: _isActive, ...structure } = override.structure;
        return structure;
      }
    }

    for (const key of candidates) {
      const hit = found.find((f) => f.scopeKey === key);
      if (hit) return hit;
    }
    return null;
  }

  /** Every structure with its entries. Admin view. */
  async academicStructures() {
    return this.prisma.academicStructure.findMany({
      // Several platform-wide structures can exist, so they share a scopeKey.
      // createdAt/id keep them in a stable order instead of an arbitrary one.
      orderBy: [{ scopeKey: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        kind: true,
        scopeKey: true,
        isActive: true,
        universityId: true,
        facultyId: true,
        departmentId: true,
        university: { select: { id: true, name: true, nameAr: true } },
        faculty: { select: { id: true, name: true, nameAr: true } },
        department: { select: { id: true, name: true, nameAr: true } },
        entries: {
          orderBy: { order: 'asc' },
          select: { id: true, order: true, name: true, nameAr: true, isActive: true },
        },
        // The faculties pinned to this ladder. The faculty's own university
        // rides along because an override may name a faculty from a different
        // university than the one that owns the structure — without it the
        // admin screen would show two identically-named colleges and no way to
        // tell them apart.
        facultyOverrides: {
          orderBy: { createdAt: 'asc' },
          select: {
            facultyId: true,
            faculty: {
              select: {
                id: true,
                name: true,
                nameAr: true,
                universityId: true,
                university: { select: { id: true, name: true, nameAr: true } },
              },
            },
          },
        },
      },
    });
  }

  /**
   * Replaces the set of faculties explicitly pinned to one structure.
   *
   * Deliberately NOT restricted to faculties of the structure's own university:
   * pinning University A's college to University B's ladder is the whole point
   * of the feature.
   *
   * A faculty already pinned elsewhere is MOVED here rather than rejected.
   * `facultyId` is unique platform-wide, so it can only point at one ladder,
   * and refusing would force the Admin to go and unpin it from the other
   * structure first for no benefit. The audit row records the before and after
   * sets, so the move is traceable.
   */
  async setStructureFacultyOverrides(
    structureId: string,
    facultyIds: string[],
    actor: { id: string; role: UserRole },
  ) {
    const structure = await this.prisma.academicStructure.findUnique({
      where: { id: structureId },
      select: { id: true, facultyOverrides: { select: { facultyId: true } } },
    });
    if (!structure) throw AppException.notFound('academic structure');

    const wanted = [
      ...new Set(facultyIds.filter((id) => typeof id === 'string' && id !== '')),
    ];

    // Every id must name a live faculty. Checked in one query so a typo is a
    // field error rather than a foreign-key violation surfaced as a 500.
    if (wanted.length > 0) {
      const existing = await this.prisma.faculty.findMany({
        where: { id: { in: wanted }, ...notDeleted },
        select: { id: true },
      });
      if (existing.length !== wanted.length) {
        const found = new Set(existing.map((f) => f.id));
        throw AppException.validation({
          facultyIds: [
            `unknown or deleted faculty: ${wanted.filter((id) => !found.has(id)).join(', ')}`,
          ],
        });
      }
    }

    const before = structure.facultyOverrides.map((o) => o.facultyId).sort();

    await this.prisma.$transaction([
      // 1. Drop this structure's rows for faculties no longer wanted. Written
      //    as an explicit where rather than `notIn: []`, whose meaning for an
      //    empty array is a Prisma implementation detail: with nothing wanted
      //    this must clear the structure's whole set.
      this.prisma.academicStructureFaculty.deleteMany({
        where:
          wanted.length > 0
            ? { structureId, facultyId: { notIn: wanted } }
            : { structureId },
      }),
      // 2. Release the wanted faculties from whichever structure holds them —
      //    including this one, so the insert below is unconditional and the
      //    unique index can never be hit.
      this.prisma.academicStructureFaculty.deleteMany({
        where: { facultyId: { in: wanted } },
      }),
      this.prisma.academicStructureFaculty.createMany({
        data: wanted.map((facultyId) => ({ structureId, facultyId })),
      }),
    ]);

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'academic_structure',
      entityId: structureId,
      before: { facultyOverrides: before },
      after: { facultyOverrides: [...wanted].sort() },
    });

    return { id: structureId, facultyIds: wanted };
  }

  /**
   * A department's ladder must be expressed in its COLLEGE's system.
   *
   * This used to be `studyType === 'PROGRAMS' ? LEVEL : YEAR`, which made the
   * academic progression system a consequence of what a department is called.
   * That is the assumption the product explicitly rules out: a programme
   * department inside a year-based college must show years, and a general
   * department inside a level-based college must show levels.
   *
   * `studyType` survives as descriptive metadata for the admin UI and for course
   * targeting; it just no longer decides this.
   */
  private async assertDepartmentStructureKind(
    departmentId: string,
    kind: AcademicStructureKind,
  ): Promise<void> {
    const department = await this.prisma.department.findUnique({
      where: { id: departmentId },
      select: { id: true },
    });
    if (!department) throw AppException.notFound('department');
    await this.assertStructureKindMatchesSystem({ departmentId }, kind);
  }

  async createAcademicStructure(
    input: { kind: AcademicStructureKind } & AcademicScope,
    actor: { id: string; role: UserRole },
  ) {
    assertSingleAcademicOwner(input);
    const scopeKey = academicScopeKey(input);

    // Scoped units still get exactly one structure: a second ladder for the
    // same faculty is a mistake, because nothing would say which one governs.
    // Checked before the insert so the Admin gets a field error rather than a
    // unique-violation surfaced as a 500. The partial unique index still has
    // the last word if two Admins race.
    //
    // The platform scope is deliberately NOT checked. Several platform-wide
    // structures may coexist (a YEAR ladder and a LEVEL ladder, or a second
    // default alongside the first), which is why the index in the
    // allow_multiple_platform_academic_structures migration exempts 'platform'.
    if (scopeKey !== PLATFORM_SCOPE_KEY) {
      const existing = await this.prisma.academicStructure.findFirst({
        where: { scopeKey },
        select: { id: true },
      });
      if (existing) {
        throw AppException.validation({
          scope: ['this unit already has an academic structure; edit that one instead'],
        });
      }
    }

    if (input.departmentId)
      await this.assertDepartmentStructureKind(input.departmentId, input.kind);
    else await this.assertStructureKindMatchesSystem(input, input.kind);

    const created = await this.prisma.academicStructure.create({
      data: {
        kind: input.kind,
        scopeKey,
        universityId: input.universityId ?? null,
        facultyId: input.facultyId ?? null,
        departmentId: input.departmentId ?? null,
      },
    });

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'academic_structure',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  async updateAcademicStructure(
    id: string,
    data: { kind?: AcademicStructureKind; isActive?: boolean },
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.academicStructure.findUnique({ where: { id } });
    if (!before) throw AppException.notFound('academic structure');
    if (data.kind) {
      if (before.departmentId)
        await this.assertDepartmentStructureKind(before.departmentId, data.kind);
      else await this.assertStructureKindMatchesSystem(before, data.kind);
    }

    const updated = await this.prisma.academicStructure.update({ where: { id }, data });

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'academic_structure',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  /**
   * Defines a structure's rungs in one write: how many, and what they are
   * called. This is the endpoint that makes the count configurable — there is
   * no fixed four anywhere.
   *
   * Entries are matched by `order`, so renaming "Third Year" keeps every
   * student and course already filed under it. An entry the Admin removes is
   * DEACTIVATED rather than deleted, because students and courses point at it
   * and deleting the row would either fail on the foreign key or strip their
   * academic placement. Reappearing at the same order reactivates it.
   */
  async replaceStructureEntries(
    structureId: string,
    entries: { order: number; name: string; nameAr: string }[],
    actor: { id: string; role: UserRole },
  ) {
    const structure = await this.prisma.academicStructure.findUnique({
      where: { id: structureId },
      select: { id: true, entries: { select: { id: true, order: true } } },
    });
    if (!structure) throw AppException.notFound('academic structure');

    const orders = entries.map((e) => e.order);
    if (new Set(orders).size !== orders.length) {
      throw AppException.validation({ entries: ['two entries share the same order'] });
    }
    if (orders.some((o) => !Number.isInteger(o) || o < 1)) {
      throw AppException.validation({
        entries: ['order must be a whole number from 1 up'],
      });
    }

    const keep = new Set(orders);
    const retire = structure.entries.filter((e) => !keep.has(e.order)).map((e) => e.id);

    await this.prisma.$transaction([
      ...entries.map((e) =>
        this.prisma.academicYear.upsert({
          where: { structureId_order: { structureId, order: e.order } },
          update: { name: e.name, nameAr: e.nameAr, isActive: true },
          create: { structureId, order: e.order, name: e.name, nameAr: e.nameAr },
        }),
      ),
      this.prisma.academicYear.updateMany({
        where: { id: { in: retire } },
        data: { isActive: false },
      }),
    ]);

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'academic_structure_entries',
      entityId: structureId,
      before: { entries: structure.entries },
      after: { entries, deactivated: retire },
    });

    return this.prisma.academicYear.findMany({
      where: { structureId },
      orderBy: { order: 'asc' },
      select: { id: true, order: true, name: true, nameAr: true, isActive: true },
    });
  }

  /**
   * One call for admin dashboards that need the whole tree.
   *
   * Inactive rows are **included**, unlike every student-facing reader above.
   * Deactivating sets both `isActive: false` and `deletedAt`, so filtering
   * `notDeleted` here made a deactivated university vanish from the only
   * screen that could bring it back: the row disappeared, its "Reactivate"
   * menu item became unreachable, and the `Inactive` badge the structure
   * manager renders could never appear. This is the management view — it has
   * to show the things that need managing.
   *
   * Nothing student-facing reads this route (`@AdminOnly`), so no catalogue a
   * student sees widens as a result.
   */
  async tree() {
    const universities = await this.prisma.university.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        faculties: {
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            departments: {
              orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
            },
          },
        },
      },
    });

    const years = await this.prisma.academicYear.findMany({ orderBy: { order: 'asc' } });
    return { universities, academicYears: years };
  }

  // ---------------------------------------------------------------------------
  // Mutations (admin)
  // ---------------------------------------------------------------------------

  private async bust() {
    await this.redis.delByPattern('catalog:*');
  }

  async createUniversity(
    data: {
      name: string;
      nameAr: string;
      code?: string;
      sortOrder?: number;
      defaultAcademicSystem?: AcademicStructureKind;
    },
    actor: { id: string; role: UserRole },
  ) {
    const created = await this.prisma.university.create({
      data: {
        name: data.name,
        nameAr: data.nameAr,
        code: data.code,
        sortOrder: data.sortOrder,
        // Not written when absent: Prisma then applies the column default, and
        // the row stays a valid inheritable configuration.
        ...(data.defaultAcademicSystem
          ? { defaultAcademicSystem: data.defaultAcademicSystem }
          : {}),
      },
    });
    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'university',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  /**
   * Updates a university.
   *
   * Changing `defaultAcademicSystem` is a genuine inheritance event, not a
   * rename: every college that has no override follows the university straight
   * away, and every college that HAS one keeps what it had. Nothing is copied
   * anywhere, which is what makes the change reversible and what stops the next
   * university-wide change from being a no-op.
   *
   * A college whose override was recorded as the opposite system keeps working
   * untouched. A college whose stored override would become redundant is left
   * alone too — the database trigger only judges NEW or CHANGED override
   * values, precisely so that flipping a university's default does not fail on
   * a row that was legitimate a moment earlier. The admin screen surfaces the
   * now-redundant overrides so an Admin can clear them; nothing breaks in the
   * meantime.
   */
  async updateUniversity(
    id: string,
    data: {
      name?: string;
      nameAr?: string;
      logoUrl?: string;
      isActive?: boolean;
      sortOrder?: number;
      defaultAcademicSystem?: AcademicStructureKind;
    },
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.university.findUnique({ where: { id } });
    if (!before) throw AppException.notFound('University', id);

    const updated = await this.prisma.university.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.nameAr !== undefined ? { nameAr: data.nameAr } : {}),
        ...(data.logoUrl !== undefined ? { logoUrl: data.logoUrl } : {}),
        ...(data.isActive !== undefined ? { isActive: data.isActive } : {}),
        ...(data.sortOrder !== undefined ? { sortOrder: data.sortOrder } : {}),
        ...(data.defaultAcademicSystem !== undefined
          ? { defaultAcademicSystem: data.defaultAcademicSystem }
          : {}),
      },
    });

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'university',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  /**
   * Sets or clears a college's academic system override.
   *
   * `null` is a first-class value here, not "field omitted": it is how an Admin
   * returns a college to inheritance. Sending no field at all leaves the column
   * alone.
   *
   * A redundant override is refused with a field error. Storing YEAR on a
   * university that already defaults to YEAR records no decision, but it would
   * survive the next change of that default and then mean something nobody
   * asked for — so the honest instruction is to send null instead.
   */
  async setFacultyAcademicSystemOverride(
    facultyId: string,
    override: AcademicStructureKind | null,
    actor: { id: string; role: UserRole },
  ) {
    const faculty = await this.prisma.faculty.findFirst({
      where: { id: facultyId, ...notDeleted },
      select: {
        id: true,
        academicSystemOverride: true,
        university: { select: { id: true, defaultAcademicSystem: true } },
      },
    });
    if (!faculty) throw AppException.notFound('Faculty', facultyId);

    if (override && override === faculty.university.defaultAcademicSystem) {
      throw AppException.validation({
        academicSystemOverride: [
          `this college already inherits ${override} from its university; clear the override instead of storing the same value`,
        ],
      });
    }

    const updated = await this.prisma.faculty.update({
      where: { id: facultyId },
      data: { academicSystemOverride: override },
    });

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      /*
        UPDATE for both branches, deliberately.
        `AuditAction.RESTORE` means one specific thing in this file — it is the
        partner of `DELETE` for reactivating a soft-deleted row (see
        `setActive`), and it is already emitted for the same `faculty` entity.
        Reusing it to mean "cleared a field value" would put two unrelated events
        under one filter, so anyone auditing "which colleges were reactivated"
        would also be shown every override that was ever cleared.
        Clearing an override is a mutation of a live row, which is what UPDATE
        covers; the note already says which of the two it was.
      */
      action: AuditAction.UPDATE,
      entity: 'faculty',
      entityId: facultyId,
      before: { academicSystemOverride: faculty.academicSystemOverride },
      after: { academicSystemOverride: override },
      note: override
        ? 'College academic system override set'
        : 'College academic system override cleared — inherits university default',
    });

    // The effective system is the useful answer for a UI that just saved.
    return {
      id: updated.id,
      academicSystemOverride: updated.academicSystemOverride,
      academicSystem: await this.resolveAcademicSystem({ facultyId }),
    };
  }

  /**
   * The Academic Structure screen's data.
   *
   * Every university with its default system, every college with its effective
   * system AND whether that value is inherited or an override. The two are
   * reported separately on purpose: an Admin looking at a college must be able
   * to tell "Levels, inherited from Cairo University" from "Levels, set on this
   * college", because only the second one survives a change of the default.
   *
   * `redundantOverride` marks a college whose stored override now equals its
   * university's default — harmless, but stale, and worth clearing. The
   * database cannot reject it retroactively (that would fail legitimate data on
   * a default change), so it is reported instead.
   */
  async academicSystemOverview() {
    const [universities, faculties] = await Promise.all([
      this.prisma.university.findMany({
        where: { ...notDeleted },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          nameAr: true,
          isActive: true,
          defaultAcademicSystem: true,
          _count: { select: { faculties: { where: { ...notDeleted } } } },
        },
      }),
      this.prisma.faculty.findMany({
        where: { ...notDeleted },
        orderBy: [{ name: 'asc' }],
        select: {
          id: true,
          name: true,
          nameAr: true,
          isActive: true,
          universityId: true,
          academicSystemOverride: true,
          university: { select: { id: true, name: true, defaultAcademicSystem: true } },
        },
      }),
    ]);

    return {
      universities: universities.map((u) => ({
        id: u.id,
        name: u.name,
        nameAr: u.nameAr,
        isActive: u.isActive,
        defaultAcademicSystem: u.defaultAcademicSystem,
        collegeCount: u._count.faculties,
      })),
      faculties: await Promise.all(
        faculties.map(async (f) => {
          const resolution = resolveAcademicSystem({
            facultyId: f.id,
            facultyOverride: f.academicSystemOverride,
            universityId: f.universityId,
            universityDefault: f.university.defaultAcademicSystem,
          });

          /*
            The vocabulary the college's ACTUAL ladder is written in, resolved
            through the same precedence as `resolveAcademicStructure` — including
            the explicit pin, which is how a college's ladder very often arrives.

            The admin screen needs this to be honest about the consequence of
            changing a university's default: the ladder does not move with the
            configuration, so a college can legitimately be configured for levels
            while its entries are still named "First Year". Reporting the
            disagreement is the whole point; hiding it would make the screen
            claim a change completed work that has not been done.
          */
          const structure = await this.resolveAcademicStructure({ facultyId: f.id });

          return {
            id: f.id,
            name: f.name,
            nameAr: f.nameAr,
            isActive: f.isActive,
            universityId: f.universityId,
            universityName: f.university.name,
            academicSystemOverride: f.academicSystemOverride,
            effectiveAcademicSystem: resolution.system,
            inherited: resolution.source === 'UNIVERSITY_DEFAULT',
            /** The governing ladder's vocabulary, or null when it has none. */
            ladderKind: structure?.kind ?? null,
            /** True when the ladder's vocabulary disagrees with the configuration. */
            ladderMismatch: structure !== null && structure.kind !== resolution.system,
            redundantOverride:
              f.academicSystemOverride !== null &&
              f.academicSystemOverride === f.university.defaultAcademicSystem,
          };
        }),
      ),
    };
  }

  async createFaculty(
    data: { universityId: string; name: string; nameAr: string; sortOrder?: number },
    actor: { id: string; role: UserRole },
  ) {
    const university = await this.prisma.university.findFirst({
      where: { id: data.universityId, ...notDeleted },
    });
    if (!university) throw AppException.notFound('University', data.universityId);

    const created = await this.prisma.faculty.create({ data });
    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'faculty',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  async createDepartment(
    data: {
      facultyId: string;
      studyType?: 'GENERAL' | 'PROGRAMS';
      name: string;
      nameAr: string;
      sortOrder?: number;
    },
    actor: { id: string; role: UserRole },
  ) {
    const faculty = await this.prisma.faculty.findFirst({
      where: { id: data.facultyId, ...notDeleted },
    });
    if (!faculty) throw AppException.notFound('Faculty', data.facultyId);

    const created = await this.prisma.department.create({ data });
    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'department',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  /**
   * Renames a faculty. Reparenting is deliberately not offered.
   *
   * A faculty's university is the spine of every student profile and course
   * filed under it; moving one would silently relocate all of them. If a
   * college genuinely belongs elsewhere, that is a data migration, not an
   * inline edit.
   */
  async updateFaculty(
    id: string,
    data: {
      name?: string;
      nameAr?: string;
      sortOrder?: number;
      isActive?: boolean;
      academicSystemOverride?: AcademicStructureKind | null;
    },
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.faculty.findFirst({ where: { id, ...notDeleted } });
    if (!before) throw AppException.notFound('Faculty', id);

    // Split out so the "omitted means leave alone, null means clear" distinction
    // survives. Spreading `{ academicSystemOverride: undefined }` into Prisma
    // would be treated as an explicit write by some clients and ignored by
    // others, which is exactly the ambiguity this endpoint must not have.
    const { academicSystemOverride, ...rest } = data;

    const updated = await this.prisma.faculty.update({
      where: { id },
      data: {
        ...(rest.name !== undefined ? { name: rest.name } : {}),
        ...(rest.nameAr !== undefined ? { nameAr: rest.nameAr } : {}),
        ...(rest.sortOrder !== undefined ? { sortOrder: rest.sortOrder } : {}),
        ...(rest.isActive !== undefined ? { isActive: rest.isActive } : {}),
        ...(academicSystemOverride !== undefined ? { academicSystemOverride } : {}),
      },
    });
    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'faculty',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  /** Renames a department. Reparenting is not offered, for the same reason. */
  async updateDepartment(
    id: string,
    data: { name?: string; nameAr?: string; sortOrder?: number; isActive?: boolean },
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.department.findFirst({
      where: { id, ...notDeleted },
    });
    if (!before) throw AppException.notFound('Department', id);

    const updated = await this.prisma.department.update({ where: { id }, data });
    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'department',
      entityId: id,
      before,
      after: updated,
    });
    return updated;
  }

  async createAcademicYear(
    data: { order: number; name: string; nameAr: string; structureId?: string },
    actor: { id: string; role: UserRole },
  ) {
    // Omitting the structure means the platform-wide list, which is what this
    // endpoint has always written to. Keeping that default is what lets the
    // existing dashboard form keep working untouched.
    let structureId = data.structureId;
    if (!structureId) {
      const platform = await this.prisma.academicStructure.findFirst({
        where: { scopeKey: PLATFORM_SCOPE_KEY },
        // Several platform-wide structures may now exist, so 'platform' is no
        // longer a unique key. Ordering keeps this endpoint pointed at the
        // default ladder the migration created; picking an arbitrary row would
        // silently move the platform's year list between calls.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true },
      });
      if (!platform) {
        throw AppException.validation({
          structureId: ['no platform academic structure exists; create one first'],
        });
      }
      structureId = platform.id;
    }

    const created = await this.prisma.academicYear.create({
      data: {
        structureId,
        order: data.order,
        name: data.name,
        nameAr: data.nameAr,
      },
    });
    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'academic_year',
      entityId: created.id,
      after: created,
    });
    return created;
  }

  /**
   * How many rows hang off a catalogue entity.
   *
   * The confirmation dialog quotes these, because "deactivate this university"
   * is not a self-explanatory action when three colleges and two hundred
   * students are filed under it. Counting is cheap next to the surprise of
   * finding out afterwards.
   */
  async dependents(
    entity: CatalogEntity,
    id: string,
  ): Promise<{ children: number; students: number }> {
    switch (entity) {
      case 'university': {
        const [children, students] = await Promise.all([
          this.prisma.faculty.count({ where: { universityId: id, ...notDeleted } }),
          this.prisma.studentProfile.count({ where: { universityId: id } }),
        ]);
        return { children, students };
      }
      case 'faculty': {
        const [children, students] = await Promise.all([
          this.prisma.department.count({ where: { facultyId: id, ...notDeleted } }),
          this.prisma.studentProfile.count({ where: { facultyId: id } }),
        ]);
        return { children, students };
      }
      case 'department': {
        const students = await this.prisma.studentProfile.count({
          where: { departmentId: id },
        });
        return { children: 0, students };
      }
      case 'academicYear': {
        const students = await this.prisma.studentProfile.count({
          where: { academicYearId: id },
        });
        return { children: 0, students };
      }
    }
  }

  /**
   * Deactivation, not deletion: students reference these rows, and removing a
   * faculty would orphan every student filed under it.
   *
   * Reversible by design — `setActive(…, true)` clears `deletedAt` as well as
   * the flag, because the list queries filter on `deletedAt` and a row that
   * only regained `isActive` would stay invisible.
   */
  async deactivate(
    entity: CatalogEntity,
    id: string,
    actor: { id: string; role: UserRole },
  ) {
    return this.setActive(entity, id, false, actor);
  }

  /** Puts a deactivated catalogue entity back into service. */
  async reactivate(
    entity: CatalogEntity,
    id: string,
    actor: { id: string; role: UserRole },
  ) {
    return this.setActive(entity, id, true, actor);
  }

  private async setActive(
    entity: CatalogEntity,
    id: string,
    active: boolean,
    actor: { id: string; role: UserRole },
  ) {
    // `deletedAt` and `isActive` move together. Setting one without the other
    // is what produces a row that is active but filtered out of every list.
    const data = active
      ? { isActive: true, deletedAt: null }
      : { isActive: false, deletedAt: new Date() };

    switch (entity) {
      case 'university':
        await this.prisma.university.update({ where: { id }, data });
        break;
      case 'faculty':
        await this.prisma.faculty.update({ where: { id }, data });
        break;
      case 'department':
        await this.prisma.department.update({ where: { id }, data });
        break;
      case 'academicYear':
        // No `deletedAt` column on this table — the flag is the whole story.
        await this.prisma.academicYear.update({
          where: { id },
          data: { isActive: active },
        });
        break;
      default:
        // Unreachable through the controller, which validates the segment
        // first. Kept so that a future caller cannot reintroduce the silent
        // no-op this switch used to allow.
        throw AppException.validation({ entity: ['unknown catalogue entity'] });
    }

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: active ? AuditAction.RESTORE : AuditAction.DELETE,
      entity,
      entityId: id,
      note: active ? 'Reactivated' : 'Deactivated (soft)',
    });

    return { ok: true, id, isActive: active };
  }
}
