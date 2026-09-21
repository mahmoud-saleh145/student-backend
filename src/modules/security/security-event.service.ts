import { Injectable, Logger } from '@nestjs/common';
import {
  Prisma,
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

  /**
   * Never throws — telemetry must not break the request it describes.
   *
   * The outer guard makes that a property of the method rather than something
   * a reader has to verify by tracing every branch. Callers await this on
   * paths that are already failing — an expired session, a reused token — and
   * a throw here would replace a deliberate 401 with an accidental 500. That
   * is a worse outcome than losing the event, so nothing escapes.
   */
  async record(input: SecurityEventInput): Promise<void> {
    try {
      await this.write(input);
    } catch (e) {
      this.logger.error(`security event recording failed: ${(e as Error).message}`);
    }
  }

  private async write(input: SecurityEventInput): Promise<void> {
    const severity = input.severity ?? DEFAULT_SEVERITY[input.type] ?? SecuritySeverity.INFO;
    const data = this.toCreateData(input, severity);

    try {
      await this.prisma.securityEvent.create({ data });

      if (input.userId) {
        await this.bumpCounters(input.userId, input.type, severity);
      }

      this.warnIfSevere(input, severity);
    } catch (e) {
      // A reference that no longer resolves must not cost us the event.
      //
      // The clearest case is a refresh token whose signature still verifies
      // but whose account is gone: the token carries a `sub` that was never
      // checked against `users`, so the insert trips
      // `security_events_userId_fkey`. That event is precisely the one worth
      // keeping — a valid signature for a non-existent user is either a stale
      // client or a leaked secret — and the schema already allows it, since
      // `userId` is nullable for events with no user behind them.
      //
      // So the dangling reference is detached and the row is written again
      // with the claimed id preserved in `metadata`. The retry costs nothing
      // in the normal case: it runs only after the database has actually
      // refused the write.
      const detached = this.detachDanglingReference(e, data);

      if (detached) {
        try {
          await this.prisma.securityEvent.create({ data: detached });
          // Counters are deliberately not bumped. They feed a risk score for
          // an account, and there is no account here to score.
          this.logger.warn(
            `security ${input.type} recorded without its dangling reference: ${
              (e as Error).message.split('\n')[0] ?? ''
            }`,
          );
          this.warnIfSevere(input, severity);
          return;
        } catch (retryError) {
          this.logger.error(
            `security event retry failed: ${(retryError as Error).message}`,
          );
          return;
        }
      }

      this.logger.error(`security event write failed: ${(e as Error).message}`);
    }
  }

  private toCreateData(
    input: SecurityEventInput,
    severity: SecuritySeverity,
  ): Prisma.SecurityEventUncheckedCreateInput {
    return {
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
    };
  }

  /**
   * Rewrites the row so a foreign key that no longer resolves becomes null.
   *
   * Returns null when the failure was not a foreign-key violation, or when
   * there is no reference left to detach — in both cases the caller should
   * report the original error rather than retry a write that will fail again.
   *
   * `userId` and `ticketId` are the only relations on this model; the other
   * id columns carry no constraint, so a violation can only be one of these.
   */
  private detachDanglingReference(
    error: unknown,
    data: Prisma.SecurityEventUncheckedCreateInput,
  ): Prisma.SecurityEventUncheckedCreateInput | null {
    if (
      !(error instanceof Prisma.PrismaClientKnownRequestError) ||
      error.code !== 'P2003'
    ) {
      return null;
    }

    // Postgres names the constraint; Prisma surfaces it as `field_name`.
    // Matching on the substring rather than the exact string keeps this
    // working across the formats Prisma has used for it.
    const field = String(error.meta?.['field_name'] ?? '');
    const hitsUser = field.includes('userId') && data.userId != null;
    const hitsTicket = field.includes('ticketId') && data.ticketId != null;

    // An unrecognised constraint name: detach whichever relations are set, so
    // a future relation on this model still degrades to a recorded event
    // rather than a lost one.
    const blind = !hitsUser && !hitsTicket;
    const dropUser = hitsUser || (blind && data.userId != null);
    const dropTicket = hitsTicket || (blind && data.ticketId != null);

    if (!dropUser && !dropTicket) return null;

    const existing =
      data.metadata && typeof data.metadata === 'object' && !Array.isArray(data.metadata)
        ? (data.metadata as Record<string, unknown>)
        : {};

    return {
      ...data,
      ...(dropUser ? { userId: null } : {}),
      ...(dropTicket ? { ticketId: null } : {}),
      metadata: {
        ...existing,
        // The id is kept as plain data so the trail still names who the
        // client claimed to be, without asserting a relationship the
        // database cannot vouch for.
        ...(dropUser ? { orphanedUserId: data.userId } : {}),
        ...(dropTicket ? { orphanedTicketId: data.ticketId } : {}),
      } as Prisma.InputJsonValue,
    };
  }

  private warnIfSevere(input: SecurityEventInput, severity: SecuritySeverity): void {
    if (severity === SecuritySeverity.CRITICAL || severity === SecuritySeverity.HIGH) {
      this.logger.warn(
        `security ${input.type} severity=${severity} user=${input.userId ?? '-'} ${
          input.message ?? ''
        }`,
      );
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
