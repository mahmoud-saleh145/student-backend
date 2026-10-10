import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';

/** Arabic + Latin letters, spaces, apostrophes, tatweel. Nothing else. */
const NAME_CHARS = /^[\p{Script=Arabic}\p{Script=Latin}\s'’.ـ-]+$/u;

@ValidatorConstraint({ name: 'threePartName', async: false })
class ThreePartNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string') return false;
    return value.trim().split(/\s+/).filter(Boolean).length >= 3;
  }
  defaultMessage(_args: ValidationArguments): string {
    return 'fullName must contain at least three parts';
  }
}

@ValidatorConstraint({ name: 'strongPassword', async: false })
class StrongPasswordConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length < 8) return false;
    // Mirrors the client-side Zod rule so a password accepted on the phone is
    // accepted here, and one the client would reject is rejected here too.
    const hasLower = /[a-z؀-ۿ]/.test(value);
    const hasUpper = /[A-Z]/.test(value) || /[؀-ۿ]/.test(value);
    const hasDigit = /\d/.test(value);
    return hasLower && hasUpper && hasDigit;
  }
  defaultMessage(): string {
    return 'password must be at least 8 characters and include upper, lower and a digit';
  }
}

export class RegisterDto {
  @ApiProperty({ example: 'Ahmed Mohamed Ali', description: 'Three parts minimum' })
  @IsString()
  @MinLength(5)
  @MaxLength(120)
  @Matches(NAME_CHARS, { message: 'fullName may only contain letters and spaces' })
  @Validate(ThreePartNameConstraint)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : value,
  )
  fullName!: string;

  /**
   * Removed.
   *
   * This used to be REQUIRED and to decide whether the app labelled the control
   * "Academic year" or "Level". That is the student choosing their own academic
   * progression system, which the product rules out: the system is the college's
   * configuration, resolved from its override or its university's default.
   *
   * The field is tolerated rather than rejected so that an older published build
   * * of the web or mobile app keeps working during a rollout. It is validated
   * against the department when present (a student cannot claim PROGRAMS for a
   * GENERAL department) but it never influences the resolved system. Remove it
   * *and* `whitelist` it once both clients are on a version that omits it.
   */
  @IsOptional()
  @IsIn(['GENERAL', 'PROGRAMS'])
  studyType?: 'GENERAL' | 'PROGRAMS';

  @ApiProperty({ example: '01001234567' })
  @IsString()
  @MaxLength(20)
  @Matches(/^(?:\+?20|0020|0)?1[0125]\d{8}$/, {
    message: 'phone must be a valid Egyptian mobile number',
  })
  @Transform(({ value }) =>
    typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value,
  )
  phone!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MaxLength(128)
  @Validate(StrongPasswordConstraint)
  password!: string;

  @ApiProperty() @IsString() @MaxLength(32) universityId!: string;
  @ApiProperty() @IsString() @MaxLength(32) facultyId!: string;
  @ApiProperty() @IsString() @MaxLength(32) departmentId!: string;
  @ApiProperty() @IsString() @MaxLength(32) academicYearId!: string;

  @ApiProperty({ enum: Gender })
  @IsEnum(Gender)
  gender!: Gender;

  @ApiPropertyOptional({ enum: ['en', 'ar'], default: 'en' })
  @IsOptional()
  @IsIn(['en', 'ar'])
  locale?: string;
}
