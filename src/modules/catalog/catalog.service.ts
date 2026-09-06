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
   * Deactivation, not deletion: students reference these rows, and removing a
   * faculty would orphan every student filed under it.
   */
  async deactivate(
    entity: 'university' | 'faculty' | 'department' | 'academicYear',
    id: string,
    actor: { id: string; role: UserRole },
  ) {
    const now = new Date();

    switch (entity) {
      case 'university':
        await this.prisma.university.update({
          where: { id },
          data: { isActive: false, deletedAt: now },
        });
        break;
      case 'faculty':
        await this.prisma.faculty.update({
          where: { id },
          data: { isActive: false, deletedAt: now },
        });
        break;
      case 'department':
        await this.prisma.department.update({
          where: { id },
          data: { isActive: false, deletedAt: now },
        });
        break;
      case 'academicYear':
        await this.prisma.academicYear.update({ where: { id }, data: { isActive: false } });
        break;
    }

    await this.bust();
    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity,
      entityId: id,
      note: 'Deactivated (soft)',
    });

    return { ok: true };
  }
}
