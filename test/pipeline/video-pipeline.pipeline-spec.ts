/**
 * The video pipeline, for real, minus the two things this environment cannot
 * reach (Postgres through Prisma, and R2).
 *
 *   dashboard complete → VideosService.enqueueTranscode → REAL Redis/BullMQ
 *   → the REAL VideoProcessor, registered through @nestjs/bullmq's @Processor
 *   → REAL ffmpeg/ffprobe (AES-128 HLS ladder, poster)
 *   → objects written to a local stand-in for the media bucket
 *   → ManifestService (master + media playlists, signed segment URLs, key)
 *   → the REAL Cloudflare Worker code (docs/cloudflare-worker.js) verifying
 *     every segment signature against a local R2 stand-in
 *   → ffmpeg as the HLS client: fetches the master, a media playlist, the key
 *     and every segment over HTTP, decrypts and decodes the whole lecture.
 *
 * Run with: REDIS_URL=redis://127.0.0.1:6390 npx jest -c test/pipeline/jest-pipeline.json
 * (needs redis-server and ffmpeg on PATH; skipped otherwise).
 */
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';

import type { Queue } from 'bullmq';

import { VideoProcessor } from '../../src/jobs/processors/video.processor';
import { QUEUE_NAMES, VIDEO_JOBS } from '../../src/jobs/queue.constants';
import { ManifestService } from '../../src/modules/playback/manifest.service';
import { StorageService } from '../../src/modules/storage/storage.service';
import { VideosService } from '../../src/modules/videos/videos.service';

const hasTools =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('redis-server', ['--version']).status === 0;
const maybe = hasTools ? describe : describe.skip;

const REDIS_PORT = 6390;

/**
 * Async on purpose: the HTTP server the player talks to lives in this same
 * process, so a blocking spawnSync would deadlock it (the server cannot accept
 * the player's connection until the player exits).
 */
function run(cmd: string, args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
const KEY_ROOT = 'pipeline-test-key-root-0123456789abcdef';
const SIGNING_KEY = 'pipeline-test-signing-key-0123456789abcdef';

maybe('video pipeline (real Redis, BullMQ, ffmpeg, Worker code)', () => {
  let redis: ReturnType<typeof spawn>;
  let root: string;
  let server: Server;
  let port: number;
  let queue: Queue;
  let closeApp: () => Promise<void>;

  // What the worker reported back — the fields VideosService.markReady stores.
  const readyCalls: { videoId: string; result: Record<string, unknown> }[] = [];
  const statusLog: string[] = [];

  beforeAll(async () => {
    redis = spawn('redis-server', ['--port', String(REDIS_PORT), '--save', '', '--appendonly', 'no'], {
      stdio: 'ignore',
    });
    await new Promise((r) => setTimeout(r, 400));

    root = await mkdtemp(join(tmpdir(), 'edu-pipeline-'));
    await mkdir(join(root, 'uploads', 'source'), { recursive: true });

    // A 14-second 1280x720 lecture with sound.
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '14', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      join(root, 'uploads', 'source', 'lecture.mp4'),
    ]);

    const bucketDir = (bucket: string) => join(root, bucket);

    // StorageService with its object IO pointed at local directories. The
    // signing (signMediaUrl/computeMediaSignature) is the real code.
    class LocalStorage extends StorageService {
      override async downloadToFile(bucket: 'uploads', key: string, dest: string) {
        await copyFile(join(bucketDir(bucket), key), dest);
      }
      override async putFile(p: { bucket: string; objectKey: string; filePath: string }) {
        const out = join(bucketDir(p.bucket), p.objectKey);
        await mkdir(dirname(out), { recursive: true });
        await copyFile(p.filePath, out);
        return { sizeBytes: 0 };
      }
      override async putObject(p: { bucket: string; objectKey: string; body: Buffer | string }) {
        const out = join(bucketDir(p.bucket), p.objectKey);
        await mkdir(dirname(out), { recursive: true });
        await writeFile(out, p.body);
      }
      override async getObjectBuffer(bucket: 'media', key: string) {
        return readFile(join(bucketDir(bucket), key));
      }
    }

    const storageConfig = {
      accessKeyId: 'x',
      secretAccessKey: 'y',
      region: 'auto',
      endpoint: 'http://127.0.0.1:1',
      buckets: { media: 'media', uploads: 'uploads', library: 'library' },
      cdnBaseUrl: '', // set once the server port is known
      signingKey: SIGNING_KEY,
      localOrigin: false,
      forcePathStyle: true,
    };
    const videoCfg = {
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      workDir: join(root, 'work'),
      ladder: [360, 720, 1080],
      segmentSeconds: 4,
      encryptionEnabled: true,
      keyRoot: KEY_ROOT,
      drm: { enabled: false },
    };
    const config = new ConfigService({
      storage: storageConfig,
      video: videoCfg,
      app: { publicUrl: 'http://127.0.0.1:0', apiPrefix: 'api', apiVersion: '1' },
      playback: { ticketTtl: 300 },
    });
    const storage = new LocalStorage(config);

    // VideosService stand-in: only the three calls the worker makes.
    const videos = {
      markProcessing: jest.fn(async () => {
        statusLog.push('PROCESSING');
        return true;
      }),
      markReady: jest.fn(async (videoId: string, result: Record<string, unknown>) => {
        statusLog.push('READY');
        readyCalls.push({ videoId, result });
      }),
      markFailed: jest.fn(async (_: string, error: string) => {
        statusLog.push(`FAILED: ${error}`);
      }),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        BullModule.forRoot({
          connection: { host: '127.0.0.1', port: REDIS_PORT, maxRetriesPerRequest: null },
          prefix: 'pipeline-test:bull',
        }),
        BullModule.registerQueue({ name: QUEUE_NAMES.video }),
      ],
      providers: [
        VideoProcessor,
        { provide: StorageService, useValue: storage },
        { provide: VideosService, useValue: videos },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    closeApp = () => app.close();
    queue = moduleRef.get<Queue>(getQueueToken(QUEUE_NAMES.video));

    // --- the HTTP side: API playlists/keys + the Worker in front of "R2" ----
    const ticket = {
      id: 'tkt_1',
      userId: 'usr_1',
      sessionId: 'ses_1',
      deviceId: 'dev_1',
      videoId: 'vid_1',
      status: 'ACTIVE',
      maxHeight: null,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      session: { status: 'ACTIVE' },
      device: { status: 'ACTIVE' },
      video: { isEncrypted: true, renditions: [] as unknown[] },
    };
    const prisma = { playbackTicket: { findUnique: jest.fn(async () => ticket) } };

    // The Worker file is an ES module for Cloudflare. Loaded verbatim, with
    // only `export default` rewritten, into a context with the same globals
    // workerd provides — so what runs here is the deployed code.
    const workerSource = (await readFile(join(__dirname, '../../docs/cloudflare-worker.js'), 'utf8'))
      .replace('export default {', 'module.exports.default = {');
    const sandbox = {
      module: { exports: {} as Record<string, unknown> },
      crypto: globalThis.crypto,
      btoa: globalThis.btoa,
      TextEncoder,
      Headers,
      Response,
      Request,
      URL,
      AbortSignal,
      fetch,
      caches: { default: { match: async () => undefined, put: async () => undefined } },
    };
    runInNewContext(workerSource, sandbox);
    const workerModule = sandbox.module.exports as {
      default: { fetch: (r: Request, env: unknown, ctx: unknown) => Promise<Response> };
    };

    const r2 = {
      get: async (key: string) => {
        try {
          const bytes = await readFile(join(root, 'media', key));
          return {
            body: bytes,
            size: bytes.length,
            httpEtag: '"etag"',
            writeHttpMetadata: () => undefined,
          };
        } catch {
          return null;
        }
      },
    };

    let manifest: ManifestService;
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      try {
        if (url.pathname.startsWith('/media/')) {
          const edgeUrl = new URL(url.toString());
          edgeUrl.pathname = url.pathname.replace(/^\/media/, '');
          const response = await workerModule.default.fetch(
            new Request(edgeUrl, { method: 'GET' }),
            { MEDIA: r2, MEDIA_SIGNING_KEY: SIGNING_KEY, TICKET_CHECK: 'false' },
            { waitUntil: () => undefined },
          );
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
          return;
        }
        const master = /^\/api\/v1\/playback\/manifest\/([^/]+)\/master\.m3u8$/.exec(url.pathname);
        const media = /^\/api\/v1\/playback\/manifest\/([^/]+)\/(\d+)\.m3u8$/.exec(url.pathname);
        const key = /^\/api\/v1\/playback\/keys\/([^/]+)$/.exec(url.pathname);
        const exp = Number(url.searchParams.get('exp'));
        const signature = url.searchParams.get('sig') ?? '';
        if (master) {
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          res.end(await manifest.masterPlaylist({ ticketId: master[1], exp, signature }));
        } else if (media) {
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          res.end(await manifest.mediaPlaylist({ ticketId: media[1], height: Number(media[2]), exp, signature }));
        } else if (key) {
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          res.end(await manifest.contentKey({ ticketId: key[1], exp, signature }));
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (error) {
        res.writeHead(403);
        res.end(String(error));
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;

    storageConfig.cdnBaseUrl = `http://127.0.0.1:${port}/media/`;
    const appCfg = new ConfigService({
      storage: storageConfig,
      video: videoCfg,
      app: { publicUrl: `http://127.0.0.1:${port}`, apiPrefix: 'api', apiVersion: '1' },
      playback: { ticketTtl: 300 },
    });
    manifest = new ManifestService(prisma as never, new LocalStorage(appCfg), appCfg);
    (ticket.video as { renditions: unknown[] }).renditions = [];
    (globalThis as Record<string, unknown>).__ticket = ticket;
    (globalThis as Record<string, unknown>).__manifest = () => manifest;
  }, 120_000);

  afterAll(async () => {
    await closeApp?.();
    server?.close();
    redis?.kill();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('a queued transcode job is consumed by the registered processor and produces encrypted HLS', async () => {
    const job = await queue.add(VIDEO_JOBS.transcode, {
      videoId: 'vid_1',
      sourceKey: 'source/lecture.mp4',
      lessonId: 'les_1',
      courseId: 'crs_1',
      ladder: [360, 720, 1080],
      encrypt: true,
    });

    // Wait for the worker to finish.
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const state = await job.getState();
      if (state === 'completed' || state === 'failed') break;
      await new Promise((r) => setTimeout(r, 500));
    }

    expect(statusLog).toEqual(['PROCESSING', 'READY']);
    const { result } = readyCalls[0]!;
    // 720p source: 1080 is skipped (never upscale), 360 and 720 produced.
    const renditions = result.renditions as { height: number; playlistKey: string; width: number; bitrateKbps: number }[];
    expect(renditions.map((r) => r.height)).toEqual([360, 720]);
    expect(result.isEncrypted).toBe(true);
    expect(Math.round(result.durationSeconds as number)).toBe(14);

    const playlist = await readFile(join(root, 'media', 'hls/vid_1/720p/index.m3u8'), 'utf8');
    expect(playlist).toContain('#EXT-X-KEY:METHOD=AES-128');

    // Hand the renditions to the ticket the way markReady would store them.
    const ticket = (globalThis as Record<string, unknown>).__ticket as { video: { renditions: unknown[] } };
    ticket.video.renditions = [...renditions].sort((a, b) => b.height - a.height);
  });

  it('an HLS client plays the protected stream end to end through the Worker', async () => {
    const manifest = ((globalThis as Record<string, unknown>).__manifest as () => ManifestService)();
    const url = manifest.buildMasterUrl('tkt_1', new Date(Date.now() + 5 * 60_000));

    // ffmpeg as the player: master → variant → key → every signed segment,
    // decrypted and decoded. `-map 0:p:1` picks the 720p programme.
    const probe = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', url, '-map', '0:v:0', '-f', 'null', '-',
    ]);
    expect(probe.stderr).toBe('');
    expect(probe.status).toBe(0);

    const info = await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', url,
    ]);
    expect(Math.round(Number(info.stdout.trim()))).toBe(14);
  });

  it('the Worker refuses a tampered segment signature and an unsigned request', async () => {
    const manifest = ((globalThis as Record<string, unknown>).__manifest as () => ManifestService)();
    const url = new URL(manifest.buildMasterUrl('tkt_1', new Date(Date.now() + 5 * 60_000)));
    const masterBody = await (await fetch(url)).text();
    const variant = masterBody.split('\n').find((l) => l.startsWith('http'))!;
    const media = await (await fetch(variant)).text();
    const segment = media.split('\n').find((l) => l.startsWith('http'))!;

    expect((await fetch(segment)).status).toBe(200);
    const tampered = new URL(segment);
    tampered.searchParams.set('uid', 'someone-else');
    const refused = await fetch(tampered);
    expect(refused.status).toBe(403);
    expect(refused.headers.get('x-deny-reason')).toBe('bad_signature');
    const bare = new URL(segment);
    bare.search = '';
    expect((await fetch(bare)).headers.get('x-deny-reason')).toBe('unsigned');
  });
});
