import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly, StudentOnly } from '../../common/decorators/roles.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { CoursePartPurchaseService } from './course-part-purchase.service';
import { CoursePartsService } from './course-parts.service';
import {
  CreateCoursePartDto,
  PartPurchaseReportDto,
  ReorderPartsDto,
  SetPartSectionsDto,
  UpdateCoursePartDto,
} from './dto/course-part.dto';

/**
 * The student's view of a course's parts.
 *
 * Read-only. A part is acquired by redeeming a part-scoped access card through
 * the existing redemption endpoint — there is no buy route here and no wallet
 * involvement, because the wallet is for the Library and a course never debits
 * it.
 *
 * Every route is scoped to the authenticated principal; there is no `userId`
 * parameter anywhere on this controller.
 */
@ApiTags('course-parts')
@ApiBearerAuth('access-token')
@Controller()
export class CoursePartsController {
  constructor(
    private readonly parts: CoursePartsService,
    private readonly purchases: CoursePartPurchaseService,
  ) {}

  @Get('courses/:courseId/parts')
  @StudentOnly()
  @ApiOperation({
    summary: 'The parts of a course, with what the student owns',
    description:
      'Returns every sellable part, owned or not — the student is meant to see the whole course and understand what they hold. Locked parts list their section titles but nothing playable. `hasParts: false` means the course is sold whole, which is not an error.',
  })
  list(@Param('courseId') courseId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.parts.listForStudent(courseId, user.id);
  }

  // There is deliberately no purchase route here. Course parts are unlocked by
  // redeeming a part-scoped access card through the existing redemption
  // endpoint — the wallet is for the Library and is never debited for a course.

  @Get('me/part-purchases')
  @StudentOnly()
  @ApiOperation({
    summary: 'The parts the student holds, and how they got them',
    description:
      'Each row carries the value frozen at the moment of acquisition. A later change to the course price or the part’s share never appears here.',
  })
  mine(@Query() query: PaginationDto, @CurrentUser() user: AuthenticatedUser) {
    return this.purchases.myPurchases(user.id, query.page, query.pageSize);
  }
}

/**
 * Structuring and pricing a course's parts.
 *
 * `@StaffOnly()` with a per-course capability check inside the service, so a
 * teacher may only touch courses they are assigned to and only if their
 * assignment grants pricing or content rights. Admin and master are unrestricted.
 * The purchase report is `@AdminOnly()`, because it is financial.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin')
export class CoursePartsAdminController {
  constructor(
    private readonly parts: CoursePartsService,
    private readonly purchases: CoursePartPurchaseService,
  ) {}

  @Get('courses/:courseId/parts')
  @StaffOnly()
  @ApiOperation({
    summary: 'Every part of a course, with the live allocation',
    description:
      'Includes inactive and archived parts, because their purchase history still matters. `allocationError` is reported rather than thrown so a broken split can be seen and fixed rather than merely failing.',
  })
  list(@Param('courseId') courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.parts.listForAdmin(courseId, actor);
  }

  @Post('courses/:courseId/parts/default')
  @StaffOnly()
  @ApiOperation({
    summary: 'Create the default two-part structure',
    description:
      'Part 1 — Before Mid + Revision at 60%, Part 2 — After Mid + Revision at 40%. Refuses if the course already has parts rather than merging into a split nobody intended.',
  })
  createDefault(@Param('courseId') courseId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.parts.createDefaultStructure(courseId, actor);
  }

  @Post('courses/:courseId/parts')
  @StaffOnly()
  @ApiOperation({
    summary: 'Add a part',
    description:
      'The whole course’s allocation is re-validated before the part is kept, so an invalid split is refused at the point of the mistake.',
  })
  create(
    @Param('courseId') courseId: string,
    @Body() dto: CreateCoursePartDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.parts.create(courseId, dto, actor);
  }

  @Patch('course-parts/:partId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Edit a part',
    description:
      'Price and title may change freely — existing purchases carry their own frozen price and are unaffected. The pricing model may not change once the part has been sold.',
  })
  update(
    @Param('partId') partId: string,
    @Body() dto: UpdateCoursePartDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.parts.update(partId, dto, actor);
  }

  @Put('course-parts/:partId/sections')
  @StaffOnly()
  @ApiOperation({
    summary: 'Set which sections a part contains',
    description:
      'This is what decides what a buyer receives. Sections omitted are unassigned from the part, never deleted. A section belongs to at most one part.',
  })
  setSections(
    @Param('partId') partId: string,
    @Body() dto: SetPartSectionsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.parts.setSections(partId, dto.sectionIds, actor);
  }

  @Put('courses/:courseId/parts/order')
  @StaffOnly()
  @ApiOperation({ summary: 'Reorder the parts of a course' })
  reorder(
    @Param('courseId') courseId: string,
    @Body() dto: ReorderPartsDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.parts.reorder(courseId, dto.partIds, actor);
  }

  @Delete('course-parts/:partId')
  @StaffOnly()
  @ApiOperation({
    summary: 'Remove a part',
    description:
      'Soft delete, and refused outright once the part has been purchased — deleting it would orphan an entitlement someone paid for. Deactivate instead. Sections inside are unassigned, never deleted.',
  })
  remove(@Param('partId') partId: string, @CurrentUser() actor: AuthenticatedUser) {
    return this.parts.remove(partId, actor);
  }

  @Get('part-purchases')
  @AdminOnly()
  @ApiOperation({
    summary: 'Course-part acquisition report',
    description:
      'Which students hold which parts, and what each was worth at redemption. Not a cash report: the money changed hands offline when the card was sold, and the card’s own face value is that figure. Wallet credits are never involved in a course.',
  })
  report(@Query() query: PartPurchaseReportDto) {
    return this.parts.purchaseReport({
      page: query.page,
      pageSize: query.pageSize,
      courseId: query.courseId,
      coursePartId: query.coursePartId,
      userId: query.userId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      order: query.order,
    });
  }
}
