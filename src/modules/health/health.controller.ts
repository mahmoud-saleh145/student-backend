import { Controller, Get } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../../common/decorators/public.decorator';
import type { AppConfig, StorageConfig } from '../../config/configuration';
import {
  readWorkerHeartbeat,
  runningBuild,
  WORKER_HEARTBEAT_TTL_SECONDS,
} from '../../jobs/worker-heartbeat';
import { PrismaService } from '../../database/prisma.service';
import {
  DRM_LAST_SWEEP_FAILURE_KEY,
  DRM_LAST_SWEEP_KEY,
  type DrmLastSweepFailureRecord,
  type DrmLastSweepRecord,
  normalizeSweepIntervalSeconds,
} from '../playback/drm-verification-scheduler.service';
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
  private readonly storageCfg: StorageConfig;
  private readonly startedAt = Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: StorageService,
    config: ConfigService,
  ) {
    this.app = config.getOrThrow<AppConfig>('app');
    this.storageCfg = config.getOrThrow<StorageConfig>('storage');
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
    const [database, redis, storage, worker, videoCounts, lastSweep, lastSweepFailure] = await Promise.all([
      this.prisma.ping(),
      this.redis.ping(),
      this.storage.health(),
      readWorkerHeartbeat(this.redis),
      this.prisma.video
        .groupBy({ by: ['status'], where: { deletedAt: null }, _count: { _all: true } })
        .then((rows) => Object.fromEntries(rows.map((r) => [r.status, r._count._all])))
        .catch(() => null),
      this.redis.getJson<DrmLastSweepRecord>(DRM_LAST_SWEEP_KEY).catch(() => null),
      this.redis.getJson<DrmLastSweepFailureRecord>(DRM_LAST_SWEEP_FAILURE_KEY).catch(() => null),
    ]);

    // The sweep runs in-process (DrmVerificationScheduler). Playback does not
    // depend on it - the ticket path refreshes lapsed proofs - but a sweep that
    // has not completed for two intervals means proofs are only being renewed
    // on demand, which is worth knowing. Same normalisation as the scheduler,
    // so "overdue" is judged against the interval actually running.
    const sweepIntervalSeconds = normalizeSweepIntervalSeconds(process.env.DRM_SWEEP_INTERVAL_SECONDS);
    const drmSweepNote = HealthController.drmSweepNote(sweepIntervalSeconds, lastSweep, lastSweepFailure);

    const checks = { database, redis, storage, worker: Boolean(worker) };
    const critical = database;

    return {
      status: critical ? (redis && storage ? 'ok' : 'degraded') : 'unhealthy',
      checks,
      notes: {
        redis: redis ? undefined : 'Queues, caching and stream limits are degraded',
        storage: storage ? undefined : 'Uploads and playback will fail',
        worker: worker
          ? worker.ffmpeg && worker.ffprobe
            ? undefined
            : 'A worker is running but cannot execute ffmpeg/ffprobe — every transcode will fail'
          : `No queue worker has checked in within ${WORKER_HEARTBEAT_TTL_SECONDS}s — uploaded videos stay QUEUED and scheduled jobs do not run`,
        drmSweep: drmSweepNote,
      },
      drmVerification: {
        sweepIntervalSeconds,
        lastSweep: lastSweep
          ? {
              at: lastSweep.at,
              host: lastSweep.host,
              checked: lastSweep.checked,
              refreshed: lastSweep.refreshed,
              failed: lastSweep.failed,
              errored: lastSweep.errored,
              skippedFresh: lastSweep.skippedFresh,
              skippedPlatform: lastSweep.skippedPlatform,
            }
          : null,
        lastFailedAttemptAt: lastSweepFailure?.at ?? null,
      },
      // Where the video pipeline stands, so "why is it still QUEUED?" has an
      // answer without opening the database. `build` lets a release confirm the
      // API and the worker run the same commit before relying on the worker.
      videoPipeline: {
        apiBuild: runningBuild(),
        worker: worker
          ? {
              lastSeenAt: worker.at,
              host: worker.host,
              ffmpeg: worker.ffmpeg,
              ffprobe: worker.ffprobe,
              build: worker.build ?? null,
              capabilities: worker.capabilities ?? [],
            }
          : null,
        videosByStatus: videoCounts,
        publicApiUrl: this.app.publicUrl,
      },
      // Bucket names are not secrets, and a mismatch between these and the
      // Cloudflare Worker's R2 bindings is invisible otherwise: library PDFs
      // written to one bucket and read from another simply 404 at the edge.
      storageRouting: {
        buckets: this.storageCfg.buckets,
        libraryBucketExplicit: Boolean(process.env.R2_BUCKET_LIBRARY),
        mediaCdn: this.storageCfg.cdnBaseUrl || null,
      },
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      env: this.app.env,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * What, if anything, is wrong with the DRM sweep - most serious first. A
   * sweep that RAN is not automatically a healthy one: a run skipped because
   * the platform is unconfigured renews nothing, and per-video failures or
   * provider errors are exactly the state an operator needs to see.
   */
  static drmSweepNote(
    intervalSeconds: number,
    lastSweep: DrmLastSweepRecord | null,
    lastFailure: DrmLastSweepFailureRecord | null,
    now = Date.now(),
  ): string | undefined {
    if (intervalSeconds === 0) return undefined;
    const lastAt = lastSweep ? new Date(lastSweep.at).getTime() : null;
    if (lastFailure && (lastAt === null || new Date(lastFailure.at).getTime() > lastAt)) {
      return `The last DRM verification sweep attempt (${lastFailure.at}) failed before completing - see the API logs; proofs are only being renewed on demand at ticket time`;
    }
    if (lastAt === null || (now - lastAt) / 1000 > 2 * intervalSeconds) {
      return 'No DRM verification sweep has completed in the last two intervals; proofs are only being renewed on demand at ticket time';
    }
    if ((lastSweep?.skippedPlatform ?? 0) > 0) {
      return 'The last DRM verification sweep was skipped: the platform is not configured for Gumlet DRM, so no proofs were renewed';
    }
    const failed = lastSweep?.failed ?? 0;
    const errored = lastSweep?.errored ?? 0;
    if (failed > 0 || errored > 0) {
      return `The last DRM verification sweep had problems: ${failed} video(s) failed verification and are blocked until re-verified; ${errored} could not be checked (provider unavailable) and will be retried`;
    }
    return undefined;
  }
}
