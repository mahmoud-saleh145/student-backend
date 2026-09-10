import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AccountStatus,
  AuditAction,
  DeviceStatus,
  SecurityEventType,
  SecuritySeverity,
  SessionStatus,
  UserRole,
} from '@prisma/client';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { DeviceContext } from '../../common/types/request-context';
import type { AuthConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';
import { DevicesService } from '../devices/devices.service';
import { SecurityEventService } from '../security/security-event.service';
import { UsersService } from '../users/users.service';

import type { LoginDto } from './dto/login.dto';
import type { RegisterDto } from './dto/register.dto';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

export interface RequestMeta {
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  device: DeviceContext;
}

export interface AuthResult {
  user: unknown;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  /** Device state, so the client can explain a binding problem immediately. */
  device: {
    authorized: boolean;
    status: DeviceStatus | null;
    reason?: string;
  };
}

/**
 * Authentication.
 *
 * Shape note: the login/register response is exactly
 * `{ user, accessToken, refreshToken, expiresIn }` because that is what the
 * shipped mobile client's `AuthResponse` expects. The extra `device` block is
 * additive — the client ignores unknown fields — and lets a future build tell
 * the student *why* protected content is locked without an extra round trip.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly cfg: AuthConfig;

  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly passwords: PasswordService,
    private readonly tokens: TokenService,
    private readonly devices: DevicesService,
    private readonly security: SecurityEventService,
    private readonly audit: AuditService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<AuthConfig>('auth');
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Student self-registration. There is no OTP in this product (spec §12), so
   * the phone number is trusted as an identifier only — it is never used as a
   * verification channel, and an unverified number can't be used to take over
   * an account because password reset is a human, administrative process.
   */
  async register(dto: RegisterDto, meta: RequestMeta): Promise<AuthResult> {
    const phone = UsersService.normalizePhone(dto.phone);

    const existing = await this.prisma.user.findUnique({
      where: { phone },
      select: { id: true },
    });
    if (existing) {
      throw new AppException(ErrorCode.PHONE_ALREADY_REGISTERED, {
        fields: { phone: ['already registered'] },
      });
    }

    // Referential integrity for the academic selection: a client could post a
    // department that belongs to a different faculty.
    await this.users.assertAcademicSelectionIsCoherent({
      universityId: dto.universityId,
      facultyId: dto.facultyId,
      departmentId: dto.departmentId,
      academicYearId: dto.academicYearId,
    });

    const passwordHash = await this.passwords.hash(dto.password);

    const user = await this.prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          phone,
          passwordHash,
          fullName: dto.fullName.trim().replace(/\s+/g, ' '),
          // Role is never taken from the request body. The public registration
          // endpoint mints students and nothing else.
          role: UserRole.STUDENT,
          status: AccountStatus.ACTIVE,
          gender: dto.gender,
          locale: dto.locale ?? 'en',
          studentProfile: {
            create: {
              universityId: dto.universityId,
              facultyId: dto.facultyId,
              departmentId: dto.departmentId,
              academicYearId: dto.academicYearId,
            },
          },
          notificationPrefs: { create: {} },
        },
        select: { id: true, role: true, phone: true, fullName: true },
      });

      await tx.auditLog.create({
        data: {
          actorId: created.id,
          actorRole: UserRole.STUDENT,
          action: AuditAction.CREATE,
          entity: 'user',
          entityId: created.id,
          after: { phone: created.phone, role: created.role },
          ipAddress: meta.ip ?? null,
          requestId: meta.requestId ?? null,
          note: 'Self-registration',
        },
      });

      return created;
    });

    return this.establishSession(user.id, meta, 'register');
  }

  // ---------------------------------------------------------------------------
  // Login
  // ---------------------------------------------------------------------------

  async login(dto: LoginDto, meta: RequestMeta): Promise<AuthResult> {
    const phone = UsersService.normalizePhone(dto.phone);

    const user = await this.prisma.user.findUnique({
      where: { phone },
      select: {
        id: true,
        passwordHash: true,
        role: true,
        status: true,
        deletedAt: true,
        failedLoginCount: true,
        lockedUntil: true,
      },
    });

    if (!user || user.deletedAt) {
      // Spend the same CPU as a real verification so response time doesn't
      // reveal whether the number is registered.
      await this.passwords.burnTiming(dto.password);
      await this.security.record({
        type: SecurityEventType.LOGIN_FAILED,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        deviceKey: meta.device.deviceKey,
        message: 'Login attempt for unknown phone',
        metadata: { phone: this.maskPhone(phone) },
      });
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      throw new AppException(ErrorCode.RATE_LIMITED, {
        message: 'Too many failed attempts; try again later',
        details: { retryAfterSeconds: Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000) },
      });
    }

    const valid = await this.passwords.verify(user.passwordHash, dto.password);

    if (!valid) {
      await this.registerFailedAttempt(user.id, user.failedLoginCount, meta);
      throw new AppException(ErrorCode.INVALID_CREDENTIALS);
    }

    // Status is checked AFTER the password so a disabled-account response
    // can't be used to enumerate valid numbers.
    if (user.status === AccountStatus.DISABLED || user.status === AccountStatus.SUSPENDED) {
      throw new AppException(ErrorCode.ACCOUNT_DISABLED, {
        message: `Account is ${user.status.toLowerCase()}`,
      });
    }
    if (user.status === AccountStatus.PENDING) {
      throw new AppException(ErrorCode.ACCOUNT_PENDING);
    }

    // Opportunistic upgrade if the hashing parameters were raised.
    if (this.passwords.needsRehash(user.passwordHash)) {
      const rehashed = await this.passwords.hash(dto.password);
      await this.prisma.user
        .update({ where: { id: user.id }, data: { passwordHash: rehashed } })
        .catch(() => undefined);
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
    });

    return this.establishSession(user.id, meta, 'login');
  }

  private async registerFailedAttempt(
    userId: string,
    currentCount: number,
    meta: RequestMeta,
  ): Promise<void> {
    const next = currentCount + 1;
    const shouldLock = next >= this.cfg.maxFailedLogins;

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failedLoginCount: next,
        lockedUntil: shouldLock
          ? new Date(Date.now() + this.cfg.lockoutMinutes * 60_000)
          : null,
      },
    });

    await this.security.record({
      type: SecurityEventType.LOGIN_FAILED,
      severity: shouldLock ? SecuritySeverity.MEDIUM : SecuritySeverity.LOW,
      userId,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      deviceKey: meta.device.deviceKey,
      message: shouldLock
        ? `Account locked for ${this.cfg.lockoutMinutes} minutes after ${next} failures`
        : `Failed login ${next}/${this.cfg.maxFailedLogins}`,
    });
  }

  // ---------------------------------------------------------------------------
  // Session establishment (shared by login and register)
  // ---------------------------------------------------------------------------

  private async establishSession(
    userId: string,
    meta: RequestMeta,
    origin: 'login' | 'register',
  ): Promise<AuthResult> {
    const user = await this.users.findAuthUser(userId);

    const resolution = await this.devices.resolveOnLogin(
      userId,
      user.role,
      meta.device,
      { ip: meta.ip, userAgent: meta.userAgent },
    );

    const session = await this.prisma.session.create({
      data: {
        userId,
        deviceId: resolution.deviceId,
        ipAddress: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 500) ?? null,
        appVersion: meta.device.appVersion,
        platform: meta.device.platform,
        expiresAt: new Date(Date.now() + this.cfg.refreshTtl * 1000),
      },
    });

    const issued = await this.tokens.issue({
      userId,
      sessionId: session.id,
      role: user.role,
    });

    await this.prisma.refreshToken.create({
      data: {
        userId,
        sessionId: session.id,
        tokenHash: issued.refreshTokenHash,
        familyId: issued.familyId,
        expiresAt: issued.refreshExpiresAt,
      },
    });

    await this.security.record({
      type: SecurityEventType.LOGIN_SUCCESS,
      userId,
      sessionId: session.id,
      deviceKey: meta.device.deviceKey,
      ipAddress: meta.ip,
      userAgent: meta.userAgent,
      message: `${origin} from ${meta.device.platform ?? 'unknown platform'}`,
    });

    return {
      user: await this.users.toPublicUser(userId),
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      device: {
        authorized: resolution.authorized,
        status: resolution.status,
        reason: resolution.reason,
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Refresh
  // ---------------------------------------------------------------------------

  /**
   * Rotating refresh with reuse detection.
   *
   * Every refresh mints a new token and marks the old one used. Presenting an
   * already-used token means either a replay or a stolen token being raced
   * against the legitimate client — in both cases the safe response is to kill
   * the whole family, so the attacker and the victim both have to sign in
   * again.
   */
  async refresh(refreshToken: string, meta: RequestMeta): Promise<AuthResult> {
    let claims;
    try {
      claims = await this.tokens.verifyRefresh(refreshToken);
    } catch {
      throw new AppException(ErrorCode.SESSION_EXPIRED, {
        message: 'Refresh token is invalid or expired',
      });
    }

    const hash = TokenService.hashToken(refreshToken);

    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash: hash },
      include: {
        session: { select: { id: true, status: true, deviceId: true } },
        user: {
          select: {
            id: true,
            role: true,
            status: true,
            deletedAt: true,
            credentialsChangedAt: true,
          },
        },
      },
    });

    if (!stored) {
      // Signature was valid but we have no record: the token was already
      // rotated away and pruned, or it is forged with a leaked secret.
      await this.security.record({
        type: SecurityEventType.TOKEN_REUSE,
        severity: SecuritySeverity.CRITICAL,
        userId: claims.sub,
        sessionId: claims.sid,
        ipAddress: meta.ip,
        message: 'Refresh token not found for a valid signature',
      });
      await this.revokeFamily(claims.fam, 'Unknown refresh token presented');
      throw new AppException(ErrorCode.SESSION_EXPIRED);
    }

    if (stored.usedAt || stored.revokedAt) {
      await this.security.record({
        type: SecurityEventType.TOKEN_REUSE,
        severity: SecuritySeverity.CRITICAL,
        userId: stored.userId,
        sessionId: stored.sessionId,
        ipAddress: meta.ip,
        userAgent: meta.userAgent,
        message: 'Reuse of a rotated refresh token — revoking the token family',
      });
      await this.revokeFamily(stored.familyId, 'Refresh token reuse detected');
      throw new AppException(ErrorCode.SESSION_EXPIRED, {
        message: 'Refresh token already used',
      });
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, { message: 'Refresh token expired' });
    }

    if (stored.session.status !== SessionStatus.ACTIVE) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, { message: 'Session revoked' });
    }

    const user = stored.user;
    if (user.deletedAt || user.status === AccountStatus.DISABLED || user.status === AccountStatus.SUSPENDED) {
      throw new AppException(ErrorCode.ACCOUNT_DISABLED);
    }

    if (stored.createdAt.getTime() < user.credentialsChangedAt.getTime() - 1000) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, {
        message: 'Credentials changed after this token was issued',
      });
    }

    const issued = await this.tokens.issue({
      userId: user.id,
      sessionId: stored.sessionId,
      role: user.role,
      familyId: stored.familyId,
    });

    await this.prisma.$transaction(async (tx) => {
      const next = await tx.refreshToken.create({
        data: {
          userId: user.id,
          sessionId: stored.sessionId,
          tokenHash: issued.refreshTokenHash,
          familyId: stored.familyId,
          expiresAt: issued.refreshExpiresAt,
        },
      });

      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { usedAt: new Date(), replacedById: next.id },
      });

      await tx.session.update({
        where: { id: stored.sessionId },
        data: { lastSeenAt: new Date() },
      });
    });

    // Re-evaluate the device on refresh too: an admin may have revoked it
    // mid-session, and the client should learn that at the next refresh
    // rather than at the next playback attempt.
    const deviceStatus = await this.currentDeviceStatus(user.id, meta.device.deviceKey);

    return {
      user: await this.users.toPublicUser(user.id),
      accessToken: issued.accessToken,
      refreshToken: issued.refreshToken,
      expiresIn: issued.expiresIn,
      device: deviceStatus,
    };
  }

  private async currentDeviceStatus(userId: string, deviceKey: string | null) {
    if (!deviceKey) {
      return { authorized: false, status: null, reason: 'no-device-header' };
    }
    const device = await this.prisma.device.findUnique({
      where: { userId_deviceKey: { userId, deviceKey } },
      select: { status: true },
    });
    if (!device) return { authorized: false, status: null, reason: 'not-authorized' };
    return {
      authorized: device.status === DeviceStatus.ACTIVE,
      status: device.status,
      reason: device.status === DeviceStatus.ACTIVE ? undefined : 'not-authorized',
    };
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    const now = new Date();

    const tokens = await this.prisma.refreshToken.findMany({
      where: { familyId, revokedAt: null },
      select: { sessionId: true },
    });
    const sessionIds = [...new Set(tokens.map((t) => t.sessionId))];

    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      }),
      this.prisma.session.updateMany({
        where: { id: { in: sessionIds }, status: SessionStatus.ACTIVE },
        data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: reason },
      }),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Logout & session management
  // ---------------------------------------------------------------------------

  async logout(userId: string, sessionId: string, meta: RequestMeta): Promise<{ ok: true }> {
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { id: sessionId, userId },
        data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: 'User logout' },
      }),
      this.prisma.refreshToken.updateMany({
        where: { sessionId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'User logout' },
      }),
      // Free any streaming slot this session was holding, so the student can
      // immediately play on their next login.
      this.prisma.playbackTicket.updateMany({
        where: { sessionId, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: now },
      }),
      this.prisma.pushToken.updateMany({
        where: { userId, deviceKey: meta.device.deviceKey ?? '__none__' },
        data: { isActive: false },
      }),
    ]);

    return { ok: true };
  }

  async logoutAll(userId: string, reason = 'User signed out everywhere'): Promise<{ ok: true; sessions: number }> {
    const now = new Date();

    const [sessions] = await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { userId, status: SessionStatus.ACTIVE },
        data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: reason },
      }),
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: reason },
      }),
      this.prisma.playbackTicket.updateMany({
        where: { userId, status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: reason },
      }),
    ]);

    return { ok: true, sessions: sessions.count };
  }

  /** Session detail for the app's `/auth/session` probe. */
  async describeSession(userId: string, sessionId: string) {
    const session = await this.prisma.session.findFirst({
      where: { id: sessionId, userId },
      select: {
        id: true,
        status: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        platform: true,
        appVersion: true,
        device: {
          select: { id: true, name: true, platform: true, status: true, model: true },
        },
      },
    });

    if (!session) throw new AppException(ErrorCode.SESSION_EXPIRED);

    return {
      id: session.id,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      platform: session.platform,
      appVersion: session.appVersion,
      device: session.device
        ? {
            id: session.device.id,
            name: session.device.name,
            platform: session.device.platform,
            model: session.device.model,
            status: session.device.status,
            authorized: session.device.status === DeviceStatus.ACTIVE,
          }
        : null,
    };
  }

  async listSessions(userId: string) {
    const sessions = await this.prisma.session.findMany({
      where: { userId, status: SessionStatus.ACTIVE },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        createdAt: true,
        lastSeenAt: true,
        ipAddress: true,
        platform: true,
        appVersion: true,
        device: { select: { name: true, model: true, platform: true } },
      },
    });
    return sessions;
  }

  // ---------------------------------------------------------------------------
  // Password change (self-service) — reset is administrative, see UsersService
  // ---------------------------------------------------------------------------

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    meta: RequestMeta,
  ): Promise<{ ok: true }> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, passwordHash: true, role: true },
    });

    const valid = await this.passwords.verify(user.passwordHash, currentPassword);
    if (!valid) {
      throw new AppException(ErrorCode.INVALID_CREDENTIALS, {
        message: 'Current password is incorrect',
        fields: { currentPassword: ['incorrect'] },
      });
    }

    const passwordHash = await this.passwords.hash(newPassword);
    const now = new Date();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { passwordHash, credentialsChangedAt: now },
      }),
      // Every other session dies; the current one is re-established by the
      // client's next refresh, which is why credentialsChangedAt is compared
      // with a 1s tolerance in the guard.
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'Password changed' },
      }),
      this.prisma.session.updateMany({
        where: { userId, status: SessionStatus.ACTIVE },
        data: { status: SessionStatus.REVOKED, revokedAt: now, revokedReason: 'Password changed' },
      }),
    ]);

    await this.audit.record({
      actorId: userId,
      actorRole: user.role,
      action: AuditAction.PASSWORD_RESET,
      entity: 'user',
      entityId: userId,
      ipAddress: meta.ip,
      requestId: meta.requestId,
      note: 'Self-service password change',
    });

    return { ok: true };
  }

  private maskPhone(phone: string): string {
    return phone.length < 7 ? '***' : `${phone.slice(0, 4)}***${phone.slice(-2)}`;
  }
}
