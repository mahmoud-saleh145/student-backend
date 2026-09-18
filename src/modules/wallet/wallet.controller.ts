import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ClientIp, CurrentUser } from '../../common/decorators/current-user.decorator';
import { StudentOnly } from '../../common/decorators/roles.decorator';
import { CodeThrottle } from '../../common/decorators/throttle.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { ListTransactionsDto, RedeemCodeDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

/**
 * The student's own wallet.
 *
 * Every route here is scoped to the authenticated principal. There is no
 * `userId` parameter anywhere on this controller — not optional, not ignored,
 * absent — so there is nothing for a client to tamper with in order to read or
 * spend somebody else's credit.
 */
@ApiTags('wallet')
@ApiBearerAuth('access-token')
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @StudentOnly()
  @ApiOperation({
    summary: 'Current credit balance',
    description:
      'Creates the wallet on first read, so a student who registered before the credit system existed needs no back-fill.',
  })
  summary(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.summary(user.id);
  }

  @Get('transactions')
  @StudentOnly()
  @ApiOperation({
    summary: 'Wallet history',
    description:
      'Server-side filtered, sorted and paginated. Returns only the amounts and the running balance — never the acting administrator, the originating card, or any other student.',
  })
  transactions(@Query() query: ListTransactionsDto, @CurrentUser() user: AuthenticatedUser) {
    return this.wallet.transactions({
      page: query.page,
      pageSize: query.pageSize,
      // From the token, never from the query string.
      userId: user.id,
      type: query.type,
      direction: query.direction,
      source: query.source,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      q: query.q,
      order: query.order,
      includeAdmin: false,
    });
  }

  @Post('redeem')
  @StudentOnly()
  @CodeThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Redeem a recharge code into the wallet',
    description:
      'The credit comes from the card, not from the request — there is no amount parameter. Unknown, revoked and expired cards all return the same error so this cannot be used to guess valid codes. Rate-limited on the same bucket as code validation.',
  })
  redeem(
    @Body() dto: RedeemCodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientIp() ip: string | null,
  ) {
    return this.wallet.redeemRechargeCode({
      rawCode: dto.code,
      userId: user.id,
      ipAddress: ip,
      // The guard has already bound this request to a device; recording the
      // same key on the redemption is what makes card-sharing visible later.
      deviceKey: user.deviceKey,
    });
  }
}
