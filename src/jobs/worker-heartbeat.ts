import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import type { VideoConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';

/**
 * Worker liveness, visible from the API.
 *
 * The API only *enqueues*; a separate process consumes. When that process is
 * not running — never deployed, crashed, asleep on a free instance, or booted
 * without its processors registered — nothing tells anyone: the upload
 * "succeeds", the video row says QUEUED, and it stays QUEUED forever.
 *
 * So the consuming process writes a short-lived heartbeat key, and the API
 * reads it (`/meta/health/deep`, `POST /videos/:id/complete`). A missing key
 * means "no worker has checked in for three minutes" — reported plainly
 * instead of being discovered by a stuck lecture.
 *
 * A plain Redis key rather than BullMQ's `getWorkers()`: that relies on
 * `CLIENT LIST`, which managed Redis services such as Upstash do not allow.
 */
export const WORKER_HEARTBEAT_KEY = 'worker:heartbeat';
/*
 * One write per interval, forever, on a per-request Redis plan: at the old
 * 20 seconds that was 4,320 requests a day — about 130,000 a month — to answer
 * a question nobody asks more than a few times a day.
 *
 * A minute between beats with a three-minute TTL still reports a dead worker
 * within three minutes, which is well inside the window that matters: the
 * symptom it exists to explain is a video stuck in QUEUED, and nobody notices
 * that in under three minutes.
 */
export const WORKER_HEARTBEAT_TTL_SECONDS = 180;
const INTERVAL_MS = 60_000;

/**
 * Jobs this build's worker can actually execute, beyond the original set.
 *
 * Needed because an OLDER worker consuming a job name it does not know logs a
 * warning and completes it: the API schedules the DRM re-verification sweep,
 * an old worker swallows it, and verified videos silently go stale (and stop
 * playing) one TTL later while the worker still looks healthy. A heartbeat
 * without these capabilities - every pre-recovery build - is that old worker.
 */
export const WORKER_CAPABILITIES = ['drm-verification-sweep'] as const;

/**
 * The commit this process was built from: BUILD_COMMIT (passed into the
 * Docker image) or RENDER_GIT_COMMIT (set by Render). Null when unknown.
 * Shortened: enough to compare API and worker, nothing more.
 */
export function runningBuild(): string | null {
  const raw = (process.env.BUILD_COMMIT ?? process.env.RENDER_GIT_COMMIT ?? '').trim();
  return /^[0-9a-f]{7,40}$/i.test(raw) ? raw.slice(0, 12).toLowerCase() : null;
}

export interface WorkerHeartbeatPayload {
  pid: number;
  host: string;
  startedAt: string;
  at: string;
  /** Whether ffmpeg/ffprobe could be executed — transcoding is impossible without them. */
  ffmpeg: boolean;
  ffprobe: boolean;
  /** Absent on workers built before these fields existed. */
  build?: string | null;
  capabilities?: string[];
}

export async function readWorkerHeartbeat(
  redis: RedisService,
): Promise<WorkerHeartbeatPayload | null> {
  return redis.getJson<WorkerHeartbeatPayload>(WORKER_HEARTBEAT_KEY);
}

function canRun(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, ['-version'], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

@Injectable()
export class WorkerHeartbeat implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('WorkerHeartbeat');
  private readonly cfg: VideoConfig;
  private timer: NodeJS.Timeout | null = null;
  private readonly startedAt = new Date().toISOString();
  private tools = { ffmpeg: false, ffprobe: false };

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  async onModuleInit(): Promise<void> {
    const [ffmpeg, ffprobe] = await Promise.all([
      canRun(this.cfg.ffmpegPath),
      canRun(this.cfg.ffprobePath),
    ]);
    this.tools = { ffmpeg, ffprobe };

    if (!ffmpeg || !ffprobe) {
      // Every transcode would fail at its first step. Say so at boot, loudly,
      // rather than per job minutes later.
      this.logger.error(
        `ffmpeg=${ffmpeg} ffprobe=${ffprobe}: video transcoding cannot run in this process. ` +
          'Install ffmpeg (the Dockerfile image includes it) or set FFMPEG_PATH/FFPROBE_PATH.',
      );
    }

    await this.beat();
    this.timer = setInterval(() => void this.beat(), INTERVAL_MS);
    this.timer.unref();
    this.logger.log('queue consumers registered in this process; heartbeat started');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    void this.redis.del(WORKER_HEARTBEAT_KEY).catch(() => undefined);
  }

  private async beat(): Promise<void> {
    const payload: WorkerHeartbeatPayload = {
      pid: process.pid,
      host: hostname(),
      startedAt: this.startedAt,
      at: new Date().toISOString(),
      ...this.tools,
      build: runningBuild(),
      capabilities: [...WORKER_CAPABILITIES],
    };
    await this.redis
      .setJson(WORKER_HEARTBEAT_KEY, payload, WORKER_HEARTBEAT_TTL_SECONDS)
      .catch((e: Error) => this.logger.warn(`heartbeat write failed: ${e.message}`));
  }
}
