import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';

import { CurrentUser, Locale } from '../../common/decorators/current-user.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { NotificationsService } from './notifications.service';

class ListNotificationsDto extends PaginationDto {
  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true' || value === '1')
  @IsBoolean()
  unread?: boolean;
}

class RegisterPushTokenDto {
  @IsString() @MinLength(10) @MaxLength(400) token!: string;
  @IsIn(['ios', 'android', 'web']) platform!: string;
  @IsOptional() @IsIn(['expo', 'fcm', 'apns']) provider?: string;
}

class UpdatePreferencesDto {
  @IsOptional() @IsBoolean() newCourse?: boolean;
  @IsOptional() @IsBoolean() newLesson?: boolean;
  @IsOptional() @IsBoolean() announcements?: boolean;
  @IsOptional() @IsBoolean() payments?: boolean;
}

class CreateAnnouncementDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsString() @MinLength(3) @MaxLength(2000) body!: string;
  @IsOptional() @IsString() @MaxLength(2000) bodyAr?: string;
  @IsOptional() @IsString() @MaxLength(200) route?: string;
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @IsOptional() @IsBoolean() sendPush?: boolean;
  @IsOptional() @IsBoolean() publishNow?: boolean;
}

/**
 * Notifications.
 *
 * Paths match the mobile app's `Endpoints.notifications` map exactly, including
 * the slightly unusual `/notifications/devices` for push-token registration.
 */
@ApiTags('notifications')
@ApiBearerAuth('access-token')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Your notifications',
    description:
      'Localised by Accept-Language. Both languages are stored per row, so switching the app to Arabic also translates existing notifications.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListNotificationsDto,
    @Locale() locale: 'en' | 'ar',
  ) {
    return this.notifications.listLocalized({
      userId: user.id,
      page: query.page,
      pageSize: query.pageSize,
      unreadOnly: query.unread,
      locale,
    });
  }

  @Get('unread-count')
  @ApiOperation({
    summary: 'Unread badge count',
    description: 'Polled by the app roughly every minute; kept as a single indexed count.',
  })
  unread(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.unreadCount(user.id);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark one notification read' })
  markRead(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markRead(user.id, id);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark everything read' })
  markAllRead(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.markAllRead(user.id);
  }

  // --- push tokens -----------------------------------------------------------

  @Post('devices')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Register a push token',
    description:
      'Tokens are globally unique. Re-registering one that belonged to another account re-points it, so the previous owner stops receiving this student’s notifications.',
  })
  registerToken(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RegisterPushTokenDto,
    @Req() req: Request,
  ) {
    return this.notifications.registerPushToken({
      userId: user.id,
      token: dto.token,
      platform: dto.platform,
      provider: dto.provider,
      deviceKey: req.deviceContext?.deviceKey ?? null,
    });
  }

  @Delete('devices/:token')
  @ApiOperation({ summary: 'Deactivate a push token (called on logout)' })
  unregisterToken(@CurrentUser() user: AuthenticatedUser, @Param('token') token: string) {
    return this.notifications.unregisterPushToken(user.id, token);
  }

  // --- preferences -----------------------------------------------------------

  @Get('preferences')
  @ApiOperation({ summary: 'Notification preferences' })
  getPreferences(@CurrentUser() user: AuthenticatedUser) {
    return this.notifications.getPreferences(user.id);
  }

  @Put('preferences')
  @ApiOperation({
    summary: 'Update notification preferences',
    description:
      'Security and administrative messages are never suppressed by a preference — a student must always be told their device binding changed.',
  })
  updatePreferences(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.notifications.updatePreferences(user.id, dto);
  }

  // --- announcements (admin) -------------------------------------------------

  @Post('announcements')
  @AdminOnly()
  @ApiOperation({
    summary: 'Broadcast an announcement',
    description:
      'Targets all active students, or narrows by course, university or academic year. Fans out to per-student inbox rows plus one bulk push job.',
  })
  announce(@Body() dto: CreateAnnouncementDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.notifications.createAnnouncement(dto, actor);
  }

  @Post('announcements/:id/publish')
  @AdminOnly()
  @ApiOperation({ summary: 'Publish a drafted announcement' })
  publish(@Param('id') id: string) {
    return this.notifications.publishAnnouncement(id);
  }
}
