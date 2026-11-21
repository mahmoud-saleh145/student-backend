import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'node:child_process';
import { cpus, freemem, hostname, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

import type { VideoConfig } from '../config/configuration';
import { RedisService } from '../redis/redis.service';
import { DatabaseHealthMonitor, type DatabaseHealthSnapshot } from './database-health.monitor';
import { type ActiveJobNote, type PauseState, ScratchGuard, type ScratchSnapshot } from './processors/scratch-guard';
import { QUEUE_NAMES } from './queue.constants';
import { transientDeferralCounters, type TransientFailureKind } from './transient-deferral';

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

/**
 * Heartbeat of a worker that consumes the MOBILE queue but NOT the original
 * one.
 *
 * With every queue on one host there is one worker and one key, as always.
 * The split deployment (light queues on an always-on host so Gumlet ingests,
 * pushes and maintenance do not stop when the encoding machine sleeps; the
 * CPU-bound mobile encodes on their own machine) has two workers, and two
 * processes writing one key would overwrite each other every minute: the
 * dashboard would alternately report "no ffmpeg" and a healthy encoder.
 *
 * So each process writes exactly ONE key, chosen by what it consumes - no
 * extra Redis traffic - and readers ask for the role they care about.
 */
export const MOBILE_WORKER_HEARTBEAT_KEY = 'worker:heartbeat:mobile';
/** A worker that consumes neither video queue (push / maintenance only). */
export const AUX_WORKER_HEARTBEAT_KEY = 'worker:heartbeat:aux';

const ORIGINAL_QUEUE = 'video-processing';
const MOBILE_QUEUE = 'mobile-video-processing';

function consumes(queues: string[] | 'all' | undefined, name: string): boolean {
  // A heartbeat from before the field existed came from a worker running everything.
  return queues === undefined || queues === 'all' || queues.includes(name);
}

/** The key a worker with this queue selection reports under. */
export function heartbeatKeyFor(queues: string[] | 'all'): string {
  if (consumes(queues, ORIGINAL_QUEUE)) return WORKER_HEARTBEAT_KEY;
  if (consumes(queues, MOBILE_QUEUE)) return MOBILE_WORKER_HEARTBEAT_KEY;
  return AUX_WORKER_HEARTBEAT_KEY;
}
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
  /** Which queues this process consumes ('all' when WORKER_QUEUES is unset). */
  queues?: string[] | 'all';
  /** The transcoding scratch volume as this process sees it. */
  scratch?: ScratchSnapshot;
  /** Host load and memory, for the migration dashboard. */
  load?: { load1: number; cpus: number; freeMemBytes: number; totalMemBytes: number };
  /** Operator pause of mobile encodes. */
  pause?: PauseState;
  /** Mobile encodes running in this process right now. */
  activeJobs?: ActiveJobNote[];
  lastDeferral?: { videoId: string; why: string; at: string } | null;
  /**
   * Can this worker reach the DATABASE (not: is the process alive)? See
   * DatabaseHealthMonitor. Absent on workers built before this field existed.
   */
  db?: DatabaseHealthSnapshot;
  /** Jobs this process deferred through an infrastructure outage, per kind. */
  transientDeferrals?: Record<TransientFailureKind, { count: number; lastAt: string | null }>;
  /**
   * Queue backlog, refreshed every BACKLOG_EVERY_BEATS beats rather than every
   * beat: each read is several Redis commands, and the Upstash plan is metered.
   */
  backlog?: { at: string; video: Record<string, number> | null; mobile: Record<string, number> | null } | null;
}

/** The backlog is read every 10th beat (~10 min at the 60 s interval). */
export const BACKLOG_EVERY_BEATS = 10;
const BACKLOG_STATES = ['wait', 'active', 'delayed', 'prioritized', 'failed', 'paused'] as const;

export function configuredQueues(spec: string | undefined = process.env.WORKER_QUEUES): string[] | 'all' {
  const names = (spec ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length === 0 ? 'all' : names;
}

export async function readWorkerHeartbeat(
  redis: RedisService,
): Promise<WorkerHeartbeatPayload | null> {
  return redis.getJson<WorkerHeartbeatPayload>(WORKER_HEARTBEAT_KEY);
}

/**
 * The worker that runs MOBILE encodes: the primary worker when it consumes the
 * mobile queue too (the single-host deployment), otherwise the dedicated
 * mobile worker. One GET in the usual case, two only in the split deployment.
 */
export async function readMobileWorkerHeartbeat(redis: RedisService): Promise<WorkerHeartbeatPayload | null> {
  const primary = await redis.getJson<WorkerHeartbeatPayload>(WORKER_HEARTBEAT_KEY);
  if (primary && consumes(primary.queues, MOBILE_QUEUE)) return primary;
  return redis.getJson<WorkerHeartbeatPayload>(MOBILE_WORKER_HEARTBEAT_KEY);
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
  private readonly queues = configuredQueues();
  private readonly key = heartbeatKeyFor(this.queues);

  private beats = 0;
  private backlog: WorkerHeartbeatPayload['backlog'] = null;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
    private readonly guard: ScratchGuard,
    // Optional so a process (or a test) without them still beats.
    @Optional() private readonly dbHealth?: DatabaseHealthMonitor,
    @Optional() @InjectQueue(QUEUE_NAMES.video) private readonly videoQueue?: Queue,
    @Optional() @InjectQueue(QUEUE_NAMES.mobileVideo) private readonly mobileQueue?: Queue,
  ) {
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  /** Best effort, bounded; a failure keeps the previous reading. */
  private async refreshBacklog(): Promise<void> {
    const read = async (q?: Queue): Promise<Record<string, number> | null> => {
      if (!q) return null;
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          q.getJobCounts(...BACKLOG_STATES),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 5_000);
          }),
        ]);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };
    const [video, mobile] = await Promise.all([read(this.videoQueue), read(this.mobileQueue)]);
    if (video || mobile) this.backlog = { at: new Date().toISOString(), video, mobile };
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
    void this.redis.del(this.key).catch(() => undefined);
  }

  private async beat(): Promise<void> {
    if (this.beats % BACKLOG_EVERY_BEATS === 0) await this.refreshBacklog();
    this.beats += 1;
    const [scratch, pause] = await Promise.all([
      this.guard.snapshot(join(this.cfg.workDir, 'mobile')).catch(() => undefined),
      this.guard.pauseState().catch(() => undefined),
    ]);
    const payload: WorkerHeartbeatPayload = {
      pid: process.pid,
      host: hostname(),
      startedAt: this.startedAt,
      at: new Date().toISOString(),
      ...this.tools,
      build: runningBuild(),
      capabilities: [...WORKER_CAPABILITIES],
      queues: this.queues,
      scratch,
      load: { load1: loadavg()[0] ?? 0, cpus: cpus().length, freeMemBytes: freemem(), totalMemBytes: totalmem() },
      pause,
      activeJobs: this.guard.activeJobs(),
      lastDeferral: this.guard.lastDeferredJob(),
      db: this.dbHealth?.snapshot(),
      transientDeferrals: transientDeferralCounters(),
      backlog: this.backlog,
    };
    await this.redis
      .setJson(this.key, payload, WORKER_HEARTBEAT_TTL_SECONDS)
      .catch((e: Error) => this.logger.warn(`heartbeat write failed: ${e.message}`));
  }
}
