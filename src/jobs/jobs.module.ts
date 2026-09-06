import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { RedisConfig } from '../config/configuration';
import { CodesModule } from '../modules/codes/codes.module';
import { EnrollmentsModule } from '../modules/enrollments/enrollments.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { PlaybackModule } from '../modules/playback/playback.module';
import { VideosModule } from '../modules/videos/videos.module';

import { AnalyticsProcessor } from './processors/analytics.processor';
import { MaintenanceProcessor } from './processors/maintenance.processor';
import { PushProcessor } from './processors/push.processor';
import { VideoProcessor } from './processors/video.processor';
import { QUEUE_NAMES } from './queue.constants';
import { MaintenanceScheduler } from './schedulers/maintenance.scheduler';

/**
 * Queue wiring.
 *
 * `RUN_WORKERS=true` turns the processors on. The API deployment leaves it
 * unset, so it only *enqueues*; a separate worker deployment consumes. That
 * split is what keeps a 40-minute transcode from competing with request
 * handling for CPU, and lets the two scale independently.
 */
const runWorkers = process.env.RUN_WORKERS === 'true';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redis = config.getOrThrow<RedisConfig>('redis');
        const url = new URL(redis.url);

        return {
          connection: {
            host: url.hostname,
            port: Number(url.port || 6379),
            username: url.username || undefined,
            password: url.password || undefined,
            // BullMQ requires this to be null, not a number.
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
          },
          prefix: `${redis.prefix}:bull`,
        };
      },
    }),
    BullModule.registerQueue(
      { name: QUEUE_NAMES.video },
      { name: QUEUE_NAMES.push },
      { name: QUEUE_NAMES.maintenance },
      { name: QUEUE_NAMES.analytics },
    ),
    VideosModule,
    NotificationsModule,
    EnrollmentsModule,
    CodesModule,
    PlaybackModule,
  ],
  providers: [
    MaintenanceScheduler,
    ...(runWorkers
      ? [VideoProcessor, PushProcessor, MaintenanceProcessor, AnalyticsProcessor]
      : []),
  ],
  exports: [BullModule],
})
export class JobsModule {}
