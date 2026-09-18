import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  CodeKind,
  CodeStatus,
  CodeTargetType,
  CourseStatus,
  DiscountType,
  type Prisma,
  UserRole,
} from '@prisma/client';
import { randomInt } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { resolveDiscount } from '../wallet/discount';
import { toEgpNumber, toPiastres } from '../wallet/money';

export interface CodeValidation {
  code: {
    id: string;
    courseId: string | null;
    /// Set for a PART card. The caller records the part entitlement.
    coursePartId: string | null;
    accessDurationType: string | null;
    accessDurationDays: number | null;
    accessEndsAt: Date | null;
  };
  /** What this redemption unlocks, resolved from the code's frozen scope. */
  scope: RedemptionScope;
}

/**
 * The resolved effect of redeeming a code.
 *
 * `courseIds` is what to enroll in; `sectionIds` is null for "the whole
 * course" and an explicit list for a section-scoped code. Resolving this
 * once, inside the redemption transaction, is what keeps the business rule in
 * exactly one place rather than spread across the enrollment service.
 */
export interface RedemptionScope {
  targetType: CodeTargetType;
  courseIds: string[];
  sectionIds: string[] | null;
}

/**
 * Access codes.
 *
 * The correctness problem here is concurrency: a single-use code presented
 * twice at the same instant must be honoured exactly once. Two mechanisms
 * cover that, deliberately belt-and-braces:
 *
 *  1. A unique index on (codeId, userId) makes a per-student double-redeem
 *     impossible at the database level, whatever the application does.
 *  2. Redemption runs at Serializable isolation and re-reads the code inside
 *     the transaction, so two *different* students racing for the last slot of
 *     a multi-use code cannot both win.
 *
 * The alphabet excludes characters that are misread when a code is written on
 * a whiteboard and typed on a phone (O/0, I/1/L). That is not cosmetic — it
 * removes the single biggest source of "my code doesn't work" support load.
 */
@Injectable()
export class CodesService {
  private readonly logger = new Logger(CodesService.name);

  private static readonly ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: PlatformSettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  /**
   * Generates a batch of cards against one target.
   *
   * The scope is **frozen here**, at generation time, and never recomputed:
   *
   *  - a COURSE code records the sections that exist right now;
   *  - a TEACHER code records the courses assigned to that teacher right now;
   *  - a SECTION code needs no snapshot — it names one section.
   *
   * That is the whole point of the snapshot. A card sold in October must not
   * silently start unlocking a section added in December, because the buyer
   * did not pay for it and the seller did not price it.
   */
  async generateBatch(
    input: {
      targetType?: CodeTargetType;
      courseId?: string;
      sectionId?: string;
      teacherId?: string;
      coursePartId?: string;
      batchName?: string;
      count: number;
      maxRedemptions?: number;
      reservedForUserId?: string;
      accessDurationType?: 'LIFETIME' | 'FIXED_DAYS' | 'UNTIL_DATE';
      accessDurationDays?: number;
      accessEndsAt?: string;
      priceAmount?: number;
      currency?: string;
      expiresAt?: string;
      note?: string;
      prefix?: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    if (input.count < 1 || input.count > 5000) {
      throw AppException.validation({ count: ['must be between 1 and 5000'] });
    }

    const targetType = input.targetType ?? CodeTargetType.COURSE;
    const target = await this.resolveTarget(targetType, input);

    const prefix = (input.prefix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

    // Generate more candidates than needed, then insert with skipDuplicates so
    // a collision costs one fewer code instead of a failed batch.
    const codes = new Set<string>();
    while (codes.size < input.count) {
      codes.add(this.formatCode(prefix));
    }

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    const { batch, created } = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.codeBatch.create({
        data: {
          name: input.batchName ?? null,
          targetType,
          courseId: target.courseId,
          sectionId: target.sectionId,
          teacherId: target.teacherId,
          coursePartId: target.coursePartId,
          targetNameSnapshot: target.name,
          quantity: input.count,
          prefix: prefix || null,
          priceAmount: input.priceAmount ?? null,
          currency: input.currency ?? 'EGP',
          expiresAt,
          note: input.note ?? null,
          createdById: actor.id,
        },
      });

      const created = await tx.accessCode.createMany({
        data: [...codes].map((code) => ({
          code,
          targetType,
          courseId: target.courseId,
          sectionId: target.sectionId,
          teacherId: target.teacherId,
          coursePartId: target.coursePartId,
          grantedSectionIds: target.grantedSectionIds,
          grantedCourseIds: target.grantedCourseIds,
          batchId: batch.id,
          maxRedemptions: input.maxRedemptions ?? 1,
          reservedForUserId: input.reservedForUserId ?? null,
          accessDurationType: input.accessDurationType ?? null,
          accessDurationDays: input.accessDurationDays ?? null,
          accessEndsAt: input.accessEndsAt ? new Date(input.accessEndsAt) : null,
          priceAmount: input.priceAmount ?? null,
          currency: input.currency ?? 'EGP',
          expiresAt,
          note: input.note ?? null,
          issuedById: actor.id,
        })),
        skipDuplicates: true,
      });

      return { batch, created: created.count };
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CODE_ISSUE,
      entity: 'access_code_batch',
      entityId: batch.id,
      after: {
        requested: input.count,
        created,
        targetType,
        target: target.name,
        courseId: target.courseId,
        sectionId: target.sectionId,
        teacherId: target.teacherId,
        coursePartId: target.coursePartId,
        frozenSections: target.grantedSectionIds.length,
        frozenCourses: target.grantedCourseIds.length,
        maxRedemptions: input.maxRedemptions ?? 1,
      },
      note: input.note,
    });

    // Returns the plaintext codes exactly once, at creation. They are stored
    // in the clear because an admin must be able to read one out to a student
    // over the phone — hashing them would break the product.
    return {
      batchId: batch.id,
      batchName: batch.name,
      targetType,
      targetName: target.name,
      requested: input.count,
      created,
      codes: [...codes],
    };
  }

  /**
   * Validates the requested target and takes the scope snapshot.
   *
   * Sections in any non-deleted state are included, not just PUBLISHED: a
   * section that is temporarily hidden was still part of what the card was
   * sold for, and unhiding it later must not require re-issuing cards.
   */
  private async resolveTarget(
    targetType: CodeTargetType,
    input: {
      courseId?: string;
      sectionId?: string;
      teacherId?: string;
      coursePartId?: string;
    },
  ): Promise<{
    name: string;
    courseId: string | null;
    sectionId: string | null;
    teacherId: string | null;
    coursePartId: string | null;
    grantedSectionIds: string[];
    grantedCourseIds: string[];
  }> {
    if (targetType === CodeTargetType.PART) {
      if (!input.coursePartId) {
        throw AppException.validation({ coursePartId: ['is required for a part code'] });
      }
      const part = await this.prisma.coursePart.findFirst({
        where: { id: input.coursePartId, deletedAt: null },
        select: {
          id: true,
          title: true,
          courseId: true,
          course: { select: { title: true } },
          sections: {
            where: { deletedAt: null },
            orderBy: { sortOrder: 'asc' },
            select: { id: true },
          },
        },
      });
      if (!part) throw AppException.notFound('Course part', input.coursePartId);

      if (part.sections.length === 0) {
        // A card that unlocks nothing is worse than no card: the student pays,
        // redeems, and receives an empty part with no error to point at.
        throw AppException.validation({
          coursePartId: ['this part has no sections yet, so a card for it would unlock nothing'],
        });
      }

      return {
        name: `${part.course.title} — ${part.title}`,
        courseId: part.courseId,
        sectionId: null,
        teacherId: null,
        coursePartId: part.id,
        // Frozen here, exactly as a course card freezes its sections. A card
        // sold in October must not start unlocking a section added to the part
        // in December, because the buyer did not pay for it.
        grantedSectionIds: part.sections.map((s) => s.id),
        grantedCourseIds: [part.courseId],
      };
    }

    if (targetType === CodeTargetType.SECTION) {
      if (!input.sectionId) {
        throw AppException.validation({ sectionId: ['is required for a section code'] });
      }
      const section = await this.prisma.courseSection.findFirst({
        where: { id: input.sectionId, deletedAt: null },
        select: { id: true, title: true, courseId: true, course: { select: { title: true } } },
      });
      if (!section) throw AppException.notFound('Course section', input.sectionId);

      return {
        name: `${section.course.title} — ${section.title}`,
        courseId: section.courseId,
        sectionId: section.id,
        teacherId: null,
        coursePartId: null,
        grantedSectionIds: [section.id],
        grantedCourseIds: [section.courseId],
      };
    }

    if (targetType === CodeTargetType.TEACHER) {
      if (!input.teacherId) {
        throw AppException.validation({ teacherId: ['is required for a teacher code'] });
      }
      const teacher = await this.prisma.user.findFirst({
        where: { id: input.teacherId, role: UserRole.TEACHER, deletedAt: null },
        select: { id: true, fullName: true },
      });
      if (!teacher) throw AppException.notFound('Teacher', input.teacherId);

      const assignments = await this.prisma.courseTeacher.findMany({
        where: {
          teacherId: teacher.id,
          course: { deletedAt: null, status: { not: CourseStatus.ARCHIVED } },
        },
        select: { courseId: true },
      });
      const courseIds = assignments.map((a) => a.courseId);

      if (courseIds.length === 0) {
        throw AppException.validation({
          teacherId: ['this teacher has no courses to unlock'],
        });
      }

      return {
        name: teacher.fullName,
        courseId: null,
        sectionId: null,
        teacherId: teacher.id,
        coursePartId: null,
        grantedSectionIds: [],
        grantedCourseIds: courseIds,
      };
    }

    // COURSE (also the shape a legacy caller sends).
    if (!input.courseId) {
      throw AppException.validation({ courseId: ['is required for a course code'] });
    }
    const course = await this.prisma.course.findFirst({
      where: { id: input.courseId, deletedAt: null },
      select: {
        id: true,
        title: true,
        sections: { where: { deletedAt: null }, select: { id: true } },
      },
    });
    if (!course) throw AppException.notFound('Course', input.courseId);

    return {
      name: course.title,
      courseId: course.id,
      sectionId: null,
      teacherId: null,
      coursePartId: null,
      grantedSectionIds: course.sections.map((s) => s.id),
      grantedCourseIds: [course.id],
    };
  }

  private formatCode(prefix: string): string {
    const group = (length: number) =>
      Array.from(
        { length },
        () => CodesService.ALPHABET[randomInt(CodesService.ALPHABET.length)],
      ).join('');

    return prefix
      ? `${prefix}-${group(4)}-${group(4)}`
      : `${group(4)}-${group(4)}-${group(4)}`;
  }

  // ---------------------------------------------------------------------------
  // Validation (read-only preview, no side effects)
  // ---------------------------------------------------------------------------

  /**
   * Checks a code without consuming it, so the app can show "valid, grants 90
   * days" before the student commits. Deliberately returns the same error for
   * "no such code" and "expired code" — distinguishing them would turn this
   * into an oracle for enumerating valid codes.
   */
  async validate(rawCode: string, userId: string, courseId?: string) {
    const code = await this.prisma.accessCode.findUnique({
      where: { code: this.normalize(rawCode) },
      include: {
        course: { select: { id: true, title: true } },
        section: { select: { id: true, title: true } },
        teacher: { select: { id: true, fullName: true } },
      },
    });

    const invalid = () => new AppException(ErrorCode.INVALID_CODE);

    if (!code) throw invalid();
    // A recharge card carries no entitlement, and its `courseId` is null —
    // which the course path below would otherwise read as "unlocks anything".
    // This check is what stops a 50 EGP top-up card opening every course on
    // the platform, so it comes before any scope resolution.
    if (code.kind === CodeKind.RECHARGE) {
      throw new AppException(ErrorCode.CODE_NOT_RECHARGEABLE);
    }
    if (code.status === CodeStatus.REVOKED) throw invalid();
    if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) throw invalid();
    if (code.redemptionCount >= code.maxRedemptions) {
      throw new AppException(ErrorCode.CODE_ALREADY_USED);
    }
    if (code.reservedForUserId && code.reservedForUserId !== userId) throw invalid();
    if (courseId && code.courseId && code.courseId !== courseId) throw invalid();

    const alreadyUsedByThisStudent = await this.prisma.accessCodeRedemption.findUnique({
      where: { codeId_userId: { codeId: code.id, userId } },
      select: { id: true },
    });
    if (alreadyUsedByThisStudent) throw new AppException(ErrorCode.CODE_ALREADY_USED);

    return {
      valid: true,
      course: code.course,
      // Additive fields; the shipped mobile client ignores what it does not
      // read, and a future build can show what the card actually unlocks.
      targetType: code.targetType,
      section: code.section,
      teacher: code.teacher,
      remainingRedemptions: code.maxRedemptions - code.redemptionCount,
      accessDurationType: code.accessDurationType,
      accessDurationDays: code.accessDurationDays,
      expiresAt: code.expiresAt?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Redemption
  // ---------------------------------------------------------------------------

  /**
   * Consumes a code inside the caller's transaction.
   *
   * Must be called from a Serializable transaction (see MONEY_TX_OPTIONS): it
   * re-reads the counter and writes both the increment and the redemption row
   * atomically, which is what stops a race from over-redeeming.
   */
  async redeemInTransaction(
    tx: Prisma.TransactionClient,
    params: {
      rawCode: string;
      userId: string;
      courseId: string;
      enrollmentId?: string;
      ipAddress?: string | null;
      deviceKey?: string | null;
    },
  ): Promise<CodeValidation> {
    const normalized = this.normalize(params.rawCode);

    const code = await tx.accessCode.findUnique({ where: { code: normalized } });

    const invalid = () => new AppException(ErrorCode.INVALID_CODE);

    if (!code) throw invalid();
    // Same guard as validate(), repeated rather than shared because this is
    // the path that actually grants access: it must not depend on an earlier
    // call having been made.
    if (code.kind === CodeKind.RECHARGE) {
      throw new AppException(ErrorCode.CODE_NOT_RECHARGEABLE);
    }
    if (code.status === CodeStatus.REVOKED) throw invalid();
    if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) throw invalid();
    if (code.reservedForUserId && code.reservedForUserId !== params.userId) throw invalid();

    // Resolves — and enforces — what this code actually unlocks. Throws if the
    // course the student is standing in front of is not covered by the code.
    const scope = this.resolveScope(code, params.courseId);

    if (code.redemptionCount >= code.maxRedemptions) {
      throw new AppException(ErrorCode.CODE_ALREADY_USED);
    }

    // The unique (codeId, userId) index is the real guarantee; this check just
    // produces a nicer error than a constraint violation.
    const previous = await tx.accessCodeRedemption.findUnique({
      where: { codeId_userId: { codeId: code.id, userId: params.userId } },
    });
    if (previous) throw new AppException(ErrorCode.CODE_ALREADY_USED);

    await tx.accessCodeRedemption.create({
      data: {
        codeId: code.id,
        userId: params.userId,
        courseId: params.courseId,
        enrollmentId: params.enrollmentId,
        ipAddress: params.ipAddress ?? null,
        deviceKey: params.deviceKey ?? null,
      },
    });

    const nextCount = code.redemptionCount + 1;

    await tx.accessCode.update({
      where: { id: code.id },
      data: {
        redemptionCount: nextCount,
        status: nextCount >= code.maxRedemptions ? CodeStatus.EXHAUSTED : code.status,
      },
    });

    return {
      code: {
        id: code.id,
        courseId: code.courseId,
        coursePartId: code.coursePartId,
        accessDurationType: code.accessDurationType,
        accessDurationDays: code.accessDurationDays,
        accessEndsAt: code.accessEndsAt,
      },
      scope,
    };
  }

  /**
   * Turns a stored code into the concrete set of courses and sections it
   * unlocks, relative to the course the student is redeeming against.
   *
   * The legacy shape is honoured exactly: a row with `targetType = COURSE` and
   * an empty `grantedSectionIds` is a code issued before snapshots existed, and
   * it unlocks the whole course — which is what it always did. An empty
   * snapshot is therefore "not recorded", never "nothing".
   */
  private resolveScope(
    code: {
      targetType: CodeTargetType;
      courseId: string | null;
      sectionId: string | null;
      teacherId: string | null;
      coursePartId?: string | null;
      grantedSectionIds: string[];
      grantedCourseIds: string[];
    },
    requestedCourseId: string,
  ): RedemptionScope {
    return resolveRedemptionScope(code, requestedCourseId);
  }

  // ---------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------

  async list(params: {
    page: number;
    pageSize: number;
    courseId?: string;
    sectionId?: string;
    teacherId?: string;
    coursePartId?: string;
    targetType?: CodeTargetType;
    status?: CodeStatus;
    batchId?: string;
    q?: string;
  }) {
    const where: Prisma.AccessCodeWhereInput = {
      // Access cards only. Recharge cards have their own endpoint with the
      // financial columns this view has no place for.
      kind: CodeKind.ACCESS,
      ...(params.courseId ? { courseId: params.courseId } : {}),
      ...(params.sectionId ? { sectionId: params.sectionId } : {}),
      ...(params.teacherId ? { teacherId: params.teacherId } : {}),
      ...(params.coursePartId ? { coursePartId: params.coursePartId } : {}),
      ...(params.targetType ? { targetType: params.targetType } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.batchId ? { batchId: params.batchId } : {}),
      ...(params.q ? { code: { contains: params.q.toUpperCase() } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.accessCode.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          course: { select: { id: true, title: true } },
          section: { select: { id: true, title: true, courseId: true } },
          teacher: { select: { id: true, fullName: true } },
          coursePart: { select: { id: true, title: true } },
          batch: { select: { id: true, name: true, targetNameSnapshot: true } },
          issuedBy: { select: { id: true, fullName: true } },
          _count: { select: { redemptions: true } },
        },
      }),
      this.prisma.accessCode.count({ where }),
    ]);

    const offset = (params.page - 1) * params.pageSize;

    return paginated(
      rows.map((c, index) => ({
        id: c.id,
        // Row number within the current ordering, so the dashboard's "serial"
        // column is stable and meaningful without inventing a stored counter.
        serial: offset + index + 1,
        code: c.code,
        status: c.status,
        targetType: c.targetType,
        targetName: CodesService.targetNameOf(c),
        course: c.course,
        section: c.section,
        teacher: c.teacher,
        coursePart: c.coursePart,
        batchId: c.batchId,
        batchName: c.batch?.name ?? null,
        amount: c.priceAmount === null ? null : Number(c.priceAmount),
        currency: c.currency,
        maxRedemptions: c.maxRedemptions,
        redemptionCount: c._count.redemptions,
        reservedForUserId: c.reservedForUserId,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        issuedBy: c.issuedBy,
        note: c.note,
        createdAt: c.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /** Human-readable target, falling back through the batch snapshot. */
  private static targetNameOf(code: {
    targetType: CodeTargetType;
    course: { title: string } | null;
    section: { title: string } | null;
    teacher: { fullName: string } | null;
    coursePart?: { title: string } | null;
    batch: { targetNameSnapshot: string } | null;
  }): string {
    switch (code.targetType) {
      case CodeTargetType.PART:
        return code.coursePart
          ? `${code.course?.title ?? ''} — ${code.coursePart.title}`.trim()
          : (code.batch?.targetNameSnapshot ?? '—');
      case CodeTargetType.SECTION:
        return code.section
          ? `${code.course?.title ?? ''} — ${code.section.title}`.trim()
          : (code.batch?.targetNameSnapshot ?? '—');
      case CodeTargetType.TEACHER:
        return code.teacher?.fullName ?? code.batch?.targetNameSnapshot ?? '—';
      default:
        return code.course?.title ?? code.batch?.targetNameSnapshot ?? 'All courses';
    }
  }

  // ---------------------------------------------------------------------------
  // Batches
  // ---------------------------------------------------------------------------

  async listBatches(params: {
    page: number;
    pageSize: number;
    targetType?: CodeTargetType;
    q?: string;
  }) {
    const where: Prisma.CodeBatchWhereInput = {
      kind: CodeKind.ACCESS,
      ...(params.targetType ? { targetType: params.targetType } : {}),
      ...(params.q
        ? {
            OR: [
              { name: { contains: params.q, mode: 'insensitive' } },
              { targetNameSnapshot: { contains: params.q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.codeBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          createdBy: { select: { id: true, fullName: true } },
          _count: { select: { codes: true } },
        },
      }),
      this.prisma.codeBatch.count({ where }),
    ]);

    return paginated(
      rows.map((b) => ({
        id: b.id,
        name: b.name,
        targetType: b.targetType,
        targetName: b.targetNameSnapshot,
        courseId: b.courseId,
        sectionId: b.sectionId,
        teacherId: b.teacherId,
        quantity: b.quantity,
        cardCount: b._count.codes,
        prefix: b.prefix,
        amount: b.priceAmount === null ? null : Number(b.priceAmount),
        currency: b.currency,
        expiresAt: b.expiresAt?.toISOString() ?? null,
        note: b.note,
        createdBy: b.createdBy,
        createdAt: b.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /**
   * Every card in a batch, for the Excel export.
   *
   * Deliberately not paginated: an export of half a batch is worse than no
   * export. The generation cap (5 000) bounds the result.
   */
  async batchCodes(batchId: string) {
    const batch = await this.prisma.codeBatch.findUnique({
      where: { id: batchId },
      include: { createdBy: { select: { id: true, fullName: true } } },
    });
    if (!batch) throw AppException.notFound('Code batch', batchId);

    const codes = await this.prisma.accessCode.findMany({
      where: { batchId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        code: true,
        status: true,
        expiresAt: true,
        priceAmount: true,
        currency: true,
        redemptionCount: true,
        maxRedemptions: true,
        createdAt: true,
      },
    });

    return {
      batch: {
        id: batch.id,
        name: batch.name,
        targetType: batch.targetType,
        targetName: batch.targetNameSnapshot,
        quantity: batch.quantity,
        amount: batch.priceAmount === null ? null : Number(batch.priceAmount),
        currency: batch.currency,
        expiresAt: batch.expiresAt?.toISOString() ?? null,
        createdBy: batch.createdBy,
        createdAt: batch.createdAt.toISOString(),
      },
      codes: codes.map((c) => ({
        id: c.id,
        code: c.code,
        status: c.status,
        amount: c.priceAmount === null ? null : Number(c.priceAmount),
        currency: c.currency,
        redemptionCount: c.redemptionCount,
        maxRedemptions: c.maxRedemptions,
        expiresAt: c.expiresAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  }

  async redemptions(codeId: string, page: number, pageSize: number) {
    const where = { codeId };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.accessCodeRedemption.findMany({
        where,
        orderBy: { redeemedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { user: { select: { id: true, fullName: true, phone: true } } },
      }),
      this.prisma.accessCodeRedemption.count({ where }),
    ]);

    return paginated(rows, total, page, pageSize);
  }

  /**
   * Revokes a code. Past redemptions stand — a student who already used the
   * code keeps their access, because revoking a code is about stopping future
   * use, not clawing back a grant that was legitimately issued.
   */
  async revoke(codeId: string, actor: { id: string; role: UserRole }, reason: string) {
    const code = await this.prisma.accessCode.findUnique({ where: { id: codeId } });
    if (!code) throw AppException.notFound('Access code', codeId);

    const updated = await this.prisma.accessCode.update({
      where: { id: codeId },
      data: { status: CodeStatus.REVOKED, revokedAt: new Date(), revokedById: actor.id },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CODE_REVOKE,
      entity: 'access_code',
      entityId: codeId,
      before: { status: code.status },
      after: { status: updated.status },
      note: reason,
    });

    return { id: codeId, status: updated.status };
  }

  async revokeBatch(batchId: string, actor: { id: string; role: UserRole }, reason: string) {
    const { count } = await this.prisma.accessCode.updateMany({
      where: { batchId, status: { in: [CodeStatus.ACTIVE] } },
      data: { status: CodeStatus.REVOKED, revokedAt: new Date(), revokedById: actor.id },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CODE_REVOKE,
      entity: 'access_code_batch',
      entityId: batchId,
      after: { revoked: count },
      note: reason,
    });

    return { batchId, revoked: count };
  }

  /** Marks lapsed codes EXPIRED. Called by the nightly scheduler. */
  async expireLapsedCodes(): Promise<number> {
    const { count } = await this.prisma.accessCode.updateMany({
      where: { status: CodeStatus.ACTIVE, expiresAt: { lte: new Date() } },
      data: { status: CodeStatus.EXPIRED },
    });
    if (count > 0) this.logger.log(`expired ${count} access code(s)`);
    return count;
  }

  // ---------------------------------------------------------------------------
  // Recharge codes (wallet top-up)
  // ---------------------------------------------------------------------------

  /**
   * Generates a batch of wallet recharge cards.
   *
   * A recharge card is not an access card wearing a different hat: it carries
   * no course, no section and no entitlement at all. It carries money, and the
   * four numbers that describe that money are computed **once, here** and
   * frozen onto every card in the batch:
   *
   *     faceValue        what is printed on the card
   *     discountAmount   derived from the type, never supplied directly
   *     actualPaidAmount face value minus discount — THE REVENUE
   *     creditAmount     what lands in the wallet
   *
   * Freezing them at generation is what makes the financial history immutable.
   * Changing the minimum-recharge setting, or the discount policy, next month
   * cannot retroactively change what a card already in a student's hand is
   * worth, because nothing recomputes these values at redemption time.
   *
   * A 100% discount is supported and yields a giveaway card: 0 paid, 0 credits,
   * 0 revenue. It still redeems, and it still writes a revenue row, so the
   * giveaway appears in the report rather than being invisible.
   */
  async generateRechargeBatch(
    input: {
      faceValue: number;
      discountType?: DiscountType;
      discountPercent?: number;
      discountAmount?: number;
      count: number;
      batchName?: string;
      expiresAt?: string;
      reservedForUserId?: string;
      note?: string;
      prefix?: string;
      /**
       * Deliberately issues a card below the configured minimum. Honoured only
       * when the platform setting allows it; otherwise the request is refused
       * rather than quietly downgraded.
       */
      overrideMinimum?: boolean;
    },
    actor: { id: string; role: UserRole },
  ) {
    if (input.count < 1 || input.count > 5000) {
      throw AppException.validation({ count: ['must be between 1 and 5000'] });
    }

    // All validation and arithmetic happens server-side. The dashboard shows a
    // preview of these same numbers, but nothing it sends is trusted: the
    // request carries a face value and a discount, never a computed total.
    const money = resolveDiscount({
      faceValue: input.faceValue,
      discountType: input.discountType,
      discountPercent: input.discountPercent,
      discountAmount: input.discountAmount,
    });

    const bounds = await this.settings.rechargeBounds();
    const minPiastres = bounds.minimum * 100;
    const maxPiastres = bounds.maximum * 100;

    if (money.faceValuePiastres > maxPiastres) {
      throw AppException.validation({
        faceValue: [`must not exceed the configured maximum of ${bounds.maximum} EGP`],
      });
    }

    if (money.faceValuePiastres < minPiastres) {
      // The override exists for the genuine exception (a 10 EGP promotional
      // card). It is off by default and gated on a setting, so the floor is a
      // real floor rather than a suggestion the dashboard can talk its way past.
      if (!(input.overrideMinimum && bounds.allowOverride)) {
        throw new AppException(ErrorCode.AMOUNT_BELOW_MINIMUM, {
          message: `Recharge codes must be at least ${bounds.minimum} EGP`,
          fields: {
            faceValue: [`must be at least ${bounds.minimum} EGP`],
          },
          details: { minimum: bounds.minimum, provided: toEgpNumber(money.faceValuePiastres) },
        });
      }
    }

    const prefix = (input.prefix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

    const codes = new Set<string>();
    while (codes.size < input.count) {
      codes.add(this.formatCode(prefix));
    }

    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;

    const financial = {
      kind: CodeKind.RECHARGE,
      faceValue: money.faceValue,
      discountType: money.discountType,
      discountPercent: money.discountPercent,
      discountAmount: money.discountAmount,
      actualPaidAmount: money.actualPaidAmount,
      creditAmount: money.creditAmount,
    };

    const { batch, created } = await this.prisma.$transaction(async (tx) => {
      const batch = await tx.codeBatch.create({
        data: {
          name: input.batchName ?? null,
          // A recharge card has no target. The columns are required on the
          // batch for the access-card case, so they carry a self-describing
          // placeholder rather than a course that does not exist.
          targetType: CodeTargetType.COURSE,
          targetNameSnapshot: 'Wallet recharge',
          quantity: input.count,
          prefix: prefix || null,
          priceAmount: money.faceValue,
          currency: 'EGP',
          expiresAt,
          note: input.note ?? null,
          createdById: actor.id,
          ...financial,
        },
      });

      const created = await tx.accessCode.createMany({
        data: [...codes].map((code) => ({
          code,
          // No courseId, no sectionId, no teacherId, no granted* snapshot:
          // there is nothing for this card to unlock.
          targetType: CodeTargetType.COURSE,
          batchId: batch.id,
          maxRedemptions: 1,
          reservedForUserId: input.reservedForUserId ?? null,
          priceAmount: money.faceValue,
          currency: 'EGP',
          expiresAt,
          note: input.note ?? null,
          issuedById: actor.id,
          ...financial,
        })),
        skipDuplicates: true,
      });

      return { batch, created: created.count };
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CODE_ISSUE,
      entity: 'recharge_code_batch',
      entityId: batch.id,
      after: {
        requested: input.count,
        created,
        faceValue: toEgpNumber(money.faceValuePiastres),
        discountType: money.discountType,
        discountPercent: money.discountPercent,
        discountAmount: toEgpNumber(money.discountPiastres),
        actualPaidAmount: toEgpNumber(money.actualPaidPiastres),
        creditAmount: toEgpNumber(money.creditPiastres),
        expectedRevenue: toEgpNumber(money.actualPaidPiastres * created),
        belowMinimum: money.faceValuePiastres < minPiastres,
      },
      note: input.note,
    });

    return {
      batchId: batch.id,
      batchName: batch.name,
      requested: input.count,
      created,
      faceValue: toEgpNumber(money.faceValuePiastres),
      discountType: money.discountType,
      discountPercent: money.discountPercent,
      discountAmount: toEgpNumber(money.discountPiastres),
      actualPaidAmount: toEgpNumber(money.actualPaidPiastres),
      creditAmount: toEgpNumber(money.creditPiastres),
      /** What the whole batch is worth if every card sells and redeems. */
      expectedRevenue: toEgpNumber(money.actualPaidPiastres * created),
      expectedCredits: toEgpNumber(money.creditPiastres * created),
      // Returned once, at creation, for the same reason access codes are:
      // somebody has to be able to print or read them out.
      codes: [...codes],
    };
  }

  /**
   * Previews the money for a recharge card without creating anything.
   *
   * Exists so the dashboard can show "student pays 800, receives 800 credits"
   * as the administrator types, while the authoritative calculation stays on
   * the server. The dashboard never computes these numbers itself.
   */
  async previewRecharge(input: {
    faceValue: number;
    discountType?: DiscountType;
    discountPercent?: number;
    discountAmount?: number;
    count?: number;
  }) {
    const money = resolveDiscount(input);
    const bounds = await this.settings.rechargeBounds();
    const count = input.count ?? 1;

    return {
      faceValue: toEgpNumber(money.faceValuePiastres),
      discountType: money.discountType,
      discountPercent: money.discountPercent,
      discountAmount: toEgpNumber(money.discountPiastres),
      actualPaidAmount: toEgpNumber(money.actualPaidPiastres),
      creditAmount: toEgpNumber(money.creditPiastres),
      count,
      expectedRevenue: toEgpNumber(money.actualPaidPiastres * count),
      expectedCredits: toEgpNumber(money.creditPiastres * count),
      minimumRecharge: bounds.minimum,
      maximumRecharge: bounds.maximum,
      belowMinimum: money.faceValuePiastres < bounds.minimum * 100,
      overrideAllowed: bounds.allowOverride,
    };
  }

  /** Recharge cards for the admin table, with their frozen financials. */
  async listRechargeCodes(params: {
    page: number;
    pageSize: number;
    status?: CodeStatus;
    batchId?: string;
    redeemedByUserId?: string;
    from?: Date;
    to?: Date;
    q?: string;
    order?: 'asc' | 'desc';
  }) {
    const where: Prisma.AccessCodeWhereInput = {
      kind: CodeKind.RECHARGE,
      ...(params.status ? { status: params.status } : {}),
      ...(params.batchId ? { batchId: params.batchId } : {}),
      ...(params.redeemedByUserId ? { redeemedByUserId: params.redeemedByUserId } : {}),
      ...(params.from || params.to
        ? {
            createdAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
      ...(params.q ? { code: { contains: params.q.toUpperCase() } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.accessCode.findMany({
        where,
        orderBy: { createdAt: params.order ?? 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        select: {
          id: true,
          code: true,
          status: true,
          faceValue: true,
          discountType: true,
          discountPercent: true,
          discountAmount: true,
          actualPaidAmount: true,
          creditAmount: true,
          currency: true,
          expiresAt: true,
          redeemedAt: true,
          note: true,
          createdAt: true,
          batch: { select: { id: true, name: true } },
          issuedBy: { select: { id: true, fullName: true } },
          rechargeRevenue: { select: { id: true, recognizedAt: true } },
          redemptions: {
            select: { user: { select: { id: true, fullName: true, phone: true } } },
            take: 1,
          },
        },
      }),
      this.prisma.accessCode.count({ where }),
    ]);

    return paginated(
      rows.map((row) => ({
        id: row.id,
        code: row.code,
        status: row.status,
        faceValue: row.faceValue === null ? null : Number(row.faceValue),
        discountType: row.discountType,
        discountPercent: row.discountPercent === null ? null : Number(row.discountPercent),
        discountAmount: row.discountAmount === null ? null : Number(row.discountAmount),
        actualPaidAmount: row.actualPaidAmount === null ? null : Number(row.actualPaidAmount),
        creditAmount: row.creditAmount === null ? null : Number(row.creditAmount),
        currency: row.currency,
        batch: row.batch,
        issuedBy: row.issuedBy,
        redeemedAt: row.redeemedAt?.toISOString() ?? null,
        redeemedBy: row.redemptions[0]?.user ?? null,
        revenueRecognizedAt: row.rechargeRevenue?.recognizedAt.toISOString() ?? null,
        expiresAt: row.expiresAt?.toISOString() ?? null,
        note: row.note,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );
  }

  /**
   * Recharge revenue: what was actually collected.
   *
   * The total is a sum of `actualPaidAmount`, never of face values. The two
   * differ by exactly the discount given, and reporting the face value as
   * revenue is the single most expensive mistake this subsystem could make —
   * so the difference is returned alongside, as `discountGiven`, rather than
   * left for a reader to infer.
   */
  async rechargeRevenue(params: {
    page: number;
    pageSize: number;
    batchId?: string;
    userId?: string;
    from?: Date;
    to?: Date;
    order?: 'asc' | 'desc';
  }) {
    const where: Prisma.RechargeRevenueWhereInput = {
      ...(params.batchId ? { batchId: params.batchId } : {}),
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.from || params.to
        ? {
            recognizedAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total, totals] = await this.prisma.$transaction([
      this.prisma.rechargeRevenue.findMany({
        where,
        orderBy: { recognizedAt: params.order ?? 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { user: { select: { id: true, fullName: true, phone: true } } },
      }),
      this.prisma.rechargeRevenue.count({ where }),
      this.prisma.rechargeRevenue.aggregate({
        where,
        _sum: { faceValue: true, discountAmount: true, actualPaidAmount: true, creditAmount: true },
      }),
    ]);

    const page = paginated(
      rows.map((row) => ({
        id: row.id,
        code: row.codeSnapshot,
        batchId: row.batchId,
        batchName: row.batchNameSnapshot,
        student: row.user,
        faceValue: Number(row.faceValue),
        discountType: row.discountType,
        discountPercent: row.discountPercent === null ? null : Number(row.discountPercent),
        discountAmount: Number(row.discountAmount),
        actualPaidAmount: Number(row.actualPaidAmount),
        creditAmount: Number(row.creditAmount),
        currency: row.currency,
        recognizedAt: row.recognizedAt.toISOString(),
      })),
      total,
      params.page,
      params.pageSize,
    );

    return {
      ...page,
      totals: {
        faceValue: toEgpNumber(toPiastres(totals._sum.faceValue ?? 0, 'faceValue')),
        discountGiven: toEgpNumber(toPiastres(totals._sum.discountAmount ?? 0, 'discountAmount')),
        /** The real money collected. This is the revenue figure. */
        revenue: toEgpNumber(toPiastres(totals._sum.actualPaidAmount ?? 0, 'actualPaidAmount')),
        creditsIssued: toEgpNumber(toPiastres(totals._sum.creditAmount ?? 0, 'creditAmount')),
        count: total,
      },
    };
  }

  private normalize(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '');
  }
}

/**
 * Turns a stored code into the concrete set of courses and sections it
 * unlocks, relative to the course the student is redeeming against.
 *
 * A free function rather than a method because it is pure: no database, no
 * clock, no injected state. That makes the business rule — which is the part
 * that costs money when it is wrong — directly testable.
 *
 * The legacy shape is honoured exactly: a row with `targetType = COURSE` and
 * an empty `grantedSectionIds` is a code issued before snapshots existed, and
 * it unlocks the whole course, which is what it always did. An empty snapshot
 * therefore means "not recorded", never "nothing".
 */
export function resolveRedemptionScope(
  code: {
    targetType: CodeTargetType;
    courseId: string | null;
    sectionId: string | null;
    teacherId: string | null;
    coursePartId?: string | null;
    // Both columns are NOT NULL DEFAULT '{}' in the database, so a full row
    // always carries an array. They are optional here because a caller may
    // hand this function a narrowed `select`, and a missing snapshot has to
    // mean the same thing an empty one does — "not recorded" — rather than
    // throwing on `.length`.
    grantedSectionIds?: string[] | null;
    grantedCourseIds?: string[] | null;
  },
  requestedCourseId: string,
): RedemptionScope {
  const invalid = () => new AppException(ErrorCode.INVALID_CODE);

  const grantedSectionIds = code.grantedSectionIds ?? [];
  const grantedCourseIds = code.grantedCourseIds ?? [];

  if (code.targetType === CodeTargetType.SECTION) {
    if (!code.sectionId) throw invalid();
    if (code.courseId && code.courseId !== requestedCourseId) throw invalid();
    return {
      targetType: CodeTargetType.SECTION,
      courseIds: [requestedCourseId],
      sectionIds: [code.sectionId],
    };
  }

  if (code.targetType === CodeTargetType.PART) {
    // A part card unlocks exactly the sections frozen onto it at generation.
    // An empty snapshot here means "not recorded", and for a part that is a
    // corrupt row rather than "the whole course" — granting the course would
    // hand over everything for the price of one part.
    if (code.courseId && code.courseId !== requestedCourseId) throw invalid();
    if (grantedSectionIds.length === 0) throw invalid();
    return {
      targetType: CodeTargetType.PART,
      courseIds: [requestedCourseId],
      sectionIds: grantedSectionIds,
    };
  }

  if (code.targetType === CodeTargetType.TEACHER) {
    // Only the courses frozen at generation time. A course the teacher
    // published afterwards is deliberately not unlocked by an older card.
    if (!grantedCourseIds.includes(requestedCourseId)) throw invalid();
    return {
      targetType: CodeTargetType.TEACHER,
      courseIds: grantedCourseIds,
      sectionIds: null,
    };
  }

  // COURSE. A global code (courseId null) still works anywhere, which is how
  // free-trial campaigns are run.
  if (code.courseId && code.courseId !== requestedCourseId) throw invalid();

  return {
    targetType: CodeTargetType.COURSE,
    courseIds: [requestedCourseId],
    // A course code covers the sections that existed when it was issued.
    // No snapshot (legacy row, or a global code) means the whole course.
    sectionIds:
      grantedSectionIds.length > 0 && code.courseId === requestedCourseId
        ? grantedSectionIds
        : null,
  };
}
