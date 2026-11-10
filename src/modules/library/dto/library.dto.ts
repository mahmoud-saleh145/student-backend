import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContentStatus, LibraryDepartmentScope, LibraryPurchaseKind } from '@prisma/client';
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

/** More rungs than any ladder has; a material filed under all of them is "all years". */
export const MAX_MATERIAL_ACADEMIC_YEARS = 20;

/**
 * Browsing filters. They can only NARROW what the student is eligible for.
 *
 * There is deliberately no `universityId`/`facultyId`: academic eligibility is
 * read from the student's own profile on the server, and a client-supplied
 * placement would be meaningless at best. The validation pipe forbids unknown
 * properties, so sending them is a 400.
 */
export class BrowseLibraryDto extends SearchablePaginationDto {
  /** Optional Year/Level browsing filter. Never an eligibility rule. */
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
  /** Materials filed under this year/level, plus those filed under none ("all years"). */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
}

/**
 * A material and its audience.
 *
 * The audience — university, faculty, scope, departments, years/levels — is
 * validated as one unit by LibraryService. University and faculty are required
 * there (a null is refused with a field error naming the field). `null` clears
 * `academicYearId`/`subjectId`.
 *
 * Years/levels: `academicYearIds` is the list (empty = all years). The legacy
 * single `academicYearId` is still accepted — a client that sends it and not
 * the list gets a one-year material — and when both are sent the list wins.
 */
export class CreateMaterialDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(200) title!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000) description?: string;
  @ApiProperty() @IsOptional() @IsString() @MaxLength(32) universityId?: string | null;
  @ApiProperty() @IsOptional() @IsString() @MaxLength(32) facultyId?: string | null;
  @ApiPropertyOptional({ enum: LibraryDepartmentScope, default: LibraryDepartmentScope.FACULTY })
  @IsOptional()
  @IsEnum(LibraryDepartmentScope)
  departmentScope?: LibraryDepartmentScope;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  departmentIds?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(32) academicYearId?: string | null;
  @ApiPropertyOptional({ type: [String], description: 'Years/levels the material is filed under; empty means all years' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MATERIAL_ACADEMIC_YEARS)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  academicYearIds?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(32) subjectId?: string | null;
  /** Object key issued by POST /storage/uploads/library-cover/content. Never a URL. */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) coverKey?: string;
}

/**
 * Editing a material. Sending ANY audience field means sending all of it
 * (universityId, facultyId, departmentScope, departmentIds and the years —
 * `academicYearIds`, or the legacy `academicYearId`); a partial audience is
 * refused, so an edit cannot change who sees a material as a side effect.
 */
export class UpdateMaterialDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) @MaxLength(200) title?: string;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(200) titleAr?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(4000) description?: string | null;
  @ApiPropertyOptional({ enum: ContentStatus }) @IsOptional() @IsEnum(ContentStatus) status?: ContentStatus;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(0) sortOrder?: number;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(32) universityId?: string | null;
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(32) facultyId?: string | null;
  @ApiPropertyOptional({ enum: LibraryDepartmentScope })
  @IsOptional()
  @IsEnum(LibraryDepartmentScope)
  departmentScope?: LibraryDepartmentScope;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  departmentIds?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(32) academicYearId?: string | null;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MATERIAL_ACADEMIC_YEARS)
  @IsString({ each: true })
  @MaxLength(32, { each: true })
  academicYearIds?: string[];
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(32) subjectId?: string | null;
  /** Send null to remove the cover. A key must come from the library-cover upload route. */
  @ApiPropertyOptional({ nullable: true }) @IsOptional() @IsString() @MaxLength(512) coverKey?: string | null;
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

  /**
   * Object key from a presigned thumbnail upload, never a public URL.
   *
   * Left unset the part inherits, at read time, the material's cover and then
   * the library default. The default is never written onto the row: doing so
   * would make an inherited image indistinguishable from a chosen one, and
   * the next change of default would silently overwrite the Admin's choice.
   */
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(512) thumbnailKey?: string;
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

  /** Send null to clear the part's own image and fall back to inheritance. */
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  thumbnailKey?: string | null;
}

export class CreateLibraryPackageDto {
  /** Required: a package belongs to exactly one material, and so do its items. */
  @ApiProperty() @IsString() @MaxLength(32) materialId!: string;
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
