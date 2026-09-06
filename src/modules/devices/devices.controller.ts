import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

import {
  CurrentUser,
  DeviceInfo,
} from '../../common/decorators/current-user.decorator';
import { StudentOnly } from '../../common/decorators/roles.decorator';
import type {
  AuthenticatedUser,
  DeviceContext,
} from '../../common/types/request-context';

import { DevicesService } from './devices.service';

class RequestDeviceChangeDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/**
 * Student-facing device endpoints.
 *
 * Paths match the mobile app's `Endpoints.devices` map: GET /devices,
 * GET /devices/current, POST /devices/change-request.
 */
@ApiTags('devices')
@ApiBearerAuth('access-token')
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({
    summary: 'List your devices',
    description:
      'Returns the AuthorizedDevice[] shape the app renders, with `current: true` on the calling device.',
  })
  list(@CurrentUser() user: AuthenticatedUser, @DeviceInfo() device: DeviceContext | null) {
    return this.devices.listForUser(user.id, device?.deviceKey ?? null);
  }

  @Get('current')
  @ApiOperation({ summary: 'Describe the calling device' })
  current(@CurrentUser() user: AuthenticatedUser, @DeviceInfo() device: DeviceContext | null) {
    return this.devices.currentDevice(user.id, device?.deviceKey ?? null);
  }

  @Post('change-request')
  @StudentOnly()
  @ApiOperation({
    summary: 'Ask to move the account to this device',
    description:
      'Creates (or updates) a pending request for an administrator to review. Idempotent — repeated taps do not flood the queue.',
  })
  requestChange(
    @CurrentUser() user: AuthenticatedUser,
    @DeviceInfo() device: DeviceContext | null,
    @Body() dto: RequestDeviceChangeDto,
  ) {
    return this.devices.requestChange({
      userId: user.id,
      device: device ?? {
        deviceKey: null,
        platform: null,
        model: null,
        name: null,
        osVersion: null,
        appVersion: null,
        appBuild: null,
        integritySuspect: false,
      },
      reason: dto.reason,
    });
  }
}
