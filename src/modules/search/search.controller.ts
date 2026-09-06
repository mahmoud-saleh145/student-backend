import { Controller, Get, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { Request } from 'express';

import { Public } from '../../common/decorators/public.decorator';

import { SearchService, type SearchEntity } from './search.service';

class SearchQueryDto {
  @IsString() @MinLength(1) @MaxLength(120) q!: string;

  @IsOptional()
  @IsIn(['COURSE', 'LESSON', 'TEACHER', 'ATTACHMENT'])
  entity?: SearchEntity;
}

class SuggestQueryDto {
  @IsString() @MinLength(1) @MaxLength(120) q!: string;
}

@ApiTags('search')
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Search courses, lessons, teachers and materials',
    description: [
      'Grouped by entity. Locked results are returned rather than hidden — a',
      'student searching for a course they have not joined should find it and',
      'be able to open the join screen. Materials are only searched inside',
      'courses the student has actually joined.',
    ].join(' '),
  })
  query(@Query() query: SearchQueryDto, @Req() req: Request) {
    return this.search.search({
      q: query.q,
      entity: query.entity,
      userId: req.user?.id ?? null,
      role: req.user?.role,
    });
  }

  @Get('suggestions')
  @Public()
  @ApiOperation({ summary: 'Typeahead suggestions' })
  suggest(@Query() query: SuggestQueryDto) {
    return this.search.suggestions(query.q);
  }
}
