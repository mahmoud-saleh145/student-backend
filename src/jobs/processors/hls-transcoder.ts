import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';

import type { VideoConfig } from '../../config/configuration';
import { HLS_CODECS, ManifestService } from '../../modules/playback/manifest.service';
import { StorageService } from '../../modules/storage/storage.service';
import { formatBytes, ScratchGuard, type ScratchAssessment } from './scratch-guard';

export interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string;
}

export interface HlsRendition {
  height: number;
  width: number;
  bitrateKbps: number;
  playlistKey: string;
  sizeBytes: number;
}

export interface HlsLadderResult {
  probe: ProbeResult;
  renditions: HlsRendition[];
  hlsPrefix: string;
  masterPlaylistKey: string;
  thumbnailKey?: string;
  isEncrypted: boolean;
}

/**
 * The host cannot run this job right now (no scratch space, ffmpeg missing).
 * Nothing is wrong with the video, so the caller leaves the row retryable.
 */
export class TranscodeEnvironmentError extends Error {}

/**
 * The worker was told to stop (deploy, reboot, `docker stop`) while ffmpeg was
 * running. The video is fine; the job is retried when a worker is back.
 */
export class TranscodeInterruptedError extends TranscodeEnvironmentError {}

/**
 * The scratch volume fell below the configured reserve while ffmpeg was
 * running (ScratchGuard.watch). The encode is killed before the drive fills;
 * the source is untouched and the job is deferred until space is back.
 */
export class TranscodeDiskPressureError extends TranscodeEnvironmentError {}

/**
 * ffmpeg finished but what it produced does not check out (a playlist without
 * its end marker, a segment that will not demux, a duration that does not
 * match the source, an object missing on R2 after upload). Nothing is marked
 * READY on this evidence.
 */
export class TranscodeOutputError extends Error {}

/** Bitrate ladder, in kbps, tuned for lecture content (low motion, lots of text). */
export const BITRATES: Record<number, { video: number; audio: number; maxrate: number }> = {
  360: { video: 600, audio: 64, maxrate: 700 },
  480: { video: 1000, audio: 96, maxrate: 1200 },
  720: { video: 2200, audio: 128, maxrate: 2600 },
  1080: { video: 4200, audio: 128, maxrate: 5000 },
};

/** Segment uploads in flight at once. R2 is happy with more; the host's uplink is not. */
const UPLOAD_CONCURRENCY = 4;

/**
 * Scratch budget.
 *
 * Peak disk during a run is the source plus ONE rendition (each rendition's
 * segments are deleted once uploaded), so the budget is source + the largest
 * rung + a floor for the key, playlists, poster and filesystem slack.
 *
 * The rung is bounded by its `-maxrate` (the encoder cannot exceed it over a
 * `-bufsize` window), so `duration × (maxrate + audio)` is a true ceiling,
 * not an average; MPEG-TS packetisation adds a few percent on top. When no
 * duration is known yet, the old source-multiple is used instead.
 */
const SCRATCH_SOURCE_MULTIPLIER = 2.5;
const SCRATCH_FLOOR_BYTES = 512 * 1024 * 1024;
const TS_OVERHEAD_MULTIPLIER = 1.08;

/**
 * How far the sum of a rendition's segment durations may stray from the
 * probed source duration before the output is rejected. HLS segmenting adds
 * audio priming and rounds to frame boundaries, so a hard equality is wrong;
 * a rung that is several percent short lost frames, and is wrong too.
 */
const DURATION_TOLERANCE_RATIO = 0.025;
const DURATION_TOLERANCE_SECONDS = 3;

/** Grace between SIGTERM and SIGKILL when the worker is asked to stop. */
const CHILD_STOP_GRACE_MS = 5_000;

/**
 * Source → AES-128 HLS ladder on R2.
 *
 * Shared by the legacy local pipeline and the independent mobile pipeline; both
 * produce exactly the layout `ManifestService` serves:
 *
 *   hls/<videoId>/master.m3u8        static master (diagnostics / direct CDN)
 *   hls/<videoId>/<h>p/index.m3u8    media playlist, segment URIs relative
 *   hls/<videoId>/<h>p/seg_NNNNN.ts  MPEG-TS segments, AES-128-CBC
 *
 * Audit of the original worker code, and what changed here:
 *  - `-g` assumed 25 fps, so at 30/60 fps keyframes drifted off the segment
 *    boundaries and quality switches stuttered. The GOP now follows the probed
 *    frame rate, and `-force_key_frames` pins a keyframe to every boundary.
 *  - No `-pix_fmt`: a 10-bit or 4:2:2 source produced High10/High422 output
 *    that phone decoders refuse. Output is forced to 8-bit 4:2:0.
 *  - No stream mapping: a source with a subtitle track or a second audio track
 *    either failed or embedded the extra stream into the TS. The first video
 *    and (optionally) first audio stream are mapped explicitly.
 *  - Segments were uploaded one at a time; now `UPLOAD_CONCURRENCY` at once,
 *    and each rendition's scratch is deleted as soon as it is uploaded, so peak
 *    disk is source + one rendition rather than source + the whole ladder.
 *  - Scratch space is checked before the download rather than discovered as an
 *    ENOSPC halfway through an encode.
 *  - A thread cap (`TRANSCODE_THREADS`) keeps a core free for the push and
 *    maintenance consumers on a single-host deployment.
 *
 * Unchanged on purpose: the derived content key and IV (`ManifestService`
 * derives the same key for playback, and the six October videos were packaged
 * this way), the codec profile the master advertises, and the bitrate ladder.
 *
 * Security note: AES-128 HLS is transport encryption, not DRM. The key is
 * delivered to any client holding a live ticket, so a modified client can save
 * the decrypted stream. See docs/MOBILE_VIDEO_PIPELINE.md.
 */
@Injectable()
export class HlsTranscoder implements OnModuleDestroy {
  private readonly logger = new Logger(HlsTranscoder.name);
  private readonly cfg: VideoConfig;
  /** ffmpeg/ffprobe processes currently running, so a shutdown can stop them. */
  private readonly children = new Set<ChildProcess>();
  private stopping = false;
  /** Set by abortActive(): why the running ffmpeg is being killed, if not a shutdown. */
  private aborting: string | null = null;

  constructor(
    private readonly storage: StorageService,
    config: ConfigService,
    private readonly guard: ScratchGuard,
  ) {
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  /**
   * Kills the running ffmpeg for a reason other than shutdown (disk pressure).
   * The pending exec() rejects with TranscodeDiskPressureError.
   */
  abortActive(reason: string): void {
    this.aborting = reason;
    for (const child of this.children) {
      child.kill('SIGTERM');
      const hammer = setTimeout(() => child.kill('SIGKILL'), CHILD_STOP_GRACE_MS);
      hammer.unref();
      child.once('exit', () => clearTimeout(hammer));
    }
  }

  /**
   * The preflight alone, for a caller that wants to DEFER a job rather than
   * claim it when the host cannot hold it: source size, the scratch budget and
   * the guard's verdict, without downloading or writing anything.
   */
  async preflight(params: {
    workDir: string;
    sourceKey: string;
    durationSeconds?: number;
    ladder: number[];
    guardId: string;
  }): Promise<
    | { sourceMissing: true; sourceBytes: null; budgetBytes: 0; assessment: null }
    | { sourceMissing: false; sourceBytes: number; budgetBytes: number; assessment: ScratchAssessment }
  > {
    const size = await this.storage.objectSize('uploads', params.sourceKey);
    if (size === null) return { sourceMissing: true, sourceBytes: null, budgetBytes: 0, assessment: null };
    const budgetBytes = HlsTranscoder.scratchNeeded(size, {
      durationSeconds: params.durationSeconds,
      ladder: params.ladder,
    });
    await mkdir(params.workDir, { recursive: true }).catch(() => undefined);
    const assessment = await this.guard.assess(params.workDir, budgetBytes, params.guardId);
    return { sourceMissing: false, sourceBytes: size, budgetBytes, assessment };
  }

  /**
   * Nest calls this on SIGTERM/SIGINT (the worker enables shutdown hooks).
   * BullMQ waits for the active job, which would otherwise mean waiting for
   * an hour-long encode; killing ffmpeg makes the job fail as "interrupted"
   * at once, and the queue retries it when a worker is back.
   */
  onModuleDestroy(): void {
    this.stopping = true;
    for (const child of this.children) {
      child.kill('SIGTERM');
      const hammer = setTimeout(() => child.kill('SIGKILL'), CHILD_STOP_GRACE_MS);
      hammer.unref();
      child.once('exit', () => clearTimeout(hammer));
    }
  }

  /**
   * ffmpeg `-threads`. An explicit cap wins; `0` means "every core but one",
   * so the push and maintenance consumers (and the laptop's owner) keep a
   * core while a lecture encodes. ffmpeg's own default would take them all.
   */
  effectiveThreads(): number {
    if (this.cfg.transcodeThreads > 0) return this.cfg.transcodeThreads;
    return Math.max(2, availableParallelism() - 1);
  }

  /**
   * Runs the whole pipeline inside `workDir`, which the caller owns and removes.
   * Progress is reported 0–100; the caller maps it onto the job.
   */
  async run(params: {
    videoId: string;
    sourceKey: string;
    workDir: string;
    ladder: number[];
    encrypt: boolean;
    /** Duration already on the row, if any; sharpens the preflight before download. */
    durationSeconds?: number;
    onProgress?: (percent: number) => Promise<void> | void;
  }): Promise<HlsLadderResult> {
    const { videoId, sourceKey, workDir } = params;
    const progress = async (pct: number) => {
      await params.onProgress?.(Math.max(0, Math.min(100, Math.round(pct))));
    };

    await mkdir(workDir, { recursive: true });
    // Preflight 1: before anything is downloaded. Refuses outright when the
    // host cannot hold the source plus the largest rung, every other job's
    // reservation and the configured reserve.
    const { sourceBytes, budgetBytes } = await this.assertScratchSpace(workDir, sourceKey, videoId, {
      durationSeconds: params.durationSeconds,
      ladder: params.ladder,
    });

    // The budget is reserved for the whole run so a second worker on this host
    // sees it, and free space is watched so a drive that fills up for another
    // reason (someone copying files) stops the encode before Windows suffers.
    const release = await this.guard.reserve(videoId, budgetBytes);
    this.aborting = null;
    const stopWatching = this.guard.watch(workDir, (free) =>
      this.abortActive(
        `scratch volume below the ${formatBytes(this.guard.minFreeBytes)} reserve (${formatBytes(free)} free)`,
      ),
    );
    try {
      return await this.runPipeline(params, sourceBytes, progress);
    } finally {
      stopWatching();
      this.aborting = null;
      await release().catch(() => undefined);
    }
  }

  private async runPipeline(
    params: Parameters<HlsTranscoder['run']>[0],
    sourceBytes: number,
    progress: (pct: number) => Promise<void>,
  ): Promise<HlsLadderResult> {
    const { videoId, sourceKey, workDir } = params;

    // 1. download ----------------------------------------------------------
    await progress(3);
    const sourcePath = join(workDir, 'source.bin');
    await this.storage.downloadToFile('uploads', sourceKey, sourcePath);

    // 2. probe -------------------------------------------------------------
    await progress(8);
    const probe = await this.probe(sourcePath);
    this.logger.log(
      `probe ${videoId}: ${probe.width}x${probe.height} ${Math.round(probe.durationSeconds)}s ` +
        `${probe.frameRate}fps ${probe.videoCodec}/${probe.audioCodec}`,
    );

    const targets = HlsTranscoder.planLadder(params.ladder, probe.height);

    // Preflight 2: the exact duration and the real rungs are known now, and the
    // source is already on disk, so only the largest rung must still fit.
    await this.assertFreeSpace(
      workDir,
      HlsTranscoder.largestRungBytes(probe.durationSeconds, targets) + SCRATCH_FLOOR_BYTES,
      `the ${Math.max(...targets)}p rung of a ${Math.round(probe.durationSeconds)} s, ` +
        `${Math.round(sourceBytes / 1048576)} MB source`,
    );

    // 3. encryption key ------------------------------------------------------
    let keyInfoPath: string | undefined;
    if (params.encrypt) keyInfoPath = await this.writeKeyInfo(workDir, videoId);

    // 4. encode + upload, one rendition at a time ------------------------------
    const renditions: HlsRendition[] = [];
    const hlsPrefix = StorageService.keys.hlsPrefix(videoId);
    for (const [index, height] of targets.entries()) {
      const rate = BITRATES[height] ?? BITRATES[720]!;
      const width = HlsTranscoder.evenWidth(probe.width, probe.height, height);
      const outDir = join(workDir, `${height}p`);
      await mkdir(outDir, { recursive: true });

      // Encoding is ~70% of a rung's time, uploading the rest; ffmpeg's own
      // progress stream drives the first part so a 2-hour encode is not one
      // silent jump.
      const rungStart = 10 + (index / targets.length) * 75;
      const rungSpan = 75 / targets.length;
      let lastReported = -1;
      await this.exec(
        this.cfg.ffmpegPath,
        HlsTranscoder.ffmpegArgs({
          sourcePath,
          outDir,
          height,
          width,
          bitrateKbps: rate.video,
          maxrateKbps: rate.maxrate,
          audioKbps: rate.audio,
          keyInfoPath,
          segmentSeconds: this.cfg.segmentSeconds,
          frameRate: probe.frameRate,
          threads: this.effectiveThreads(),
        }),
        {
          onStdoutLine: (line) => {
            const encoded = HlsTranscoder.parseProgressSeconds(line);
            if (encoded === null || probe.durationSeconds <= 0) return;
            const pct = Math.floor(rungStart + rungSpan * 0.7 * Math.min(1, encoded / probe.durationSeconds));
            if (pct > lastReported) {
              lastReported = pct;
              void progress(pct);
            }
          },
        },
      );
      await progress(rungStart + rungSpan * 0.7);

      // Nothing leaves the host unverified: the playlist must be complete,
      // every segment must demux (and decrypt), and the rung must be as long
      // as the source.
      await this.verifyRendition(outDir, probe, keyInfoPath ? join(workDir, 'enc.key') : undefined);

      const uploaded = await this.uploadRendition(outDir, hlsPrefix, height);
      renditions.push({
        height,
        width,
        bitrateKbps: rate.video + rate.audio,
        playlistKey: `${hlsPrefix}${height}p/index.m3u8`,
        sizeBytes: uploaded.totalBytes,
      });
      // Free the scratch for this rendition before encoding the next one.
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
      await progress(10 + ((index + 1) / targets.length) * 75);
    }

    // 5. static master ----------------------------------------------------------
    // The API serves a per-session master (ManifestService); this one is for
    // diagnostics and any future direct-CDN path.
    const masterPlaylistKey = StorageService.keys.hlsMaster(videoId);
    await this.storage.putObject({
      bucket: 'media',
      objectKey: masterPlaylistKey,
      body: HlsTranscoder.buildStaticMaster(renditions),
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'no-store',
    });

    // 6. poster frame ---------------------------------------------------------
    await progress(90);
    const thumbnailKey = await this.extractThumbnail(sourcePath, workDir, videoId, probe.durationSeconds);

    await progress(100);
    return {
      probe,
      renditions,
      hlsPrefix,
      masterPlaylistKey,
      thumbnailKey,
      isEncrypted: params.encrypt,
    };
  }

  // ---------------------------------------------------------------------------
  // Planning (pure; unit-tested)
  // ---------------------------------------------------------------------------

  /** Never upscale: drop every rung above the source, but always keep the smallest. */
  static planLadder(ladder: number[], sourceHeight: number): number[] {
    const sorted = [...new Set(ladder.filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => a - b);
    if (sorted.length === 0) return [360];
    const smallest = sorted[0]!;
    const targets = sorted.filter((h) => h <= sourceHeight || h === smallest);
    return targets.length > 0 ? targets : [smallest];
  }

  /** Widths must be even for H.264 chroma subsampling. */
  static evenWidth(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
    const ratio = sourceWidth / Math.max(1, sourceHeight);
    return Math.max(2, Math.round((targetHeight * ratio) / 2) * 2);
  }

  static ffmpegArgs(params: {
    sourcePath: string;
    outDir: string;
    height: number;
    width: number;
    bitrateKbps: number;
    maxrateKbps: number;
    audioKbps: number;
    keyInfoPath?: string;
    segmentSeconds: number;
    frameRate: number;
    threads: number;
  }): string[] {
    const seg = params.segmentSeconds;
    const fps = params.frameRate > 0 && params.frameRate <= 120 ? params.frameRate : 25;
    const gop = Math.max(1, Math.round(seg * fps));

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostats',
      // Machine-readable progress on stdout (`out_time_us=...` lines).
      '-progress', 'pipe:1',
      '-y',
      '-i', params.sourcePath,
      // First video stream, first audio stream if there is one. Subtitle and
      // data streams are never carried into the TS.
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn', '-dn',
      // Video: H.264 High 4.1, 8-bit 4:2:0 - what every Android and iOS
      // hardware decoder accepts. `veryfast` is the right trade for lecture
      // content: slower presets buy maybe 8% bitrate for triple the CPU time.
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '23',
      '-maxrate', `${params.maxrateKbps}k`,
      '-bufsize', `${params.maxrateKbps * 2}k`,
      '-b:v', `${params.bitrateKbps}k`,
      '-vf', `scale=${params.width}:${params.height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,
      // Closed GOP aligned to the segment length, at the SOURCE frame rate, and a
      // keyframe forced on every segment boundary regardless of it.
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-force_key_frames', `expr:gte(t,n_forced*${seg})`,
      '-c:a', 'aac',
      '-b:a', `${params.audioKbps}k`,
      '-ac', '2',
      '-ar', '48000',
      '-max_muxing_queue_size', '1024',
      '-f', 'hls',
      '-hls_time', String(seg),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(params.outDir, 'seg_%05d.ts'),
      '-hls_flags', 'independent_segments',
    ];
    if (params.threads > 0) args.push('-threads', String(params.threads));
    if (params.keyInfoPath) args.push('-hls_key_info_file', params.keyInfoPath);
    args.push(join(params.outDir, 'index.m3u8'));
    return args;
  }

  /** Seconds encoded so far from one line of ffmpeg's `-progress` stream, else null. */
  static parseProgressSeconds(line: string): number | null {
    const m = /^out_time_us=(-?\d+)/.exec(line.trim());
    if (!m) return null;
    const us = Number(m[1]);
    return Number.isFinite(us) && us >= 0 ? us / 1_000_000 : null;
  }

  /**
   * Structural check of a media playlist as ffmpeg wrote it. Returns the
   * segment file names in playlist order and the summed segment duration.
   */
  static inspectMediaPlaylist(text: string): { segments: string[]; totalSeconds: number; complete: boolean } {
    const segments: string[] = [];
    let totalSeconds = 0;
    let complete = false;
    let pendingDuration = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const seconds = Number(line.slice('#EXTINF:'.length).split(',')[0]);
        if (Number.isFinite(seconds)) totalSeconds += seconds;
        pendingDuration = true;
      } else if (line === '#EXT-X-ENDLIST') {
        complete = true;
      } else if (!line.startsWith('#')) {
        if (pendingDuration) segments.push(line);
        pendingDuration = false;
      }
    }
    return { segments, totalSeconds, complete };
  }

  /** Whether a rung's summed segment duration is acceptably close to the source's. */
  static durationMatches(renditionSeconds: number, sourceSeconds: number): boolean {
    const tolerance = Math.max(DURATION_TOLERANCE_SECONDS, sourceSeconds * DURATION_TOLERANCE_RATIO);
    return Math.abs(renditionSeconds - sourceSeconds) <= tolerance;
  }

  static buildStaticMaster(renditions: { height: number; width: number; bitrateKbps: number }[]): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
    for (const r of renditions) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrateKbps * 1000},RESOLUTION=${r.width}x${r.height},CODECS="${HLS_CODECS}"`,
      );
      lines.push(`${r.height}p/index.m3u8`);
    }
    return `${lines.join('\n')}\n`;
  }

  /**
   * Upper bound, in bytes, of the largest rung's segments on disk: the rung
   * is capped at `maxrate` + audio, times the duration, plus TS overhead.
   */
  static largestRungBytes(durationSeconds: number, ladder: number[]): number {
    const heights = ladder.filter((h) => Number.isFinite(h) && h > 0);
    const top = heights.length > 0 ? Math.max(...heights) : 720;
    const rate = BITRATES[top] ?? BITRATES[720]!;
    const bytesPerSecond = ((rate.maxrate + rate.audio) * 1000) / 8;
    return Math.ceil(Math.max(0, durationSeconds) * bytesPerSecond * TS_OVERHEAD_MULTIPLIER);
  }

  /**
   * Bytes of scratch a source of `sourceBytes` needs. With a known duration
   * the budget is the source plus the largest rung's ceiling; without one, a
   * source multiple (long lecture sources are small for their length, so the
   * multiple is only a fallback).
   */
  static scratchNeeded(
    sourceBytes: number,
    hint?: { durationSeconds?: number; ladder?: number[] },
  ): number {
    if (hint?.durationSeconds && hint.durationSeconds > 0) {
      return (
        sourceBytes +
        HlsTranscoder.largestRungBytes(hint.durationSeconds, hint.ladder ?? [720]) +
        SCRATCH_FLOOR_BYTES
      );
    }
    return Math.ceil(sourceBytes * SCRATCH_SOURCE_MULTIPLIER) + SCRATCH_FLOOR_BYTES;
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  /** Returns the source size and the reserved budget so later steps can report them. */
  private async assertScratchSpace(
    workDir: string,
    sourceKey: string,
    guardId: string,
    hint: { durationSeconds?: number; ladder?: number[] },
  ): Promise<{ sourceBytes: number; budgetBytes: number }> {
    const size = await this.storage.objectSize('uploads', sourceKey);
    if (size === null) {
      throw new Error(`Source object ${sourceKey} is missing from storage`);
    }
    const budgetBytes = HlsTranscoder.scratchNeeded(size, hint);
    await this.assertFreeSpace(
      workDir,
      budgetBytes,
      `a ${Math.round(size / 1048576)} MB source` +
        (hint.durationSeconds ? ` of ${Math.round(hint.durationSeconds)} s` : ''),
      guardId,
    );
    return { sourceBytes: size, budgetBytes };
  }

  private async assertFreeSpace(workDir: string, needed: number, what: string, guardId?: string): Promise<void> {
    const verdict = await this.guard.assess(workDir, needed, guardId);
    if (verdict.ok) return;
    throw new TranscodeEnvironmentError(
      `Not enough scratch space in ${workDir}: ${formatBytes(verdict.freeBytes)} free, ` +
        `${formatBytes(needed)} needed for ${what}, ${formatBytes(verdict.reservedByOthers)} reserved by other jobs, ` +
        `${formatBytes(verdict.minFreeBytes)} must stay free (short by ${formatBytes(verdict.shortfallBytes)})`,
    );
  }


  private async probe(filePath: string): Promise<ProbeResult> {
    const raw = await this.exec(this.cfg.ffprobePath, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    const parsed = JSON.parse(raw) as {
      format?: { duration?: string };
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
        avg_frame_rate?: string;
      }[];
    };
    const video = parsed.streams?.find((s) => s.codec_type === 'video');
    const audio = parsed.streams?.find((s) => s.codec_type === 'audio');
    if (!video) throw new Error('The uploaded file contains no video stream');

    // avg_frame_rate is the real cadence; r_frame_rate is the container's
    // timebase guess and reads 90000/1 on some screen recordings.
    const parseRate = (value?: string): number | null => {
      if (!value) return null;
      const [num, den] = value.split('/').map(Number);
      if (!num || !den) return null;
      const rate = num / den;
      return Number.isFinite(rate) && rate > 0 && rate <= 120 ? rate : null;
    };
    const frameRate = parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate) ?? 25;

    return {
      durationSeconds: Number(parsed.format?.duration ?? 0),
      width: video.width ?? 1280,
      height: video.height ?? 720,
      frameRate: Math.round(frameRate * 100) / 100,
      videoCodec: video.codec_name ?? 'unknown',
      audioCodec: audio?.codec_name ?? 'none',
    };
  }

  /**
   * ffmpeg's keyinfo format is three lines: the URI written into the playlist,
   * the local path to the key bytes, and the IV. The URI is a placeholder
   * because the real one is injected per session by ManifestService.
   */
  private async writeKeyInfo(workDir: string, videoId: string): Promise<string> {
    const key = ManifestService.deriveContentKey(this.cfg.keyRoot, videoId);
    const iv = ManifestService.deriveIv(videoId);
    const keyPath = join(workDir, 'enc.key');
    const keyInfoPath = join(workDir, 'enc.keyinfo');
    await writeFile(keyPath, key);
    await writeFile(keyInfoPath, `key-placeholder\n${keyPath}\n${iv}\n`);
    return keyInfoPath;
  }

  /**
   * Rejects a rung that must not be served:
   *  - playlist without `#EXT-X-ENDLIST` (ffmpeg was cut off), or listing a
   *    segment that is missing or empty on disk;
   *  - summed segment duration far from the source duration (dropped frames,
   *    a truncated decode);
   *  - any segment that does not demux — and, when encrypted, decrypt — in a
   *    stream-copy pass over the whole rung. Stream copy is I/O-bound (a
   *    2-hour rung takes well under a minute) yet still surfaces a truncated
   *    or garbled TS and a bad AES block, which a decode pass would too.
   */
  private async verifyRendition(outDir: string, probe: ProbeResult, keyPath?: string): Promise<void> {
    const playlistPath = join(outDir, 'index.m3u8');
    const text = await readFile(playlistPath, 'utf8').catch(() => '');
    const playlist = HlsTranscoder.inspectMediaPlaylist(text);
    if (!playlist.complete || playlist.segments.length === 0) {
      throw new TranscodeOutputError(`${outDir}: ffmpeg left an incomplete playlist`);
    }
    for (const name of playlist.segments) {
      const info = await stat(join(outDir, name)).catch(() => null);
      if (!info || info.size === 0) {
        throw new TranscodeOutputError(`${outDir}: segment ${name} is listed but missing or empty`);
      }
    }
    if (probe.durationSeconds > 0 && !HlsTranscoder.durationMatches(playlist.totalSeconds, probe.durationSeconds)) {
      throw new TranscodeOutputError(
        `${outDir}: rendition is ${playlist.totalSeconds.toFixed(1)} s but the source is ` +
          `${probe.durationSeconds.toFixed(1)} s`,
      );
    }

    // A verification copy of the playlist whose key URI points at the local
    // key; ffmpeg's placeholder URI is only ever rewritten by ManifestService.
    // Both files are removed again before the upload step, which also only
    // ever uploads `index.m3u8`.
    const verifyPlaylist = join(outDir, 'verify.m3u8');
    const verifyKey = join(outDir, 'verify.key');
    let input = text;
    if (keyPath) {
      await copyFile(keyPath, verifyKey);
      input = text.replace(/URI="[^"]*"/, 'URI="verify.key"');
    }
    await writeFile(verifyPlaylist, input);
    try {
      await this.exec(this.cfg.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-nostats',
        '-xerror',
        '-allowed_extensions', 'ALL',
        '-protocol_whitelist', 'file,crypto,data',
        '-i', verifyPlaylist,
        '-map', '0',
        '-c', 'copy',
        '-f', 'null', '-',
      ]);
    } catch (error) {
      if (error instanceof TranscodeEnvironmentError) throw error;
      throw new TranscodeOutputError(`${outDir}: a segment failed to demux/decrypt (${(error as Error).message})`);
    } finally {
      await rm(verifyPlaylist, { force: true }).catch(() => undefined);
      await rm(verifyKey, { force: true }).catch(() => undefined);
    }
  }

  private async uploadRendition(
    outDir: string,
    hlsPrefix: string,
    height: number,
  ): Promise<{ totalBytes: number }> {
    const files = await readdir(outDir);
    let totalBytes = 0;

    // Segments first, playlist last: a player that fetches the playlist the
    // instant it appears must not 404 on a segment that is still uploading.
    const segments = files.filter((f) => f.endsWith('.ts')).sort();
    const sizes = new Map<string, number>();

    let next = 0;
    const worker = async () => {
      while (next < segments.length) {
        const file = segments[next++]!;
        const path = join(outDir, file);
        const info = await stat(path);
        totalBytes += info.size;
        sizes.set(file, info.size);
        await this.storage.putFile({
          bucket: 'media',
          objectKey: `${hlsPrefix}${height}p/${file}`,
          filePath: path,
          contentType: 'video/mp2t',
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, segments.length) }, worker));

    const playlistKey = `${hlsPrefix}${height}p/index.m3u8`;
    const body = await readFile(join(outDir, 'index.m3u8'));
    await this.storage.putObject({
      bucket: 'media',
      objectKey: playlistKey,
      body,
      contentType: 'application/vnd.apple.mpegurl',
      cacheControl: 'no-store',
    });

    // Read-after-write check on the objects a player touches first and last:
    // the playlist, the first and the last segment. A truncated multipart or a
    // silently failed PUT shows up here as a size mismatch instead of as a
    // student's "video stopped at 1:32:00".
    const probeKeys: [string, number][] = [[playlistKey, body.length]];
    if (segments.length > 0) {
      const first = segments[0]!;
      const last = segments[segments.length - 1]!;
      probeKeys.push([`${hlsPrefix}${height}p/${first}`, sizes.get(first)!]);
      if (last !== first) probeKeys.push([`${hlsPrefix}${height}p/${last}`, sizes.get(last)!]);
    }
    for (const [key, expected] of probeKeys) {
      const stored = await this.storage.objectSize('media', key);
      if (stored !== expected) {
        throw new TranscodeOutputError(
          `${key}: stored ${stored ?? 'nothing'} but ${expected} bytes were uploaded`,
        );
      }
    }
    return { totalBytes };
  }

  private async extractThumbnail(
    sourcePath: string,
    workDir: string,
    videoId: string,
    durationSeconds: number,
  ): Promise<string | undefined> {
    try {
      // 10% in, so the frame isn't a black intro or a title card.
      const at = Math.max(1, Math.min(durationSeconds * 0.1, durationSeconds - 1));
      const outPath = join(workDir, 'poster.jpg');
      await this.exec(this.cfg.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', at.toFixed(2),
        '-i', sourcePath,
        '-map', '0:v:0',
        '-frames:v', '1',
        '-vf', 'scale=1280:-2',
        '-q:v', '4',
        outPath,
      ]);
      const key = StorageService.keys.videoThumbnail(videoId);
      await this.storage.putFile({
        bucket: 'media',
        objectKey: key,
        filePath: outPath,
        contentType: 'image/jpeg',
      });
      return key;
    } catch (e) {
      // A missing poster is cosmetic; never fail the whole transcode for it.
      this.logger.warn(`thumbnail extraction failed for ${videoId}: ${(e as Error).message}`);
      return undefined;
    }
  }

  private exec(
    command: string,
    args: string[],
    options?: { onStdoutLine?: (line: string) => void },
  ): Promise<string> {
    if (this.stopping) {
      return Promise.reject(new TranscodeInterruptedError('the worker is shutting down'));
    }
    if (this.aborting) {
      return Promise.reject(new TranscodeDiskPressureError(this.aborting));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      this.children.add(child);
      let stdout = '';
      let stderr = '';
      let partialLine = '';

      child.stdout.on('data', (chunk) => {
        if (options?.onStdoutLine) {
          // Streamed consumer (ffmpeg progress): never accumulate, a 2-hour
          // encode emits several MB of progress lines.
          partialLine += chunk.toString();
          const lines = partialLine.split('\n');
          partialLine = lines.pop() ?? '';
          for (const line of lines) options.onStdoutLine(line);
          return;
        }
        stdout += chunk.toString();
        // Guard against a pathological command flooding memory.
        if (stdout.length > 5_000_000) child.kill('SIGKILL');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
      });

      child.on('error', (e) => {
        this.children.delete(child);
        const code = (e as NodeJS.ErrnoException).code;
        reject(
          code === 'ENOENT'
            ? new TranscodeEnvironmentError(`${command} is not installed on this worker`)
            : new Error(`${command} could not be started: ${e.message}`),
        );
      });

      child.on('close', (code, signal) => {
        this.children.delete(child);
        if (this.stopping) {
          reject(new TranscodeInterruptedError(`${command} was stopped by a worker shutdown`));
        } else if (this.aborting) {
          reject(new TranscodeDiskPressureError(`${command} was stopped: ${this.aborting}`));
        } else if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`${command} exited with ${code ?? signal}: ${stderr.slice(-2000)}`));
        }
      });
    });
  }
}
