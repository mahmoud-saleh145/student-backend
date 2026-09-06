import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import type { VideoConfig } from '../../config/configuration';
import { ManifestService } from '../../modules/playback/manifest.service';
import { StorageService } from '../../modules/storage/storage.service';
import { VideosService } from '../../modules/videos/videos.service';
import { QUEUE_NAMES, VIDEO_JOBS, type TranscodeJobData } from '../queue.constants';

interface ProbeResult {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number;
  videoCodec: string;
  audioCodec: string;
}

/** Bitrate ladder, in kbps, tuned for lecture content (low motion, lots of text). */
const BITRATES: Record<number, { video: number; audio: number; maxrate: number }> = {
  360: { video: 600, audio: 64, maxrate: 700 },
  480: { video: 1000, audio: 96, maxrate: 1200 },
  720: { video: 2200, audio: 128, maxrate: 2600 },
  1080: { video: 4200, audio: 128, maxrate: 5000 },
};

/**
 * Video transcoding.
 *
 * Runs in the worker process (`npm run worker`), never in the API. A single
 * 40-minute lecture saturates a core for several minutes; doing that inside
 * the request process would make the whole API unresponsive.
 *
 * Pipeline per video:
 *   download source → ffprobe → transcode ladder (AES-128 HLS) → upload
 *   → write metadata → delete scratch
 *
 * Design notes:
 *  - **Renditions above the source are skipped.** Upscaling a 480p phone
 *    recording to 1080p triples the storage bill for a blurrier picture.
 *  - **Encryption keys are derived, never stored.** Both this worker and the
 *    manifest service compute HMAC(HLS_KEY_ROOT, videoId), so the key exists
 *    only in memory and in the ffmpeg keyinfo file, which is deleted with the
 *    scratch directory.
 *  - **Scratch is always cleaned up**, including on failure, because a partial
 *    transcode of a 2 GB source left behind will fill the disk within a day.
 */
@Processor(QUEUE_NAMES.video, {
  // One video at a time per worker: ffmpeg already uses every core, so
  // parallel jobs just thrash.
  concurrency: 1,
  lockDuration: 30 * 60_000,
  stalledInterval: 60_000,
})
export class VideoProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessor.name);
  private readonly cfg: VideoConfig;

  constructor(
    private readonly storage: StorageService,
    private readonly videos: VideosService,
    config: ConfigService,
  ) {
    super();
    this.cfg = config.getOrThrow<VideoConfig>('video');
  }

  async process(job: Job<TranscodeJobData>): Promise<unknown> {
    if (job.name !== VIDEO_JOBS.transcode) return null;

    const { videoId, sourceKey, ladder, encrypt } = job.data;
    const workDir = join(this.cfg.workDir, videoId);

    this.logger.log(`transcoding video ${videoId} (job ${job.id})`);

    try {
      await this.videos.markProcessing(videoId);
      await mkdir(workDir, { recursive: true });

      // 1. download ---------------------------------------------------------
      await job.updateProgress(5);
      const sourcePath = join(workDir, 'source.bin');
      await this.downloadSource(sourceKey, sourcePath);

      // 2. probe ------------------------------------------------------------
      await job.updateProgress(10);
      const probe = await this.probe(sourcePath);
      this.logger.log(
        `probe ${videoId}: ${probe.width}x${probe.height} ${Math.round(probe.durationSeconds)}s ${probe.videoCodec}`,
      );

      // Never upscale.
      const targets = ladder
        .filter((h) => h <= probe.height || h === Math.min(...ladder))
        .sort((a, b) => a - b);

      if (targets.length === 0) targets.push(Math.min(...ladder));

      // 3. encryption key ----------------------------------------------------
      let keyInfoPath: string | undefined;
      if (encrypt) {
        keyInfoPath = await this.writeKeyInfo(workDir, videoId);
      }

      // 4. transcode ---------------------------------------------------------
      const renditions: {
        height: number;
        width: number;
        bitrateKbps: number;
        playlistKey: string;
        sizeBytes: number;
      }[] = [];

      const hlsPrefix = StorageService.keys.hlsPrefix(videoId);

      for (const [index, height] of targets.entries()) {
        const rate = BITRATES[height] ?? BITRATES[720]!;
        const width = this.evenWidth(probe.width, probe.height, height);
        const outDir = join(workDir, `${height}p`);
        await mkdir(outDir, { recursive: true });

        await this.runFfmpeg({
          sourcePath,
          outDir,
          height,
          width,
          bitrateKbps: rate.video,
          maxrateKbps: rate.maxrate,
          audioKbps: rate.audio,
          keyInfoPath,
        });

        const uploaded = await this.uploadRendition(outDir, hlsPrefix, height);

        renditions.push({
          height,
          width,
          bitrateKbps: rate.video + rate.audio,
          playlistKey: `${hlsPrefix}${height}p/index.m3u8`,
          sizeBytes: uploaded.totalBytes,
        });

        await job.updateProgress(10 + Math.round(((index + 1) / targets.length) * 75));
      }

      // 5. packaged master playlist -----------------------------------------
      // The API serves a per-session master (see ManifestService); this static
      // one is uploaded for diagnostics and for any future direct-CDN path.
      const masterKey = StorageService.keys.hlsMaster(videoId);
      await this.storage.putObject({
        bucket: 'media',
        objectKey: masterKey,
        body: this.buildStaticMaster(renditions),
        contentType: 'application/vnd.apple.mpegurl',
        cacheControl: 'no-store',
      });

      // 6. poster frame ------------------------------------------------------
      await job.updateProgress(90);
      const thumbnailKey = await this.extractThumbnail(
        sourcePath,
        workDir,
        videoId,
        probe.durationSeconds,
      );

      // 7. metadata ----------------------------------------------------------
      await this.videos.markReady(videoId, {
        durationSeconds: Math.round(probe.durationSeconds),
        width: probe.width,
        height: probe.height,
        frameRate: probe.frameRate,
        videoCodec: probe.videoCodec,
        audioCodec: probe.audioCodec,
        hlsPrefix,
        masterPlaylistKey: masterKey,
        thumbnailKey,
        isEncrypted: encrypt,
        encryptionKeyId: encrypt ? `derived:${videoId}` : undefined,
        renditions,
      });

      await job.updateProgress(100);
      this.logger.log(`video ${videoId} ready (${renditions.length} renditions)`);

      return { videoId, renditions: renditions.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`transcode failed for ${videoId}: ${message}`);
      await this.videos.markFailed(videoId, message);
      throw error;
    } finally {
      // Always clean up. A leftover 2 GB scratch directory per failed job
      // fills the disk within a day.
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------------------
  // Steps
  // ---------------------------------------------------------------------------

  private async downloadSource(sourceKey: string, destination: string): Promise<void> {
    const buffer = await this.storage.getObjectBuffer('uploads', sourceKey);
    await writeFile(destination, buffer);
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
      }[];
    };

    const video = parsed.streams?.find((s) => s.codec_type === 'video');
    const audio = parsed.streams?.find((s) => s.codec_type === 'audio');

    if (!video) throw new Error('The uploaded file contains no video stream');

    const [num, den] = (video.r_frame_rate ?? '25/1').split('/').map(Number);
    const frameRate = den && den !== 0 ? (num ?? 25) / den : 25;

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
   * the local path to the key bytes, and the IV. We write a placeholder URI
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

  private async runFfmpeg(params: {
    sourcePath: string;
    outDir: string;
    height: number;
    width: number;
    bitrateKbps: number;
    maxrateKbps: number;
    audioKbps: number;
    keyInfoPath?: string;
  }): Promise<void> {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', params.sourcePath,

      // Video: H.264 High for universal device support. `veryfast` is the
      // right trade for lecture content — slower presets buy maybe 8% bitrate
      // on low-motion footage while tripling CPU time.
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-level', '4.1',
      '-preset', 'veryfast',
      '-crf', '23',
      '-maxrate', `${params.maxrateKbps}k`,
      '-bufsize', `${params.maxrateKbps * 2}k`,
      '-b:v', `${params.bitrateKbps}k`,
      '-vf', `scale=${params.width}:${params.height}:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2`,

      // Closed GOP aligned to the segment length. Without this, segments do
      // not start on a keyframe and quality switching stutters.
      '-g', String(Math.round(this.cfg.segmentSeconds * 25)),
      '-keyint_min', String(Math.round(this.cfg.segmentSeconds * 25)),
      '-sc_threshold', '0',

      '-c:a', 'aac',
      '-b:a', `${params.audioKbps}k`,
      '-ac', '2',
      '-ar', '48000',

      '-f', 'hls',
      '-hls_time', String(this.cfg.segmentSeconds),
      '-hls_playlist_type', 'vod',
      '-hls_segment_filename', join(params.outDir, 'seg_%05d.ts'),
      '-hls_flags', 'independent_segments',
    ];

    if (params.keyInfoPath) {
      args.push('-hls_key_info_file', params.keyInfoPath);
    }

    args.push(join(params.outDir, 'index.m3u8'));

    await this.exec(this.cfg.ffmpegPath, args);
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
    const segments = files.filter((f) => f.endsWith('.ts'));
    const playlists = files.filter((f) => f.endsWith('.m3u8'));

    for (const file of segments) {
      const path = join(outDir, file);
      const info = await stat(path);
      totalBytes += info.size;

      await this.storage.putFile({
        bucket: 'media',
        objectKey: `${hlsPrefix}${height}p/${file}`,
        filePath: path,
        contentType: 'video/mp2t',
      });
    }

    for (const file of playlists) {
      const body = await readFile(join(outDir, file));
      await this.storage.putObject({
        bucket: 'media',
        objectKey: `${hlsPrefix}${height}p/${file}`,
        body,
        contentType: 'application/vnd.apple.mpegurl',
        cacheControl: 'no-store',
      });
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

  private buildStaticMaster(
    renditions: { height: number; width: number; bitrateKbps: number }[],
  ): string {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];

    for (const r of renditions) {
      lines.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${r.bitrateKbps * 1000},RESOLUTION=${r.width}x${r.height},CODECS="avc1.4d401f,mp4a.40.2"`,
      );
      lines.push(`${r.height}p/index.m3u8`);
    }

    return `${lines.join('\n')}\n`;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Widths must be even for H.264 chroma subsampling. */
  private evenWidth(sourceWidth: number, sourceHeight: number, targetHeight: number): number {
    const ratio = sourceWidth / Math.max(1, sourceHeight);
    return Math.round((targetHeight * ratio) / 2) * 2;
  }

  private exec(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        // Guard against a pathological command flooding memory.
        if (stdout.length > 5_000_000) child.kill('SIGKILL');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000);
      });

      child.on('error', (e) =>
        reject(new Error(`${command} could not be started: ${e.message}`)),
      );

      child.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-2000)}`));
      });
    });
  }
}
