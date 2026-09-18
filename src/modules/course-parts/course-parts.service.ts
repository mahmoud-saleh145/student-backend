import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  ContentStatus,
  CourseStatus,
  PartPricingModel,
  type Prisma,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CourseAccessService } from '../courses/course-access.service';
import { toEgpNumber } from '../wallet/money';

import { loadPartAllocation } from './part-allocation.guard';
import { allocatePartPrices, DEFAULT_PART_STRUCTURE, type PartAllocation } from './part-pricing';

/**
 * Course part structure and pricing.
 *
 * The admin side, plus the student's read-only view of what a course is
 * divided into and which slices they hold. Acquisition happens elsewhere: a
 * part is unlocked by redeeming a part-scoped access card
 * (`grantPartFromCode`), never by debiting the wallet — the wallet is for the
 * Library and a course never touches it.
 *
 * The rule that shapes every write here: **the allocation is validated on
 * every structural change.** An invalid split is caught when the admin makes
 * it, while they are looking at the screen and can fix it — not months later
 * when a student redeems a card and gets the wrong thing.
 */
@Injectable()
export class CoursePartsService {
  private readonly logger = new Logger(CoursePartsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: CourseAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------

  /** The course's current price in EGP, or null when it has never been priced. */
  private async coursePrice(
    tx: Prisma.TransactionClient | PrismaService,
    courseId: string,
  ): Promise<string | null> {
    const price = await tx.coursePrice.findFirst({
      where: { courseId, isCurrent: true },
      orderBy: { version: 'desc' },
      select: { amount: true },
    });
    return price ? price.amount.toString() : null;
  }

  /**
   * Admin view: every part including inactive and archived ones, with the live
   * allocation. Inactive parts are listed because their purchase history still
   * matters; they are simply not sellable.
   */
  async listForAdmin(courseId: string, actor: { id: string; role: UserRole }) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'content');

    const [parts, price] = await Promise.all([
      this.prisma.coursePart.findMany({
        where: { courseId, ...notDeleted },
        orderBy: { sortOrder: 'asc' },
        include: {
          sections: {
            where: notDeleted,
            orderBy: { sortOrder: 'asc' },
            select: { id: true, title: true, sortOrder: true, status: true },
          },
          _count: { select: { entitlements: true, purchases: true } },
        },
      }),
      this.coursePrice(this.prisma, courseId),
    ]);

    // The allocation only covers sellable parts, and only makes sense once the
    // course has a price. Both absences are normal states, not errors, so they
    // are reported rather than thrown.
    let allocation: Map<string, PartAllocation> | null = null;
    let allocationError: string | null = null;

    if (price !== null && parts.length > 0) {
      try {
        const result = await this.prisma.$transaction(async (tx) =>
          loadPartAllocation(tx, courseId, price),
        );
        allocation = result ? new Map(result.parts.map((p) => [p.id, p])) : null;
      } catch (error) {
        allocationError =
          error instanceof AppException
            ? Object.values(error.fields ?? {}).flat().join('; ') || error.message
            : 'the part prices do not add up';
      }
    }

    return {
      courseId,
      coursePrice: price === null ? null : Number(price),
      // Surfaced rather than thrown so the dashboard can render the parts AND
      // the problem together; an admin cannot fix a split they cannot see.
      allocationError,
      parts: parts.map((part) => ({
        id: part.id,
        title: part.title,
        titleAr: part.titleAr,
        description: part.description,
        sortOrder: part.sortOrder,
        status: part.status,
        isActive: part.isActive,
        pricingModel: part.pricingModel,
        pricePercent: part.pricePercent === null ? null : Number(part.pricePercent),
        priceAmount: part.priceAmount === null ? null : Number(part.priceAmount),
        /** What this part actually costs a student right now. */
        effectivePrice: allocation?.get(part.id)?.egp ?? null,
        currency: part.currency,
        sections: part.sections,
        sectionCount: part.sections.length,
        entitlementCount: part._count.entitlements,
        purchaseCount: part._count.purchases,
        createdAt: part.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Student view: the sellable parts of a course, each marked owned or locked.
   *
   * Deliberately returns every sellable part, not just the unowned ones: the
   * requirement is that a student sees the whole course and understands what
   * they have and what they do not. Hiding locked parts would make the course
   * look smaller than it is.
   */
  async listForStudent(courseId: string, userId: string) {
    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: { id: true, title: true, status: true },
    });
    if (!course) throw AppException.notFound('Course', courseId);

    const [parts, price, entitlements, enrollment] = await Promise.all([
      this.prisma.coursePart.findMany({
        where: {
          courseId,
          ...notDeleted,
          isActive: true,
          status: { not: ContentStatus.ARCHIVED },
        },
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          title: true,
          titleAr: true,
          description: true,
          sortOrder: true,
          pricingModel: true,
          pricePercent: true,
          priceAmount: true,
          currency: true,
          sections: {
            where: { ...notDeleted, status: ContentStatus.PUBLISHED },
            orderBy: { sortOrder: 'asc' },
            select: { id: true, title: true, titleAr: true, sortOrder: true },
          },
        },
      }),
      this.coursePrice(this.prisma, courseId),
      this.prisma.coursePartEntitlement.findMany({
        where: { userId, courseId, revokedAt: null },
        select: { coursePartId: true, grantedAt: true },
      }),
      this.prisma.enrollment.findUnique({
        where: { userId_courseId: { userId, courseId } },
        select: { coversAllSections: true },
      }),
    ]);

    if (parts.length === 0) {
      // Not an error: a course sold only as a whole has no parts, and the app
      // needs to be able to tell that apart from "parts failed to load".
      return {
        courseId,
        hasParts: false,
        coursePrice: price === null ? null : Number(price),
        ownsAllParts: false,
        parts: [],
      };
    }

    let allocation: Map<string, PartAllocation> | null = null;
    if (price !== null) {
      try {
        const result = allocatePartPrices(
          parts.map((p) => ({
            id: p.id,
            title: p.title,
            sortOrder: p.sortOrder,
            pricingModel: p.pricingModel,
            pricePercent: p.pricePercent?.toString() ?? null,
            priceAmount: p.priceAmount?.toString() ?? null,
          })),
          price,
        );
        allocation = new Map(result.parts.map((p) => [p.id, p]));
      } catch (error) {
        // A misconfigured course must not break the student's course page. The
        // parts render without prices and the purchase endpoint refuses, which
        // is a far better failure than a 500 on the course screen.
        this.logger.error(
          `course ${courseId} has an invalid part allocation: ${String(error)}`,
        );
      }
    }

    const owned = new Map(entitlements.map((e) => [e.coursePartId, e.grantedAt]));
    // A whole-course enrollment predates parts, or came from a course-wide
    // code. Either way the student already has everything, and every part must
    // read as owned or they would be invited to buy what they already hold.
    const coversEverything = enrollment?.coversAllSections === true;

    return {
      courseId,
      hasParts: true,
      coursePrice: price === null ? null : Number(price),
      ownsAllParts:
        coversEverything || parts.every((part) => owned.has(part.id)),
      parts: parts.map((part) => {
        const isOwned = coversEverything || owned.has(part.id);
        return {
          id: part.id,
          title: part.title,
          titleAr: part.titleAr,
          description: part.description,
          sortOrder: part.sortOrder,
          price: allocation?.get(part.id)?.egp ?? null,
          pricePercent: allocation?.get(part.id)?.percent ?? null,
          currency: part.currency,
          owned: isOwned,
          ownedSince: owned.get(part.id)?.toISOString() ?? null,
          /** Why it is owned, so the app can word the badge correctly. */
          ownedVia: owned.has(part.id)
            ? 'PART_PURCHASE'
            : coversEverything
              ? 'FULL_COURSE'
              : null,
          purchasable: !isOwned && allocation?.get(part.id) !== undefined,
          sectionCount: part.sections.length,
          // Titles only. A locked part shows what it contains — that is what
          // makes it worth buying — but never anything playable.
          sections: part.sections.map((s) => ({
            id: s.id,
            title: s.title,
            titleAr: s.titleAr,
            sortOrder: s.sortOrder,
            locked: !isOwned,
          })),
        };
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Structure
  // ---------------------------------------------------------------------------

  /**
   * Option A from the requirements: the default two-part structure, 60/40.
   *
   * Refuses rather than merges when parts already exist. Silently adding two
   * more parts to a course that already has three would produce a 260% split
   * and an admin with no idea where it came from.
   */
  async createDefaultStructure(courseId: string, actor: { id: string; role: UserRole }) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'pricing');

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: { id: true, title: true },
    });
    if (!course) throw AppException.notFound('Course', courseId);

    const existing = await this.prisma.coursePart.count({
      where: { courseId, ...notDeleted },
    });
    if (existing > 0) {
      throw AppException.conflict(
        'This course already has parts. Remove them first, or add parts individually.',
        { existing },
      );
    }

    const created = await this.prisma.$transaction(async (tx) =>
      Promise.all(
        DEFAULT_PART_STRUCTURE.map((template, index) =>
          tx.coursePart.create({
            data: {
              courseId,
              title: template.title,
              titleAr: template.titleAr,
              sortOrder: index + 1,
              pricingModel: PartPricingModel.PERCENTAGE,
              pricePercent: template.pricePercent,
              createdById: actor.id,
            },
          }),
        ),
      ),
    );

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'course_part_structure',
      entityId: courseId,
      after: {
        structure: 'DEFAULT',
        parts: created.map((p) => ({ id: p.id, title: p.title, percent: Number(p.pricePercent) })),
      },
    });

    return this.listForAdmin(courseId, actor);
  }

  /**
   * Adds one part.
   *
   * The new part is validated into the course's existing allocation before it
   * is kept: adding a third 50% part to a 60/40 course is refused at the point
   * of the mistake. The whole write runs in one transaction so a rejected part
   * leaves nothing behind.
   */
  async create(
    courseId: string,
    input: {
      title: string;
      titleAr?: string;
      description?: string;
      pricingModel: PartPricingModel;
      pricePercent?: number;
      priceAmount?: number;
      sortOrder?: number;
      sectionIds?: string[];
    },
    actor: { id: string; role: UserRole },
  ) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'pricing');

    const course = await this.prisma.course.findFirst({
      where: { id: courseId, ...notDeleted },
      select: { id: true },
    });
    if (!course) throw AppException.notFound('Course', courseId);

    this.assertPriceMatchesModel(input);

    const part = await this.prisma.$transaction(async (tx) => {
      const last = await tx.coursePart.findFirst({
        where: { courseId, ...notDeleted },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });

      const created = await tx.coursePart.create({
        data: {
          courseId,
          title: input.title,
          titleAr: input.titleAr ?? null,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? (last?.sortOrder ?? 0) + 1,
          pricingModel: input.pricingModel,
          pricePercent: input.pricingModel === PartPricingModel.PERCENTAGE
            ? (input.pricePercent ?? 0)
            : null,
          priceAmount: input.pricingModel === PartPricingModel.FIXED
            ? (input.priceAmount ?? 0)
            : null,
          createdById: actor.id,
        },
      });

      if (input.sectionIds?.length) {
        await this.attachSections(tx, courseId, created.id, input.sectionIds);
      }

      await this.revalidate(tx, courseId);
      return created;
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CREATE,
      entity: 'course_part',
      entityId: part.id,
      after: {
        courseId,
        title: part.title,
        pricingModel: part.pricingModel,
        pricePercent: part.pricePercent === null ? null : Number(part.pricePercent),
        priceAmount: part.priceAmount === null ? null : Number(part.priceAmount),
      },
    });

    return this.listForAdmin(courseId, actor);
  }

  /**
   * Edits a part.
   *
   * A part with purchases may still be retitled and reordered, and its price
   * may still change — none of that touches what anyone already bought, because
   * a purchase carries its own frozen price. What it may NOT do is change
   * pricing model while sold, because the allocation of the money already
   * collected would stop being explainable.
   */
  async update(
    partId: string,
    input: {
      title?: string;
      titleAr?: string | null;
      description?: string | null;
      pricingModel?: PartPricingModel;
      pricePercent?: number;
      priceAmount?: number;
      isActive?: boolean;
      status?: ContentStatus;
    },
    actor: { id: string; role: UserRole },
  ) {
    const part = await this.requirePart(partId);
    await this.access.assertCanManageCourse(actor.id, actor.role, part.courseId, 'pricing');

    const model = input.pricingModel ?? part.pricingModel;

    if (input.pricingModel && input.pricingModel !== part.pricingModel) {
      const sold = await this.prisma.coursePartPurchase.count({
        where: { coursePartId: partId },
      });
      if (sold > 0) {
        throw AppException.conflict(
          'This part has been sold, so its pricing model cannot be changed. Change the price instead, or deactivate it and add a replacement.',
          { purchases: sold },
        );
      }
    }

    if (input.pricingModel || input.pricePercent !== undefined || input.priceAmount !== undefined) {
      this.assertPriceMatchesModel({
        pricingModel: model,
        pricePercent: input.pricePercent ?? (part.pricePercent === null ? undefined : Number(part.pricePercent)),
        priceAmount: input.priceAmount ?? (part.priceAmount === null ? undefined : Number(part.priceAmount)),
      });
    }

    const before = {
      title: part.title,
      pricingModel: part.pricingModel,
      pricePercent: part.pricePercent === null ? null : Number(part.pricePercent),
      priceAmount: part.priceAmount === null ? null : Number(part.priceAmount),
      isActive: part.isActive,
      status: part.status,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.coursePart.update({
        where: { id: partId },
        data: {
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.titleAr !== undefined ? { titleAr: input.titleAr } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.pricingModel || input.pricePercent !== undefined || input.priceAmount !== undefined
            ? {
                pricingModel: model,
                pricePercent: model === PartPricingModel.PERCENTAGE
                  ? (input.pricePercent ?? (part.pricePercent === null ? 0 : Number(part.pricePercent)))
                  : null,
                priceAmount: model === PartPricingModel.FIXED
                  ? (input.priceAmount ?? (part.priceAmount === null ? 0 : Number(part.priceAmount)))
                  : null,
              }
            : {}),
        },
      });

      await this.revalidate(tx, part.courseId);
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'course_part',
      entityId: partId,
      before,
      after: input,
    });

    return this.listForAdmin(part.courseId, actor);
  }

  /**
   * Soft-deletes a part.
   *
   * A part anyone has bought is never removed, only deactivated — deleting it
   * would orphan an entitlement someone paid for. The sections inside it are
   * unassigned rather than deleted, so no teaching material is ever lost to a
   * structural change.
   */
  async remove(partId: string, actor: { id: string; role: UserRole }) {
    const part = await this.requirePart(partId);
    await this.access.assertCanManageCourse(actor.id, actor.role, part.courseId, 'pricing');

    const sold = await this.prisma.coursePartPurchase.count({ where: { coursePartId: partId } });
    if (sold > 0) {
      throw AppException.conflict(
        'This part has been purchased and cannot be deleted. Deactivate it instead — students who bought it keep their access.',
        { purchases: sold },
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.courseSection.updateMany({
        where: { partId },
        data: { partId: null },
      });
      await tx.coursePart.update({
        where: { id: partId },
        data: { deletedAt: new Date(), isActive: false },
      });
      await this.revalidate(tx, part.courseId);
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DELETE,
      entity: 'course_part',
      entityId: partId,
      before: { courseId: part.courseId, title: part.title },
    });

    return this.listForAdmin(part.courseId, actor);
  }

  /**
   * Assigns sections to a part, replacing whatever was assigned before.
   *
   * This is what actually decides what a buyer receives. Sections not listed
   * are unassigned from this part rather than deleted; a section may belong to
   * at most one part, so assigning it here removes it from any other.
   */
  async setSections(
    partId: string,
    sectionIds: string[],
    actor: { id: string; role: UserRole },
  ) {
    const part = await this.requirePart(partId);
    await this.access.assertCanManageCourse(actor.id, actor.role, part.courseId, 'content');

    await this.prisma.$transaction(async (tx) => {
      await tx.courseSection.updateMany({
        where: { partId, id: { notIn: sectionIds.length ? sectionIds : ['__none__'] } },
        data: { partId: null },
      });
      if (sectionIds.length) {
        await this.attachSections(tx, part.courseId, partId, sectionIds);
      }
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.UPDATE,
      entity: 'course_part_sections',
      entityId: partId,
      after: { sectionIds },
    });

    return this.listForAdmin(part.courseId, actor);
  }

  /**
   * Reorders parts.
   *
   * Two phases, because `(courseId, sortOrder)` is unique and a direct swap
   * would collide mid-update. The same trick the section reorder already uses.
   */
  async reorder(courseId: string, partIds: string[], actor: { id: string; role: UserRole }) {
    await this.access.assertCanManageCourse(actor.id, actor.role, courseId, 'content');

    const parts = await this.prisma.coursePart.findMany({
      where: { courseId, ...notDeleted },
      select: { id: true },
    });

    const known = new Set(parts.map((p) => p.id));
    if (partIds.length !== known.size || partIds.some((id) => !known.has(id))) {
      throw AppException.validation({
        partIds: ['must list every part of this course exactly once'],
      });
    }

    await this.prisma.$transaction(async (tx) => {
      // Park everything in negative space first, where nothing can collide.
      for (const [index, id] of partIds.entries()) {
        await tx.coursePart.update({ where: { id }, data: { sortOrder: -(index + 1) } });
      }
      for (const [index, id] of partIds.entries()) {
        await tx.coursePart.update({ where: { id }, data: { sortOrder: index + 1 } });
      }
    });

    return this.listForAdmin(courseId, actor);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async requirePart(partId: string) {
    const part = await this.prisma.coursePart.findFirst({
      where: { id: partId, ...notDeleted },
    });
    if (!part) throw AppException.notFound('Course part', partId);
    return part;
  }

  private assertPriceMatchesModel(input: {
    pricingModel: PartPricingModel;
    pricePercent?: number;
    priceAmount?: number;
  }): void {
    if (input.pricingModel === PartPricingModel.PERCENTAGE) {
      if (input.pricePercent === undefined || input.pricePercent === null) {
        throw AppException.validation({ pricePercent: ['is required for a percentage part'] });
      }
    } else if (input.priceAmount === undefined || input.priceAmount === null) {
      throw AppException.validation({ priceAmount: ['is required for a fixed-price part'] });
    }
  }

  /** Re-proves the whole course's allocation inside a write transaction. */
  private async revalidate(tx: Prisma.TransactionClient, courseId: string): Promise<void> {
    const price = await this.coursePrice(tx, courseId);
    // An unpriced course cannot have its allocation checked yet, and that is a
    // legitimate authoring state — the parts are validated the moment a price
    // is set, and the purchase path refuses until then regardless.
    if (price === null) return;
    await loadPartAllocation(tx, courseId, price);
  }

  private async attachSections(
    tx: Prisma.TransactionClient,
    courseId: string,
    partId: string,
    sectionIds: string[],
  ): Promise<void> {
    const sections = await tx.courseSection.findMany({
      where: { id: { in: sectionIds }, courseId, deletedAt: null },
      select: { id: true },
    });

    if (sections.length !== sectionIds.length) {
      const found = new Set(sections.map((s) => s.id));
      throw AppException.validation({
        sectionIds: [
          `these sections do not belong to this course: ${sectionIds.filter((id) => !found.has(id)).join(', ')}`,
        ],
      });
    }

    await tx.courseSection.updateMany({
      where: { id: { in: sectionIds } },
      data: { partId },
    });
  }

  /**
   * The sections a part unlocks, resolved at purchase time and snapshotted.
   *
   * Archived sections are excluded: a buyer should not be sold access to
   * material that has been withdrawn. Everything else in the part is included,
   * including sections that are merely hidden, because those are still part of
   * what was sold and may be unhidden later.
   */
  async sectionIdsOfPart(
    tx: Prisma.TransactionClient,
    partId: string,
  ): Promise<string[]> {
    const sections = await tx.courseSection.findMany({
      where: { partId, deletedAt: null, status: { not: ContentStatus.ARCHIVED } },
      orderBy: { sortOrder: 'asc' },
      select: { id: true },
    });
    return sections.map((s) => s.id);
  }

  /** Guards the purchase path against a course that is not open for business. */
  assertCourseSellable(course: { status: CourseStatus; deletedAt: Date | null }): void {
    if (course.deletedAt) throw new AppException(ErrorCode.COURSE_NOT_AVAILABLE);

    if (course.status === CourseStatus.ARCHIVED) {
      throw new AppException(ErrorCode.COURSE_ARCHIVED);
    }
    // HIDDEN is deliberately allowed, matching the existing access rules: it
    // means "unlisted", not "withdrawn", so a student holding the link may
    // still buy. DRAFT and SUSPENDED are not for sale.
    if (course.status === CourseStatus.DRAFT || course.status === CourseStatus.SUSPENDED) {
      throw new AppException(ErrorCode.COURSE_NOT_AVAILABLE);
    }
  }

  /** Admin report: what has been sold, per part. */
  async purchaseReport(params: {
    page: number;
    pageSize: number;
    courseId?: string;
    coursePartId?: string;
    userId?: string;
    from?: Date;
    to?: Date;
    order?: 'asc' | 'desc';
  }) {
    const where: Prisma.CoursePartPurchaseWhereInput = {
      ...(params.courseId ? { courseId: params.courseId } : {}),
      ...(params.coursePartId ? { coursePartId: params.coursePartId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.from || params.to
        ? {
            purchasedAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total, totals] = await this.prisma.$transaction([
      this.prisma.coursePartPurchase.findMany({
        where,
        orderBy: { purchasedAt: params.order ?? 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
          teacher: { select: { id: true, fullName: true } },
        },
      }),
      this.prisma.coursePartPurchase.count({ where }),
      this.prisma.coursePartPurchase.aggregate({
        where,
        _sum: { priceAtPurchase: true, teacherAmount: true, platformAmount: true },
      }),
    ]);

    return {
      items: rows.map((row) => ({
        id: row.id,
        student: row.user,
        courseId: row.courseId,
        courseTitle: row.courseTitleSnapshot,
        partId: row.coursePartId,
        partTitle: row.partTitleSnapshot,
        priceAtPurchase: Number(row.priceAtPurchase),
        pricingModel: row.pricingModelAtPurchase,
        pricePercent: row.pricePercentAtPurchase === null ? null : Number(row.pricePercentAtPurchase),
        coursePriceAtPurchase:
          row.coursePriceAtPurchase === null ? null : Number(row.coursePriceAtPurchase),
        teacher: row.teacher,
        teacherAmount: Number(row.teacherAmount),
        platformAmount: Number(row.platformAmount),
        currency: row.currency,
        sectionsUnlocked: row.sectionIdsSnapshot.length,
        purchasedAt: row.purchasedAt.toISOString(),
      })),
      meta: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / Math.max(1, params.pageSize))),
        hasNext: params.page * params.pageSize < total,
        hasPrevious: params.page > 1,
      },
      totals: {
        // The catalogue value of the parts handed out, NOT cash collected. The
        // money changed hands offline when the cards were sold; the cards'
        // own face values are that figure. Wallet credits never enter a course,
        // so nothing here belongs in a wallet total either.
        valueAtAcquisition: toEgpNumber(
          Math.round(Number(totals._sum.priceAtPurchase ?? 0) * 100),
        ),
        teacherShare: toEgpNumber(Math.round(Number(totals._sum.teacherAmount ?? 0) * 100)),
        platformShare: toEgpNumber(Math.round(Number(totals._sum.platformAmount ?? 0) * 100)),
        count: total,
      },
    };
  }
}
