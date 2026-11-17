import { Module } from '@nestjs/common';

import { NotificationsModule } from '../notifications/notifications.module';

import { NewVideoAnnouncer } from './new-video-announcer.service';

/**
 * The "new video" notification on its own, so that both the video pipelines
 * (VideosModule) and the lesson module (publishing a draft) can use the same
 * instance without either importing the other. Everything else it needs -
 * Prisma, Redis, configuration, CourseAccessService - comes from global
 * modules.
 */
@Module({
  imports: [NotificationsModule],
  providers: [NewVideoAnnouncer],
  exports: [NewVideoAnnouncer],
})
export class NewVideoAnnouncerModule {}
