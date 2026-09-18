import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContentStatus, LibraryPurchaseKind } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

import { SearchablePaginationDto } from '../../../common/dto/pagination.dto';
import { MAX_MONEY_EGP } from '../../wallet/money';

export class BrowseLibraryDto extends SearchablePaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) subjectId?: string;
}

/**
 * Buying a library item.
 *
 * Carries what to buy, never what it costs. The price is read from the database
 * inside the purchase transaction and there is no amount field to tamper with.
 */
export class PurchaseLibraryDto {
  @ApiProperty({ enum: LibraryPurchaseKind })
  @IsEnum(LibraryPurchaseKind)
  kind!: LibraryPurchaseKind;

  @ApiProperty({ description: 'The library part id, or the package id' })
  @IsString()
  @MaxLength(32)
  targetId!: string;
}

export class AdminListLibraryDto extends SearchablePaginationDto {
  @ApiPropertyOptional({ enum: ContentStatus })
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
}

export class CreateMaterialDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) subjectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) coverKey?: string;
}

export class UpdateMaterialDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiPropertyOptional({ enum: ContentStatus }) @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) subjectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) coverKey?: string;
}

export class CreateLibraryPartDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;

  @ApiProperty({ minimum: 0, maximum: MAX_MONEY_EGP })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  price!: number;

  /** Object-storage key from a presigned upload. Never a public URL. */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  objectKey!: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) mimeType?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sizeBytes?: number;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) pageCount?: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPreview?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) sortOrder?: number;
}

export class UpdateLibraryPartDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_MONEY_EGP })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  price?: number;

  @ApiPropertyOptional({ enum: ContentStatus }) @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isPreview?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) objectKey?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) mimeType?: string;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) pageCount?: number;
}

export class CreateLibraryPackageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) materialId?: string;
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;

  @ApiProperty({ minimum: 0, maximum: MAX_MONEY_EGP })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  price!: number;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  partIds!: string[];

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
}

export class UpdateLibraryPackageDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: MAX_MONEY_EGP })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  price?: number;

  @ApiPropertyOptional({ enum: ContentStatus }) @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsString({ each: true })
  partIds?: string[];
}

export class LibraryPurchaseReportDto extends SearchablePaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) userId?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() to?: string;
}
