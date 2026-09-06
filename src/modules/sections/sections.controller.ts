import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ContentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { StaffOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { SectionsService } from './sections.service';

class CreateSectionDto {
  @IsString() @MinLength(1) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(160) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) sortOrder?: number;
  @IsOptional() @IsISO8601() unlocksAt?: string;
  @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
}

class UpdateSectionDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(160) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
  @IsOptional() @IsISO8601() unlocksAt?: string | null;
}

class ReorderSectionsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  sectionIds!: string[];
}

/**
 * Course structure authoring.
 *
 * Students read sections through GET /courses/:id/sections; this controller is
 * the authoring side.
 */
@ApiTags('sections')
@ApiBearerAuth('access-token')
@Controller()
export class SectionsController {
  constructor(private readonly sections: SectionsService) {}

  @Get('admin/courses/:courseId/sections')
  @StaffOnly()
  @ApiOperation({ summary: 'List sections for authoring' })
  list(@Param('courseId') courseId: string) {
    return this.sections.listForCourse(courseId);
  }

  @Post('admin/courses/:courseId/sections')
  @StaffOnly()
  @ApiOperation({
    summary: 'Add a section',
    description:
      'Titles are free text and the count is unbounded — "Before Midterm", "Unit 3", "Part 4" are all valid. Passing sortOrder inserts at that position and shifts the rest.',
  })
  create(
    @Param('courseId') courseId: string,
    @Body() dto: CreateSectionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sections.create(courseId, dto, actor);
  }

  @Patch('admin/sections/:sectionId')
  @StaffOnly()
  @ApiOperation({ summary: 'Update a section' })
  update(
    @Param('sectionId') sectionId: string,
    @Body() dto: UpdateSectionDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sections.update(sectionId, dto, actor);
  }

  @Post('admin/courses/:courseId/sections/reorder')
  @StaffOnly()
  @ApiOperation({
    summary: 'Reorder every section in one call',
    description:
      'Send the complete ordered id list. Applying the final order as a set avoids intermediate states where two sections share a position.',
  })
  reorder(
    @Param('courseId') courseId: string,
    @Body() dto: ReorderSectionsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.sections.reorder(courseId, dto.sectionIds, actor);
  }

  @Delete('admin/sections/:sectionId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Soft-delete a section and its lessons',
    description: 'Watch history and analytics for those lessons are preserved.',
  })
  remove(@Param('sectionId') sectionId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.sections.remove(sectionId, actor);
  }
}
