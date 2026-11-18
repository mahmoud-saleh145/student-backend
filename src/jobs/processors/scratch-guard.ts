import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

import type { VideoConfig } from '../../config/configuration';
import { RedisService } from '../../redis/redis.service';

/**
 * Disk protection for the transcoding scratch volume.
 *
 * The worker runs on a laptop whose system drive also holds Windows, Docker's
 * WSL2 image and other projects. A full drive there is not a failed job, it is
 * an unusable machine. So every encode is gated three times:
 *
 *   1. before a job is CLAIMED (`canStart`): the volume must hold the job's
 *      budget plus every other in-flight reservation plus the configured
 *      reserve; otherwise the job is deferred, not failed, and nothing is
 *      downloaded;
 *   2. while it RUNS (`watch`): free space is re-read every few seconds and
 *      the encode is aborted the moment the reserve is breached, before the
 *      drive is actually full;
 *   3. across PROCESSES (`reserve`): each running job records its budget in
 *      Redis, so two worker containers on one host do not both pass the
 *      preflight against the same free bytes.
 *
 * The reserve is absolute (`TRANSCODE_MIN_FREE_GB`), chosen from the real
 * machine: Windows itself needs room to page and update, and the WSL2 image
 * grows in place. Nothing here deletes anything outside the job's own scratch
 * directory.
 */
export const SCRATCH_PAUSE_KEY = 'mobile:transcode:paused';
const RESERVATION_PREFIX = 'transcode:reserve';
/** A reservation outlives any realistic encode; it is released explicitly on completion. */
const RESERVATION_TTL_SECONDS = 6 * 3600;

export interface ScratchAssessment {
  ok: boolean;
  /** Bytes free on the volume right now; null when it could not be measured. */
  freeBytes: number | null;
  /** Bytes other in-flight jobs (any process on this host) have reserved. */
  reservedByOthers: number;
  /** The configured reserve that must stay free after this job's budget. */
  minFreeBytes: number;
  /** Bytes still missing for the job to be safe (0 when ok). */
  shortfallBytes: number;
}

export interface ScratchSnapshot {
  path: string;
  freeBytes: number | null;
  minFreeBytes: number;
  reservedBytes: number;
  /** Free space minus reservations is above the reserve. */
  safe: boolean | null;
}

/**
 * What an operator pause holds back.
 *
 *   all         every mobile encode, including new uploads. For when the
 *               worker itself must not run: a metered connection, a failing
 *               network, a machine that is needed for something else. This is
 *               what a pause without a scope has always meant, and what the
 *               safety watchdog sets.
 *   historical  only the back catalogue (`migration` / `recovery` jobs). New
 *               uploads and staff retries keep flowing. For pausing BETWEEN
 *               backlog batches, which used to hold every new lecture hostage
 *               to the next batch as well.
 */
export type PauseScope = 'all' | 'historical';

export interface PauseState {
  paused: boolean;
  reason: string | null;
  by: string | null;
  at: string | null;
  /** Absent on a flag written before scopes existed, which means `all`. */
  scope: PauseScope;
}

/** Whether the pause holds a job with this trigger back. */
export function pauseHolds(pause: PauseState, trigger: string | null | undefined): boolean {
  if (!pause.paused) return false;
  if (pause.scope !== 'historical') return true;
  return trigger === 'migration' || trigger === 'recovery';
}

export interface ActiveJobNote {
  videoId: string;
  jobId: string;
  startedAt: string;
  progress: number;
}

/**
 * `strict`: a Redis error throws instead of reading as "not paused". The
 * worker's gate and the operator transitions read strictly; dashboards, which
 * only display the flag, keep the lenient read.
 */
export interface PauseIo {
  strict?: boolean;
}

/** Pause flag readers/writers for processes that do not host the guard (the API). */
export async function readPauseState(redis: RedisService, io: PauseIo = {}): Promise<PauseState> {
  type Stored = Partial<Omit<PauseState, 'paused'>>;
  const stored = io.strict
    ? await redis.getJsonOrThrow<Stored>(SCRATCH_PAUSE_KEY)
    : await redis.getJson<Stored>(SCRATCH_PAUSE_KEY);
  return stored
    ? {
        paused: true,
        reason: stored.reason ?? null,
        by: stored.by ?? null,
        at: stored.at ?? null,
        scope: stored.scope === 'historical' ? 'historical' : 'all',
      }
    : { paused: false, reason: null, by: null, at: null, scope: 'all' };
}

export async function writePauseState(
  redis: RedisService,
  paused: boolean,
  by: string,
  reason?: string,
  scope: PauseScope = 'all',
  io: PauseIo = {},
): Promise<PauseState> {
  if (paused) {
    const value = {
      reason: reason?.slice(0, 200) ?? null,
      by,
      at: new Date().toISOString(),
      scope,
    };
    if (io.strict) await redis.setJsonPersistentOrThrow(SCRATCH_PAUSE_KEY, value);
    else await redis.setJsonPersistent(SCRATCH_PAUSE_KEY, value);
  } else if (io.strict) {
    await redis.delOrThrow(SCRATCH_PAUSE_KEY);
  } else {
    await redis.del(SCRATCH_PAUSE_KEY);
  }
  return readPauseState(redis, io);
}

@Injectable()
export class ScratchGuard {
  private readonly logger = new Logger(ScratchGuard.name);
  private readonly cfg: VideoConfig;
  private readonly host = hostname();
  /** Jobs this process is encoding right now, for the heartbeat. */
  private readonly active = new Map<string, ActiveJobNote>();
  /** The last deferral this process decided, for the heartbeat. */
  private lastDeferral: { videoId: string; why: string; at: string } | null = null;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  get minFreeBytes(): number {
    return this.cfg.minFreeBytes;
  }

  /**
   * Free bytes on the volume holding `dir`, or null when it cannot be measured.
   * A scratch directory that does not exist yet (first boot, nothing encoded
   * so far) is measured through its nearest existing parent: the volume is
   * the same, and "unknown" would hide a full drive from the dashboard.
   */
  async freeBytes(dir: string): Promise<number | null> {
    let probe = dir;
    for (let depth = 0; depth < 6; depth += 1) {
      try {
        const fs = await statfs(probe);
        return Number(fs.bavail) * Number(fs.bsize);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
        const parent = dirname(probe);
        if (parent === probe) return null;
        probe = parent;
      }
    }
    return null;
  }

  /** Sum of reservations held by other jobs on this host. */
  async reservedByOthers(excludeId?: string): Promise<number> {
    const entries = await this.redis.scanJson<{ bytes: number }>(`${RESERVATION_PREFIX}:${this.host}:*`);
    let total = 0;
    for (const [key, value] of entries) {
      if (excludeId && key.endsWith(`:${excludeId}`)) continue;
      total += Number(value?.bytes) || 0;
    }
    return total;
  }

  /**
   * Whether `neededBytes` of scratch can be taken from `dir` while leaving the
   * reserve and every other reservation untouched. An unmeasurable volume
   * (unusual filesystem) is reported as ok, exactly as before this guard
   * existed, so a worker on an exotic mount is not bricked by it.
   */
  async assess(dir: string, neededBytes: number, excludeId?: string): Promise<ScratchAssessment> {
    const [freeBytes, reservedByOthers] = await Promise.all([this.freeBytes(dir), this.reservedByOthers(excludeId)]);
    const minFreeBytes = this.cfg.minFreeBytes;
    if (freeBytes === null) return { ok: true, freeBytes, reservedByOthers, minFreeBytes, shortfallBytes: 0 };
    const available = freeBytes - reservedByOthers - minFreeBytes;
    const shortfallBytes = Math.max(0, neededBytes - available);
    return { ok: shortfallBytes === 0, freeBytes, reservedByOthers, minFreeBytes, shortfallBytes };
  }

  /** Records a job's scratch budget so other processes on this host see it. Returns the release. */
  async reserve(id: string, bytes: number): Promise<() => Promise<void>> {
    const key = `${RESERVATION_PREFIX}:${this.host}:${id}`;
    await this.redis.setJson(key, { bytes, at: new Date().toISOString(), pid: process.pid }, RESERVATION_TTL_SECONDS);
    return async () => this.redis.del(key);
  }

  /**
   * Polls free space while an encode runs and calls `onPressure` once if the
   * volume drops below the reserve. The caller aborts the encode; the job is
   * then deferred and retried when space is back, with the source untouched.
   */
  watch(dir: string, onPressure: (freeBytes: number) => void): () => void {
    const intervalMs = Math.max(5, this.cfg.diskCheckSeconds) * 1000;
    let fired = false;
    const timer = setInterval(() => {
      void this.freeBytes(dir).then((free) => {
        if (fired || free === null || free >= this.cfg.minFreeBytes) return;
        fired = true;
        this.logger.error(
          `scratch volume at ${dir} has ${Math.round(free / 1048576)} MB free, below the ` +
            `${Math.round(this.cfg.minFreeBytes / 1048576)} MB reserve; aborting the encode`,
        );
        onPressure(free);
      });
    }, intervalMs);
    timer.unref();
    return () => clearInterval(timer);
  }

  /** What the heartbeat and the overview report. */
  async snapshot(dir: string): Promise<ScratchSnapshot> {
    const [freeBytes, reservedBytes] = await Promise.all([this.freeBytes(dir), this.reservedByOthers()]);
    return {
      path: dir,
      freeBytes,
      minFreeBytes: this.cfg.minFreeBytes,
      reservedBytes,
      safe: freeBytes === null ? null : freeBytes - reservedBytes > this.cfg.minFreeBytes,
    };
  }

  // --- what this process is doing (heartbeat) ---------------------------------

  noteActive(note: ActiveJobNote): void {
    this.active.set(note.videoId, note);
  }

  noteProgress(videoId: string, progress: number): void {
    const note = this.active.get(videoId);
    if (note) note.progress = progress;
  }

  noteFinished(videoId: string): void {
    this.active.delete(videoId);
  }

  noteDeferred(videoId: string, why: string): void {
    this.lastDeferral = { videoId, why, at: new Date().toISOString() };
  }

  activeJobs(): ActiveJobNote[] {
    return [...this.active.values()];
  }

  lastDeferredJob(): { videoId: string; why: string; at: string } | null {
    return this.lastDeferral;
  }

  // --- operator pause -------------------------------------------------------

  /**
   * Strict: THROWS when Redis cannot be read. The lenient read answered "not
   * paused" during a Redis hiccup, which let a held job start encoding.
   */
  async pauseState(): Promise<PauseState> {
    return readPauseState(this.redis, { strict: true });
  }

  /**
   * Pausing stops NEW mobile encodes from starting (each queued job is deferred
   * until resumed); the one already running finishes, so nothing half-written
   * is left behind. Stopping the container is the way to interrupt that one.
   * No TTL: a pause survives restarts until someone resumes.
   */
  async setPaused(paused: boolean, by: string, reason?: string, scope?: PauseScope): Promise<PauseState> {
    return writePauseState(this.redis, paused, by, reason, scope);
  }
}

/** Human-readable bytes for log lines. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'unknown';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1048576)} MB`;
}
