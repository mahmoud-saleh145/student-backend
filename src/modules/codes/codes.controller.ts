import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CodeStatus, CodeTargetType, DiscountType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsIn,
  IsInt,
  IsNumber,
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
import { SearchablePaginationDto, SortablePaginationDto } from '../../common/dto/pagination.dto';
import type { AuthenticatedUser } from '../../common/types/request-context';
import { MAX_MONEY_EGP } from '../wallet/money';

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

/**
 * Creating recharge cards.
 *
 * The request carries a face value and a discount — never a computed total.
 * `actualPaidAmount` and `creditAmount` are derived on the server and there is
 * no field to post them into, so a tampered client cannot mint credit.
 */
class GenerateRechargeDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  faceValue!: number;

  @IsOptional() @IsEnum(DiscountType) discountType?: DiscountType;

  /** 0-100. Required for a PERCENTAGE discount; 100 is legal and means free. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPercent?: number;

  /** Absolute EGP off. Required for a FIXED discount; never above face value. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  discountAmount?: number;

  @Type(() => Number) @IsInt() @Min(1) @Max(5000) count!: number;

  @IsOptional() @IsString() @MaxLength(120) batchName?: string;
  @IsOptional() @IsISO8601() expiresAt?: string;
  @IsOptional() @IsString() @MaxLength(32) reservedForUserId?: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(6) @Matches(/^[A-Za-z0-9]*$/) prefix?: string;

  /** Honoured only when the platform setting permits it. */
  @IsOptional() @IsBoolean() overrideMinimum?: boolean;
}

class PreviewRechargeDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  faceValue!: number;

  @IsOptional() @IsEnum(DiscountType) discountType?: DiscountType;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100) discountPercent?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_MONEY_EGP) discountAmount?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5000) count?: number;
}

class ListRechargeCodesDto extends SortablePaginationDto {
  @IsOptional() @IsEnum(CodeStatus) status?: CodeStatus;
  @IsOptional() @IsString() @MaxLength(64) batchId?: string;
  @IsOptional() @IsString() @MaxLength(32) redeemedByUserId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
}

class RechargeRevenueDto extends SortablePaginationDto {
  @IsOptional() @IsString() @MaxLength(64) batchId?: string;
  @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @IsOptional() @IsISO8601() from?: string;
  @IsOptional() @IsISO8601() to?: string;
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

  // --- recharge codes (wallet top-up) ---------------------------------------

  @Post('admin/recharge-codes/preview')
  @AdminOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Preview what a recharge card is worth',
    description:
      'Creates nothing. Lets the dashboard show "pays 800, receives 800 credits" while the authoritative arithmetic stays on the server.',
  })
  previewRecharge(@Body() dto: PreviewRechargeDto) {
    return this.codes.previewRecharge(dto);
  }

  @Post('admin/recharge-codes/generate')
  @AdminOnly()
  @ApiOperation({
    summary: 'Generate wallet recharge cards',
    description:
      'The face value, discount, amount actually paid and credits granted are computed once and frozen onto every card. A later change to pricing or to the minimum-recharge setting never alters a card already issued.',
  })
  generateRecharge(@Body() dto: GenerateRechargeDto, @CurrentUser() actor: AuthenticatedUser) {
    return this.codes.generateRechargeBatch(dto, actor);
  }

  @Get('admin/recharge-codes')
  @AdminOnly()
  @ApiOperation({ summary: 'Browse recharge cards with their frozen financials' })
  listRecharge(@Query() query: ListRechargeCodesDto) {
    return this.codes.listRechargeCodes({
      page: query.page,
      pageSize: query.pageSize,
      status: query.status,
      batchId: query.batchId,
      redeemedByUserId: query.redeemedByUserId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      q: query.q,
      order: query.order,
    });
  }

  @Get('admin/recharge-revenue')
  @AdminOnly()
  @ApiOperation({
    summary: 'Cash collected from redeemed recharge cards',
    description:
      'Totals sum the amount actually paid, never the face value. The difference is reported separately as discountGiven.',
  })
  rechargeRevenue(@Query() query: RechargeRevenueDto) {
    return this.codes.rechargeRevenue({
      page: query.page,
      pageSize: query.pageSize,
      batchId: query.batchId,
      userId: query.userId,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      order: query.order,
    });
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
