import { Module } from '@nestjs/common';

import { AdminWalletController } from './admin-wallet.controller';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';

/**
 * The credit system.
 *
 * `WalletService` is exported because every paid feature that follows —
 * course parts, library parts, library packages — debits through it rather
 * than touching the balance itself. That is the point of keeping the ledger
 * behind one service: there is exactly one place where credit moves, so there
 * is exactly one place to audit.
 */
@Module({
  controllers: [WalletController, AdminWalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
