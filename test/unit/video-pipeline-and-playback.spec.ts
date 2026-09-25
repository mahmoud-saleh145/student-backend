import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { ValidationPipe } from '@nestjs/common';
import { VideoStatus } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { resolvePublicApiUrl } from '../../src/config/env.validation';
import { SignedQueryDto } from '../../src/modules/playback/manifest.controller';
import { HLS_CODECS, ManifestService } from '../../src/modules/playback/manifest.service';
import { VideosService } from '../../src/modules/videos/videos.service';

/**
 * The two production failures this file pins:
 *
 *  1. Playback: every manifest request without `maxHeight` was answered 422
 *     by the global ValidationPipe (confirmed against the live API on
 *     2026-09-25), and the per-rendition URLs never carry it — so no stream
 *     could ever start.
 *  2. Processing: the worker never registered its processors, and a failed
 *     enqueue left a video QUEUED with no job behind it.
 */

// The exact pipe main.ts installs.
const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
});
const asQuery = (value: Record<string, string>) =>
  pipe.transform(value, { type: 'query', metatype: SignedQueryDto });

describe('manifest query validation', () => {
  it('accepts a master/media request with no maxHeight (the "auto" case)', async () => {
    await expect(asQuery({ exp: '1999999999', sig: 'abc' })).resolves.toMatchObject({
      exp: 1999999999,
      sig: 'abc',
    });
  });

  it('still validates maxHeight when a quality is chosen', async () => {
    await expect(asQuery({ exp: '1999999999', sig: 'abc', maxHeight: '720' })).resolves.toMatchObject({
      maxHeight: 720,
    });
    await expect(asQuery({ exp: '1999999999', sig: 'abc', maxHeight: 'x' })).rejects.toBeDefined();
  });

  it('refuses unknown parameters — the app must not add any (it used to add `captions`)', async () => {
    await expect(asQuery({ exp: '1999999999', sig: 'abc', captions: 'ar' })).rejects.toBeDefined();
  });
});

describe('master playlist', () => {
  function service(renditions: { height: number; width: number; bitrateKbps: number }[]) {
    const prisma = {
      playbackTicket: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tkt_1',
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 60_000),
          maxHeight: null,
          session: { status: 'ACTIVE' },
          device: { status: 'ACTIVE' },
          video: { renditions: [...renditions].sort((a, b) => b.height - a.height) },
        }),
      },
    };
    const config = {
      getOrThrow: (key: string) =>
        ({
          app: { publicUrl: 'https://api.example.test', apiPrefix: 'api', apiVersion: '1' },
          playback: {},
          video: { keyRoot: 'k'.repeat(40) },
        })[key],
    };
    return new ManifestService(prisma as never, {} as never, config as never);
  }

  it('advertises the codec the worker actually encodes (H.264 High 4.1)', async () => {
    const svc = service([{ height: 720, width: 1280, bitrateKbps: 2328 }]);
    const url = new URL(svc.buildMasterUrl('tkt_1', new Date(Date.now() + 60_000)));
    const body = await svc.masterPlaylist({
      ticketId: 'tkt_1',
      exp: Number(url.searchParams.get('exp')),
      signature: url.searchParams.get('sig')!,
    });
    expect(HLS_CODECS).toBe('avc1.640029,mp4a.40.2');
    expect(body).toContain(`CODECS="${HLS_CODECS}"`);
    // Every variant URL is absolute, on the public origin, signed — and
    // carries no parameter the validator would reject.
    const variant = body.split('\n').find((l) => l.startsWith('https://'))!;
    expect(variant).toMatch(/^https:\/\/api\.example\.test\/api\/v1\/playback\/manifest\/tkt_1\/720\.m3u8\?exp=\d+&sig=/);
  });
});

describe('PUBLIC_API_URL resolution', () => {
  it('prefers the explicit value, then Render’s own URL, then localhost', () => {
    expect(resolvePublicApiUrl({ PUBLIC_API_URL: 'https://a.test/' })).toBe('https://a.test');
    expect(resolvePublicApiUrl({ RENDER_EXTERNAL_URL: 'https://b.onrender.com' })).toBe(
      'https://b.onrender.com',
    );
    expect(resolvePublicApiUrl({})).toBe('http://localhost:3000');
  });
});

describe('worker entry point', () => {
  it('sets RUN_WORKERS before the module graph is loaded', () => {
    const source = readFileSync(join(__dirname, '../../src/worker.ts'), 'utf8');
    // A static import is hoisted above every statement, so it would evaluate
    // jobs.module (which reads the flag) before the flag is set.
    expect(source).not.toMatch(/^import\s+\{\s*AppModule\s*\}\s+from/m);
    expect(source.indexOf("process.env.RUN_WORKERS = 'true'")).toBeLessThan(
      source.indexOf("await import('./app.module')"),
    );
  });

  it('registers the processors when RUN_WORKERS=true at load time', () => {
    const previous = process.env.RUN_WORKERS;
    process.env.RUN_WORKERS = 'true';
    let providers: unknown[] = [];
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { JobsModule } = require('../../src/jobs/jobs.module');
      providers = Reflect.getMetadata('providers', JobsModule) as unknown[];
    });
    process.env.RUN_WORKERS = previous;
    const names = providers.map((p) => (p as { name?: string }).name);
    expect(names).toEqual(
      expect.arrayContaining(['VideoProcessor', 'MaintenanceProcessor', 'WorkerHeartbeat']),
    );
  });
});

// ---------------------------------------------------------------------------
// VideosService enqueue / recovery
// ---------------------------------------------------------------------------

function videosService(overrides: { queue?: Record<string, jest.Mock>; heartbeat?: unknown } = {}) {
  const updates: unknown[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma: any = {
    video: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(async (args: unknown) => {
        updates.push(args);
        return {};
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    playbackTicket: { updateMany: jest.fn() },
    lesson: { update: jest.fn() },
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma)),
  };
  const queue = {
    add: jest.fn(async () => ({ id: 'job-1' })),
    getJob: jest.fn(async () => null),
    ...overrides.queue,
  };
  const storage = { objectSize: jest.fn(async () => 1234) };
  const access = {
    assertCanManageCourse: jest.fn(),
    assertTeacherCapability: jest.fn(),
  };
  const redis = { getJson: jest.fn(async () => overrides.heartbeat ?? null) };
  const audit = { record: jest.fn() };
  const courses = { recountCourse: jest.fn() };
  const config = {
    getOrThrow: () => ({ ladder: [360, 720], encryptionEnabled: true }),
  };
  const svc = new VideosService(
    prisma as never,
    storage as never,
    access as never,
    courses as never,
    {} as never,
    audit as never,
    redis as never,
    queue as never,
    config as never,
  );
  return { svc, prisma, queue, updates, redis };
}

const ACTOR = { id: 'usr_admin', role: 'ADMIN' as never };

describe('VideosService.completeUpload', () => {
  const row = {
    id: 'vid_1',
    courseId: 'crs_1',
    sourceKey: 'source/videos/vid_1/x.mp4',
    status: VideoStatus.UPLOADING,
    lessonId: 'les_1',
  };

  it('marks QUEUED only after the job is in the queue, and records the job id', async () => {
    const { svc, prisma, queue, updates } = videosService();
    prisma.video.findFirst.mockResolvedValue(row);

    const result = await svc.completeUpload('vid_1', ACTOR);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'QUEUED', jobId: 'job-1', workerOnline: false });
    const statuses = updates
      .map((u) => (u as { data: { status?: string } }).data.status)
      .filter(Boolean);
    expect(statuses).toEqual(['QUEUED']);
    expect(updates.at(-1)).toMatchObject({ data: { status: 'QUEUED', processingJobId: 'job-1' } });
  });

  it('does not strand the video QUEUED when Redis refuses the job', async () => {
    const { svc, prisma, updates } = videosService({
      queue: { add: jest.fn(async () => Promise.reject(new Error('max requests limit exceeded'))) },
    });
    prisma.video.findFirst.mockResolvedValue(row);

    await expect(svc.completeUpload('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.QUEUE_UNAVAILABLE,
    });
    expect(updates.at(-1)).toMatchObject({
      data: { status: 'UPLOADING', processingError: expect.stringContaining('max requests') },
    });
    expect(
      updates.some((u) => (u as { data: { status?: string } }).data.status === 'QUEUED'),
    ).toBe(false);
  });

  it('reports a live worker from its heartbeat', async () => {
    const { svc, prisma } = videosService({
      heartbeat: { at: '2026-09-25T10:00:00.000Z', ffmpeg: true, ffprobe: true },
    });
    prisma.video.findFirst.mockResolvedValue(row);
    await expect(svc.completeUpload('vid_1', ACTOR)).resolves.toMatchObject({
      workerOnline: true,
      workerCanTranscode: true,
    });
  });
});

describe('VideosService.markProcessing', () => {
  it('skips a stale job (deleted or re-uploaded video)', async () => {
    const { svc, prisma } = videosService();
    prisma.video.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.markProcessing('vid_1', 'old-key')).resolves.toBe(false);
    expect(prisma.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'vid_1', deletedAt: null, sourceKey: 'old-key' }),
      }),
    );
  });
});

describe('VideosService.recoverStrandedVideos', () => {
  it('re-queues a QUEUED video whose job has vanished, and leaves a live one alone', async () => {
    const live = { getState: jest.fn(async () => 'waiting') };
    const { svc, prisma, queue } = videosService({
      queue: {
        add: jest.fn(async () => ({ id: 'job-new' })),
        getJob: jest.fn(async (id: string) => (id === 'job-live' ? live : null)),
      },
    });
    prisma.video.findMany.mockResolvedValue([
      { id: 'vid_lost', status: 'QUEUED', sourceKey: 'k1', lessonId: 'l1', courseId: 'c1', processingJobId: 'job-gone' },
      { id: 'vid_live', status: 'QUEUED', sourceKey: 'k2', lessonId: 'l2', courseId: 'c1', processingJobId: 'job-live' },
    ]);

    await expect(svc.recoverStrandedVideos()).resolves.toEqual({ requeued: 1, failed: 0 });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect((queue.add.mock.calls[0] as unknown[])[1]).toMatchObject({ videoId: 'vid_lost' });
  });

  it('marks a PROCESSING video whose worker died as FAILED so it can be retried', async () => {
    const { svc, prisma } = videosService();
    prisma.video.findMany.mockResolvedValue([
      { id: 'vid_dead', status: 'PROCESSING', sourceKey: 'k', lessonId: 'l', courseId: 'c', processingJobId: 'job-x' },
    ]);
    await expect(svc.recoverStrandedVideos()).resolves.toEqual({ requeued: 0, failed: 1 });
    expect(prisma.video.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });
});

describe('VideosService.remove', () => {
  it('soft-deletes, revokes live grants and clears the lesson duration', async () => {
    const { svc, prisma } = videosService();
    prisma.video.findFirst.mockResolvedValue({
      id: 'vid_1',
      courseId: 'c1',
      lessonId: 'l1',
      hlsPrefix: null,
      sourceKey: null,
      processingJobId: null,
    });
    await svc.remove('vid_1', ACTOR);
    expect(prisma.video.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ deletedAt: expect.any(Date) }) }),
    );
    expect(prisma.playbackTicket.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { videoId: 'vid_1', status: 'ACTIVE' } }),
    );
    expect(prisma.lesson.update).toHaveBeenCalledWith({ where: { id: 'l1' }, data: { durationSeconds: 0 } });
  });

  it('refuses an already deleted video', async () => {
    const { svc, prisma } = videosService();
    prisma.video.findFirst.mockResolvedValue(null);
    await expect(svc.remove('vid_1', ACTOR)).rejects.toBeInstanceOf(AppException);
  });
});
