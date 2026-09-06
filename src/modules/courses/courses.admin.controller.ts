import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';

import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { CoursesAdminService } from './courses.admin.service';
import {
  ArchiveCourseDto,
  AssignTeacherDto,
  ChangePriceDto,
  CreateCourseDto,
  ListStaffCoursesDto,
  UnpublishCourseDto,
  UpdateCourseDto,
} from './dto/course.dto';

/**
 * Course authoring for teachers, admins and the master.
 *
 * Role gating here is coarse (@StaffOnly). The fine-grained check — is this
 * teacher assigned to THIS course, and does the assignment grant this
 * capability — happens inside the service via
 * CourseAccessService.assertCanManageCourse, because it needs to load the
 * assignment row anyway.
 */
@ApiTags('courses')
@ApiBearerAuth('access-token')
@Controller('admin/courses')
export class CoursesAdminController {
  constructor(private readonly admin: CoursesAdminService) {}

  @Get()
  @StaffOnly()
  @ApiOperation({
    summary: 'List courses for management',
    description: 'A teacher sees only the courses they are assigned to.',
  })
  list(@Query() query: ListStaffCoursesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.admin.list({
      actor,
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      status: query.status,
      teacherId: query.teacherId,
    });
  }

  @Get(':courseId')
  @StaffOnly()
  @ApiOperation({ summary: 'Full course record for editing' })
  detail(@Param('courseId') courseId: string) {
    return this.admin.detailForStaff(courseId);
  }

  @Post()
  @StaffOnly()
  @Audit({ action: AuditAction.CREATE, entity: 'course' })
  @ApiOperation({
    summary: 'Create a course',
    description:
      'Starts in DRAFT. Sections are optional here and fully dynamic — pass any number with any titles, or add them later.',
  })
  create(@Body() dto: CreateCourseDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.admin.create(dto, actor);
  }

  @Patch(':courseId')
  @StaffOnly()
  @ApiOperation({ summary: 'Update course information' })
  update(
    @Param('courseId') courseId: string,
    @Body() dto: UpdateCourseDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.admin.update(courseId, dto, actor);
  }

  // --- pricing ---------------------------------------------------------------

  @Post(':courseId/price')
  @StaffOnly()
  @ApiOperation({
    summary: 'Change the price for future purchases',
    description:
      'Appends a new price version. Existing payments keep pointing at the version they were charged at, so historical revenue is never rewritten.',
  })
  changePrice(
    @Param('courseId') courseId: string,
    @Body() dto: ChangePriceDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.admin.changePrice(courseId, dto, actor);
  }

  @Get(':courseId/price-history')
  @StaffOnly()
  @ApiOperation({
    summary: 'Price versions with the purchase count at each',
  })
  priceHistory(@Param('courseId') courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.admin.priceHistory(courseId, actor);
  }

  // --- staffing --------------------------------------------------------------

  @Post(':courseId/teachers')
  @AdminOnly()
  @ApiOperation({
    summary: 'Assign or update a teacher on the course',
    description:
      'Administrators only — a teacher cannot add themselves to a course or alter a colleague’s permissions.',
  })
  assignTeacher(
    @Param('courseId') courseId: string,
    @Body() dto: AssignTeacherDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.admin.assignTeacher(courseId, dto, actor);
  }

  @Delete(':courseId/teachers/:teacherId')
  @AdminOnly()
  @ApiOperation({ summary: 'Remove a teacher (a course must keep at least one)' })
  removeTeacher(
    @Param('courseId') courseId: string,
    @Param('teacherId') teacherId: string,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.admin.removeTeacher(courseId, teacherId, actor);
  }

  // --- lifecycle -------------------------------------------------------------

  @Post(':courseId/publish')
  @StaffOnly()
  @ApiOperation({
    summary: 'Publish a course',
    description:
      'Refused unless the course has sections, lessons, a teacher, a valid price and at least one enrollment method.',
  })
  publish(@Param('courseId') courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.admin.publish(courseId, actor);
  }

  @Post(':courseId/unpublish')
  @StaffOnly()
  @ApiOperation({ summary: 'Move a published course back to draft/hidden/suspended' })
  unpublish(
    @Param('courseId') courseId: string,
    @Body() dto: UnpublishCourseDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.admin.unpublish(courseId, actor, dto.status, dto.reason);
  }

  @Post(':courseId/archive')
  @AdminOnly()
  @ApiOperation({
    summary: 'Archive a course',
    description:
      'Freezes a counter snapshot and stops delivery. Payments, revenue, enrollments, watch history and audit rows are all preserved — the database forbids deleting them.',
  })
  archive(
    @Param('courseId') courseId: string,
    @Body() dto: ArchiveCourseDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.admin.archive(courseId, actor, dto.reason);
  }

  @Post(':courseId/restore')
  @AdminOnly()
  @ApiOperation({
    summary: 'Restore an archived course to DRAFT',
    description:
      'Enrollments whose access window still holds return to ACTIVE; the rest become EXPIRED.',
  })
  restore(@Param('courseId') courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.admin.restore(courseId, actor);
  }
}
