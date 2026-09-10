import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly } from '../../common/decorators/roles.decorator';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { SearchablePaginationDto } from '../../common/dto/pagination.dto';

import { AnalyticsService } from './analytics.service';

class PeriodDto {
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

class RevenueSeriesDto extends PeriodDto {
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
}

class LessonViewersDto extends SearchablePaginationDto {}

@ApiTags('analytics')
@ApiBearerAuth('access-token')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('overview')
  @AdminOnly()
  @ApiOperation({
    summary: 'Platform overview',
    description:
      'Every money figure comes from the immutable revenue ledger, never from a course’s current price.',
  })
  overview(@Query() query: PeriodDto) {
    return this.analytics.overview({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('courses/:courseId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Course analytics',
    description:
      'Teachers see only their assigned courses, and revenue only when their assignment grants it.',
  })
  course(
    @Param('courseId') courseId: string,
    @Query() query: PeriodDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.analytics.course({
      courseId,
      actorId: actor.id,
      role: actor.role,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('teachers/:teacherId/earnings')
  @StaffOnly()
  @ApiOperation({
    summary: 'Teacher earnings statement',
    description:
      'A teacher may only read their own. Course names come from the ledger snapshot, so archived or renamed courses still read correctly.',
  })
  earnings(
    @Param('teacherId') teacherId: string,
    @Query() query: PeriodDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    if (actor.role === 'TEACHER' && actor.id !== teacherId) {
      throw new AppException(ErrorCode.FORBIDDEN, {
        message: 'You can only view your own earnings',
      });
    }

    return this.analytics.teacherEarnings({
      teacherId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('dashboard')
  @AdminOnly()
  @ApiOperation({
    summary: 'Everything the Statistics screen shows, in one request',
    description:
      'Students, teachers, courses by status, codes by status, purchases and revenue. `/analytics/overview` is unchanged and remains what existing clients call.',
  })
  dashboard(@Query() query: PeriodDto) {
    return this.analytics.dashboard({
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
    });
  }

  @Get('lessons/:lessonId/students')
  @StaffOnly()
  @ApiOperation({
    summary: 'Who watched a lecture, how much, and whether they finished',
    description:
      'Completion is read from stored progress using the course’s own rule, so this screen can never disagree with what the student sees. Teachers may only read their own courses.',
  })
  lessonViewers(
    @Param('lessonId') lessonId: string,
    @Query() query: LessonViewersDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.analytics.lessonViewers({
      lessonId,
      actorId: actor.id,
      role: actor.role,
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
    });
  }

  @Get('revenue')
  @AdminOnly()
  @ApiOperation({ summary: 'Daily revenue series for charting' })
  revenue(@Query() query: RevenueSeriesDto) {
    return this.analytics.revenueSeries({
      from: query.from ? new Date(query.from) : new Date(Date.now() - 30 * 86_400_000),
      to: query.to ? new Date(query.to) : new Date(),
      courseId: query.courseId,
    });
  }
}
