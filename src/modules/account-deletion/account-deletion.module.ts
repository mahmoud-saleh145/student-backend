import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module';

import { AccountDeletionAdminController, AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionScheduler } from './account-deletion.scheduler';
import { AccountDeletionService } from './account-deletion.service';

/**
 * Owner decision D5. AuthModule, AuditModule, StorageModule, RedisModule and
 * DatabaseModule are global; WalletModule is imported for the settlement
 * confirmation (Phase 6 §4.2), which debits the remaining balance through the
 * one service allowed to move credit.
 */
@Module({
  imports: [WalletModule],
  controllers: [AccountDeletionController, AccountDeletionAdminController],
  providers: [AccountDeletionService, AccountDeletionScheduler],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
