import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DeviceChangeStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { DevicesService } from './devices.service';

class ListChangeRequestsDto extends PaginationDto {
  @IsOptional() @IsEnum(DeviceChangeStatus) status?: DeviceChangeStatus;
}

class ReviewDto {
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class RevokeDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@ApiTags('devices')
@ApiBearerAuth('access-token')
@Controller('admin/devices')
export class DevicesAdminController {
  constructor(private readonly devices: DevicesService) {}

  @Get('change-requests')
  @AdminOnly()
  @ApiOperation({ summary: 'Review queue for device changes' })
  listRequests(@Query() query: ListChangeRequestsDto) {
    return this.devices.listChangeRequests({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status ?? DeviceChangeStatus.PENDING,
    });
  }

  @Post('change-requests/:id/approve')
  @AdminOnly()
  @ApiOperation({
    summary: 'Approve a device change',
    description:
      'Swaps the binding atomically: the new device is authorized, previously bound devices are revoked, and their sessions are killed in the same transaction.',
  })
  approve(
    @Param('id') id: string,
    @Body() dto: ReviewDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.devices.approveChange(id, actor, dto.note);
  }

  @Post('change-requests/:id/reject')
  @AdminOnly()
  @ApiOperation({ summary: 'Reject a device change' })
  reject(
    @Param('id') id: string,
    @Body() dto: ReviewDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.devices.rejectChange(id, actor, dto.note);
  }

  @Post(':deviceId/revoke')
  @AdminOnly()
  @ApiOperation({
    summary: 'Revoke one device',
    description: 'Kills its sessions and any in-flight playback grant immediately.',
  })
  revoke(
    @Param('deviceId') deviceId: string,
    @Body() dto: RevokeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.devices.revokeDevice(deviceId, actor, dto.reason);
  }

  @Post('users/:userId/reset-binding')
  @AdminOnly()
  @ApiOperation({
    summary: 'Clear a student’s device binding',
    description:
      'For a lost or replaced phone. The next login re-binds automatically when DEVICE_AUTO_BIND_FIRST is enabled.',
  })
  resetBinding(
    @Param('userId') userId: string,
    @Body() dto: RevokeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.devices.resetBinding(userId, actor, dto.reason);
  }
}
