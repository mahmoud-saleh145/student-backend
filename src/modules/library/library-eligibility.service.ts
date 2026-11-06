import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ContentStatus, LibraryDepartmentScope, type Prisma } from '@prisma/client';

import type { LibraryConfig } from '../../config/configuration';
import { PrismaService, notDeleted } from '../../database/prisma.service';

/**
 * Who may see a Library material — the academic half of Library authorization.
 *
 * ── The rule (approved F2/F5) ───────────────────────────────────────────────
 *
 * A student sees a material when ALL of these hold, read from the student's own
 * server-side profile and never from anything the client sends:
 *
 *   • the material's university is the student's university;
 *   • the material's faculty is the student's faculty;
 *   • the material is faculty-wide (`FACULTY`), or it is department-scoped and
 *     links the student's department.
 *
 * Academic year/level is NOT part of it: it is a browsing filter only.
 *
 * ── Fail closed ─────────────────────────────────────────────────────────────
 *
 * Unlike courses, a null never means "everyone". No profile, a profile without
 * a university or faculty, or a material without one, matches nothing. A
 * `DEPARTMENTS` material with no links matches nobody. Academic enforcement is
 * unconditional; nothing switches it off.
 *
 * ── Ownership is separate ───────────────────────────────────────────────────
 *
 * Owning a part (an UNREVOKED entitlement) is the read-only exception that lets
 * an owner keep seeing a material they are no longer in scope for. It never
 * makes anything purchasable and never covers publication or security checks.
 *
 * The rule itself is in pure functions so the edge-liveness probe
 * (playback.service.ts) applies exactly the same logic without importing this
 * module.
 */

export interface StudentScope {
  universityId: string | null;
  facultyId: string | null;
  departmentId: string | null;
}

export interface MaterialAudience {
  universityId: string | null;
  facultyId: string | null;
  departmentScope: LibraryDepartmentScope;
  /** Linked department ids (only meaningful for `DEPARTMENTS`). */
  departmentIds: readonly string[];
}

/** A department id that can never exist, for "student has no department". */
const NO_DEPARTMENT = '__no_department__';

/** Published, active, not deleted — the publication half of visibility. */
export const PUBLISHED_MATERIAL: Prisma.LibraryMaterialWhereInput = Object.freeze({
  ...notDeleted,
  isActive: true,
  status: ContentStatus.PUBLISHED,
}) as Prisma.LibraryMaterialWhereInput;

export function isPublished(row: {
  status: ContentStatus;
  isActive: boolean;
  deletedAt: Date | null;
}): boolean {
  return row.deletedAt === null && row.isActive && row.status === ContentStatus.PUBLISHED;
}

/** The SQL form of the academic rule, for list queries. */
export function academicMaterialWhere(
  scope: StudentScope | null,
): Prisma.LibraryMaterialWhereInput {
  if (!scope?.universityId || !scope.facultyId) {
    // Matches no row — never `{}`, which would match every row.
    return { id: { in: [] } };
  }
  return {
    universityId: scope.universityId,
    facultyId: scope.facultyId,
    OR: [
      { departmentScope: LibraryDepartmentScope.FACULTY },
      {
        departmentScope: LibraryDepartmentScope.DEPARTMENTS,
        departments: { some: { departmentId: scope.departmentId ?? NO_DEPARTMENT } },
      },
    ],
  };
}

/** The in-memory form of the same rule, for one already-loaded material. */
export function isAcademicallyVisible(
  scope: StudentScope | null,
  material: MaterialAudience,
): boolean {
  if (!scope?.universityId || !scope.facultyId) return false;
  if (!material.universityId || !material.facultyId) return false;
  if (material.universityId !== scope.universityId) return false;
  if (material.facultyId !== scope.facultyId) return false;
  if (material.departmentScope === LibraryDepartmentScope.FACULTY) return true;
  if (!scope.departmentId) return false;
  return material.departmentIds.includes(scope.departmentId);
}

/** Selects what `isAcademicallyVisible` needs, for a `libraryMaterial` query. */
export const MATERIAL_AUDIENCE_SELECT = Object.freeze({
  universityId: true,
  facultyId: true,
  departmentScope: true,
  departments: { select: { departmentId: true } },
}) satisfies Prisma.LibraryMaterialSelect;

export function toAudience(row: {
  universityId: string | null;
  facultyId: string | null;
  departmentScope: LibraryDepartmentScope;
  departments: { departmentId: string }[];
}): MaterialAudience {
  return {
    universityId: row.universityId,
    facultyId: row.facultyId,
    departmentScope: row.departmentScope,
    // Defensive: a row loaded without the relation must read as "no links",
    // which fails closed for a DEPARTMENTS material.
    departmentIds: (row.departments ?? []).map((d) => d.departmentId),
  };
}

type EligibilityPrisma = Pick<PrismaService, 'studentProfile' | 'libraryEntitlement'> &
  Partial<Pick<PrismaService, 'libraryMaterial'>>;

/** The student's academic scope, from their own profile. Null if none. */
export async function loadStudentScope(
  prisma: Pick<PrismaService, 'studentProfile'>,
  userId: string,
): Promise<StudentScope | null> {
  const profile = await prisma.studentProfile.findUnique({
    where: { userId },
    select: { universityId: true, facultyId: true, departmentId: true },
  });
  return profile ?? null;
}

@Injectable()
export class LibraryEligibilityService {
  /**
   * `LIBRARY_STOREFRONT_ENABLED`, read once at boot (configuration.ts parses it
   * fail-closed). A field rather than a getter so tests can set it.
   */
  storefrontEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.storefrontEnabled =
      config.get<LibraryConfig>('library')?.storefrontEnabled === true;
  }

  scopeFor(
    userId: string,
    tx: Pick<PrismaService, 'studentProfile'> = this.prisma,
  ): Promise<StudentScope | null> {
    return loadStudentScope(tx, userId);
  }

  materialWhere(scope: StudentScope | null): Prisma.LibraryMaterialWhereInput {
    return academicMaterialWhere(scope);
  }

  isVisible(scope: StudentScope | null, material: MaterialAudience): boolean {
    return isAcademicallyVisible(scope, material);
  }

  /**
   * Does the student hold an UNREVOKED entitlement to any non-deleted part of
   * this material? The ownership exception — and nothing else — rests on this.
   */
  async ownsAnyPartOf(
    userId: string,
    materialId: string,
    tx: EligibilityPrisma = this.prisma,
  ): Promise<boolean> {
    const found = await tx.libraryEntitlement.findFirst({
      where: {
        userId,
        revokedAt: null,
        part: { materialId, ...notDeleted },
      },
      select: { id: true },
    });
    return found !== null;
  }
}
