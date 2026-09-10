import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AuditAction,
  DeviceChangeStatus,
  DeviceStatus,
  SecurityEventType,
  SecuritySeverity,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { DeviceContext } from '../../common/types/request-context';
import type { DeviceConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { PlatformSettingsService } from '../settings/platform-settings.service';
import { SecurityEventService } from '../security/security-event.service';

export interface DeviceResolution {
  deviceId: string | null;
  status: DeviceStatus | null;
  /** True when this login just created and authorized a new device row. */
  registered: boolean;
  /** True when the device is allowed to view protected content. */
  authorized: boolean;
  /** Populated when not authorized, so callers can pick the right error. */
  reason?:
    | 'not-authorized'
    | 'limit-reached'
    | 'change-pending'
    | 'revoked'
    | 'integrity'
    | 'no-device-header';
}

/**
 * Device binding.
 *
 * Product rule (spec §39): a student account is intended to be usable from one
 * authorized device. Two decisions shape the implementation:
 *
 *  1. **Binding gates protected content, not login.** A student who buys a new
 *     phone can still sign in, see their courses, read announcements and
 *     contact support from it. Only protected playback and protected materials
 *     are refused. Blocking login outright generates support tickets from
 *     people who cannot even reach the "request a device change" screen.
 *
 *  2. **The first device auto-binds** (configurable). Requiring an admin to
 *     approve every new registration would make onboarding unusable; the
 *     anti-sharing value comes from the *second* device being refused.
 *
 * Staff accounts (master/admin/teacher) are never device-bound — they work
 * from the dashboard on desktops.
 */
@Injectable()
export class DevicesService {
  private readonly logger = new Logger(DevicesService.name);
  private readonly cfg: DeviceConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly security: SecurityEventService,
    private readonly audit: AuditService,
    private readonly settings: PlatformSettingsService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<DeviceConfig>('device');
  }

  /**
   * How many devices this account may bind.
   *
   * The administrator-editable platform setting is authoritative; the
   * DEVICE_LIMIT_PER_STUDENT environment variable remains the fallback, so an
   * existing deployment that never touches the dashboard keeps its configured
   * limit unchanged.
   */
  private async deviceLimit(): Promise<number> {
    return this.settings.deviceLimit();
  }

  // ---------------------------------------------------------------------------
  // Login-time resolution
  // ---------------------------------------------------------------------------

  /**
   * Called during login. Registers the device when the account has none, marks
   * it seen when it is the bound one, and records a mismatch otherwise.
   * Never throws — login proceeds regardless; the resolution is returned so
   * the caller can report the state to the client.
   */
  async resolveOnLogin(
    userId: string,
    role: UserRole,
    device: DeviceContext,
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<DeviceResolution> {
    // Staff are not device-bound.
    if (role !== UserRole.STUDENT) {
      return { deviceId: null, status: null, registered: false, authorized: true };
    }

    if (!device.deviceKey) {
      return {
        deviceId: null,
        status: null,
        registered: false,
        authorized: false,
        reason: 'no-device-header',
      };
    }

    const existing = await this.prisma.device.findUnique({
      where: { userId_deviceKey: { userId, deviceKey: device.deviceKey } },
    });

    if (existing) {
      return this.handleKnownDevice(existing.id, existing.status, userId, device, context);
    }

    return this.handleUnknownDevice(userId, device, context);
  }

  private async handleKnownDevice(
    deviceId: string,
    status: DeviceStatus,
    userId: string,
    device: DeviceContext,
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<DeviceResolution> {
    await this.prisma.device.update({
      where: { id: deviceId },
      data: {
        lastSeenAt: new Date(),
        // Refresh the descriptor: an OS upgrade should not look like a new device.
        name: device.name ?? undefined,
        model: device.model ?? undefined,
        osVersion: device.osVersion ?? undefined,
        appVersion: device.appVersion ?? undefined,
        integritySuspect: device.integritySuspect,
      },
    });

    if (status === DeviceStatus.ACTIVE) {
      if (device.integritySuspect && this.cfg.blockOnIntegrityFailure) {
        await this.security.record({
          type: SecurityEventType.INTEGRITY_FAILED,
          userId,
          deviceKey: device.deviceKey,
          ipAddress: context.ip,
          userAgent: context.userAgent,
          message: 'Client reported failed integrity checks',
        });
        return {
          deviceId,
          status,
          registered: false,
          authorized: false,
          reason: 'integrity',
        };
      }
      return { deviceId, status, registered: false, authorized: true };
    }

    const reason =
      status === DeviceStatus.PENDING_APPROVAL
        ? ('change-pending' as const)
        : ('revoked' as const);

    return { deviceId, status, registered: false, authorized: false, reason };
  }

  private async handleUnknownDevice(
    userId: string,
    device: DeviceContext,
    context: { ip?: string | null; userAgent?: string | null },
  ): Promise<DeviceResolution> {
    const activeCount = await this.prisma.device.count({
      where: { userId, status: DeviceStatus.ACTIVE },
    });

    const withinLimit = activeCount < (await this.deviceLimit());
    const shouldAutoBind = withinLimit && (activeCount === 0 ? this.cfg.autoBindFirst : true);

    const created = await this.prisma.device.create({
      data: {
        userId,
        deviceKey: device.deviceKey!,
        name: device.name ?? `${device.platform ?? 'Unknown'} device`,
        platform: device.platform ?? 'unknown',
        model: device.model,
        osVersion: device.osVersion,
        appVersion: device.appVersion,
        integritySuspect: device.integritySuspect,
        status: shouldAutoBind ? DeviceStatus.ACTIVE : DeviceStatus.PENDING_APPROVAL,
        approvedAt: shouldAutoBind ? new Date() : null,
      },
    });

    if (shouldAutoBind) {
      await this.security.record({
        type: SecurityEventType.DEVICE_REGISTERED,
        severity: SecuritySeverity.INFO,
        userId,
        deviceKey: device.deviceKey,
        ipAddress: context.ip,
        userAgent: context.userAgent,
        message: `Auto-bound first device (${created.name})`,
      });

      return {
        deviceId: created.id,
        status: created.status,
        registered: true,
        authorized: !(device.integritySuspect && this.cfg.blockOnIntegrityFailure),
        reason:
          device.integritySuspect && this.cfg.blockOnIntegrityFailure
            ? 'integrity'
            : undefined,
      };
    }

    // Second device on a limit-1 account: the anti-sharing case.
    await this.security.record({
      type: SecurityEventType.DEVICE_MISMATCH,
      severity: SecuritySeverity.MEDIUM,
      userId,
      deviceKey: device.deviceKey,
      ipAddress: context.ip,
      userAgent: context.userAgent,
      message: `Login from an unbound device (${created.name}); account already has ${activeCount} active device(s)`,
    });

    return {
      deviceId: created.id,
      status: created.status,
      registered: true,
      authorized: false,
      reason: 'limit-reached',
    };
  }

  // ---------------------------------------------------------------------------
  // Protected-content gate
  // ---------------------------------------------------------------------------

  /**
   * Throws unless this exact device may view protected content right now.
   * Called by the playback and attachment ticket paths — the two places where
   * device binding actually matters.
   */
  async assertAuthorizedForProtectedContent(params: {
    userId: string;
    role: UserRole;
    deviceKey: string | null;
    integritySuspect: boolean;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<{ deviceId: string | null }> {
    if (params.role !== UserRole.STUDENT) {
      // Staff previewing content are not device-bound.
      return { deviceId: null };
    }

    if (!params.deviceKey) {
      await this.security.record({
        type: SecurityEventType.DEVICE_MISMATCH,
        userId: params.userId,
        ipAddress: params.ip,
        message: 'Protected content requested without an X-Device-Id header',
      });
      throw new AppException(ErrorCode.DEVICE_NOT_AUTHORIZED, {
        message: 'X-Device-Id header is required for protected content',
      });
    }

    if (params.integritySuspect && this.cfg.blockOnIntegrityFailure) {
      await this.security.record({
        type: SecurityEventType.INTEGRITY_FAILED,
        userId: params.userId,
        deviceKey: params.deviceKey,
        ipAddress: params.ip,
        message: 'Protected content refused: client reported integrity failure',
      });
      throw new AppException(ErrorCode.DEVICE_INTEGRITY_FAILED);
    }

    const device = await this.prisma.device.findUnique({
      where: {
        userId_deviceKey: { userId: params.userId, deviceKey: params.deviceKey },
      },
      select: { id: true, status: true },
    });

    if (!device) {
      await this.security.record({
        type: SecurityEventType.DEVICE_MISMATCH,
        userId: params.userId,
        deviceKey: params.deviceKey,
        ipAddress: params.ip,
        userAgent: params.userAgent,
        message: 'Protected content requested from an unregistered device',
      });
      throw new AppException(ErrorCode.DEVICE_NOT_AUTHORIZED);
    }

    if (device.status === DeviceStatus.ACTIVE) {
      return { deviceId: device.id };
    }

    await this.security.record({
      type: SecurityEventType.DEVICE_MISMATCH,
      userId: params.userId,
      deviceKey: params.deviceKey,
      ipAddress: params.ip,
      message: `Protected content refused: device status ${device.status}`,
    });

    if (device.status === DeviceStatus.PENDING_APPROVAL) {
      throw new AppException(ErrorCode.DEVICE_CHANGE_PENDING);
    }

    throw new AppException(ErrorCode.DEVICE_NOT_AUTHORIZED);
  }

  // ---------------------------------------------------------------------------
  // Student-facing
  // ---------------------------------------------------------------------------

  /** Shape matches the mobile app's `AuthorizedDevice` type exactly. */
  async listForUser(userId: string, currentDeviceKey: string | null) {
    const devices = await this.prisma.device.findMany({
      where: { userId, status: { not: DeviceStatus.REVOKED } },
      orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }],
    });

    return devices.map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      model: d.model ?? 'unknown',
      lastSeenAt: d.lastSeenAt.toISOString(),
      current: currentDeviceKey ? d.deviceKey === currentDeviceKey : false,
      authorizedAt: (d.approvedAt ?? d.createdAt).toISOString(),
      status: d.status,
    }));
  }

  async currentDevice(userId: string, deviceKey: string | null) {
    if (!deviceKey) return null;
    const device = await this.prisma.device.findUnique({
      where: { userId_deviceKey: { userId, deviceKey } },
    });
    if (!device) return null;

    return {
      id: device.id,
      name: device.name,
      platform: device.platform,
      model: device.model ?? 'unknown',
      status: device.status,
      lastSeenAt: device.lastSeenAt.toISOString(),
      current: true,
      authorizedAt: (device.approvedAt ?? device.createdAt).toISOString(),
    };
  }

  /**
   * Student asks for their account to be moved to the device they're holding.
   * Idempotent: repeated taps update the existing pending request rather than
   * flooding the admin queue.
   */
  async requestChange(params: {
    userId: string;
    device: DeviceContext;
    reason?: string;
  }) {
    if (!params.device.deviceKey) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, {
        message: 'X-Device-Id header is required to request a device change',
      });
    }

    const existingPending = await this.prisma.deviceChangeRequest.findFirst({
      where: { userId: params.userId, status: DeviceChangeStatus.PENDING },
    });

    if (existingPending) {
      const updated = await this.prisma.deviceChangeRequest.update({
        where: { id: existingPending.id },
        data: {
          requestedDeviceKey: params.device.deviceKey,
          requestedDeviceName: params.device.name ?? 'Unknown device',
          reason: params.reason ?? existingPending.reason,
        },
      });
      return { ok: true, status: updated.status, requestId: updated.id };
    }

    // Make sure a row exists for the requested device so an approving admin
    // has something concrete to authorize.
    const deviceRow = await this.prisma.device.upsert({
      where: {
        userId_deviceKey: { userId: params.userId, deviceKey: params.device.deviceKey },
      },
      create: {
        userId: params.userId,
        deviceKey: params.device.deviceKey,
        name: params.device.name ?? `${params.device.platform ?? 'Unknown'} device`,
        platform: params.device.platform ?? 'unknown',
        model: params.device.model,
        osVersion: params.device.osVersion,
        appVersion: params.device.appVersion,
        status: DeviceStatus.PENDING_APPROVAL,
      },
      update: { lastSeenAt: new Date() },
    });

    const request = await this.prisma.deviceChangeRequest.create({
      data: {
        userId: params.userId,
        requestedDeviceId: deviceRow.id,
        requestedDeviceKey: params.device.deviceKey,
        requestedDeviceName: deviceRow.name,
        reason: params.reason,
      },
    });

    return { ok: true, status: request.status, requestId: request.id };
  }

  // ---------------------------------------------------------------------------
  // Administrative
  // ---------------------------------------------------------------------------

  async listChangeRequests(params: {
    page: number;
    pageSize: number;
    status?: DeviceChangeStatus;
  }) {
    const where = params.status ? { status: params.status } : {};

    const [items, total] = await this.prisma.$transaction([
      this.prisma.deviceChangeRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
        include: {
          user: { select: { id: true, fullName: true, phone: true } },
          requestedDevice: true,
        },
      }),
      this.prisma.deviceChangeRequest.count({ where }),
    ]);

    return {
      items,
      meta: {
        page: params.page,
        pageSize: params.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
        hasNext: params.page * params.pageSize < total,
        hasPrevious: params.page > 1,
      },
    };
  }

  /**
   * Approving a change is a swap, not an addition: the previously bound
   * devices are revoked in the same transaction so the account never ends up
   * with two live devices because of a race.
   */
  async approveChange(requestId: string, actor: { id: string; role: UserRole }, note?: string) {
    const request = await this.prisma.deviceChangeRequest.findUnique({
      where: { id: requestId },
    });

    if (!request) throw AppException.notFound('Device change request', requestId);
    if (request.status !== DeviceChangeStatus.PENDING) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: `Request is already ${request.status}`,
      });
    }

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.device.updateMany({
        where: {
          userId: request.userId,
          status: DeviceStatus.ACTIVE,
          deviceKey: { not: request.requestedDeviceKey },
        },
        data: {
          status: DeviceStatus.REVOKED,
          revokedAt: new Date(),
          revokedReason: `Replaced by device change request ${requestId}`,
        },
      });

      const device = await tx.device.upsert({
        where: {
          userId_deviceKey: {
            userId: request.userId,
            deviceKey: request.requestedDeviceKey,
          },
        },
        create: {
          userId: request.userId,
          deviceKey: request.requestedDeviceKey,
          name: request.requestedDeviceName,
          platform: 'unknown',
          status: DeviceStatus.ACTIVE,
          approvedAt: new Date(),
          approvedById: actor.id,
        },
        update: {
          status: DeviceStatus.ACTIVE,
          approvedAt: new Date(),
          approvedById: actor.id,
          revokedAt: null,
          revokedReason: null,
        },
      });

      const updated = await tx.deviceChangeRequest.update({
        where: { id: requestId },
        data: {
          status: DeviceChangeStatus.APPROVED,
          reviewedById: actor.id,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });

      // Sessions on the old device must die with it, otherwise the previous
      // handset keeps a valid access token until it expires.
      await tx.session.updateMany({
        where: {
          userId: request.userId,
          deviceId: { not: device.id },
          status: 'ACTIVE',
        },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: 'Device change approved',
        },
      });

      return { device, request: updated };
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DEVICE_APPROVE,
      entity: 'device_change_request',
      entityId: requestId,
      after: { deviceId: result.device.id, userId: request.userId },
      note,
    });

    await this.security.record({
      type: SecurityEventType.DEVICE_REGISTERED,
      userId: request.userId,
      deviceKey: request.requestedDeviceKey,
      message: `Device change approved by ${actor.id}`,
    });

    return result.request;
  }

  async rejectChange(requestId: string, actor: { id: string; role: UserRole }, note?: string) {
    const request = await this.prisma.deviceChangeRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw AppException.notFound('Device change request', requestId);
    if (request.status !== DeviceChangeStatus.PENDING) {
      throw new AppException(ErrorCode.INVALID_STATE, {
        message: `Request is already ${request.status}`,
      });
    }

    const updated = await this.prisma.deviceChangeRequest.update({
      where: { id: requestId },
      data: {
        status: DeviceChangeStatus.REJECTED,
        reviewedById: actor.id,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DEVICE_REVOKE,
      entity: 'device_change_request',
      entityId: requestId,
      note,
    });

    return updated;
  }

  /** Admin revokes a specific device and kills its sessions. */
  async revokeDevice(
    deviceId: string,
    actor: { id: string; role: UserRole },
    reason: string,
  ) {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw AppException.notFound('Device', deviceId);

    await this.prisma.$transaction([
      this.prisma.device.update({
        where: { id: deviceId },
        data: {
          status: DeviceStatus.REVOKED,
          revokedAt: new Date(),
          revokedReason: reason,
        },
      }),
      this.prisma.session.updateMany({
        where: { deviceId, status: 'ACTIVE' },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: `Device revoked: ${reason}`,
        },
      }),
      // Any in-flight playback grant on that device dies immediately.
      this.prisma.playbackTicket.updateMany({
        where: { deviceId, status: 'ACTIVE' },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: 'Device revoked',
        },
      }),
    ]);

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DEVICE_REVOKE,
      entity: 'device',
      entityId: deviceId,
      before: { status: device.status },
      after: { status: DeviceStatus.REVOKED },
      note: reason,
    });

    await this.security.record({
      type: SecurityEventType.DEVICE_REVOKED,
      severity: SecuritySeverity.MEDIUM,
      userId: device.userId,
      deviceKey: device.deviceKey,
      message: reason,
    });

    return { ok: true };
  }

  /** Admin clears a student's binding entirely (e.g. lost phone). */
  async resetBinding(userId: string, actor: { id: string; role: UserRole }, reason: string) {
    const { count } = await this.prisma.device.updateMany({
      where: { userId, status: { in: [DeviceStatus.ACTIVE, DeviceStatus.PENDING_APPROVAL] } },
      data: { status: DeviceStatus.REVOKED, revokedAt: new Date(), revokedReason: reason },
    });

    await this.prisma.session.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'REVOKED', revokedAt: new Date(), revokedReason: 'Device binding reset' },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: actor.role,
      action: AuditAction.DEVICE_REVOKE,
      entity: 'user',
      entityId: userId,
      note: `Device binding reset (${count} device(s)): ${reason}`,
    });

    // The next login re-binds automatically when autoBindFirst is on.
    return { ok: true, revoked: count };
  }
}
