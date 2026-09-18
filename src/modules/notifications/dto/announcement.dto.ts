import { AnnouncementFrequency, AnnouncementStatus, EnrollmentState, UserRole } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { PaginationDto } from '../../../common/dto/pagination.dto';
import { MAX_IDS_PER_DIMENSION } from '../audience';

/**
 * The audience, as the dashboard sends it.
 *
 * `@ArrayMinSize(1)` on every list is the important annotation. An empty list
 * compiles to `{ in: [] }`, which matches nobody — a send that reports success
 * and reaches no one. Omitting a field is how you say "any"; sending it empty
 * is a mistake, and it is refused at the edge as well as in the compiler.
 */
export class AudienceRuleDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsEnum(UserRole, { each: true })
  roles?: UserRole[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  universityIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  facultyIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  departmentIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  academicYearIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  courseIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  subjectIds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsEnum(EnrollmentState, { each: true })
  enrollmentStates?: EnrollmentState[];

  @IsOptional()
  @IsBoolean()
  includeInactiveAccounts?: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS_PER_DIMENSION)
  @ArrayUnique()
  @IsString({ each: true })
  excludeUserIds?: string[];
}

/** Shared schedule fields. Absent `sendAtLocal` means the announcement is a draft. */
class ScheduleFieldsDto {
  @IsOptional()
  @IsEnum(AnnouncementFrequency)
  frequency?: AnnouncementFrequency;

  /** 24-hour local time in `timezone`, e.g. "19:00". */
  @IsOptional()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'sendAtLocal must be "HH:MM" in 24-hour form, e.g. "19:00".',
  })
  sendAtLocal?: string;

  /** IANA zone. Defaults to Africa/Cairo, which observes DST. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  /** WEEKLY only. ISO weekdays: 1 = Monday … 7 = Sunday. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(7, { each: true })
  weekdays?: number[];

  /** MONTHLY only. Clamped to the last day of a shorter month. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  dayOfMonth?: number;

  @IsOptional() @IsDateString() startsOn?: string;
  @IsOptional() @IsDateString() endsOn?: string;

  @IsOptional() @IsInt() @Min(1) @Max(1000) maxOccurrences?: number;
}

export class CreateScheduledAnnouncementDto extends ScheduleFieldsDto {
  @IsString() @MinLength(3) @MaxLength(200) title!: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsString() @MinLength(3) @MaxLength(2000) body!: string;
  @IsOptional() @IsString() @MaxLength(2000) bodyAr?: string;
  @IsOptional() @IsString() @MaxLength(200) route?: string;
  @IsOptional() @IsBoolean() sendPush?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceRuleDto)
  audience?: AudienceRuleDto;

  /**
   * Send immediately rather than scheduling.
   *
   * Kept explicit rather than inferred from a missing schedule, because
   * "I forgot to set a time" and "send this to everyone now" must not be the
   * same request.
   */
  @IsOptional() @IsBoolean() sendNow?: boolean;
}

export class UpdateScheduledAnnouncementDto extends ScheduleFieldsDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(200) title?: string;
  @IsOptional() @IsString() @MaxLength(200) titleAr?: string;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(2000) body?: string;
  @IsOptional() @IsString() @MaxLength(2000) bodyAr?: string;
  @IsOptional() @IsString() @MaxLength(200) route?: string;
  @IsOptional() @IsBoolean() sendPush?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => AudienceRuleDto)
  audience?: AudienceRuleDto;
}

export class PreviewAudienceDto {
  @ValidateNested()
  @Type(() => AudienceRuleDto)
  audience!: AudienceRuleDto;
}

export class ListAnnouncementsDto extends PaginationDto {
  @IsOptional() @IsEnum(AnnouncementStatus) status?: AnnouncementStatus;
}
