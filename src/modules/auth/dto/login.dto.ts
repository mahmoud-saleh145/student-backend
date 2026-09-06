import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @ApiProperty({ example: '01001234567' })
  @IsString()
  @MaxLength(20)
  @Matches(/^(?:\+?20|0020)?1[0125]\d{8}$/, {
    message: 'phone must be a valid Egyptian mobile number',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.replace(/[\s()-]/g, '') : value))
  phone!: string;

  /**
   * No complexity rule here on purpose: an existing account may predate the
   * current policy, and rejecting it client- or server-side at login would
   * lock the student out of a password the system still accepts.
   */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}
