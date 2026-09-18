import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletTxDirection, WalletTxSource, WalletTxType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsIn,
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
import { MAX_MONEY_EGP } from '../money';

/** Redeeming a recharge card. Note there is no amount field — see below. */
export class RedeemCodeDto {
  /**
   * The card as printed. Normalised here so "abc-1234" and " ABC 1234 " reach
   * the service identically.
   *
   * There is deliberately no amount parameter: the credit comes from the code
   * row, so a client cannot ask to be credited more than the card is worth.
   */
  @ApiProperty({ example: 'KH7P-9Q2M-4XRT' })
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase().replace(/\s+/g, '') : value,
  )
  code!: string;
}

/** Shared filters for the ledger, used by both the student and admin routes. */
export class ListTransactionsDto extends SortablePaginationDto {
  @ApiPropertyOptional({ enum: WalletTxType })
  @IsOptional()
  @IsEnum(WalletTxType)
  type?: WalletTxType;

  @ApiPropertyOptional({ enum: WalletTxDirection })
  @IsOptional()
  @IsEnum(WalletTxDirection)
  direction?: WalletTxDirection;

  @ApiPropertyOptional({ enum: WalletTxSource })
  @IsOptional()
  @IsEnum(WalletTxSource)
  source?: WalletTxSource;

  @ApiPropertyOptional({ description: 'Inclusive lower bound, ISO 8601' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Inclusive upper bound, ISO 8601' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

/** Admin ledger view: the same filters plus a student selector. */
export class AdminListTransactionsDto extends ListTransactionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  userId?: string;
}

export class ListWalletsDto extends SortablePaginationDto {
  @ApiPropertyOptional({ enum: ['balance', 'totalSpent', 'totalRecharged', 'updatedAt'] })
  @IsOptional()
  @IsIn(['balance', 'totalSpent', 'totalRecharged', 'updatedAt'])
  sort?: 'balance' | 'totalSpent' | 'totalRecharged' | 'updatedAt';

  @ApiPropertyOptional({ description: 'Only wallets holding at least this much' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_MONEY_EGP)
  minBalance?: number;
}

/**
 * A manual balance change.
 *
 * `reason` is required and has a real minimum length because an unexplained
 * adjustment is indistinguishable from fraud when someone reads the log a year
 * from now.
 */
export class AdjustWalletDto {
  @ApiProperty({ minimum: 0.01, maximum: MAX_MONEY_EGP })
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(MAX_MONEY_EGP)
  amount!: number;

  @ApiProperty({ enum: WalletTxDirection })
  @IsEnum(WalletTxDirection)
  direction!: WalletTxDirection;

  @ApiProperty({ minLength: 5 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}
