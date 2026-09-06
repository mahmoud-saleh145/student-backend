import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import type { AppConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { StorageService } from '../storage/storage.service';

/**
 * Health.
 *
 * Two endpoints with different jobs, which matters for Kubernetes:
 *
 *  - `/meta/health` is the **liveness/readiness** probe. It checks only the
 *    database, because that is the one dependency without which the process
 *    cannot serve anything. Redis and R2 being down degrade features but do
 *    not justify restarting the container or pulling it from the load
 *    balancer — a probe that fails on a Redis blip causes a cascading restart
 *    loop, turning a partial outage into a total one.
 *
 *  - `/meta/health/deep` reports everything for humans and dashboards.
 */
@ApiTags('meta')
@Controller('meta')
export class HealthController {
  private readonly app: AppConfig;
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
  }

  @Get('health')
  @Public()
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      'Database only. Redis or storage being unavailable degrades features but must not take the instance out of rotation.',
  })
  async health() {
    const database = await this.prisma.ping();

    return {
      status: database ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      version: process.env.npm_package_version ?? '1.0.0',
      env: this.app.env,
      timestamp: new Date().toISOString(),
    };
  }

  @Get('health/deep')
  @Public()
  @ApiOperation({ summary: 'Full dependency report' })
  async deep() {
    const [database, redis, storage] = await Promise.all([
      this.prisma.ping(),
      this.redis.ping(),
      this.storage.health(),
    ]);

    const checks = { database, redis, storage };
    const critical = database;

    return {
      status: critical ? (redis && storage ? 'ok' : 'degraded') : 'unhealthy',
      checks,
      notes: {
        redis: redis ? undefined : 'Queues, caching and stream limits are degraded',
        storage: storage ? undefined : 'Uploads and playback will fail',
      },
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      env: this.app.env,
      timestamp: new Date().toISOString(),
    };
  }
}
