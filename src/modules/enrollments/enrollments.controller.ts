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
import { PaginationDto } from '../../common/dto/pagination.dto';
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

class ListEnrollmentsDto extends PaginationDto {
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @IsOptional() @IsEnum(EnrollmentState) state?: EnrollmentState;
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

class ExtendDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(3650) days!: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
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
  list(@Query() query: ListEnrollmentsDto) {
    return this.enrollments.list({
      page: query.page,
      pageSize: query.pageSize,
      courseId: query.courseId,
      userId: query.userId,
      state: query.state,
    });
  }

  @Post('admin/enrollments/grant')
  @StaffOnly()
  @ApiOperation({
    summary: 'Grant access directly',
    description:
      'Approves a pending request or enrolls a student outright — the administrative override for offline payments and approvals.',
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
  @StaffOnly()
  @ApiOperation({
    summary: 'Revoke access',
    description:
      'Sets the state to REVOKED and kills any live playback. The enrollment row, its payments and watch history are all preserved.',
  })
  revoke(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.enrollments.revoke(id, actor, dto.reason);
  }

  @Post('admin/enrollments/:id/extend')
  @StaffOnly()
  @ApiOperation({
    summary: 'Extend an access window',
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
