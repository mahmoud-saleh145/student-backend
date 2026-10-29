import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

import { LoginDto } from '../auth/dto/login.dto';

/** Requesting deletion of the signed-in account: the current password only. */
export class RequestAccountDeletionDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

/**
 * Cancelling a pending deletion. The sessions were revoked when deletion was
 * requested, so the phone and password are the proof - the same shape and
 * validation as sign-in.
 */
export class CancelAccountDeletionDto extends LoginDto {}

/** Administrator recovery of a failed erasure: the reason is audited. */
export class RecoverAccountDeletionDto {
  @ApiProperty({ description: 'Why this is being done, e.g. the support ticket reference' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
