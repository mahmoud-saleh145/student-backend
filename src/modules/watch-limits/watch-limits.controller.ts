import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { Equals, IsBoolean, IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { MAX_ADJUSTMENT, WATCH_LIMIT_ACTIONS, type WatchLimitAction, WatchLimitsService } from './watch-limits.service';

const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

class WatchLimitChangeDto {
  @ApiProperty({ enum: WATCH_LIMIT_ACTIONS })
  @IsIn(WATCH_LIMIT_ACTIONS as unknown as string[])
  action!: WatchLimitAction;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_ADJUSTMENT,
    description: 'Required for ADD_PLAYS (1–100: plays to add) and SET_REMAINING (0–100: plays left afterwards).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_ADJUSTMENT)
  amount?: number;
}

class CourseResetPreviewQuery {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  restoreDefault?: boolean;
}

class CourseResetDto {
  @ApiPropertyOptional({ default: false, description: 'Also drop every custom limit back to the default.' })
  @IsOptional()
  @IsBoolean()
  restoreDefault?: boolean;

  @ApiProperty({ description: 'Must be true. Guards against an accidental call.' })
  @Equals(true)
  confirm!: true;
}

/**
 * Video watch-limit management (dashboard "Manage Views" and "Reset All
 * Students' Views"). Administrators only: teachers and students are refused by
 * the roles guard before any of these handlers run.
 *
 * Every change is scoped to one course: the student must hold an enrolment on
 * it and the video must be attached to one of its lectures.
 */
@ApiTags('watch-limits')
@ApiBearerAuth()
@AdminOnly()
@Controller('admin/watch-limits/courses/:courseId')
export class WatchLimitsController {
  constructor(private readonly watchLimits: WatchLimitsService) {}

  @Get('students/:userId')
  @ApiOperation({ summary: "One student's allowed / used / remaining plays for every video of a course" })
  overview(@Param('courseId') courseId: string, @Param('userId') userId: string) {
    return this.watchLimits.studentOverview(courseId, userId);
  }

  @Post('students/:userId/videos/:videoId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Change one student's watch limit on one video" })
  changeVideo(
    @Param('courseId') courseId: string,
    @Param('userId') userId: string,
    @Param('videoId') videoId: string,
    @Body() dto: WatchLimitChangeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.watchLimits.applyToVideo(actor, courseId, userId, videoId, dto.action, dto.amount);
  }

  @Post('students/:userId/bulk')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Apply one change to every accessible video of the course for one student" })
  changeStudent(
    @Param('courseId') courseId: string,
    @Param('userId') userId: string,
    @Body() dto: WatchLimitChangeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.watchLimits.applyToStudent(actor, courseId, userId, dto.action, dto.amount);
  }

  @Get('reset-preview')
  @ApiOperation({ summary: 'What a course-wide reset would touch (read-only)' })
  resetPreview(@Param('courseId') courseId: string, @Query() query: CourseResetPreviewQuery) {
    return this.watchLimits.courseResetPreview(courseId, query.restoreDefault ?? false);
  }

  @Post('reset')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Reset consumed plays to zero for every student of the course, on this course's videos only",
    description:
      'Play history is kept: the counting window restarts now. Custom limits are kept unless restoreDefault is true. Idempotent: a repeat finds nothing to reset.',
  })
  resetCourse(
    @Param('courseId') courseId: string,
    @Body() dto: CourseResetDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.watchLimits.resetCourse(actor, courseId, dto.restoreDefault ?? false);
  }
}
