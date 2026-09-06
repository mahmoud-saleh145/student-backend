import { Injectable, Logger } from '@nestjs/common';
import {
  AuditAction,
  type DeviceStatus,
  PlaybackTicketStatus,
  type Prisma,
  SessionStatus,
  type UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import type { AuthenticatedUser } from '../../common/types/request-context';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

/**
 * Administrative session management.
 *
 * A student's own sessions are handled by `/auth/sessions` and
 * `/auth/logout-all` — that is the pair the mobile app uses. This module is
 * the staff-facing counterpart: it answers "who is logged in on this account,
 * from where, and how do I cut it off".
 *
 * Two things this deliberately does NOT do:
 *
 *  1. **It never reads or reissues tokens.** Revocation flips session state
 *     and kills the refresh-token family; the already-issued access token
 *     stays cryptographically valid until it expires, but `JwtAuthGuard`
 *     re-checks session status on every request, so the practical revocation
 *     latency is one request rather than one token lifetime.
 *
 *  2. **It does not ban accounts.** Ending sessions is reversible — the
 *     student simply signs in again. Suspending an account is a separate,
 *     deliberate action (spec §91: security automation stays conservative and
 *     auditable).
 */
@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  async listForUser(params: {
    userId: string;
    page: number;
    pageSize: number;
    activeOnly?: boolean;
  }) {
    const where: Prisma.SessionWhereInput = {
      userId: params.userId,
      ...(params.activeOnly
        ? { status: SessionStatus.ACTIVE, expiresAt: { gt: new Date() } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.session.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: { device: { select: DEVICE_SELECT } },
      }),
      this.prisma.session.count({ where }),
    ]);

    return {
      items: rows.map((row) => serializeSession(row)),
      meta: pageMeta(params.page, params.pageSize, total),
    };
  }

  /**
   * Platform-wide active-session view for the master console.
   *
   * Sorted by last activity, because this is an operational view ("what is
   * happening right now") rather than an analytics one.
   */
  async listActive(params: { page: number; pageSize: number; role?: UserRole }) {
    const where: Prisma.SessionWhereInput = {
      status: SessionStatus.ACTIVE,
      expiresAt: { gt: new Date() },
      ...(params.role ? { user: { role: params.role } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.session.findMany({
        where,
        orderBy: { lastSeenAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: { select: { id: true, fullName: true, role: true, phone: true } },
          device: { select: DEVICE_SELECT },
        },
      }),
      this.prisma.session.count({ where }),
    ]);

    return {
      items: rows.map((row) => ({
        ...serializeSession(row),
        user: {
          id: row.user.id,
          fullName: row.user.fullName,
          role: row.user.role,
          // Phone is the login identifier, so staff need it to match a support
          // ticket to a session. Nothing else personal is exposed here.
          phone: row.user.phone,
        },
      })),
      meta: pageMeta(params.page, params.pageSize, total),
    };
  }

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------

  async revoke(params: { sessionId: string; actor: AuthenticatedUser; reason: string }) {
    const session = await this.prisma.session.findUnique({
      where: { id: params.sessionId },
      select: { id: true, userId: true, status: true },
    });

    if (!session) throw AppException.notFound('Session', params.sessionId);

    if (session.status !== SessionStatus.ACTIVE) {
      // Idempotent: revoking an already-dead session is a success, not a
      // conflict. Support staff clicking twice should not see an error.
      return { ok: true as const, alreadyEnded: true };
    }

    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.session.update({
        where: { id: session.id },
        data: {
          status: SessionStatus.REVOKED,
          revokedAt: now,
          revokedReason: params.reason,
        },
      });

      await tx.refreshToken.updateMany({
        where: { sessionId: session.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: params.reason },
      });

      // Live playback bound to this session dies with it. Without this, a
      // revoked session keeps streaming until its ticket expires.
      await tx.playbackTicket.updateMany({
        where: { sessionId: session.id, status: PlaybackTicketStatus.ACTIVE },
        data: {
          status: PlaybackTicketStatus.REVOKED,
          revokedAt: now,
          revokedReason: params.reason,
        },
      });
    });

    await this.audit.record({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.ACCESS_REVOKE,
      entity: 'Session',
      entityId: session.id,
      note: params.reason,
      after: { targetUserId: session.userId, status: SessionStatus.REVOKED },
    });

    return { ok: true as const, alreadyEnded: false };
  }

  async revokeAllForUser(params: {
    userId: string;
    actor: AuthenticatedUser;
    reason: string;
  }) {
    const now = new Date();

    const count = await this.prisma.$transaction(async (tx) => {
      const sessions = await tx.session.findMany({
        where: { userId: params.userId, status: SessionStatus.ACTIVE },
        select: { id: true },
      });

      if (sessions.length === 0) return 0;

      const ids = sessions.map((s) => s.id);

      await tx.session.updateMany({
        where: { id: { in: ids } },
        data: {
          status: SessionStatus.REVOKED,
          revokedAt: now,
          revokedReason: params.reason,
        },
      });

      await tx.refreshToken.updateMany({
        where: { sessionId: { in: ids }, revokedAt: null },
        data: { revokedAt: now, revokedReason: params.reason },
      });

      await tx.playbackTicket.updateMany({
        where: { sessionId: { in: ids }, status: PlaybackTicketStatus.ACTIVE },
        data: {
          status: PlaybackTicketStatus.REVOKED,
          revokedAt: now,
          revokedReason: params.reason,
        },
      });

      return ids.length;
    });

    await this.audit.record({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.ACCESS_REVOKE,
      entity: 'User',
      entityId: params.userId,
      note: params.reason,
      after: { revokedSessions: count },
    });

    this.logger.log(
      `revoked ${count} session(s) for user ${params.userId} by ${params.actor.id}`,
    );

    return { ok: true as const, sessions: count };
  }

  /**
   * Ends every playback grant for a user without touching their login.
   *
   * This is the proportionate response to a capture-tool detection: the
   * student is not signed out of the app, they simply cannot stream until a
   * fresh playback request passes the full authorization chain again.
   */
  async revokePlaybackForUser(params: {
    userId: string;
    actor: AuthenticatedUser;
    reason: string;
  }) {
    const now = new Date();

    const result = await this.prisma.playbackTicket.updateMany({
      where: { userId: params.userId, status: PlaybackTicketStatus.ACTIVE },
      data: {
        status: PlaybackTicketStatus.REVOKED,
        revokedAt: now,
        revokedReason: params.reason,
      },
    });

    await this.audit.record({
      actorId: params.actor.id,
      actorRole: params.actor.role,
      action: AuditAction.ACCESS_REVOKE,
      entity: 'PlaybackTicket',
      entityId: params.userId,
      note: params.reason,
      after: { revokedTickets: result.count },
    });

    return { ok: true as const, tickets: result.count };
  }
}

// -----------------------------------------------------------------------------

const DEVICE_SELECT = {
  id: true,
  deviceKey: true,
  platform: true,
  model: true,
  name: true,
  status: true,
} as const;

interface SerializableSession {
  id: string;
  status: SessionStatus;
  ipAddress: string | null;
  platform: string | null;
  appVersion: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
  device: {
    id: string;
    deviceKey: string;
    platform: string;
    model: string | null;
    name: string;
    status: DeviceStatus;
  } | null;
}

function serializeSession(row: SerializableSession) {
  return {
    id: row.id,
    status: row.status,
    // Truncated to the /24 (or /48 for v6) network. Staff need "did this jump
    // continents", not the student's exact address (spec §42).
    network: maskIp(row.ipAddress),
    platform: row.platform,
    appVersion: row.appVersion,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedReason: row.revokedReason,
    device: row.device
      ? {
          id: row.device.id,
          // Never the raw key — that is the secret the client presents.
          fingerprint: `${row.device.deviceKey.slice(0, 6)}…`,
          platform: row.device.platform,
          model: row.device.model,
          name: row.device.name,
          status: row.device.status,
        }
      : null,
  };
}

function pageMeta(page: number, pageSize: number, total: number) {
  return {
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    hasNext: page * pageSize < total,
    hasPrevious: page > 1,
  };
}

/** IPv4 → a.b.c.0/24, IPv6 → first three hextets /48. */
function maskIp(ip: string | null): string | null {
  if (!ip) return null;
  if (ip.includes(':')) {
    const parts = ip.split(':').filter(Boolean);
    return `${parts.slice(0, 3).join(':')}::/48`;
  }
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}
