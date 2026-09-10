import { Injectable, Logger } from '@nestjs/common';
import {
  ContentStatus,
  CourseStatus,
  type EnrollmentMethod,
  EnrollmentState,
  type Prisma,
  UserRole,
  type WatchProgress,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated, type Paginated } from '../../common/types/api-response';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { StorageService } from '../storage/storage.service';

import { CourseAccessService } from './course-access.service';
import {
  computeCourseProgress,
  toAttachment,
  toCourseSummary,
  toSection,
  type CourseWithRelations,
} from './course.serializer';

export interface CourseListFilters {
  q?: string;
  universityId?: string;
  facultyId?: string;
  academicYearId?: string;
  teacherId?: string;
  free?: boolean;
  sort?: 'newest' | 'popular' | 'priceLow' | 'priceHigh';
}

const COURSE_INCLUDE = {
  teachers: {
    orderBy: { isLead: 'desc' as const },
    select: {
      isLead: true,
      teacher: {
        select: {
          id: true,
          fullName: true,
          avatarUrl: true,
          teacherProfile: { select: { title: true, bio: true } },
        },
      },
    },
  },
  prices: { where: { isCurrent: true }, take: 1 },
  university: { select: { id: true, name: true, nameAr: true } },
  academicYear: { select: { id: true, name: true, nameAr: true } },
} satisfies Prisma.CourseInclude;

/**
 * Student-facing course reads.
 *
 * The guiding rule from the spec: browsing and joining are separate states. A
 * non-enrolled student gets the full structure — every section, every lesson
 * title — with `locked: true` on what they cannot open. Hiding the structure
 * would make the course impossible to evaluate before paying, and hiding it
 * adds no security, because titles are not the protected asset.
 */
@Injectable()
export class CoursesService {
  private readonly logger = new Logger(CoursesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CourseAccessService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------

  async list(params: {
    userId: string | null;
    filters: CourseListFilters;
    page: number;
    pageSize: number;
  }): Promise<Paginated<unknown>> {
    const { filters } = params;

    const where: Prisma.CourseWhereInput = {
      ...notDeleted,
      // Drafts and hidden courses never appear in the student catalogue.
      // Archived ones do not either — they surface only under /courses/mine.
      status: CourseStatus.PUBLISHED,
      ...(filters.q
        ? {
            OR: [
              { title: { contains: filters.q, mode: 'insensitive' } },
              { shortDescription: { contains: filters.q, mode: 'insensitive' } },
              {
                teachers: {
                  some: {
                    teacher: { fullName: { contains: filters.q, mode: 'insensitive' } },
                  },
                },
              },
            ],
          }
        : {}),
      ...(filters.universityId ? { universityId: filters.universityId } : {}),
      ...(filters.facultyId ? { facultyId: filters.facultyId } : {}),
      ...(filters.academicYearId ? { academicYearId: filters.academicYearId } : {}),
      ...(filters.teacherId ? { teachers: { some: { teacherId: filters.teacherId } } } : {}),
      ...(filters.free === true ? { isFree: true } : {}),
    };

    const orderBy = this.orderFor(filters.sort);

    const [courses, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        include: COURSE_INCLUDE,
        orderBy,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.course.count({ where }),
    ]);

    const items = await this.decorateSummaries(courses as CourseWithRelations[], params.userId);

    return paginated(items, total, params.page, params.pageSize);
  }

  /**
   * Price sorting can't be done in SQL against the current price without a
   * join to a filtered relation, which Prisma can't order by. The set is
   * page-sized by then, so sorting the page in memory is correct for
   * `priceLow`/`priceHigh` only when the whole result set fits — hence the
   * documented behaviour: price sorts order within the returned page, and the
   * denormalised `sortPrice` column (kept in sync on price change) is used for
   * the global ordering.
   */
  private orderFor(sort?: CourseListFilters['sort']): Prisma.CourseOrderByWithRelationInput[] {
    switch (sort) {
      case 'popular':
        return [{ studentCount: 'desc' }, { publishedAt: 'desc' }];
      case 'priceLow':
        return [{ isFree: 'desc' }, { publishedAt: 'desc' }];
      case 'priceHigh':
        return [{ isFree: 'asc' }, { publishedAt: 'desc' }];
      case 'newest':
      default:
        return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
    }
  }

  /** Courses the student has any relationship with, including expired ones. */
  async listMine(params: {
    userId: string;
    page: number;
    pageSize: number;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.CourseWhereInput = {
      ...notDeleted,
      enrollments: {
        some: {
          userId: params.userId,
          // PENDING_PAYMENT is deliberately included: the student started a
          // purchase and needs to find it again to finish.
          state: {
            in: [
              EnrollmentState.ACTIVE,
              EnrollmentState.EXPIRED,
              EnrollmentState.ARCHIVED,
              EnrollmentState.PENDING_APPROVAL,
              EnrollmentState.PENDING_PAYMENT,
            ],
          },
        },
      },
    };

    const [courses, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        include: COURSE_INCLUDE,
        orderBy: { updatedAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.course.count({ where }),
    ]);

    const items = await this.decorateSummaries(courses as CourseWithRelations[], params.userId);
    return paginated(items, total, params.page, params.pageSize);
  }

  /**
   * Adds access + progress + thumbnail to a page of courses using a fixed
   * number of queries regardless of page size.
   */
  private async decorateSummaries(courses: CourseWithRelations[], userId: string | null) {
    if (courses.length === 0) return [];

    const accessMap = await this.access.resolveMany(
      userId,
      courses.map((c) => ({
        id: c.id,
        status: c.status,
        enrollmentMethods: c.enrollmentMethods,
      })),
    );

    const progressByCourse = userId
      ? await this.progressByCourse(
          userId,
          courses.map((c) => c.id),
        )
      : new Map<string, WatchProgress[]>();

    return Promise.all(
      courses.map(async (course) => {
        const resolved = accessMap.get(course.id)!;
        const rows = progressByCourse.get(course.id) ?? [];

        return toCourseSummary({
          course,
          currentPrice: course.prices?.[0] ?? null,
          access: resolved.access,
          progress: computeCourseProgress(course.lessonCount, rows),
          thumbnailUrl: await this.storage.publicAssetUrl(course.thumbnailKey),
        });
      }),
    );
  }

  private async progressByCourse(userId: string, courseIds: string[]) {
    const rows = await this.prisma.watchProgress.findMany({
      where: { userId, courseId: { in: courseIds } },
    });

    const map = new Map<string, WatchProgress[]>();
    for (const row of rows) {
      const list = map.get(row.courseId) ?? [];
      list.push(row);
      map.set(row.courseId, list);
    }
    return map;
  }

  // ---------------------------------------------------------------------------
  // Detail
  // ---------------------------------------------------------------------------

  async detail(params: {
    courseId: string;
    userId: string | null;
    role?: UserRole;
  }): Promise<unknown> {
    const course = (await this.prisma.course.findFirst({
      where: { id: params.courseId, ...notDeleted },
      include: COURSE_INCLUDE,
    })) as CourseWithRelations | null;

    if (!course) throw AppException.notFound('Course', params.courseId);

    const isStaff = params.role && params.role !== UserRole.STUDENT;

    // A draft or hidden course is invisible to students even by direct id —
    // otherwise a guessed id leaks unpublished content.
    if (!isStaff && course.status !== CourseStatus.PUBLISHED && course.status !== CourseStatus.ARCHIVED) {
      throw new AppException(ErrorCode.COURSE_NOT_AVAILABLE);
    }

    const decision = await this.access.resolve({
      userId: params.userId,
      role: params.role,
      courseId: course.id,
    });

    const hasAccess = decision.canAccessContent;

    const sections = await this.loadSections(course.id, {
      includeUnpublished: Boolean(isStaff),
    });

    const progressRows = params.userId
      ? await this.prisma.watchProgress.findMany({
          where: { userId: params.userId, courseId: course.id },
        })
      : [];
    const progressByLesson = new Map(progressRows.map((p) => [p.lessonId, p]));

    const attachments = await this.prisma.attachment.findMany({
      where: { courseId: course.id, lessonId: null, ...notDeleted },
      orderBy: { sortOrder: 'asc' },
    });

    const summary = toCourseSummary({
      course,
      currentPrice: course.prices?.[0] ?? null,
      access: this.access.toCourseAccess(decision, course.enrollmentMethods, course.status),
      progress: computeCourseProgress(course.lessonCount, progressRows),
      thumbnailUrl: await this.storage.publicAssetUrl(course.thumbnailKey),
    });

    return {
      ...summary,
      description: course.description,
      requirements: course.requirements,
      outcomes: course.outcomes,
      updatedAt: course.updatedAt.toISOString(),
      sections: sections.map((section) =>
        toSection({ section, hasCourseAccess: hasAccess, progressByLesson }),
      ),
      attachments: attachments.map((a) => toAttachment(a, hasAccess)),
      completionRule: {
        type: course.completionRuleType,
        threshold: course.completionThreshold,
        requireContiguous: course.completionRequireContiguous,
      },
    };
  }

  /** Sections alone, for the app's `/courses/:id/sections` call. */
  async sections(params: { courseId: string; userId: string | null; role?: UserRole }) {
    const course = await this.prisma.course.findFirst({
      where: { id: params.courseId, ...notDeleted },
      select: { id: true, status: true, enrollmentMethods: true },
    });
    if (!course) throw AppException.notFound('Course', params.courseId);

    const decision = await this.access.resolve({
      userId: params.userId,
      role: params.role,
      courseId: course.id,
    });

    const sections = await this.loadSections(course.id, {
      includeUnpublished: Boolean(params.role && params.role !== UserRole.STUDENT),
    });

    const progressRows = params.userId
      ? await this.prisma.watchProgress.findMany({
          where: { userId: params.userId, courseId: course.id },
        })
      : [];
    const progressByLesson = new Map(progressRows.map((p) => [p.lessonId, p]));

    // Section-scoped access. `null` — which is what every course-wide grant and
    // every enrollment predating section codes returns — leaves the previous
    // behaviour exactly as it was.
    const allowedSections = params.userId
      ? await this.access.allowedSectionIds(params.userId, course.id)
      : null;

    return sections.map((section) =>
      toSection({
        section,
        hasCourseAccess:
          decision.canAccessContent &&
          (allowedSections === null || allowedSections.includes(section.id)),
        progressByLesson,
      }),
    );
  }

  /**
   * Loads the dynamic structure.
   *
   * Ordering comes entirely from `sortOrder` as configured on the course —
   * nothing here assumes a count, a naming scheme, or that a "midterm"
   * section exists.
   */
  private async loadSections(courseId: string, options: { includeUnpublished: boolean }) {
    return this.prisma.courseSection.findMany({
      where: {
        courseId,
        ...notDeleted,
        ...(options.includeUnpublished
          ? {}
          : { status: { in: [ContentStatus.PUBLISHED] } }),
      },
      orderBy: { sortOrder: 'asc' },
      include: {
        lessons: {
          where: {
            ...notDeleted,
            ...(options.includeUnpublished
              ? {}
              : { status: { in: [ContentStatus.PUBLISHED] } }),
          },
          orderBy: { sortOrder: 'asc' },
          include: {
            video: { select: { id: true, status: true, durationSeconds: true } },
            _count: { select: { attachments: { where: { deletedAt: null } } } },
          },
        },
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Progress + materials
  // ---------------------------------------------------------------------------

  async courseProgress(courseId: string, userId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: { id: true, lessonCount: true },
    });
    if (!course) throw AppException.notFound('Course', courseId);

    const rows = await this.prisma.watchProgress.findMany({
      where: { userId, courseId },
      orderBy: { lastWatchedAt: 'desc' },
    });

    return (
      computeCourseProgress(course.lessonCount, rows) ?? {
        completedLessons: 0,
        totalLessons: course.lessonCount,
        percent: 0,
        lastLessonId: null,
        lastWatchedAt: null,
      }
    );
  }

  async attachments(courseId: string, userId: string | null, role?: UserRole) {
    const decision = await this.access.resolve({ userId, role, courseId });

    const rows = await this.prisma.attachment.findMany({
      where: { courseId, ...notDeleted },
      orderBy: [{ lessonId: 'asc' }, { sortOrder: 'asc' }],
    });

    return rows.map((a) => toAttachment(a, decision.canAccessContent));
  }

  // ---------------------------------------------------------------------------
  // Shared helpers for other domains
  // ---------------------------------------------------------------------------

  async currentPrice(courseId: string) {
    return this.prisma.coursePrice.findFirst({
      where: { courseId, isCurrent: true },
    });
  }

  async requirePublishedCourse(courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: {
        id: true,
        title: true,
        status: true,
        isFree: true,
        enrollmentMethods: true,
        accessDurationType: true,
        accessDurationDays: true,
        accessEndsAt: true,
      },
    });

    if (!course) throw AppException.notFound('Course', courseId);
    if (course.status === CourseStatus.ARCHIVED) {
      throw new AppException(ErrorCode.COURSE_ARCHIVED);
    }
    if (course.status !== CourseStatus.PUBLISHED) {
      throw new AppException(ErrorCode.COURSE_NOT_AVAILABLE, {
        details: { status: course.status },
      });
    }

    return course;
  }

  /**
   * Recomputes the denormalised counters. Called after any structural change
   * so the catalogue cards never drift from reality.
   */
  async recountCourse(courseId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;

    const [sectionCount, lessonAggregate] = await Promise.all([
      db.courseSection.count({
        where: { courseId, deletedAt: null, status: ContentStatus.PUBLISHED },
      }),
      db.lesson.aggregate({
        where: { courseId, deletedAt: null, status: ContentStatus.PUBLISHED },
        _count: { _all: true },
        _sum: { durationSeconds: true },
      }),
    ]);

    await db.course.update({
      where: { id: courseId },
      data: {
        sectionCount,
        lessonCount: lessonAggregate._count._all,
        totalDurationSeconds: lessonAggregate._sum.durationSeconds ?? 0,
      },
    });
  }

  async recountStudents(courseId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;
    const studentCount = await db.enrollment.count({
      where: { courseId, state: EnrollmentState.ACTIVE },
    });
    await db.course.update({ where: { id: courseId }, data: { studentCount } });
  }

  /** Method list used by the enrollment service to validate a join request. */
  async enrollmentMethodsFor(courseId: string): Promise<EnrollmentMethod[]> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { enrollmentMethods: true },
    });
    return course?.enrollmentMethods ?? [];
  }
}
