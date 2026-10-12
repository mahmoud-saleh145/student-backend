import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_NAMES } from '../../jobs/queue.constants';
import { PlaybackModule } from '../playback/playback.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { GumletIngestService } from './gumlet-ingest.service';
import { GumletWebhookController } from './gumlet-webhook.controller';
import { GumletWebhookService } from './gumlet-webhook.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { GumletMigrationService } from './gumlet-migration.service';
import { LessonVideoService } from './lesson-video.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.video }),
    NotificationsModule,
    // Exports GumletDrmService (asset API + licensing), DrmVerificationService
    // (the DRM proof authority) and Prisma/Storage wiring.
    PlaybackModule,
  ],
  controllers: [VideosController, GumletWebhookController],
  providers: [
    VideosService,
    GumletIngestService,
    GumletWebhookService,
    GumletMigrationService,
    LessonVideoService,
  ],
  exports: [
    VideosService,
    GumletIngestService,
    GumletWebhookService,
    GumletMigrationService,
    // Exported so playback and lessons can resolve a lecture's ATTACHED video
    // (owned or reused) instead of only its owned one.
    LessonVideoService,
  ],
})
export class VideosModule {}
