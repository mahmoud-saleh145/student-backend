import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminOnly } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/request-context';

import { AdjustWalletDto, AdminListTransactionsDto, ListWalletsDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

/**
 * Back-office view of the credit system.
 *
 * `@AdminOnly()` throughout, deliberately excluding TEACHER: wallets, balances
 * and revenue are platform-owner concerns, and a teacher who could adjust a
 * balance could pay themselves. This is the authorization boundary the
 * requirements call for, enforced here on the server rather than by hiding a
 * menu item in the dashboard.
 */
@ApiTags('admin')
@ApiBearerAuth('access-token')
@Controller('admin')
export class AdminWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get('wallets')
  @AdminOnly()
  @ApiOperation({
    summary: 'Student balances',
    description:
      'Paginated and searchable by name or phone. Sorting is restricted to a fixed set of columns, so an arbitrary string can never reach the query as a column name.',
  })
  list(@Query() query: ListWalletsDto) {
    return this.wallet.listWallets({
      page: query.page,
      pageSize: query.pageSize,
      q: query.q,
      order: query.order,
      sort: query.sort,
      minBalance: query.minBalance,
    });
  }

  @Get('wallet-transactions')
  @AdminOnly()
  @ApiOperation({
    summary: 'The credit ledger',
    description:
      'Append-only. Filterable by student, type, direction, source and date range. There is no edit or delete endpoint for a ledger row anywhere in the API — corrections are made with an adjustment, which leaves the original entry visible.',
  })
  transactions(@Query() query: AdminListTransactionsDto) {
    return this.wallet.transactions({
      page: query.page,
      pageSize: query.pageSize,
      userId: query.userId,
      type: query.type,
      direction: query.direction,
      source: query.source,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      q: query.q,
      order: query.order,
      includeAdmin: true,
    });
  }

  @Get('wallets/:userId')
  @AdminOnly()
  @ApiOperation({ summary: 'One student’s balance and recent history' })
  async detail(@Param('userId') userId: string) {
    const [summary, recent] = await Promise.all([
      this.wallet.summary(userId),
      this.wallet.transactions({ page: 1, pageSize: 20, userId, includeAdmin: true }),
    ]);
    return { userId, wallet: summary, recent };
  }

  @Post('wallets/:userId/adjust')
  @AdminOnly()
  @ApiOperation({
    summary: 'Move credit by hand',
    description:
      'Writes an ADMIN_ADJUSTMENT ledger entry recording the amount, the administrator and the reason. A debit that would overdraw the wallet is refused exactly like a purchase would be.',
  })
  adjust(
    @Param('userId') userId: string,
    @Body() dto: AdjustWalletDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.wallet.adjust({
      userId,
      amount: dto.amount,
      direction: dto.direction,
      reason: dto.reason,
      actor,
    });
  }

  @Get('wallets/:userId/integrity')
  @AdminOnly()
  @ApiOperation({
    summary: 'Prove the cached balance against the ledger',
    description:
      'Re-sums every credit and debit and compares the result with the stored balance. Read-only: a mismatch is fixed with a compensating entry, never by writing to the balance.',
  })
  integrity(@Param('userId') userId: string) {
    return this.wallet.verifyIntegrity(userId);
  }
}
