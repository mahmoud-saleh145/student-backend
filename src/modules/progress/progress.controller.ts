import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StaffOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { ProgressService } from './progress.service';

class ProgressItemDto {
  @IsString() @MaxLength(32) lessonId!: string;
  @Type(() => Number) @IsInt() @Min(0) positionSeconds!: number;

  /** Contiguous seconds watched since the last report — seeks contribute 0. */
  @Type(() => Number) @IsInt() @Min(0) watchedSeconds!: number;
}

class BatchProgressDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ProgressItemDto)
  items!: ProgressItemDto[];
}

/**
 * Watch progress.
 *
 * Paths match the mobile app's `Endpoints.progress` map: POST /progress,
 * POST /progress/batch, GET /progress/continue-watching.
 */
@ApiTags('progress')
@ApiBearerAuth('access-token')
@Controller('progress')
export class ProgressController {
  constructor(private readonly progress: ProgressService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report watch progress',
    description: [
      'Percent is monotonic — it is only ever raised, so reopening a finished',
      'lesson cannot reset it. `watchedSeconds` accumulates contiguous time',
      'only and is clamped server-side, so seeking to the end earns nothing.',
      'Completion is decided here from the course’s configured rule.',
    ].join(' '),
  })
  upsert(@Body() dto: ProgressItemDto, @CurrentUser() user: AuthenticatedUser) {
    return this.progress.upsert({ userId: user.id, role: user.role, input: dto });
  }

  @Post('batch')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replay queued offline progress',
    description:
      'Each item is applied independently, so one stale entry does not discard the whole batch.',
  })
  batch(@Body() dto: BatchProgressDto, @CurrentUser() user: AuthenticatedUser) {
    return this.progress.upsertBatch({
      userId: user.id,
      role: user.role,
      items: dto.items,
    });
  }

  @Get('continue-watching')
  @ApiOperation({
    summary: 'Resume list for the home screen',
    description:
      'Only includes courses the student can still open, so the shelf never contains a dead end.',
  })
  continueWatching(@CurrentUser() user: AuthenticatedUser) {
    return this.progress.continueWatching(user.id);
  }

  @Get('lessons/:lessonId')
  @ApiOperation({ summary: 'Your progress on one lesson' })
  forLesson(@Param('lessonId') lessonId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.progress.forLesson(user.id, lessonId);
  }

  @Get('courses/:courseId/students')
  @StaffOnly()
  @ApiOperation({ summary: 'Per-student progress for a course (teacher dashboard)' })
  breakdown(
    @Param('courseId') courseId: string,
    @Query() query: PaginationDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.progress.courseBreakdown({
      courseId,
      actorId: actor.id,
      role: actor.role,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
