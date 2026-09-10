import { Injectable, Logger } from '@nestjs/common';
import { type AuditAction, type Prisma, type UserRole } from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { paginated, type Paginated } from '../../common/types/api-response';

export interface AuditEntry {
  actorId?: string | null;
  actorRole?: UserRole | null;
  action: AuditAction;
  entity: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  note?: string | null;
}

/**
 * Append-only administrative trail.
 *
 * Two rules make this trustworthy:
 *  1. There is no update or delete path in the service — only `record` and
 *     read methods. Retention is handled by an offline archival job, not by
 *     the API.
 *  2. Snapshots are redacted before storage. An audit log that contains
 *     password hashes or tokens is itself a breach vector, so those keys are
 *     stripped rather than trusted not to be passed in.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  private static readonly REDACT_KEYS = [
    'password',
    'passwordhash',
    'confirmpassword',
    'token',
    'tokenhash',
    'accesstoken',
    'refreshtoken',
    'secret',
    'signature',
    'apikey',
    'authorization',
    'hmac',
  ];

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Writes an audit row. Never throws: a failure to audit must not roll back
   * the business operation that succeeded, but it is logged loudly so the gap
   * is visible in monitoring.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          actorId: entry.actorId ?? null,
          actorRole: entry.actorRole ?? null,
          action: entry.action,
          entity: entry.entity,
          entityId: entry.entityId ?? null,
          before: this.sanitize(entry.before) as Prisma.InputJsonValue,
          after: this.sanitize(entry.after) as Prisma.InputJsonValue,
          ipAddress: entry.ipAddress ?? null,
          userAgent: entry.userAgent?.slice(0, 500) ?? null,
          requestId: entry.requestId ?? null,
          note: entry.note ?? null,
        },
      });
    } catch (e) {
      this.logger.error(
        `AUDIT WRITE FAILED action=${entry.action} entity=${entry.entity} id=${entry.entityId}: ${
          (e as Error).message
        }`,
      );
    }
  }

  /** Same as record(), inside an existing transaction. */
  async recordTx(
    tx: Prisma.TransactionClient,
    entry: AuditEntry,
  ): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId ?? null,
        actorRole: entry.actorRole ?? null,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId ?? null,
        before: this.sanitize(entry.before) as Prisma.InputJsonValue,
        after: this.sanitize(entry.after) as Prisma.InputJsonValue,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent?.slice(0, 500) ?? null,
        requestId: entry.requestId ?? null,
        note: entry.note ?? null,
      },
    });
  }

  async list(params: {
    page: number;
    pageSize: number;
    actorId?: string;
    entity?: string;
    entityId?: string;
    action?: AuditAction;
    q?: string;
    from?: Date;
    to?: Date;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.entity ? { entity: params.entity } : {}),
      ...(params.entityId ? { entityId: params.entityId } : {}),
      ...(params.action ? { action: params.action } : {}),
      ...(params.q
        ? {
            OR: [
              { entity: { contains: params.q, mode: 'insensitive' } },
              { entityId: { contains: params.q } },
              { note: { contains: params.q, mode: 'insensitive' } },
              { actor: { fullName: { contains: params.q, mode: 'insensitive' } } },
            ],
          }
        : {}),
      ...(params.from || params.to
        ? { createdAt: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          actor: { select: { id: true, fullName: true, role: true, phone: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return paginated(items, total, params.page, params.pageSize);
  }

  /** Full history for one entity, newest first. */
  async forEntity(entity: string, entityId: string, limit = 50) {
    return this.prisma.auditLog.findMany({
      where: { entity, entityId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { actor: { select: { id: true, fullName: true, role: true } } },
    });
  }

  private sanitize(value: unknown, depth = 0): unknown {
    if (value === undefined || value === null) return undefined;
    if (depth > 5) return '«deep»';

    if (Array.isArray(value)) {
      return value.slice(0, 50).map((v) => this.sanitize(v, depth + 1));
    }

    if (value instanceof Date) return value.toISOString();

    if (typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = AuditService.REDACT_KEYS.some((r) => k.toLowerCase().includes(r))
          ? '«redacted»'
          : this.sanitize(v, depth + 1);
      }
      return out;
    }

    if (typeof value === 'bigint') return value.toString();

    return value;
  }

  /**
   * Successful student sign-ins.
   *
   * Sourced from `security_events` (LOGIN_SUCCESS), which is where the auth
   * path already records them — there is no second, parallel log to keep in
   * sync. Device and IP come off the same row.
   */
  async loginLog(params: {
    page: number;
    pageSize: number;
    q?: string;
    from?: Date;
    to?: Date;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.SecurityEventWhereInput = {
      type: 'LOGIN_SUCCESS',
      user: { role: 'STUDENT' },
      ...(params.q
        ? {
            user: {
              role: 'STUDENT',
              OR: [
                { fullName: { contains: params.q, mode: 'insensitive' } },
                { phone: { contains: params.q.replace(/\D/g, '') } },
              ],
            },
          }
        : {}),
      ...(params.from || params.to
        ? {
            occurredAt: {
              ...(params.from ? { gte: params.from } : {}),
              ...(params.to ? { lte: params.to } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.securityEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: {
            select: {
              id: true,
              fullName: true,
              phone: true,
              createdAt: true,
              studentProfile: {
                select: {
                  university: { select: { name: true, nameAr: true } },
                  academicYear: { select: { name: true, nameAr: true } },
                },
              },
            },
          },
        },
      }),
      this.prisma.securityEvent.count({ where }),
    ]);

    const items = rows.map((row) => {
      const devices = row.metadata as { platform?: string; model?: string } | null;
      return {
        id: row.id,
        student: row.user
          ? {
              id: row.user.id,
              fullName: row.user.fullName,
              phone: row.user.phone,
              university: row.user.studentProfile?.university ?? null,
              academicYear: row.user.studentProfile?.academicYear ?? null,
              registeredAt: row.user.createdAt.toISOString(),
            }
          : null,
        deviceKey: row.deviceKey,
        platform: devices?.platform ?? null,
        model: devices?.model ?? null,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        occurredAt: row.occurredAt.toISOString(),
      };
    });

    return paginated(items, total, params.page, params.pageSize);
  }
}
