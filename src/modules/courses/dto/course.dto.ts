import { ApiPropertyOptional } from '@nestjs/swagger';
import { CourseStatus, EnrollmentMethod } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
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

const toBool = () =>
  Transform(({ value }) =>
    value === undefined ? undefined : value === true || value === 'true' || value === '1',
  );

export class ListCoursesDto extends SearchablePaginationDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) teacherId?: string;

  @ApiPropertyOptional() @IsOptional() @toBool() @IsBoolean() free?: boolean;

  @ApiPropertyOptional({ enum: ['newest', 'popular', 'priceLow', 'priceHigh'] })
  @IsOptional()
  @IsIn(['newest', 'popular', 'priceLow', 'priceHigh'])
  sort?: 'newest' | 'popular' | 'priceLow' | 'priceHigh';
}

export class ListStaffCoursesDto extends SearchablePaginationDto {
  @ApiPropertyOptional({ enum: CourseStatus })
  @IsOptional()
  @IsEnum(CourseStatus)
  status?: CourseStatus;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(32) teacherId?: string;
}

class SectionSeedDto {
  @IsString() @MinLength(1) @MaxLength(160) title!: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

export class CreateCourseDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;

  @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @IsOptional() @IsString() @MaxLength(32) facultyId?: string;
  @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  teacherIds!: string[];

  @IsOptional() @IsString() @MaxLength(32) leadTeacherId?: string;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000) price?: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @toBool() @IsBoolean() isFree?: boolean;

  /**
   * Which ways a student may join. Rendered verbatim by the app's join sheet,
   * so an empty array means "cannot be joined right now".
   */
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(EnrollmentMethod, { each: true })
  enrollmentMethods!: EnrollmentMethod[];

  @IsOptional()
  @IsIn(['LIFETIME', 'FIXED_DAYS', 'UNTIL_DATE'])
  accessDurationType?: 'LIFETIME' | 'FIXED_DAYS' | 'UNTIL_DATE';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) accessDurationDays?: number;
  @IsOptional() @IsISO8601() accessEndsAt?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) requirements?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20) outcomes?: string[];

  @IsOptional() @IsString() @MaxLength(400) thumbnailKey?: string;

  @IsOptional()
  @IsIn(['WATCH_PERCENT', 'WATCH_FULL', 'MANUAL'])
  completionRuleType?: 'WATCH_PERCENT' | 'WATCH_FULL' | 'MANUAL';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) completionThreshold?: number;
  @IsOptional() @toBool() @IsBoolean() completionRequireContiguous?: boolean;

  /** Optional starting structure. Any names, any count — nothing is fixed. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @Type(() => SectionSeedDto)
  sections?: SectionSeedDto[];
}

export class UpdateCourseDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @MaxLength(500) shortDescription?: string;
  @IsOptional() @IsString() @MaxLength(20000) description?: string;
  @IsOptional() @IsString() @MaxLength(32) universityId?: string;
  @IsOptional() @IsString() @MaxLength(32) academicYearId?: string;
  @IsOptional() @IsString() @MaxLength(400) thumbnailKey?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) requirements?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) outcomes?: string[];

  @IsOptional()
  @IsArray()
  @IsEnum(EnrollmentMethod, { each: true })
  enrollmentMethods?: EnrollmentMethod[];

  @IsOptional()
  @IsIn(['LIFETIME', 'FIXED_DAYS', 'UNTIL_DATE'])
  accessDurationType?: 'LIFETIME' | 'FIXED_DAYS' | 'UNTIL_DATE';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(3650) accessDurationDays?: number;
  @IsOptional() @IsISO8601() accessEndsAt?: string;

  @IsOptional()
  @IsIn(['WATCH_PERCENT', 'WATCH_FULL', 'MANUAL'])
  completionRuleType?: 'WATCH_PERCENT' | 'WATCH_FULL' | 'MANUAL';

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) completionThreshold?: number;
  @IsOptional() @toBool() @IsBoolean() completionRequireContiguous?: boolean;
}

export class ChangePriceDto {
  @Type(() => Number) @IsNumber() @Min(0) @Max(1_000_000) amount!: number;
  @IsOptional() @IsString() @MaxLength(3) currency?: string;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) compareAtAmount?: number;
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

export class AssignTeacherDto {
  @IsString() @MaxLength(32) teacherId!: string;
  @IsOptional() @toBool() @IsBoolean() isLead?: boolean;
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100) revenueSharePercent?: number;
  @IsOptional() @toBool() @IsBoolean() canEditContent?: boolean;
  @IsOptional() @toBool() @IsBoolean() canEditPricing?: boolean;
  @IsOptional() @toBool() @IsBoolean() canPublish?: boolean;
  @IsOptional() @toBool() @IsBoolean() canViewStudents?: boolean;
  @IsOptional() @toBool() @IsBoolean() canViewRevenue?: boolean;
}

export class ArchiveCourseDto {
  @IsString() @MinLength(3) @MaxLength(500) reason!: string;
}

export class UnpublishCourseDto {
  @IsIn([CourseStatus.DRAFT, CourseStatus.HIDDEN, CourseStatus.SUSPENDED])
  status!: Extract<CourseStatus, 'DRAFT' | 'HIDDEN' | 'SUSPENDED'>;
  // or: typeof CourseStatusEnum.DRAFT | typeof CourseStatusEnum.HIDDEN | ...
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}
