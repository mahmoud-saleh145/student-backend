import { Module } from '@nestjs/common';

import { AccountDeletionAdminController, AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionScheduler } from './account-deletion.scheduler';
import { AccountDeletionService } from './account-deletion.service';

/**
 * Owner decision D5. AuthModule, AuditModule, StorageModule, RedisModule and
 * DatabaseModule are global, so nothing needs importing here.
 */
@Module({
  controllers: [AccountDeletionController, AccountDeletionAdminController],
  providers: [AccountDeletionService, AccountDeletionScheduler],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
