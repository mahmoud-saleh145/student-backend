import { Injectable, Logger } from '@nestjs/common';
import {
  AccountStatus,
  AuditAction,
  CourseStatus,
  type EnrollmentMethod,
  EnrollmentState,
  type Prisma,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { MONEY_TX_OPTIONS, PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { StorageService } from '../storage/storage.service';

import { CourseAccessService } from './course-access.service';
import { CoursesService } from './courses.service';

export interface CreateCourseInput {
  title: string;
  titleAr?: string;
  shortDescription?: string;
  description?: string;
  universityId?: string;
  facultyId?: string;
  academicYearId?: string;
  subjectId?: string;
  teacherIds: string[];
  leadTeacherId?: string;
  price?: number;
  currency?: string;
  isFree?: boolean;
  enrollmentMethods: EnrollmentMethod[];
  accessDurationType?: 'LIFETIME' | 'FIXED_DAYS' | 'UNTIL_DATE';
  accessDurationDays?: number;
  accessEndsAt?: string;
  requirements?: string[];
  outcomes?: string[];
  thumbnailKey?: string;
  completionRuleType?: 'WATCH_PERCENT' | 'WATCH_FULL' | 'MANUAL';
  completionThreshold?: number;
  completionRequireContiguous?: boolean;
  /** Optional initial structure, created in the same transaction. */
  sections?: { title: string; description?: string }[];
}

/**
 * Course authoring.
 *
 * Two invariants this service exists to protect:
 *
 *  1. **Price history is append-only.** A price change never mutates a row; it
 *     closes the current version and opens a new one. Payments point at the
 *     version they used, so changing a price from 100 to 150 leaves every past
 *     100 EGP transaction reading 100 EGP forever (spec §28, §71, §73).
 *
 *  2. **Archive is a state transition, not a delete.** Archiving flips a
 *     status, snapshots the counters into an ArchiveRecord, and leaves every
 *     payment, enrollment, watch event and audit row untouched. The schema
 *     enforces this too: financial tables reference courses with
 *     onDelete: Restrict.
 */
@Injectable()
export class CoursesAdminService {
  private readonly logger = new Logger(CoursesAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly courses: CoursesService,
    private readonly access: CourseAccessService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) { }

  // ---------------------------------------------------------------------------
  // Listing (staff)
  // ---------------------------------------------------------------------------

  async list(params: {
    actor: { id: string; role: UserRole };
    page: number;
    pageSize: number;
    q?: string;
    status?: CourseStatus;
    teacherId?: string;
    universityId?: string;
    facultyId?: string;
    academicYearId?: string;
    subjectId?: string;
    sort?: 'newest' | 'oldest' | 'title' | 'students' | 'price';
    order?: 'asc' | 'desc';
  }) {
    // A teacher only ever sees courses they are assigned to.
    const scopeIds =
      params.actor.role === UserRole.TEACHER
        ? await this.access.teacherCourseIds(params.actor.id)
        : null;

    const where: Prisma.CourseWhereInput = {
      ...notDeleted,
      ...(scopeIds ? { id: { in: scopeIds } } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.teacherId ? { teachers: { some: { teacherId: params.teacherId } } } : {}),
      ...(params.universityId ? { universityId: params.universityId } : {}),
      ...(params.facultyId ? { facultyId: params.facultyId } : {}),
      ...(params.academicYearId ? { academicYearId: params.academicYearId } : {}),
      ...(params.subjectId ? { subjectId: params.subjectId } : {}),
      ...(params.q ? { title: { contains: params.q, mode: 'insensitive' } } : {}),
    };

    // Sorting is server-side so a filtered page of 20 is genuinely the top 20
    // of the whole result set, not the top 20 of an arbitrary page.
    const direction: Prisma.SortOrder = params.order === 'asc' ? 'asc' : 'desc';
    const orderBy: Prisma.CourseOrderByWithRelationInput = (() => {
      switch (params.sort) {
        case 'oldest':
          return { createdAt: 'asc' };
        case 'title':
          return { title: params.order === 'desc' ? 'desc' : 'asc' };
        case 'students':
          return { studentCount: direction };
        case 'price':
          // Price lives in a versioned child table, so ordering by it is done
          // through the course's own creation order as a stable tiebreak; the
          // dashboard sorts the visible page by the resolved amount.
          return { createdAt: direction };
        case 'newest':
          return { createdAt: 'desc' };
        default:
          return { updatedAt: 'desc' };
      }
    })();

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.course.findMany({
        where,
        orderBy,
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          teachers: {
            select: {
              isLead: true,
              teacher: { select: { id: true, fullName: true } },
            },
          },
          prices: { where: { isCurrent: true }, take: 1 },
          university: { select: { id: true, name: true, nameAr: true } },
          faculty: { select: { id: true, name: true, nameAr: true } },
          academicYear: { select: { id: true, name: true, nameAr: true, order: true } },
          subject: { select: { id: true, name: true, nameAr: true } },
          _count: { select: { enrollments: true, sections: true, lessons: true } },
        },
      }),
      this.prisma.course.count({ where }),
    ]);

    const items = rows.map((course) => ({
      id: course.id,
      title: course.title,
      slug: course.slug,
      status: course.status,
      isFree: course.isFree,
      price: course.prices[0]
        ? { amount: Number(course.prices[0].amount), currency: course.prices[0].currency }
        : null,
      teachers: course.teachers.map((t) => ({
        id: t.teacher.id,
        fullName: t.teacher.fullName,
        isLead: t.isLead,
      })),
      counts: {
        enrollments: course._count.enrollments,
        sections: course._count.sections,
        lessons: course._count.lessons,
      },
      studentCount: course.studentCount,
      thumbnailKey: course.thumbnailKey,
      university: course.university,
      faculty: course.faculty,
      academicYear: course.academicYear,
      subject: course.subject,
      publishedAt: course.publishedAt?.toISOString() ?? null,
      archivedAt: course.archivedAt?.toISOString() ?? null,
      createdAt: course.createdAt.toISOString(),
      updatedAt: course.updatedAt.toISOString(),
    }));

    return paginated(items, total, params.page, params.pageSize);
  }

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  async create(input: CreateCourseInput, actor: { id: string; role: UserRole }) {
    if (input.teacherIds.length === 0) {
      throw AppException.validation({ teacherIds: ['at least one teacher is required'] });
    }

    // A teacher creating a course must include themselves, otherwise they'd
    // immediately lose access to what they just made.
    if (actor.role === UserRole.TEACHER && !input.teacherIds.includes(actor.id)) {
      input.teacherIds.push(actor.id);
    }

    await this.assertTeachersExist(input.teacherIds);

    const isFree = input.isFree ?? (input.price ?? 0) <= 0;
    if (!isFree && (input.price === undefined || input.price <= 0)) {
      throw AppException.validation({ price: ['a paid course requires a positive price'] });
    }
    if (input.enrollmentMethods.length === 0) {
      throw AppException.validation({
        enrollmentMethods: ['choose at least one way for students to join'],
      });
    }

    const slug = await this.uniqueSlug(input.title);
    const leadId = input.leadTeacherId ?? input.teacherIds[0]!;

    const course = await this.prisma.$transaction(async (tx) => {
      const created = await tx.course.create({
        data: {
          slug,
          title: input.title.trim(),
          titleAr: input.titleAr?.trim(),
          shortDescription: input.shortDescription?.trim() ?? '',
          description: input.description?.trim() ?? '',
          thumbnailKey: input.thumbnailKey,
          status: CourseStatus.DRAFT,
          universityId: input.universityId,
          facultyId: input.facultyId,
          academicYearId: input.academicYearId,
          subjectId: input.subjectId,
          isFree,
          enrollmentMethods: input.enrollmentMethods,
          accessDurationType: input.accessDurationType ?? 'LIFETIME',
          accessDurationDays: input.accessDurationDays,
          accessEndsAt: input.accessEndsAt ? new Date(input.accessEndsAt) : null,
          requirements: input.requirements ?? [],
          outcomes: input.outcomes ?? [],
          completionRuleType: input.completionRuleType ?? 'WATCH_PERCENT',
          completionThreshold: input.completionThreshold ?? 90,
          completionRequireContiguous: input.completionRequireContiguous ?? true,
          createdById: actor.id,
          teachers: {
            create: input.teacherIds.map((teacherId) => ({
              teacherId,
              isLead: teacherId === leadId,
              // Content editing is the default; pricing and publishing are
              // opt-in per assignment so a co-teacher can't reprice a course.
              canEditContent: true,
              canEditPricing: false,
              canPublish: false,
              canViewStudents: true,
              canViewRevenue: teacherId === leadId,
              assignedById: actor.id,
            })),
          },
        },
      });

      // Version 1 of the price exists even for free courses, so the history
      // has a defined starting point if the course later becomes paid.
      await tx.coursePrice.create({
        data: {
          courseId: created.id,
          amount: isFree ? 0 : (input.price ?? 0),
          currency: input.currency ?? 'EGP',
          version: 1,
          isCurrent: true,
          changedById: actor.id,
          reason: 'Initial price',
        },
      });

      if (input.sections?.length) {
        await tx.courseSection.createMany({
          data: input.sections.map((section, index) => ({
            courseId: created.id,
            title: section.title,
            description: section.description,
            sortOrder: index + 1,
          })),
        });
      }

      return created;
    });

    await this.courses.recountCourse(course.id);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'course',
      entityId: course.id,
      after: { title: course.title, status: course.status, isFree },
    });

    return this.detailForStaff(course.id);
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------

  async update(
    courseId: string,
    input: Partial<CreateCourseInput> & { status?: CourseStatus },
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'content');

    const before = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
    });
    if (!before) throw AppException.notFound('Course', courseId);

    if (before.status === CourseStatus.ARCHIVED) {
      throw new AppException(ErrorCode.COURSE_ARCHIVED, {
        message: 'Restore the course before editing it',
      });
    }

    // Status changes go through publish/archive, which have their own rules.
    if (input.status && input.status !== before.status) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'Use the publish/unpublish/archive endpoints to change status',
      });
    }

    const data: Prisma.CourseUpdateInput = {
      title: input.title?.trim(),
      titleAr: input.titleAr?.trim(),
      shortDescription: input.shortDescription?.trim(),
      description: input.description?.trim(),
      thumbnailKey: input.thumbnailKey,
      requirements: input.requirements,
      outcomes: input.outcomes,
      enrollmentMethods: input.enrollmentMethods,
      accessDurationType: input.accessDurationType,
      accessDurationDays: input.accessDurationDays,
      accessEndsAt: input.accessEndsAt ? new Date(input.accessEndsAt) : undefined,
      completionRuleType: input.completionRuleType,
      completionThreshold: input.completionThreshold,
      completionRequireContiguous: input.completionRequireContiguous,
      ...(input.universityId !== undefined
        ? { university: input.universityId ? { connect: { id: input.universityId } } : { disconnect: true } }
        : {}),
      ...(input.facultyId !== undefined
        ? {
          faculty: input.facultyId ? { connect: { id: input.facultyId } } : { disconnect: true },
        }
        : {}),
      ...(input.academicYearId !== undefined
        ? {
          academicYear: input.academicYearId
            ? { connect: { id: input.academicYearId } }
            : { disconnect: true },
        }
        : {}),
      ...(input.subjectId !== undefined
        ? {
          subject: input.subjectId ? { connect: { id: input.subjectId } } : { disconnect: true },
        }
        : {}),
    };

    const updated = await this.prisma.course.update({ where: { id: courseId }, data });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'course',
      entityId: courseId,
      before: { title: before.title, shortDescription: before.shortDescription },
      after: { title: updated.title, shortDescription: updated.shortDescription },
    });

    return this.detailForStaff(courseId);
  }

  // ---------------------------------------------------------------------------
  // Pricing — append-only versioning
  // ---------------------------------------------------------------------------

  /**
   * Changes the price for FUTURE purchases only.
   *
   * The old version is closed with `effectiveTo` and a new `isCurrent` row is
   * appended. Existing payments keep pointing at the version they used, so
   * historical revenue is unaffected — this is the guarantee spec §28 asks for,
   * expressed in the data model rather than in reporting code.
   */
  async changePrice(
    courseId: string,
    input: { amount: number; currency?: string; compareAtAmount?: number; reason?: string },
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'pricing');
    await this.access.assertTeacherCapability(actor.role, 'editCoursePrices');

    if (input.amount < 0) {
      throw AppException.validation({ amount: ['must not be negative'] });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.coursePrice.findFirst({
        where: { courseId, isCurrent: true },
        orderBy: { version: 'desc' },
      });

      const nextVersion = (current?.version ?? 0) + 1;
      const now = new Date();

      if (current) {
        await tx.coursePrice.update({
          where: { id: current.id },
          data: { isCurrent: false, effectiveTo: now },
        });
      }

      const created = await tx.coursePrice.create({
        data: {
          courseId,
          amount: input.amount,
          currency: input.currency ?? current?.currency ?? 'EGP',
          compareAtAmount: input.compareAtAmount,
          version: nextVersion,
          isCurrent: true,
          effectiveFrom: now,
          changedById: actor.id,
          reason: input.reason,
        },
      });

      // Keep the denormalised free flag in step with the live price.
      await tx.course.update({
        where: { id: courseId },
        data: { isFree: input.amount <= 0 },
      });

      return { previous: current, created };
    }, MONEY_TX_OPTIONS);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.PRICE_CHANGE,
      entity: 'course',
      entityId: courseId,
      before: result.previous
        ? { amount: Number(result.previous.amount), version: result.previous.version }
        : null,
      after: { amount: Number(result.created.amount), version: result.created.version },
      note: input.reason,
    });

    return {
      id: result.created.id,
      amount: Number(result.created.amount),
      currency: result.created.currency,
      version: result.created.version,
      effectiveFrom: result.created.effectiveFrom.toISOString(),
    };
  }

  async priceHistory(courseId: string, actor: { id: string; role: UserRole }) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'pricing');

    const rows = await this.prisma.coursePrice.findMany({
      where: { courseId },
      orderBy: { version: 'desc' },
      include: {
        changedBy: { select: { id: true, fullName: true } },
        _count: { select: { payments: true } },
      },
    });

    return rows.map((p) => ({
      id: p.id,
      version: p.version,
      amount: Number(p.amount),
      currency: p.currency,
      isCurrent: p.isCurrent,
      effectiveFrom: p.effectiveFrom.toISOString(),
      effectiveTo: p.effectiveTo?.toISOString() ?? null,
      changedBy: p.changedBy,
      reason: p.reason,
      /** How many purchases were made at this price — the audit answer. */
      paymentCount: p._count.payments,
    }));
  }

  // ---------------------------------------------------------------------------
  // Teachers
  // ---------------------------------------------------------------------------

  async assignTeacher(
    courseId: string,
    input: {
      teacherId: string;
      isLead?: boolean;
      revenueSharePercent?: number;
      canEditContent?: boolean;
      canEditPricing?: boolean;
      canPublish?: boolean;
      canViewStudents?: boolean;
      canViewRevenue?: boolean;
    },
    actor: { id: string; role: UserRole },
  ) {
    // Only admins/master change the teaching roster — otherwise a teacher
    // could add themselves to any course, or remove a colleague.
    if (actor.role !== UserRole.MASTER && actor.role !== UserRole.ADMIN) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Only administrators can change course staffing',
      });
    }

    await this.assertTeachersExist([input.teacherId]);

    const assignment = await this.prisma.$transaction(async (tx) => {
      if (input.isLead) {
        await tx.courseTeacher.updateMany({
          where: { courseId },
          data: { isLead: false },
        });
      }

      return tx.courseTeacher.upsert({
        where: { courseId_teacherId: { courseId, teacherId: input.teacherId } },
        create: {
          courseId,
          teacherId: input.teacherId,
          isLead: input.isLead ?? false,
          revenueSharePercent: input.revenueSharePercent,
          canEditContent: input.canEditContent ?? true,
          canEditPricing: input.canEditPricing ?? false,
          canPublish: input.canPublish ?? false,
          canViewStudents: input.canViewStudents ?? true,
          canViewRevenue: input.canViewRevenue ?? false,
          assignedById: actor.id,
        },
        update: {
          isLead: input.isLead,
          revenueSharePercent: input.revenueSharePercent,
          canEditContent: input.canEditContent,
          canEditPricing: input.canEditPricing,
          canPublish: input.canPublish,
          canViewStudents: input.canViewStudents,
          canViewRevenue: input.canViewRevenue,
        },
      });
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'course_teacher',
      entityId: assignment.id,
      after: { courseId, teacherId: input.teacherId, isLead: assignment.isLead },
    });

    return assignment;
  }

  async removeTeacher(
    courseId: string,
    teacherId: string,
    actor: { id: string; role: UserRole },
  ) {
    if (actor.role !== UserRole.MASTER && actor.role !== UserRole.ADMIN) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE);
    }

    const remaining = await this.prisma.courseTeacher.count({ where: { courseId } });
    if (remaining <= 1) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: 'A course must keep at least one teacher',
      });
    }

    await this.prisma.courseTeacher.delete({
      where: { courseId_teacherId: { courseId, teacherId } },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'course_teacher',
      entityId: `${courseId}:${teacherId}`,
    });

    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Publishing is gated on the course being coherent. Shipping an empty
   * course to the catalogue is a worse failure than a rejected publish, and
   * these checks are cheap.
   */
  async publish(courseId: string, actor: { id: string; role: UserRole }) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'publish');

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      include: {
        sections: { where: { deletedAt: null }, select: { id: true } },
        prices: { where: { isCurrent: true }, take: 1 },
        _count: { select: { lessons: { where: { deletedAt: null } }, teachers: true } },
      },
    });
    if (!course) throw AppException.notFound('Course', courseId);

    const problems: string[] = [];
    if (course.sections.length === 0) problems.push('the course has no sections');
    if (course._count.lessons === 0) problems.push('the course has no lessons');
    if (course._count.teachers === 0) problems.push('no teacher is assigned');
    if (!course.isFree && Number(course.prices[0]?.amount ?? 0) <= 0) {
      problems.push('a paid course needs a price greater than zero');
    }
    if (course.enrollmentMethods.length === 0) {
      problems.push('no enrollment method is configured');
    }

    if (problems.length > 0) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: `Cannot publish: ${problems.join('; ')}`,
        details: { problems },
      });
    }

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: {
        status: CourseStatus.PUBLISHED,
        publishedAt: course.publishedAt ?? new Date(),
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.PUBLISH,
      entity: 'course',
      entityId: courseId,
      before: { status: course.status },
      after: { status: updated.status },
    });

    return { id: updated.id, status: updated.status, publishedAt: updated.publishedAt };
  }

  async unpublish(
    courseId: string,
    actor: { id: string; role: UserRole },
    status: Extract<CourseStatus, 'DRAFT' | 'HIDDEN' | 'SUSPENDED'>,
    reason?: string,
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'publish');

    const before = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: { status: true },
    });
    if (!before) throw AppException.notFound('Course', courseId);

    const updated = await this.prisma.course.update({
      where: { id: courseId },
      data: { status },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UNPUBLISH,
      entity: 'course',
      entityId: courseId,
      before,
      after: { status },
      note: reason,
    });

    return { id: updated.id, status: updated.status };
  }

  /**
   * Archive.
   *
   * What changes: the course status, enrollment states, and video availability
   * for students.
   * What does NOT change: payments, revenue ledger, watch events, watch
   * progress, code redemptions, audit rows. Those are the business record and
   * survive untouched — the schema's Restrict constraints make that structural
   * rather than a promise.
   */
  async archive(courseId: string, actor: { id: string; role: UserRole }, reason: string) {
    if (actor.role !== UserRole.MASTER && actor.role !== UserRole.ADMIN) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: 'Only administrators can archive a course',
      });
    }

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
    });
    if (!course) throw AppException.notFound('Course', courseId);
    if (course.status === CourseStatus.ARCHIVED) {
      throw new AppException(ErrorCode.INVALID_STATE, { message: 'Already archived' });
    }

    const now = new Date();

    const snapshot = await this.prisma.$transaction(async (tx) => {
      const [enrollmentCount, paymentAggregate, watchEventCount] = await Promise.all([
        tx.enrollment.count({ where: { courseId } }),
        tx.payment.aggregate({
          where: { courseId, status: 'PAID' },
          _sum: { amount: true },
          _count: { _all: true },
        }),
        tx.watchEvent.count({ where: { courseId } }),
      ]);

      const frozen = {
        enrollments: enrollmentCount,
        paidPayments: paymentAggregate._count._all,
        grossRevenue: Number(paymentAggregate._sum.amount ?? 0),
        watchEvents: watchEventCount,
        lessonCount: course.lessonCount,
        studentCount: course.studentCount,
        archivedAt: now.toISOString(),
      };

      await tx.course.update({
        where: { id: courseId },
        data: { status: CourseStatus.ARCHIVED, archivedAt: now },
      });

      // Enrollments move to ARCHIVED so the student sees the right state, but
      // the rows — and their payment links — remain.
      await tx.enrollment.updateMany({
        where: { courseId, state: { in: [EnrollmentState.ACTIVE, EnrollmentState.PENDING_APPROVAL] } },
        data: { state: EnrollmentState.ARCHIVED },
      });

      // Any in-flight playback dies immediately.
      await tx.playbackTicket.updateMany({
        where: { courseId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Course archived' },
      });

      await tx.archiveRecord.create({
        data: {
          entity: 'course',
          entityId: courseId,
          courseId,
          reason,
          snapshot: frozen as Prisma.InputJsonValue,
          archivedById: actor.id,
        },
      });

      return frozen;
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.ARCHIVE,
      entity: 'course',
      entityId: courseId,
      before: { status: course.status },
      after: { status: CourseStatus.ARCHIVED, snapshot },
      note: reason,
    });

    return { id: courseId, status: CourseStatus.ARCHIVED, snapshot };
  }

  async restore(courseId: string, actor: { id: string; role: UserRole }) {
    if (actor.role !== UserRole.MASTER && actor.role !== UserRole.ADMIN) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE);
    }

    const course = await this.prisma.course.findFirst({ where: { id: courseId } });
    if (!course) throw AppException.notFound('Course', courseId);
    if (course.status !== CourseStatus.ARCHIVED) {
      throw new AppException(ErrorCode.INVALID_STATE, { message: 'Course is not archived' });
    }

    await this.prisma.$transaction(async (tx) => {
      // Restores to DRAFT, never straight back to PUBLISHED — an archived
      // course usually needs review before students see it again.
      await tx.course.update({
        where: { id: courseId },
        data: { status: CourseStatus.DRAFT, archivedAt: null },
      });

      // Enrollments come back to ACTIVE only if their access window still
      // holds; the rest become EXPIRED, which is the honest state.
      const now = new Date();
      await tx.enrollment.updateMany({
        where: {
          courseId,
          state: EnrollmentState.ARCHIVED,
          OR: [{ accessEndsAt: null }, { accessEndsAt: { gt: now } }],
        },
        data: { state: EnrollmentState.ACTIVE },
      });
      await tx.enrollment.updateMany({
        where: { courseId, state: EnrollmentState.ARCHIVED, accessEndsAt: { lte: now } },
        data: { state: EnrollmentState.EXPIRED },
      });

      await tx.archiveRecord.updateMany({
        where: { entity: 'course', entityId: courseId, restoredAt: null },
        data: { restoredAt: now, restoredById: actor.id },
      });
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.RESTORE,
      entity: 'course',
      entityId: courseId,
    });

    return { id: courseId, status: CourseStatus.DRAFT };
  }

  // ---------------------------------------------------------------------------
  // Staff detail
  // ---------------------------------------------------------------------------

  async detailForStaff(courseId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      include: {
        teachers: {
          include: {
            teacher: {
              select: {
                id: true,
                fullName: true,
                avatarUrl: true,
                teacherProfile: { select: { title: true, revenueSharePercent: true } },
              },
            },
          },
        },
        prices: { orderBy: { version: 'desc' }, take: 5 },
        sections: {
          where: notDeleted,
          orderBy: { sortOrder: 'asc' },
          include: {
            lessons: {
              where: notDeleted,
              orderBy: { sortOrder: 'asc' },
              include: { video: { select: { id: true, status: true, durationSeconds: true } } },
            },
          },
        },
        university: { select: { id: true, name: true } },
        academicYear: { select: { id: true, name: true } },
        _count: { select: { enrollments: true, attachments: true } },
      },
    });

    if (!course) throw AppException.notFound('Course', courseId);

    return {
      ...course,
      thumbnailUrl: await this.storage.publicAssetUrl(course.thumbnailKey),
      prices: course.prices.map((p) => ({
        ...p,
        amount: Number(p.amount),
        compareAtAmount: p.compareAtAmount ? Number(p.compareAtAmount) : null,
      })),
      teachers: course.teachers.map((t) => ({
        ...t,
        revenueSharePercent: t.revenueSharePercent ? Number(t.revenueSharePercent) : null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async assertTeachersExist(teacherIds: string[]): Promise<void> {
    const found = await this.prisma.user.count({
      where: {
        id: { in: teacherIds },
        role: UserRole.TEACHER,
        status: AccountStatus.ACTIVE,
        ...notDeleted,
      },
    });

    if (found !== new Set(teacherIds).size) {
      throw AppException.validation({
        teacherIds: ['one or more ids are not active teacher accounts'],
      });
    }
  }

  private async uniqueSlug(title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .normalize('NFKD')
        // Keep Arabic letters; strip everything that isn't a letter, digit or space.
        .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60) || 'course';

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
      const clash = await this.prisma.course.findUnique({
        where: { slug: candidate },
        select: { id: true },
      });
      if (!clash) return candidate;
    }

    return `${base}-${Date.now().toString(36)}`;
  }
}
