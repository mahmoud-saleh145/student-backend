import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';

import { SupportAdminController, SupportController } from './support.controller';
import { SupportService } from './support.service';

@Module({
  imports: [NotificationsModule],
  controllers: [SupportController, SupportAdminController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
