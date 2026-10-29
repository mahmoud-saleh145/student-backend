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
import { AuditAction } from '@prisma/client';
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

import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser, Locale } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { CourseAccessService } from '../courses/course-access.service';

import { AnnouncementsService } from './announcements.service';
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
  /**
   * One student. Used by the dashboard's "Send notification" on a student;
   * the field was never accepted, so that button always failed validation.
   */
  @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @IsOptional() @IsBoolean() sendPush?: boolean;
  @IsOptional() @IsBoolean() publishNow?: boolean;
}

/**
 * A notification to the students of ONE course.
 *
 * Deliberately narrower than `CreateAnnouncementDto`: no audience fields, no
 * `userId`, no `route`. The course comes from the URL, the audience is derived
 * on the server from that course's ACTIVE enrollments, and the deep link is
 * fixed to the course page. A teacher therefore cannot widen the audience, name
 * individual users, or point the notification somewhere else - the DTO has no
 * field to do it with, and `forbidNonWhitelisted` rejects any extra one.
 */
export class CourseAnnouncementDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsString() @MinLength(3) @MaxLength(2000) body!: string;
  @IsOptional() @IsString() @MaxLength(2000) bodyAr?: string;
  @IsOptional() @IsBoolean() sendPush?: boolean;
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
  constructor(
    private readonly notifications: NotificationsService,
    private readonly announcements: AnnouncementsService,
    private readonly courseAccess: CourseAccessService,
  ) {}

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
      'Targets all active students, or narrows by course, university or academic year. Shares one publication path with the scheduled announcements: the occurrence is claimed first, the audience is resolved from a stored rule, and the fan-out is paged — so publishing twice sends once.',
  })
  announce(@Body() dto: CreateAnnouncementDto, @CurrentUser() actor: AuthenticatedUser) {
    // A direct message to one student is a notification, not a broadcast: there
    // is no audience to record, so no Announcement row is written.
    if (dto.userId) {
      return this.notifications.messageStudent(dto, actor);
    }

    return this.announcements.createLegacy(dto, actor);
  }

  /**
   * Teachers (and admins) notifying the students of one course.
   *
   * Authorised by the course assignment, not by the role alone: the teacher
   * must be assigned to THIS course with the student-management capability
   * (`canViewStudents`), checked by the same authority every course route uses.
   * Admins pass that check for any existing course.
   *
   * The audience is the course's ACTIVE enrollments of ACTIVE student accounts
   * (`compileAudience` with `courseIds`), resolved server-side at send time -
   * pending, expired, revoked and archived enrollments, and suspended or
   * deleted accounts, are not reached. Broadcasts to everyone, to a
   * university or a year, and direct messages stay on the admin-only route
   * above.
   */
  @Post('courses/:courseId/announcements')
  @StaffOnly()
  @Audit({ action: AuditAction.CREATE, entity: 'course_announcement' })
  @ApiOperation({
    summary: "Notify the active students of one course",
    description:
      "Teachers need an assignment on the course with the student capability. The audience is the course's active enrollments, resolved on the server; no recipient list is accepted.",
  })
  async announceToCourse(
    @Param('courseId') courseId: string,
    @Body() dto: CourseAnnouncementDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    await this.courseAccess.assertCourseExistsAndManageable(
      actor.id,
      actor.role,
      courseId,
      'students',
    );

    return this.announcements.createLegacy(
      {
        title: dto.title,
        titleAr: dto.titleAr,
        body: dto.body,
        bodyAr: dto.bodyAr,
        sendPush: dto.sendPush,
        courseId,
        route: `/course/${courseId}`,
        publishNow: true,
      },
      actor,
    );
  }

  @Post('announcements/:id/publish')
  @AdminOnly()
  @ApiOperation({
    summary: 'Publish a drafted announcement',
    description:
      'Refused once the announcement has been published. The draft is a one-shot, and a second publish would otherwise broadcast the same message to everyone a second time.',
  })
  publish(@Param('id') id: string) {
    return this.announcements.publishLegacy(id);
  }
}
