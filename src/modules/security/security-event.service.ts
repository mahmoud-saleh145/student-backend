import { Injectable, Logger } from '@nestjs/common';
import {
  type Prisma,
  SecurityEventType,
  SecuritySeverity,
} from '@prisma/client';

import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { paginated, type Paginated } from '../../common/types/api-response';

export interface SecurityEventInput {
  type: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: string | null;
  courseId?: string | null;
  lessonId?: string | null;
  videoId?: string | null;
  ticketId?: string | null;
  deviceKey?: string | null;
  sessionId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  message?: string | null;
  metadata?: Record<string, unknown> | null;
}

const DEFAULT_SEVERITY: Record<SecurityEventType, SecuritySeverity> = {
  LOGIN_SUCCESS: SecuritySeverity.INFO,
  LOGIN_FAILED: SecuritySeverity.LOW,
  DEVICE_REGISTERED: SecuritySeverity.INFO,
  DEVICE_MISMATCH: SecuritySeverity.MEDIUM,
  DEVICE_REVOKED: SecuritySeverity.MEDIUM,
  INTEGRITY_FAILED: SecuritySeverity.HIGH,
  SCREENSHOT: SecuritySeverity.MEDIUM,
  RECORDING_STARTED: SecuritySeverity.HIGH,
  RECORDING_STOPPED: SecuritySeverity.INFO,
  EXTERNAL_DISPLAY: SecuritySeverity.MEDIUM,
  TICKET_DENIED: SecuritySeverity.LOW,
  TICKET_ABUSE: SecuritySeverity.HIGH,
  CONCURRENT_STREAM_BLOCKED: SecuritySeverity.MEDIUM,
  TOKEN_REUSE: SecuritySeverity.CRITICAL,
  UNAUTHORIZED_ACCESS: SecuritySeverity.MEDIUM,
};

/**
 * Security telemetry.
 *
 * Design stance: this system **observes and scores**, it does not punish.
 * Automatic bans on weak heuristics turn a flaky network or a shared family
 * tablet into a locked-out student, and the support cost of that exceeds the
 * piracy it prevents. What it does instead:
 *
 *  - persist every event server-side, where a patched client cannot strip it;
 *  - maintain cheap Redis counters so the playback service can make a
 *    *bounded, reversible* decision (stop this playback session) rather than a
 *    permanent one;
 *  - surface a risk score to humans, who decide on suspensions.
 *
 * The only automatic enforcement is per-session: too many capture attempts
 * ends that playback session. The account is untouched.
 */
@Injectable()
export class SecurityEventService {
  private readonly logger = new Logger(SecurityEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** Never throws — telemetry must not break the request it describes. */
  async record(input: SecurityEventInput): Promise<void> {
    const severity = input.severity ?? DEFAULT_SEVERITY[input.type] ?? SecuritySeverity.INFO;

    try {
      await this.prisma.securityEvent.create({
        data: {
          type: input.type,
          severity,
          userId: input.userId ?? null,
          courseId: input.courseId ?? null,
          lessonId: input.lessonId ?? null,
          videoId: input.videoId ?? null,
          ticketId: input.ticketId ?? null,
          deviceKey: input.deviceKey ?? null,
          sessionId: input.sessionId ?? null,
          ipAddress: input.ipAddress ?? null,
          userAgent: input.userAgent?.slice(0, 500) ?? null,
          message: input.message ?? null,
          metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
        },
      });

      if (input.userId) {
        await this.bumpCounters(input.userId, input.type, severity);
      }

      if (severity === SecuritySeverity.CRITICAL || severity === SecuritySeverity.HIGH) {
        this.logger.warn(
          `security ${input.type} severity=${severity} user=${input.userId ?? '-'} ${
            input.message ?? ''
          }`,
        );
      }
    } catch (e) {
      this.logger.error(`security event write failed: ${(e as Error).message}`);
    }
  }

  /** Rolling counters used for rate decisions and the risk score. */
  private async bumpCounters(
    userId: string,
    type: SecurityEventType,
    severity: SecuritySeverity,
  ): Promise<void> {
    const day = 24 * 3600;
    await Promise.all([
      this.redis.incrementWindow(`sec:${userId}:${type}:24h`, day),
      severity === SecuritySeverity.HIGH || severity === SecuritySeverity.CRITICAL
        ? this.redis.incrementWindow(`sec:${userId}:high:24h`, day)
        : Promise.resolve(0),
    ]);
  }

  async countRecent(userId: string, type: SecurityEventType, hours = 24): Promise<number> {
    const since = new Date(Date.now() - hours * 3600 * 1000);
    return this.prisma.securityEvent.count({
      where: { userId, type, occurredAt: { gte: since } },
    });
  }

  /**
   * Advisory 0-100 risk score for the admin UI. Never used to auto-block; it
   * exists so a human reviewing an account has a starting point.
   */
  async riskScore(userId: string): Promise<{
    score: number;
    signals: { type: SecurityEventType; count: number; weight: number }[];
  }> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);

    const grouped = await this.prisma.securityEvent.groupBy({
      by: ['type'],
      where: { userId, occurredAt: { gte: since } },
      _count: { _all: true },
    });

    const WEIGHTS: Partial<Record<SecurityEventType, number>> = {
      RECORDING_STARTED: 12,
      SCREENSHOT: 6,
      EXTERNAL_DISPLAY: 8,
      DEVICE_MISMATCH: 10,
      INTEGRITY_FAILED: 15,
      TICKET_ABUSE: 20,
      CONCURRENT_STREAM_BLOCKED: 8,
      TOKEN_REUSE: 25,
      LOGIN_FAILED: 2,
    };

    const signals = grouped.map((g) => ({
      type: g.type,
      count: g._count._all,
      weight: WEIGHTS[g.type] ?? 0,
    }));

    // Diminishing returns: ten screenshots is worse than one, but not ten
    // times worse, and the cap keeps a single noisy signal from pegging it.
    const raw = signals.reduce(
      (sum, s) => sum + s.weight * Math.min(4, Math.log2(s.count + 1)),
      0,
    );

    return { score: Math.min(100, Math.round(raw)), signals };
  }

  async list(params: {
    page: number;
    pageSize: number;
    userId?: string;
    type?: SecurityEventType;
    severity?: SecuritySeverity;
    from?: Date;
  }): Promise<Paginated<unknown>> {
    const where: Prisma.SecurityEventWhereInput = {
      ...(params.userId ? { userId: params.userId } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(params.severity ? { severity: params.severity } : {}),
      ...(params.from ? { occurredAt: { gte: params.from } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.securityEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { user: { select: { id: true, fullName: true, phone: true } } },
      }),
      this.prisma.securityEvent.count({ where }),
    ]);

    return paginated(items, total, params.page, params.pageSize);
  }
}
