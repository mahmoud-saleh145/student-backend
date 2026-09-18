import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_NAMES } from '../../jobs/queue.constants';

import { AnnouncementsController } from './announcements.controller';
import { AnnouncementsService } from './announcements.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

/**
 * `AnnouncementsService` is exported because the maintenance worker dispatches
 * due occurrences. It depends on `NotificationsService` for fan-out rather than
 * writing notification rows itself, so there stays exactly one place that
 * creates a notification.
 */
@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.push })],
  controllers: [NotificationsController, AnnouncementsController],
  providers: [NotificationsService, AnnouncementsService],
  exports: [NotificationsService, AnnouncementsService],
})
export class NotificationsModule {}
