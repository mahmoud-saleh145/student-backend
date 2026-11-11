import { BullModule } from '@nestjs/bullmq';
import { Logger, Module, type Type } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { RedisConfig } from '../config/configuration';
import { CodesModule } from '../modules/codes/codes.module';
import { EnrollmentsModule } from '../modules/enrollments/enrollments.module';
import { NotificationsModule } from '../modules/notifications/notifications.module';
import { PlaybackModule } from '../modules/playback/playback.module';
import { VideosModule } from '../modules/videos/videos.module';

import { AnalyticsProcessor } from './processors/analytics.processor';
import { HlsTranscoder } from './processors/hls-transcoder';
import { MaintenanceProcessor } from './processors/maintenance.processor';
import { MobileEncodeScheduler } from './processors/mobile-encode-scheduler';
import { MobileVideoProcessor } from './processors/mobile-video.processor';
import { PushProcessor } from './processors/push.processor';
import { ScratchGuard } from './processors/scratch-guard';
import { VideoProcessor } from './processors/video.processor';
import { QUEUE_NAMES, type QueueName } from './queue.constants';
import { MaintenanceScheduler } from './schedulers/maintenance.scheduler';
import { WorkerHeartbeat } from './worker-heartbeat';

/**
 * Queue wiring.
 *
 * `RUN_WORKERS=true` turns the processors on. The API deployment leaves it
 * unset, so it only *enqueues*; a separate worker deployment consumes. That
 * split is what keeps a 40-minute transcode from competing with request
 * handling for CPU, and lets the two scale independently.
 */
const runWorkers = process.env.RUN_WORKERS === 'true';

const PROCESSOR_BY_QUEUE: Record<QueueName, Type<unknown>> = {
  [QUEUE_NAMES.video]: VideoProcessor,
  [QUEUE_NAMES.mobileVideo]: MobileVideoProcessor,
  [QUEUE_NAMES.push]: PushProcessor,
  [QUEUE_NAMES.maintenance]: MaintenanceProcessor,
  [QUEUE_NAMES.analytics]: AnalyticsProcessor,
};

/**
 * Which consumers this worker process registers.
 *
 * `WORKER_QUEUES` unset or empty means every queue, which is the single-host
 * deployment. Naming queues lets the CPU-bound mobile transcode run on its own
 * machine (`WORKER_QUEUES=mobile-video-processing`) while the light, latency-
 * sensitive queues stay on a small always-on one. An unknown name is a boot
 * error rather than a silently idle worker.
 */
export function selectProcessors(spec: string | undefined): Type<unknown>[] {
  const names = (spec ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  if (names.length === 0) return Object.values(PROCESSOR_BY_QUEUE);
  return names.map((name) => {
    const processor = PROCESSOR_BY_QUEUE[name as QueueName];
    if (!processor) {
      throw new Error(
        `WORKER_QUEUES names unknown queue "${name}". Known: ${Object.keys(PROCESSOR_BY_QUEUE).join(', ')}`,
      );
    }
    return processor;
  });
}

if (!runWorkers && process.env.NODE_ENV !== 'test') {
  // Not an error — the API is meant to only enqueue — but it is the single
  // most common reason a video stays QUEUED, so it is said at boot.
  new Logger('JobsModule').warn(
    'RUN_WORKERS is not "true": this process only ENQUEUES jobs. Videos will stay QUEUED, ' +
      'scheduled announcements will not send and stream slots will not be reclaimed unless a ' +
      'worker (`npm run worker`, or RUN_WORKERS=true on a process with ffmpeg) is running.',
  );
}

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
            // Rebuilding the connection field by field drops the scheme, and
            // with it the TLS that `rediss://` asks for — ioredis infers that
            // from the URL, which BullMQ never sees. A managed Redis that
            // requires TLS would refuse the handshake, so it is restored here.
            tls: url.protocol === 'rediss:' ? {} : undefined,
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
      { name: QUEUE_NAMES.mobileVideo },
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
    // Shared by the legacy and mobile video processors; harmless on the API.
    HlsTranscoder,
    ScratchGuard,
    // Cross-queue rule: new uploads before historical mobile HLS work.
    MobileEncodeScheduler,
    ...(runWorkers ? [...selectProcessors(process.env.WORKER_QUEUES), WorkerHeartbeat] : []),
  ],
  exports: [BullModule],
})
export class JobsModule {}
