import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CodeStatus, CodeTargetType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { CodeThrottle } from '../../common/decorators/throttle.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly, StudentOnly } from '../../common/decorators/roles.decorator';
import { SearchablePaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { CodesService } from './codes.service';

class GenerateCodesDto {
  @IsOptional() @IsEnum(CodeTargetType) targetType?: CodeTargetType;

  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) sectionId?: string;
  @IsOptional() @IsString() @MaxLength(32) teacherId?: string;

  /** Optional human label for the generated batch. */
  @IsOptional() @IsString() @MaxLength(120) batchName?: string;

  /** Face value printed on the card, for reporting only. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000) priceAmount?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;

  @Type(() => Number) @IsInt() @Min(1) @Max(5000) count!: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10000) maxRedemptions?: number;
  @IsOptional() @IsString() @MaxLength(32) reservedForUserId?: string;

  @IsOptional()
  @IsIn(['LIFETIME', 'FIXED_DAYS', 'UNTIL_DATE'])
  accessDurationType?: 'LIFETIME' | 'FIXED_DAYS' | 'UNTIL_DATE';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) accessDurationDays?: number;
  @IsOptional() @IsISO8601() accessEndsAt?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(6) @Matches(/^[A-Za-z0-9]*$/) prefix?: string;
}

class ListCodesDto extends SearchablePaginationDto {
  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
  @IsOptional() @IsString() @MaxLength(32) sectionId?: string;
  @IsOptional() @IsString() @MaxLength(32) teacherId?: string;
  @IsOptional() @IsEnum(CodeTargetType) targetType?: CodeTargetType;
  @IsOptional() @IsEnum(CodeStatus) status?: CodeStatus;
  @IsOptional() @IsString() @MaxLength(64) batchId?: string;
}

class ListBatchesDto extends SearchablePaginationDto {
  @IsOptional() @IsEnum(CodeTargetType) targetType?: CodeTargetType;
}

class ValidateCodeDto {
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  code!: string;

  @IsOptional() @IsString() @MaxLength(32) courseId?: string;
}

class ReasonDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

@ApiTags('codes')
@ApiBearerAuth('access-token')
@Controller()
export class CodesController {
  constructor(private readonly codes: CodesService) {}

  // --- student ---------------------------------------------------------------

  @Post('codes/validate')
  @StudentOnly()
  @CodeThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Check a code without consuming it',
    description:
      'Lets the app show what the code grants before the student commits. Unknown and expired codes return the same error so this cannot be used to enumerate valid codes.',
  })
  validate(@Body() dto: ValidateCodeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.codes.validate(dto.code, user.id, dto.courseId);
  }

  // --- administration --------------------------------------------------------

  @Post('admin/codes/generate')
  @AdminOnly()
  @ApiOperation({
    summary: 'Generate a batch of codes',
    description:
      'Returns the plaintext codes once, at creation. They are stored readable because an administrator has to be able to read one out over the phone.',
  })
  generate(@Body() dto: GenerateCodesDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.codes.generateBatch(dto, actor);
  }

  @Get('admin/codes')
  @AdminOnly()
  @ApiOperation({ summary: 'Browse codes' })
  list(@Query() query: ListCodesDto) {
    return this.codes.list({
      page: query.page,
      pageSize: query.pageSize,
      courseId: query.courseId,
      sectionId: query.sectionId,
      teacherId: query.teacherId,
      targetType: query.targetType,
      status: query.status,
      batchId: query.batchId,
      q: query.q,
    });
  }

  @Get('admin/code-batches')
  @AdminOnly()
  @ApiOperation({
    summary: 'Browse generated batches',
    description:
      'One row per generation run, with its target frozen at creation time so an archived or renamed target still reads correctly.',
  })
  batches(@Query() query: ListBatchesDto) {
    return this.codes.listBatches({
      page: query.page,
      pageSize: query.pageSize,
      targetType: query.targetType,
      q: query.q,
    });
  }

  @Get('admin/code-batches/:batchId/codes')
  @AdminOnly()
  @ApiOperation({
    summary: 'Every card in a batch',
    description:
      'Unpaginated by design — this backs the Excel export, and half an export is worse than none. The 5 000-per-batch generation cap bounds the response.',
  })
  batchCodes(@Param('batchId') batchId: string) {
    return this.codes.batchCodes(batchId);
  }

  @Get('admin/codes/:id/redemptions')
  @AdminOnly()
  @ApiOperation({ summary: 'Who redeemed a code, and when' })
  redemptions(@Param('id') id: string, @Query() query: SearchablePaginationDto) {
    return this.codes.redemptions(id, query.page, query.pageSize);
  }

  @Post('admin/codes/:id/revoke')
  @AdminOnly()
  @ApiOperation({
    summary: 'Revoke a code',
    description:
      'Stops future use. Students who already redeemed it keep their access — the grant was legitimate when it was made.',
  })
  revoke(
    @Param('id') id: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.codes.revoke(id, actor, dto.reason);
  }

  @Post('admin/codes/batches/:batchId/revoke')
  @AdminOnly()
  @ApiOperation({ summary: 'Revoke every unused code in a batch' })
  revokeBatch(
    @Param('batchId') batchId: string,
    @Body() dto: ReasonDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.codes.revokeBatch(batchId, actor, dto.reason);
  }
}
