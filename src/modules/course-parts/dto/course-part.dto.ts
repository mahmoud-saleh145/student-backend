import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContentStatus, PartPricingModel } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { SortablePaginationDto } from '../../../common/dto/pagination.dto';
import { MAX_MONEY_EGP } from '../../wallet/money';

/**
 * Creating a part.
 *
 * Note what is absent: there is no "effective price" field. A percentage part
 * carries a percentage and a fixed part carries an amount; what a student
 * actually pays is derived server-side from the course price and the rest of
 * the allocation. A client cannot propose a price.
 */
export class CreateCoursePartDto {
  @ApiProperty({ example: 'Part 1 — Before Mid + Revision' })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  titleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ enum: PartPricingModel })
  @IsEnum(PartPricingModel)
  pricingModel!: PartPricingModel;

  /** Required for PERCENTAGE. All active parts must total exactly 100. */
  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  pricePercent?: number;

  /** Required for FIXED. All active parts must total the course price. */
  @ApiPropertyOptional({ minimum: 0, maximum: MAX_MONEY_EGP })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  priceAmount?: number;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  sortOrder?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  sectionIds?: string[];
}

export class UpdateCoursePartDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  titleAr?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ enum: PartPricingModel })
  @IsOptional()
  @IsEnum(PartPricingModel)
  pricingModel?: PartPricingModel;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  pricePercent?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_MONEY_EGP })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  priceAmount?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: ContentStatus })
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
}

export class SetPartSectionsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  sectionIds!: string[];
}

export class ReorderPartsDto {
  @ApiProperty({ type: [String], description: 'Every part id, in the new order' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  partIds!: string[];
}

export class PartPurchaseReportDto extends SortablePaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  courseId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  coursePartId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  userId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  to?: string;
}
