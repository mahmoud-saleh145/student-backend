import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  CodeStatus,
  type Prisma,
  UserRole,
} from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { paginated } from '../../common/types/api-response';
import { MONEY_TX_OPTIONS, PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

export interface CodeValidation {
  code: {
    id: string;
    courseId: string | null;
    accessDurationType: string | null;
    accessDurationDays: number | null;
    accessEndsAt: Date | null;
  };
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
  ) {}

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  async generateBatch(
    input: {
      courseId?: string;
      count: number;
      maxRedemptions?: number;
      reservedForUserId?: string;
      accessDurationType?: 'LIFETIME' | 'FIXED_DAYS' | 'UNTIL_DATE';
      accessDurationDays?: number;
      accessEndsAt?: string;
      expiresAt?: string;
      note?: string;
      prefix?: string;
    },
    actor: { id: string; role: UserRole },
  ) {
    if (input.count < 1 || input.count > 5000) {
      throw AppException.validation({ count: ['must be between 1 and 5000'] });
    }

    if (input.courseId) {
      const course = await this.prisma.course.findFirst({
        where: { id: input.courseId, deletedAt: null },
        select: { id: true },
      });
      if (!course) throw AppException.notFound('Course', input.courseId);
    }

    const batchId = randomUUID();
    const prefix = (input.prefix ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

    // Generate more candidates than needed, then insert with skipDuplicates so
    // a collision costs one fewer code instead of a failed batch.
    const codes = new Set<string>();
    while (codes.size < input.count) {
      codes.add(this.formatCode(prefix));
    }

    const rows = [...codes].map((code) => ({
      code,
      courseId: input.courseId ?? null,
      batchId,
      maxRedemptions: input.maxRedemptions ?? 1,
      reservedForUserId: input.reservedForUserId ?? null,
      accessDurationType: input.accessDurationType ?? null,
      accessDurationDays: input.accessDurationDays ?? null,
      accessEndsAt: input.accessEndsAt ? new Date(input.accessEndsAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      note: input.note ?? null,
      issuedById: actor.id,
    }));

    const created = await this.prisma.accessCode.createMany({
      data: rows,
      skipDuplicates: true,
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.CODE_ISSUE,
      entity: 'access_code_batch',
      entityId: batchId,
      after: {
        requested: input.count,
        created: created.count,
        courseId: input.courseId,
        maxRedemptions: input.maxRedemptions ?? 1,
      },
      note: input.note,
    });

    // Returns the plaintext codes exactly once, at creation. They are stored
    // in the clear because an admin must be able to read one out to a student
    // over the phone — hashing them would break the product.
    return {
      batchId,
      requested: input.count,
      created: created.count,
      codes: [...codes],
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
      include: { course: { select: { id: true, title: true } } },
    });

    const invalid = () => new AppException(ErrorCode.INVALID_CODE);

    if (!code) throw invalid();
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
    if (code.status === CodeStatus.REVOKED) throw invalid();
    if (code.expiresAt && code.expiresAt.getTime() <= Date.now()) throw invalid();
    if (code.reservedForUserId && code.reservedForUserId !== params.userId) throw invalid();

    // A course-scoped code only works on that course. A global code (courseId
    // null) works anywhere, which is how "free trial" campaigns are run.
    if (code.courseId && code.courseId !== params.courseId) throw invalid();

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
        accessDurationType: code.accessDurationType,
        accessDurationDays: code.accessDurationDays,
        accessEndsAt: code.accessEndsAt,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Administration
  // ---------------------------------------------------------------------------

  async list(params: {
    page: number;
    pageSize: number;
    courseId?: string;
    status?: CodeStatus;
    batchId?: string;
    q?: string;
  }) {
    const where: Prisma.AccessCodeWhereInput = {
      ...(params.courseId ? { courseId: params.courseId } : {}),
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
          issuedBy: { select: { id: true, fullName: true } },
          _count: { select: { redemptions: true } },
        },
      }),
      this.prisma.accessCode.count({ where }),
    ]);

    return paginated(
      rows.map((c) => ({
        id: c.id,
        code: c.code,
        status: c.status,
        course: c.course,
        batchId: c.batchId,
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

  private normalize(code: string): string {
    return code.trim().toUpperCase().replace(/\s+/g, '');
  }
}
