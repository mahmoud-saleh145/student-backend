import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

import { LoginDto } from '../auth/dto/login.dto';
import { MAX_MONEY_EGP } from '../wallet/money';

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

/**
 * Confirming a physical settlement (Phase 6 §4.2). The administrator states
 * exactly what was handed over; the service refuses anything that does not
 * equal the wallet's current balance, so the audited record and the ledger
 * movement can never disagree.
 */
export class ConfirmSettlementDto {
  @ApiProperty({
    description:
      'The amount settled, in EGP. Must equal the current wallet balance (0 when the balance was already drained through the audited adjustment flow).',
    minimum: 0,
    maximum: MAX_MONEY_EGP,
  })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  amount!: number;

  @ApiProperty({ description: 'How the money changed hands offline, e.g. "cash at the centre"' })
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  method!: string;

  @ApiPropertyOptional({ description: 'Receipt or document reference, if one exists' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  reference?: string;

  @ApiProperty({ description: 'Why/context, e.g. the support ticket reference. Audited.' })
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}
