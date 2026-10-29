import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { EnrollmentMethod, EnrollmentState } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';

import { CodeThrottle } from '../../common/decorators/throttle.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StaffOnly, StudentOnly } from '../../common/decorators/roles.decorator';
import { SearchablePaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { EnrollmentsService } from './enrollments.service';

class JoinCourseDto {
  @IsEnum(EnrollmentMethod)
  method!: EnrollmentMethod;
}

class RedeemCodeDto {
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'code contains unsupported characters' })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  code!: string;
}

class ListEnrollmentsDto extends SearchablePaginationDto {
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @IsOptional() @IsEnum(EnrollmentState) state?: EnrollmentState;
  @IsOptional() @IsString() @MaxLength(32) sectionId?: string;
}

class GrantAccessDto {
  @IsString() @MaxLength(32) userId!: string;
  @IsString() @MaxLength(32) courseId!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) accessDurationDays?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

class RevokeDto extends ReasonDto {
  /**
   * The course the caller believes this enrollment belongs to. When sent, an
   * enrollment of any other course is answered as not found, so a stale or
   * mistyped id can never remove a student from a different course.
   */
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
}

class ExtendDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(3650) days!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

class TransferEnrollmentDto {
  /** The course the student’s access moves to. Must be a different course. */
  @IsString() @MaxLength(32) destinationCourseId!: string;
  /**
   * Required iff the source enrollment is section-scoped: names the part of
   * the destination course whose sections become the new scope. Omit for a
   * whole-course transfer.
   */
  @IsOptional() @IsString() @MaxLength(32) destinationPartId?: string;
  /** Required iff the destination course targets several departments. */
  @IsOptional() @IsString() @MaxLength(32) departmentId?: string;
  /** Defaults to the student’s current rung, revalidated for the destination. */
  @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

/**
 * Join Course and enrollment administration.
 *
 * Student paths match the mobile app's `Endpoints.courses` map:
 * POST /courses/:id/enroll and POST /courses/:id/redeem.
 */
@ApiTags('enrollments')
@ApiBearerAuth('access-token')
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  // --- student ---------------------------------------------------------------

  @Post('courses/:courseId/enroll')
  @StudentOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Join a course',
    description:
      'Evaluates the course’s configured requirements and returns the resulting state — ACTIVE, PENDING_PAYMENT or PENDING_APPROVAL. Pressing Join never grants access on its own.',
  })
  @ApiResponse({
    status: 200,
    description: '{ state, courseId, payment, message }',
  })
  @ApiResponse({ status: 402, description: 'PAYMENT_REQUIRED' })
  @ApiResponse({ status: 409, description: 'ALREADY_ENROLLED' })
  @ApiResponse({ status: 410, description: 'COURSE_ARCHIVED' })
  join(
    @Param('courseId') courseId: string,
    @Body() dto: JoinCourseDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.enrollments.join({
      userId: user.id,
      role: user.role,
      courseId,
      method: dto.method,
      ip: req.ip ?? null,
      deviceKey: req.deviceContext?.deviceKey ?? null,
    });
  }

  @Post('courses/:courseId/redeem')
  @StudentOnly()
  @CodeThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeem an access code',
    description:
      'Consumes the code and grants access in one Serializable transaction, so a code can never be redeemed twice under a race.',
  })
  @ApiResponse({ status: 400, description: 'INVALID_CODE' })
  @ApiResponse({ status: 409, description: 'CODE_ALREADY_USED | ALREADY_ENROLLED' })
  redeem(
    @Param('courseId') courseId: string,
    @Body() dto: RedeemCodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    return this.enrollments.redeemCode({
      userId: user.id,
      role: user.role,
      courseId,
      code: dto.code,
      ip: req.ip ?? null,
      deviceKey: req.deviceContext?.deviceKey ?? null,
    });
  }

  // --- administration --------------------------------------------------------

  @Get('admin/enrollments')
  @StaffOnly()
  @ApiOperation({ summary: 'List enrollments' })
  list(@Query() query: ListEnrollmentsDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrollments.list({
      actor,
      page: query.page,
      pageSize: query.pageSize,
      courseId: query.courseId,
      userId: query.userId,
      state: query.state,
      sectionId: query.sectionId,
      q: query.q,
    });
  }

  // Owner decision D3: granting access (including approving a pending request,
  // which turns PENDING_PAYMENT / PENDING_APPROVAL into ACTIVE without a
  // payment) and extending an access window are ADMINISTRATION ONLY. Teachers
  // keep viewing students, rejecting requests and managing content.
  @Post('admin/enrollments/grant')
  @AdminOnly()
  @ApiOperation({
    summary: 'Grant access directly (admin only)',
    description:
      'Approves a pending request or enrolls a student outright — the administrative override for offline payments and approvals. Teachers receive 403.',
  })
  grant(@Body() dto: GrantAccessDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.enrollments.grantByAdmin(dto, actor);
  }

  @Post('admin/enrollments/:id/reject')
  @StaffOnly()
  @ApiOperation({ summary: 'Reject a pending access request' })
  reject(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.enrollments.rejectRequest(id, actor, dto.reason);
  }

  @Post('admin/enrollments/:id/revoke')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a student from a course (revoke access)',
    description:
      'Sets the state to REVOKED, kills live playback, revokes the student’s part entitlements on this course, clears its section grants and cancels PENDING payments on the enrollment. PAID payments, revenue, code redemptions and watch history are preserved; nothing is refunded. Idempotent: a repeat returns alreadyRemoved=true and changes nothing.',
  })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — no such enrollment in this course' })
  @ApiResponse({ status: 409, description: 'INVALID_STATE — a payment is authorised at the provider' })
  revoke(
    @Param('id') id: string,
    @Body() dto: RevokeDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.enrollments.revoke(id, actor, dto.reason, dto.courseId);
  }

  @Post('admin/enrollments/:id/transfer')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transfer a student’s course access to another course (admin only)',
    description:
      'Moves one enrollment to a destination course and points the student’s academic profile at the destination course’s university and faculty, in one Serializable transaction. When the source enrollment is section-scoped, destinationPartId names the part whose sections become the new scope. Creates no payment, redemption or purchase and recognises no revenue; the source enrollment is revoked through the same path as “Remove from course”, so payments, code redemptions and watch history survive. Idempotent: a repeat returns alreadyTransferred=true.',
  })
  @ApiResponse({ status: 404, description: 'NOT_FOUND — no such enrollment or destination course' })
  @ApiResponse({
    status: 409,
    description: 'CONFLICT — the source enrollment changed concurrently | INVALID_STATE — source revoked outside a transfer, or the student already holds the whole destination course',
  })
  @ApiResponse({ status: 422, description: 'VALIDATION_ERROR — incoherent academic selection or missing destination scope' })
  transfer(
    @Param('id') id: string,
    @Body() dto: TransferEnrollmentDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.enrollments.transfer(
      {
        enrollmentId: id,
        destinationCourseId: dto.destinationCourseId,
        destinationPartId: dto.destinationPartId,
        departmentId: dto.departmentId,
        academicYearId: dto.academicYearId,
        reason: dto.reason,
      },
      actor,
    );
  }

  @Post('admin/enrollments/:id/extend')
  @AdminOnly()
  @ApiOperation({
    summary: 'Extend an access window (admin only)',
    description:
      'Extends from the later of the current end date or now, so extending an already-lapsed enrollment actually grants time.',
  })
  extend(
    @Param('id') id: string,
    @Body() dto: ExtendDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.enrollments.extend(id, dto.days, actor, dto.note);
  }
}
