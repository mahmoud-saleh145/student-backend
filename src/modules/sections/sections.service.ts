import { Injectable } from '@nestjs/common';
import { AuditAction, ContentStatus, type UserRole } from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { CoursesService } from '../courses/courses.service';

/**
 * Dynamic course structure.
 *
 * There is no fixed semester model anywhere in this service. A course has an
 * ordered list of sections whose titles are free text chosen at authoring
 * time — "Before Midterm", "Unit 3", "Part 4" are all just strings. The only
 * structural rule is that `sortOrder` is unique and contiguous within a
 * course, which `reorder()` maintains.
 */
@Injectable()
export class SectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly courses: CoursesService,
    private readonly audit: AuditService,
  ) {}

  async listForCourse(courseId: string) {
    return this.prisma.courseSection.findMany({
      where: { courseId, ...notDeleted },
      orderBy: { sortOrder: 'asc' },
      include: {
        _count: { select: { lessons: { where: { deletedAt: null } } } },
      },
    });
  }

  async create(
    courseId: string,
    input: {
      title: string;
      titleAr?: string;
      description?: string;
      sortOrder?: number;
      unlocksAt?: string;
      status?: ContentStatus;
    },
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'content');

    const section = await this.prisma.$transaction(async (tx) => {
      // Append by default. An explicit sortOrder shifts everything at or after
      // that position, so inserting "Midterm Revision" between two units does
      // not need a separate reorder call.
      const last = await tx.courseSection.findFirst({
        where: { courseId, ...notDeleted },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });

      const target = input.sortOrder ?? (last?.sortOrder ?? 0) + 1;

      if (input.sortOrder !== undefined) {
        // Two-phase shift: move the block out to negative space first, because
        // (courseId, sortOrder) is unique and a naive increment collides.
        await tx.$executeRaw`
          UPDATE course_sections
          SET "sortOrder" = -("sortOrder" + 1)
          WHERE "courseId" = ${courseId} AND "sortOrder" >= ${target} AND "deletedAt" IS NULL
        `;
        await tx.$executeRaw`
          UPDATE course_sections
          SET "sortOrder" = -"sortOrder"
          WHERE "courseId" = ${courseId} AND "sortOrder" < 0
        `;
      }

      return tx.courseSection.create({
        data: {
          courseId,
          title: input.title.trim(),
          titleAr: input.titleAr?.trim(),
          description: input.description?.trim(),
          sortOrder: target,
          status: input.status ?? ContentStatus.PUBLISHED,
          unlocksAt: input.unlocksAt ? new Date(input.unlocksAt) : null,
        },
      });
    });

    await this.courses.recountCourse(courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'course_section',
      entityId: section.id,
      after: { courseId, title: section.title, sortOrder: section.sortOrder },
    });

    return section;
  }

  async update(
    sectionId: string,
    input: {
      title?: string;
      titleAr?: string;
      description?: string;
      status?: ContentStatus;
      unlocksAt?: string | null;
    },
    actor: { id: string; role: UserRole },
  ) {
    const section = await this.requireSection(sectionId);
    await this.access.assertCanManageCourse(actor.id, actor.role, section.courseId, 'content');

    const updated = await this.prisma.courseSection.update({
      where: { id: sectionId },
      data: {
        title: input.title?.trim(),
        titleAr: input.titleAr?.trim(),
        description: input.description?.trim(),
        status: input.status,
        unlocksAt:
          input.unlocksAt === null
            ? null
            : input.unlocksAt
              ? new Date(input.unlocksAt)
              : undefined,
      },
    });

    if (input.status) await this.courses.recountCourse(section.courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'course_section',
      entityId: sectionId,
      before: { title: section.title, status: section.status },
      after: { title: updated.title, status: updated.status },
    });

    return updated;
  }

  /**
   * Reorders the whole course in one call.
   *
   * Takes the complete ordered id list rather than a move-one-item delta:
   * a drag-and-drop UI already knows the final order, and applying it as a
   * single set avoids the intermediate states where two sections briefly share
   * a position.
   */
  async reorder(
    courseId: string,
    sectionIds: string[],
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'content');

    const existing = await this.prisma.courseSection.findMany({
      where: { courseId, ...notDeleted },
      select: { id: true },
    });

    const existingIds = new Set(existing.map((s) => s.id));
    if (sectionIds.length !== existingIds.size || !sectionIds.every((id) => existingIds.has(id))) {
      throw AppException.validation({
        sectionIds: ['must contain exactly the current section ids of this course'],
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // Park everything in negative space so the unique constraint can't be
      // violated mid-update, then write the final positions.
      await tx.$executeRaw`
        UPDATE course_sections SET "sortOrder" = -"sortOrder" - 1000
        WHERE "courseId" = ${courseId} AND "deletedAt" IS NULL
      `;

      for (const [index, id] of sectionIds.entries()) {
        await tx.courseSection.update({
          where: { id },
          data: { sortOrder: index + 1 },
        });
      }
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'course',
      entityId: courseId,
      after: { reorderedSections: sectionIds },
    });

    return this.listForCourse(courseId);
  }

  /**
   * Soft delete. A section with lessons that students have watched is never
   * removed outright — watch history references those lessons.
   */
  async remove(sectionId: string, actor: { id: string; role: UserRole }) {
    const section = await this.requireSection(sectionId);
    await this.access.assertCanManageCourse(actor.id, actor.role, section.courseId, 'content');

    const watched = await this.prisma.watchProgress.count({
      where: { lesson: { sectionId } },
    });

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.courseSection.update({
        where: { id: sectionId },
        data: { deletedAt: now, status: ContentStatus.ARCHIVED },
      });
      await tx.lesson.updateMany({
        where: { sectionId, deletedAt: null },
        data: { deletedAt: now, status: ContentStatus.ARCHIVED },
      });

      // Close the gap so ordering stays contiguous.
      await tx.$executeRaw`
        UPDATE course_sections SET "sortOrder" = "sortOrder" - 1
        WHERE "courseId" = ${section.courseId}
          AND "sortOrder" > ${section.sortOrder}
          AND "deletedAt" IS NULL
      `;
    });

    await this.courses.recountCourse(section.courseId);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'course_section',
      entityId: sectionId,
      note: watched > 0 ? `Soft-deleted; ${watched} watch records preserved` : 'Soft-deleted',
    });

    return { ok: true, preservedWatchRecords: watched };
  }

  private async requireSection(sectionId: string) {
    const section = await this.prisma.courseSection.findFirst({
      where: { id: sectionId, ...notDeleted },
    });
    if (!section) throw AppException.notFound('Section', sectionId);
    return section;
  }
}
