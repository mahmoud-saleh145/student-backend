import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  PartialType,
} from '@nestjs/swagger';
import { ContentStatus, LessonKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StaffOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { LessonsService } from './lessons.service';

class CreateLessonDto {
  @IsString() @MinLength(1) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(5000) description?: string;
  @IsOptional() @IsEnum(LessonKind) kind?: LessonKind;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) sortOrder?: number;
  @IsOptional() @IsBoolean() isPreview?: boolean;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) durationSeconds?: number;
  @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;

  @IsOptional()
  @IsIn(['WATCH_PERCENT', 'WATCH_FULL', 'MANUAL'])
  completionRuleType?: 'WATCH_PERCENT' | 'WATCH_FULL' | 'MANUAL';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) completionThreshold?: number;
  @IsOptional() @IsBoolean() completionRequireContiguous?: boolean;
}

/**
 * Every field optional, validation rules inherited.
 *
 * `PartialType` rather than `extends CreateLessonDto` with a redeclared
 * `title`: redeclaring a base field in a subclass emits a class-field
 * definition under ES2022 semantics, which overwrites whatever the base
 * constructor put there with `undefined`. `PartialType` rebuilds the metadata
 * instead of shadowing it, so the decorators survive.
 */
class UpdateLessonDto extends PartialType(CreateLessonDto) {}

class ReorderLessonsDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @IsString({ each: true })
  lessonIds!: string[];
}

@ApiTags('lessons')
@ApiBearerAuth('access-token')
@Controller()
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  // --- student ---------------------------------------------------------------

  @Get('lessons/:lessonId')
  @ApiOperation({
    summary: 'Lesson detail',
    description:
      'Enforces course access before returning anything. The `video` block is metadata only — it contains no URL. Playback requires POST /playback/videos/{videoId}/ticket.',
  })
  @ApiResponse({ status: 403, description: 'NOT_ENROLLED' })
  @ApiResponse({ status: 410, description: 'ACCESS_EXPIRED | COURSE_ARCHIVED' })
  detail(@Param('lessonId') lessonId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.lessons.detail(lessonId, user.id, user.role);
  }

  @Get('lessons/by-video/:videoId')
  @ApiOperation({
    summary: 'Resolve a video id to its lesson',
    description:
      'Convenience for the player route, which is entered with a video id but needs the lesson title, completion rule and next-lesson pointer.',
  })
  byVideo(@Param('videoId') videoId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.lessons.byVideoId(videoId, user.id, user.role);
  }

  @Post('lessons/:lessonId/complete')
  @ApiOperation({
    summary: 'Mark a lesson complete',
    description:
      'Only honoured for MANUAL completion rules. Watch-based rules are decided by the server from recorded progress — a client cannot assert completion it has not earned.',
  })
  @ApiResponse({ status: 409, description: 'INVALID_STATE — not enough watched' })
  complete(@Param('lessonId') lessonId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.lessons.markComplete(lessonId, user.id, user.role);
  }

  // --- authoring -------------------------------------------------------------

  @Post('admin/sections/:sectionId/lessons')
  @StaffOnly()
  @ApiOperation({ summary: 'Add a lesson to a section' })
  create(
    @Param('sectionId') sectionId: string,
    @Body() dto: CreateLessonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lessons.create(sectionId, dto, actor);
  }

  @Patch('admin/lessons/:lessonId')
  @StaffOnly()
  @ApiOperation({ summary: 'Update a lesson' })
  update(
    @Param('lessonId') lessonId: string,
    @Body() dto: UpdateLessonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lessons.update(lessonId, { ...dto }, actor);
  }

  @Post('admin/sections/:sectionId/lessons/reorder')
  @StaffOnly()
  @ApiOperation({ summary: 'Reorder the lessons in a section' })
  reorder(
    @Param('sectionId') sectionId: string,
    @Body() dto: ReorderLessonsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.lessons.reorder(sectionId, dto.lessonIds, actor);
  }

  @Delete('admin/lessons/:lessonId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Soft-delete a lesson',
    description: 'Watch history and analytics rows are preserved.',
  })
  remove(@Param('lessonId') lessonId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.lessons.remove(lessonId, actor);
  }
}
