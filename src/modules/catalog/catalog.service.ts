import { Injectable } from '@nestjs/common';
import { AuditAction, type Prisma, type UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { AuditService } from '../audit/audit.service';

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

  async departments(facultyId: string) {
    return this.redis.remember(
      `catalog:departments:${facultyId}`,
      CACHE_TTL_SECONDS,
      () =>
        this.prisma.department.findMany({
          where: { facultyId, isActive: true, ...notDeleted },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: { id: true, facultyId: true, name: true, nameAr: true },
        }),
    );
  }

  async academicYears() {
    return this.redis.remember('catalog:academic-years', CACHE_TTL_SECONDS, () =>
      this.prisma.academicYear.findMany({
        where: { isActive: true },
        orderBy: { order: 'asc' },
        select: { id: true, order: true, name: true, nameAr: true },
      }),
    );
  }

  /** One call for admin dashboards that need the whole tree. */
  async tree() {
    const universities = await this.prisma.university.findMany({
      where: notDeleted,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: {
        faculties: {
          where: notDeleted,
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          include: {
            departments: {
              where: notDeleted,
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
    data: { name: string; nameAr: string; code?: string; sortOrder?: number },
    actor: { id: string; role: UserRole },
  ) {
    const created = await this.prisma.university.create({ data });
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

  async updateUniversity(
    id: string,
    data: Prisma.UniversityUpdateInput,
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.university.findUnique({ where: { id } });
    if (!before) throw AppException.notFound('University', id);

    const updated = await this.prisma.university.update({ where: { id }, data });
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
    data: { facultyId: string; name: string; nameAr: string; sortOrder?: number },
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
    data: { name?: string; nameAr?: string; sortOrder?: number; isActive?: boolean },
    actor: { id: string; role: UserRole },
  ) {
    const before = await this.prisma.faculty.findFirst({ where: { id, ...notDeleted } });
    if (!before) throw AppException.notFound('Faculty', id);

    const updated = await this.prisma.faculty.update({ where: { id }, data });
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
    const before = await this.prisma.department.findFirst({ where: { id, ...notDeleted } });
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
    data: { order: number; name: string; nameAr: string },
    actor: { id: string; role: UserRole },
  ) {
    const created = await this.prisma.academicYear.create({ data });
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
  async deactivate(entity: CatalogEntity, id: string, actor: { id: string; role: UserRole }) {
    return this.setActive(entity, id, false, actor);
  }

  /** Puts a deactivated catalogue entity back into service. */
  async reactivate(entity: CatalogEntity, id: string, actor: { id: string; role: UserRole }) {
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
