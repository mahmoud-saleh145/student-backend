import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';
import { ProgressModule } from '../progress/progress.module';

import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [ProgressModule, NotificationsModule],
  controllers: [HomeController],
  providers: [HomeService],
})
export class HomeModule {}
