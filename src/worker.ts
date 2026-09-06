import 'source-map-support/register';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';

/**
 * Worker entry point.
 *
 * Runs the same application graph as the API but with no HTTP listener, so
 * the processors have every service (Prisma, storage, notifications) available
 * without duplicating wiring. `RUN_WORKERS=true` is what actually registers
 * the BullMQ processors — see JobsModule.
 *
 * Deploy this as a separate process/container from the API:
 *   • it needs ffmpeg and several GB of scratch disk;
 *   • it should scale on queue depth, not request rate;
 *   • a transcode must never compete with request handling for CPU.
 */
async function bootstrap(): Promise<void> {
  process.env.RUN_WORKERS = 'true';

  const app = await NestFactory.createApplicationContext(AppModule, {
    bufferLogs: false,
  });

  const logger = new Logger('Worker');
  app.enableShutdownHooks();

  logger.log('Worker started — processing video, push, maintenance and analytics queues');

  const shutdown = async (signal: string) => {
    logger.log(`${signal} received, draining…`);
    // Nest closes BullMQ workers on shutdown, which waits for the in-flight
    // job to finish rather than killing a half-written transcode.
    await app.close();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Worker failed to start:', error);
  process.exit(1);
});
