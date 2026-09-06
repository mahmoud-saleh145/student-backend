import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { CoursesService } from './courses.service';
import { ListCoursesDto } from './dto/course.dto';

/**
 * Student-facing course endpoints.
 *
 * Paths mirror the mobile app's `Endpoints.courses` map exactly:
 *   GET /courses, /courses/mine, /courses/:id, /courses/:id/sections,
 *   /courses/:id/progress, /courses/:id/attachments.
 *
 * The catalogue and detail routes are @Public so a signed-out visitor can
 * browse; when a token is present the guard still attaches the principal, so
 * the same handler returns personalised access and progress.
 */
@ApiTags('courses')
@Controller('courses')
export class CoursesController {
  constructor(private readonly courses: CoursesService) {}

  @Get()
  @Public()
  @ApiOperation({
    summary: 'Browse published courses',
    description:
      'Paginated. Personalised access badges and progress are included when a bearer token is supplied.',
  })
  @ApiResponse({ status: 200, description: 'Paginated<CourseSummary>' })
  list(@Query() query: ListCoursesDto, @Req() req: Request) {
    return this.courses.list({
      userId: req.user?.id ?? null,
      page: query.page,
      pageSize: query.pageSize,
      filters: {
        q: query.q,
        universityId: query.universityId,
        facultyId: query.facultyId,
        academicYearId: query.academicYearId,
        teacherId: query.teacherId,
        free: query.free,
        sort: query.sort,
      },
    });
  }

  @Get('mine')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Courses you have joined',
    description:
      'Includes EXPIRED and ARCHIVED courses on purpose — the student needs to see them to know to renew or contact support.',
  })
  mine(@CurrentUser() user: AuthenticatedUser, @Query() query: PaginationDto) {
    return this.courses.listMine({
      userId: user.id,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Get(':courseId')
  @Public()
  @ApiOperation({
    summary: 'Course details with its full dynamic structure',
    description:
      'Reachable without enrollment: browsing and joining are separate states. Gated lessons are returned with `locked: true` rather than hidden, so the course can be evaluated before joining.',
  })
  detail(@Param('courseId') courseId: string, @Req() req: Request) {
    return this.courses.detail({
      courseId,
      userId: req.user?.id ?? null,
      role: req.user?.role,
    });
  }

  @Get(':courseId/sections')
  @Public()
  @ApiOperation({
    summary: 'Course sections',
    description:
      'Returns whatever structure the course was configured with — any count, any titles, in the configured order. No semester shape is assumed.',
  })
  sections(@Param('courseId') courseId: string, @Req() req: Request) {
    return this.courses.sections({
      courseId,
      userId: req.user?.id ?? null,
      role: req.user?.role,
    });
  }

  @Get(':courseId/progress')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Your progress through a course' })
  progress(@Param('courseId') courseId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.courses.courseProgress(courseId, user.id);
  }

  @Get(':courseId/attachments')
  @Public()
  @ApiOperation({
    summary: 'Course materials',
    description:
      'Metadata only. Opening a protected attachment requires a ticket from GET /attachments/{id}/ticket.',
  })
  attachments(@Param('courseId') courseId: string, @Req() req: Request) {
    return this.courses.attachments(courseId, req.user?.id ?? null, req.user?.role);
  }
}
