import { Body, Controller, Get, Post, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction, UserRole } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { IsObject, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MasterOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';
import { PrismaService, notDeleted } from '../../database/prisma.service';
import { AuditService } from '../audit/audit.service';

class SettingDto {
  @IsString() @MinLength(1) @MaxLength(80) key!: string;
  @IsObject() value!: Prisma.InputJsonValue;
  @IsString() @MaxLength(500) description!: string;
}

/**
 * Platform-owner operations.
 *
 * Everything here is master-only and deliberately narrow. The master's
 * distinguishing powers are: creating administrators (in UsersController),
 * reading the full audit trail (AuditController), and platform settings
 * (here). Day-to-day work is done by admins.
 *
 * There is intentionally no endpoint to create or modify the master account.
 * It is provisioned out of band by scripts/create-master.ts, and the schema
 * plus UsersService.assertCanManage make it unmodifiable through the API.
 */
@ApiTags('master')
@ApiBearerAuth('access-token')
@Controller('master')
export class MasterController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) { }

  @Get('overview')
  @MasterOnly()
  @ApiOperation({ summary: 'Platform composition at a glance' })
  async overview() {
    const [byRole, courses, pendingDeviceRequests, pendingEnrollments] =
      await this.prisma.$transaction([
        this.prisma.user.groupBy({
          by: ['role', 'status'],
          where: notDeleted,
          _count: { _all: true },
          orderBy: [{ role: 'asc' }, { status: 'asc' }],
        }),
        this.prisma.course.groupBy({
          by: ['status'],
          where: notDeleted,
          _count: { _all: true },
          orderBy: { status: 'asc' },

        }),
        this.prisma.deviceChangeRequest.count({ where: { status: 'PENDING' } }),
        this.prisma.enrollment.count({ where: { state: 'PENDING_APPROVAL' } }),
      ]);

    return {
      users: byRole.map((r) => ({
        role: r.role,
        status: r.status,
        count: typeof r._count === 'object' && r._count !== null ? r._count._all ?? 0 : 0,
      })),
      courses: courses.map((c) => ({
        status: c.status,
        count: typeof c._count === 'object' && c._count !== null ? c._count._all ?? 0 : 0,
      })),
      queues: { pendingDeviceRequests, pendingEnrollments },
    };
  }

  @Get('settings')
  @MasterOnly()
  @ApiOperation({ summary: 'Platform settings' })
  settings() {
    return this.prisma.platformSetting.findMany({ orderBy: { key: 'asc' } });
  }

  @Put('settings')
  @MasterOnly()
  @ApiOperation({
    summary: 'Set a platform setting',
    description:
      'Used for minimumAppVersion (forced upgrades), maintenanceMode and supportContacts, which the mobile client reads from GET /meta/app-config.',
  })
  async setSetting(@Body() dto: SettingDto, @CurrentUser() actor: AuthenticatedUser) {
    const before = await this.prisma.platformSetting.findUnique({ where: { key: dto.key } });

    const setting = await this.prisma.platformSetting.upsert({
      where: { key: dto.key },
      create: {
        key: dto.key,
        value: dto.value,
        description: dto.description,
        updatedById: actor.id,
      },
      update: { value: dto.value, description: dto.description, updatedById: actor.id },
    });

    await this.audit.record({
      actorId: actor.id,
      actorRole: UserRole.MASTER,
      action: AuditAction.SETTINGS_CHANGE,
      entity: 'platform_setting',
      entityId: dto.key,
      before: before?.value,
      after: dto.value,
    });

    return setting;
  }

  @Post('sessions/revoke-all')
  @MasterOnly()
  @ApiOperation({
    summary: 'Emergency: sign every user out',
    description:
      'For a suspected token-secret compromise. Revokes every session, refresh token and live playback grant platform-wide.',
  })
  async revokeAllSessions(@CurrentUser() actor: AuthenticatedUser) {
    const now = new Date();

    const [sessions, tokens, tickets] = await this.prisma.$transaction([
      this.prisma.session.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Platform-wide revocation' },
      }),
      this.prisma.refreshToken.updateMany({
        where: { revokedAt: null },
        data: { revokedAt: now, revokedReason: 'Platform-wide revocation' },
      }),
      this.prisma.playbackTicket.updateMany({
        where: { status: 'ACTIVE' },
        data: { status: 'REVOKED', revokedAt: now, revokedReason: 'Platform-wide revocation' },
      }),
    ]);

    await this.audit.record({
      actorId: actor.id,
      actorRole: UserRole.MASTER,
      action: AuditAction.SETTINGS_CHANGE,
      entity: 'platform',
      entityId: 'sessions',
      after: {
        sessions: sessions.count,
        refreshTokens: tokens.count,
        playbackTickets: tickets.count,
      },
      note: 'Emergency platform-wide session revocation',
    });

    return {
      sessions: sessions.count,
      refreshTokens: tokens.count,
      playbackTickets: tickets.count,
    };
  }
}
