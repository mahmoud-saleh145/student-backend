import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { QUEUE_NAMES } from '../../jobs/queue.constants';
import { PlaybackModule } from '../playback/playback.module';
import { NotificationsModule } from '../notifications/notifications.module';

import { GumletIngestService } from './gumlet-ingest.service';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUE_NAMES.video }),
    NotificationsModule,
    // Exports GumletDrmService (asset API + licensing) and Prisma/Storage wiring.
    PlaybackModule,
  ],
  controllers: [VideosController],
  providers: [VideosService, GumletIngestService],
  exports: [VideosService, GumletIngestService],
})
export class VideosModule {}
