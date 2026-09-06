import { Injectable } from '@nestjs/common';
import { ContentStatus, CourseStatus, EnrollmentState, type Prisma, UserRole } from '@prisma/client';

import { PrismaService, notDeleted } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CourseAccessService } from '../courses/course-access.service';
import { StorageService } from '../storage/storage.service';

export type SearchEntity = 'COURSE' | 'LESSON' | 'TEACHER' | 'ATTACHMENT';

export interface SearchResultItem {
  id: string;
  entity: SearchEntity;
  title: string;
  subtitle: string | null;
  thumbnailUrl: string | null;
  route: string;
  locked: boolean;
}

export interface SearchResultGroup {
  entity: SearchEntity;
  total: number;
  items: SearchResultItem[];
}

const MIN_QUERY_LENGTH = 2;
const PER_GROUP_LIMIT = 20;

/**
 * Search.
 *
 * Implemented with indexed ILIKE prefix/substring matching rather than
 * Postgres full-text search, deliberately:
 *
 *  - The corpus is course and lesson titles — short strings, tens of thousands
 *    of rows, not documents. FTS ranking buys little here.
 *  - The content is bilingual. A single tsvector configuration cannot stem
 *    both English and Arabic well, and `simple` degenerates to substring
 *    matching anyway — which is what this already is, without the complexity.
 *  - Arabic users routinely search with partial words and mixed scripts;
 *    substring matching handles that where stemming does not.
 *
 * When the catalogue outgrows this, the upgrade path is a pg_trgm GIN index on
 * the same columns — no query rewrite needed. That is noted in docs/.
 *
 * Locked results are RETURNED, not hidden: a student searching for a course
 * they have not joined should find it and be able to open the join screen.
 */
@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly storage: StorageService,
    private readonly redis: RedisService,
  ) {}

  async search(params: {
    q: string;
    entity?: SearchEntity;
    userId: string | null;
    role?: UserRole;
  }): Promise<SearchResultGroup[]> {
    const query = params.q.trim();
    if (query.length < MIN_QUERY_LENGTH) return [];

    const wanted: SearchEntity[] = params.entity
      ? [params.entity]
      : ['COURSE', 'LESSON', 'TEACHER'];

    const groups = await Promise.all(
      wanted.map((entity) => this.searchEntity(entity, query, params.userId)),
    );

    return groups.filter((g) => g.items.length > 0);
  }

  private async searchEntity(
    entity: SearchEntity,
    query: string,
    userId: string | null,
  ): Promise<SearchResultGroup> {
    switch (entity) {
      case 'COURSE':
        return this.searchCourses(query, userId);
      case 'LESSON':
        return this.searchLessons(query, userId);
      case 'TEACHER':
        return this.searchTeachers(query);
      case 'ATTACHMENT':
        return this.searchAttachments(query, userId);
      default:
        return { entity, total: 0, items: [] };
    }
  }

  private async searchCourses(query: string, userId: string | null): Promise<SearchResultGroup> {
    const where: Prisma.CourseWhereInput = {
      ...notDeleted,
      status: CourseStatus.PUBLISHED,
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { titleAr: { contains: query, mode: 'insensitive' } },
        { shortDescription: { contains: query, mode: 'insensitive' } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        take: PER_GROUP_LIMIT,
        orderBy: [{ studentCount: 'desc' }, { publishedAt: 'desc' }],
        select: {
          id: true,
          title: true,
          thumbnailKey: true,
          status: true,
          enrollmentMethods: true,
          teachers: {
            take: 1,
            orderBy: { isLead: 'desc' },
            select: { teacher: { select: { fullName: true } } },
          },
        },
      }),
      this.prisma.course.count({ where }),
    ]);

    const accessMap = await this.access.resolveMany(
      userId,
      rows.map((r) => ({
        id: r.id,
        status: r.status,
        enrollmentMethods: r.enrollmentMethods,
      })),
    );

    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        entity: 'COURSE' as const,
        title: row.title,
        subtitle: row.teachers[0]?.teacher.fullName ?? null,
        thumbnailUrl: await this.storage.publicAssetUrl(row.thumbnailKey),
        route: `/course/${row.id}`,
        locked: !accessMap.get(row.id)?.decision.canAccessContent,
      })),
    );

    return { entity: 'COURSE', total, items };
  }

  private async searchLessons(query: string, userId: string | null): Promise<SearchResultGroup> {
    const where: Prisma.LessonWhereInput = {
      ...notDeleted,
      status: ContentStatus.PUBLISHED,
      course: { status: CourseStatus.PUBLISHED, deletedAt: null },
      OR: [
        { title: { contains: query, mode: 'insensitive' } },
        { titleAr: { contains: query, mode: 'insensitive' } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.lesson.findMany({
        where,
        take: PER_GROUP_LIMIT,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          isPreview: true,
          courseId: true,
          course: {
            select: { id: true, title: true, status: true, enrollmentMethods: true },
          },
        },
      }),
      this.prisma.lesson.count({ where }),
    ]);

    const accessMap = await this.access.resolveMany(
      userId,
      rows.map((r) => ({
        id: r.course.id,
        status: r.course.status,
        enrollmentMethods: r.course.enrollmentMethods,
      })),
    );

    const items = rows.map((row) => ({
      id: row.id,
      entity: 'LESSON' as const,
      title: row.title,
      subtitle: row.course.title,
      thumbnailUrl: null,
      route: `/lesson/${row.id}`,
      locked:
        !row.isPreview && !accessMap.get(row.course.id)?.decision.canAccessContent,
    }));

    return { entity: 'LESSON', total, items };
  }

  private async searchTeachers(query: string): Promise<SearchResultGroup> {
    const where: Prisma.UserWhereInput = {
      role: UserRole.TEACHER,
      status: 'ACTIVE',
      ...notDeleted,
      teacherProfile: { isPublic: true },
      fullName: { contains: query, mode: 'insensitive' },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        take: PER_GROUP_LIMIT,
        orderBy: { fullName: 'asc' },
        select: {
          id: true,
          fullName: true,
          avatarUrl: true,
          teacherProfile: { select: { title: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      entity: 'TEACHER',
      total,
      items: rows.map((row) => ({
        id: row.id,
        entity: 'TEACHER' as const,
        title: row.fullName,
        subtitle: row.teacherProfile?.title ?? null,
        thumbnailUrl: row.avatarUrl,
        // Deep-links into the catalogue filtered by this teacher.
        route: `/courses?teacherId=${row.id}`,
        locked: false,
      })),
    };
  }

  private async searchAttachments(
    query: string,
    userId: string | null,
  ): Promise<SearchResultGroup> {
    // Materials are only searchable inside courses the student has joined —
    // unlike titles, a materials list is part of what they paid for.
    if (!userId) return { entity: 'ATTACHMENT', total: 0, items: [] };

    const enrolled = await this.prisma.enrollment.findMany({
      where: { userId, state: EnrollmentState.ACTIVE },
      select: { courseId: true },
    });

    if (enrolled.length === 0) return { entity: 'ATTACHMENT', total: 0, items: [] };

    const where: Prisma.AttachmentWhereInput = {
      ...notDeleted,
      courseId: { in: enrolled.map((e) => e.courseId) },
      title: { contains: query, mode: 'insensitive' },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.attachment.findMany({
        where,
        take: PER_GROUP_LIMIT,
        select: {
          id: true,
          title: true,
          kind: true,
          course: { select: { title: true } },
        },
      }),
      this.prisma.attachment.count({ where }),
    ]);

    return {
      entity: 'ATTACHMENT',
      total,
      items: rows.map((row) => ({
        id: row.id,
        entity: 'ATTACHMENT' as const,
        title: row.title,
        subtitle: row.course.title,
        thumbnailUrl: null,
        route: `/viewer/${row.id}`,
        locked: false,
      })),
    };
  }

  /**
   * Typeahead suggestions. Cached briefly because the same prefixes are typed
   * constantly and the result changes only when the catalogue does.
   */
  async suggestions(query: string): Promise<string[]> {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) return [];

    return this.redis.remember(`search:suggest:${trimmed.toLowerCase()}`, 300, async () => {
      const rows = await this.prisma.course.findMany({
        where: {
          ...notDeleted,
          status: CourseStatus.PUBLISHED,
          title: { contains: trimmed, mode: 'insensitive' },
        },
        take: 8,
        orderBy: { studentCount: 'desc' },
        select: { title: true },
      });

      return rows.map((r) => r.title);
    });
  }
}
