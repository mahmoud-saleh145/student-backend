import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength, Validate } from 'class-validator';
import {
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

@ValidatorConstraint({ name: 'strongNewPassword', async: false })
class StrongNewPassword implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (typeof value !== 'string' || value.length < 8) return false;
    return /[a-z؀-ۿ]/.test(value) && /\d/.test(value);
  }
  defaultMessage(): string {
    return 'newPassword must be at least 8 characters and include a letter and a digit';
  }
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MaxLength(128)
  @Validate(StrongNewPassword)
  newPassword!: string;
}
