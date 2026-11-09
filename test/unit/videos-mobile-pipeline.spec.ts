import { ErrorCode } from '../../src/common/errors/error-codes';
import { VideosService } from '../../src/modules/videos/videos.service';

/**
 * VideosService's side of the independent mobile pipeline: queueing, the
 * library migration, stranded-job recovery and what "mobile-READY" writes.
 */
function harness(opts: {
  rows?: Record<string, unknown>[];
  exists?: (key: string) => boolean;
  queueAddFails?: boolean;
  jobState?: string | null;
} = {}) {
  const rows = opts.rows ?? [];
  const writes: { where: unknown; data: Record<string, unknown> }[] = [];
  let tx: unknown;
  const prisma = {
    video: {
      findFirst: jest.fn(async ({ where }: { where: { id?: string } }) =>
        rows.find((r) => r.id === where.id) ?? null,
      ),
      findMany: jest.fn(async () => rows),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        return row;
      }),
      update: jest.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        writes.push(args);
        return {};
      }),
      updateMany: jest.fn(async (args: { where: unknown; data: Record<string, unknown> }) => {
        writes.push(args);
        return { count: 1 };
      }),
      count: jest.fn(async () => 3),
      aggregate: jest.fn(async ({ where }: { where: { mobileStatus?: unknown } }) =>
        JSON.stringify(where.mobileStatus ?? '').includes('READY') && !JSON.stringify(where.mobileStatus).includes('NONE')
          ? { _count: { _all: 2 }, _sum: { durationSeconds: 7200 } } // READY content: 2 h
          : { _count: { _all: 3 }, _sum: { durationSeconds: 10800 } }, // pending: 3 videos, 3 h
      ),
      groupBy: jest.fn(async () => [
        { mobileStatus: 'READY', _count: { _all: 2 } },
        { mobileStatus: 'NONE', _count: { _all: 5 } },
      ]),
    },
    videoRendition: {
      deleteMany: jest.fn(async () => ({ count: 0 })),
      aggregate: jest.fn(async () => ({ _sum: { sizeBytes: BigInt(2_400_000_000) } })),
    },
    $transaction: jest.fn(async (fn: (client: unknown) => unknown) => fn(tx)),
  };
  tx = prisma;
  const mobileQueue = {
    add: jest.fn(async () => {
      if (opts.queueAddFails) throw new Error('redis unavailable');
      return { id: 'mobile-hls:v_1:1' };
    }),
    getJob: jest.fn(async () =>
      opts.jobState === null || opts.jobState === undefined
        ? null
        : { getState: jest.fn(async () => opts.jobState) },
    ),
    getJobCounts: jest.fn(async () => ({ waiting: 2, active: 1, delayed: 0, failed: 0, completed: 9 })),
  };
  const storage = { exists: jest.fn(async (_b: string, key: string) => (opts.exists ? opts.exists(key) : true)) };
  const access = { assertCanManageCourse: jest.fn() };
  const audit = { record: jest.fn() };
  const redis = {
    getJson: jest.fn(async (key: string): Promise<unknown> =>
      key === 'worker:heartbeat'
        ? { at: new Date().toISOString(), ffmpeg: true, ffprobe: true, host: 'laptop', queues: 'all', scratch: { safe: true } }
        : null,
    ),
  };
  const config = { getOrThrow: () => ({ ladder: [360, 720], encryptionEnabled: true, mobile: { autoProcess: true } }) };

  const svc = new VideosService(
    prisma as never,
    storage as never,
    access as never,
    { recountCourse: jest.fn() } as never,
    {} as never,
    audit as never,
    redis as never,
    { add: jest.fn(), getJob: jest.fn(async () => null) } as never,
    config as never,
    {} as never,
    {} as never,
    mobileQueue as never,
  );
  return { svc, prisma, mobileQueue, storage, writes, audit, redis };
}

describe('enqueueMobileTranscode', () => {
  it('writes QUEUED only after the job is really in Redis, and records the job id', async () => {
    const t = harness({ rows: [{ id: 'v_1', mobileStatus: 'NONE', mobileJobId: null }] });

    await expect(t.svc.enqueueMobileTranscode({ id: 'v_1', sourceKey: 'k' }, 'upload')).resolves.toEqual({
      jobId: 'mobile-hls:v_1:1',
      alreadyQueued: false,
    });

    expect(t.mobileQueue.add).toHaveBeenCalledWith(
      'mobile-hls',
      expect.objectContaining({ videoId: 'v_1', sourceKey: 'k', ladder: [360, 720], encrypt: true, trigger: 'upload' }),
      expect.objectContaining({ attempts: 2 }),
    );
    expect(t.writes.at(-1)?.data).toEqual({ mobileStatus: 'QUEUED', mobileJobId: 'mobile-hls:v_1:1', mobileError: null });
  });

  it('records FAILED with the reason when Redis refuses the job, instead of a phantom QUEUED', async () => {
    const t = harness({ rows: [{ id: 'v_1', mobileStatus: 'NONE', mobileJobId: null }], queueAddFails: true });

    await expect(t.svc.enqueueMobileTranscode({ id: 'v_1', sourceKey: 'k' }, 'upload')).rejects.toMatchObject({
      code: ErrorCode.QUEUE_UNAVAILABLE,
    });
    expect(t.writes.at(-1)?.data).toMatchObject({ mobileStatus: 'FAILED' });
    expect(String(t.writes.at(-1)?.data.mobileError)).toContain('redis unavailable');
  });

  it('leaves a video alone while its job is still live', async () => {
    const t = harness({
      rows: [{ id: 'v_1', mobileStatus: 'QUEUED', mobileJobId: 'mobile-hls:v_1:0' }],
      jobState: 'waiting',
    });

    await expect(t.svc.enqueueMobileTranscode({ id: 'v_1', sourceKey: 'k' }, 'retry')).resolves.toEqual({
      jobId: 'mobile-hls:v_1:0',
      alreadyQueued: true,
    });
    expect(t.mobileQueue.add).not.toHaveBeenCalled();
  });

  it('re-queues a video whose recorded job has vanished', async () => {
    const t = harness({
      rows: [{ id: 'v_1', mobileStatus: 'QUEUED', mobileJobId: 'mobile-hls:v_1:0' }],
      jobState: null,
    });
    await expect(t.svc.enqueueMobileTranscode({ id: 'v_1', sourceKey: 'k' }, 'recovery')).resolves.toMatchObject({
      alreadyQueued: false,
    });
    expect(t.mobileQueue.add).toHaveBeenCalled();
  });
});

describe('migrateLibraryToMobile', () => {
  const library = [
    { id: 'v_ok', sourceKey: 'source/v_ok.mp4', mobileStatus: 'NONE', mobileJobId: null },
    { id: 'v_gone', sourceKey: 'source/v_gone.mp4', mobileStatus: 'NONE', mobileJobId: null },
    { id: 'v_nokey', sourceKey: null, mobileStatus: 'FAILED', mobileJobId: null },
  ];

  it('dry run: scans, reports, and queues nothing', async () => {
    const t = harness({ rows: library, exists: (k) => k !== 'source/v_gone.mp4' });

    const report = await t.svc.migrateLibraryToMobile({ dryRun: true, limit: 100, actorId: 'usr_admin' });

    expect(report).toMatchObject({
      dryRun: true,
      scanned: 3,
      wouldQueue: ['v_ok'],
      missingSource: ['v_gone'],
      noSourceKey: ['v_nokey'],
      queued: [],
      remaining: 3,
    });
    expect(t.mobileQueue.add).not.toHaveBeenCalled();
    expect(t.writes).toHaveLength(0);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it('live run: queues only videos whose source is still in storage; a missing source is reported, never marked', async () => {
    const t = harness({ rows: library, exists: (k) => k !== 'source/v_gone.mp4' });

    const report = await t.svc.migrateLibraryToMobile({ dryRun: false, limit: 100, actorId: 'usr_admin' });

    expect(report.queued).toEqual(['v_ok']);
    expect(report.missingSource).toEqual(['v_gone']);
    expect(t.mobileQueue.add).toHaveBeenCalledTimes(1);
    // Every write names v_ok; v_gone and v_nokey are untouched.
    for (const write of t.writes) {
      expect(write.where).toEqual({ id: 'v_ok' });
    }
    expect(t.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'mobile-migration', after: expect.objectContaining({ queued: 1, missingSource: 1 }) }),
    );
  });
});

describe('recoverStrandedMobileVideos', () => {
  it('re-queues a QUEUED video whose job is gone and fails-then-requeues a dead PROCESSING one', async () => {
    const t = harness({
      rows: [
        { id: 'v_q', sourceKey: 'k', mobileStatus: 'QUEUED', mobileJobId: 'gone' },
        { id: 'v_p', sourceKey: 'k', mobileStatus: 'PROCESSING', mobileJobId: 'gone' },
      ],
      jobState: null,
    });

    await expect(t.svc.recoverStrandedMobileVideos()).resolves.toEqual({ requeued: 2, failed: 1 });

    const failWrite = t.writes.find((w) => w.data.mobileStatus === 'FAILED');
    expect(failWrite?.where).toEqual({ id: 'v_p' });
    expect(t.mobileQueue.add).toHaveBeenCalledTimes(2);
  });

  it('leaves a live job alone', async () => {
    const t = harness({
      rows: [{ id: 'v_q', sourceKey: 'k', mobileStatus: 'QUEUED', mobileJobId: 'live' }],
      jobState: 'active',
    });
    await expect(t.svc.recoverStrandedMobileVideos()).resolves.toEqual({ requeued: 0, failed: 0 });
    expect(t.mobileQueue.add).not.toHaveBeenCalled();
  });
});

describe('markMobileReady', () => {
  const result = {
    durationSeconds: 100,
    width: 1280,
    height: 720,
    frameRate: 25,
    videoCodec: 'h264',
    audioCodec: 'aac',
    hlsPrefix: 'hls/v_1/',
    masterPlaylistKey: 'hls/v_1/master.m3u8',
    thumbnailKey: 'thumbnails/videos/v_1.jpg',
    isEncrypted: true,
    encryptionKeyId: 'derived:v_1',
    renditions: [{ height: 720, width: 1280, bitrateKbps: 2328, playlistKey: 'hls/v_1/720p/index.m3u8', sizeBytes: 5 }],
  };

  it('replaces the renditions and marks READY without touching status or Gumlet fields', async () => {
    const t = harness({ rows: [{ id: 'v_1', durationSeconds: 2654, width: 1920, height: 1080, thumbnailKey: 'gumlet.jpg' }] });

    await t.svc.markMobileReady('v_1', result);

    expect(t.prisma.videoRendition.deleteMany).toHaveBeenCalledWith({ where: { videoId: 'v_1' } });
    const data = t.writes.at(-1)?.data as Record<string, unknown>;
    expect(data).toMatchObject({ mobileStatus: 'READY', mobileError: null, hlsPrefix: 'hls/v_1/', isEncrypted: true });
    expect(data).not.toHaveProperty('status');
    expect(data).not.toHaveProperty('gumletStatus');
    expect(data).not.toHaveProperty('drmProvider');
    // Gumlet already supplied these; the mobile encode must not overwrite them.
    expect(data).not.toHaveProperty('durationSeconds');
    expect(data).not.toHaveProperty('width');
    expect(data).not.toHaveProperty('thumbnailKey');
  });

  it('fills in duration, size and poster only where the row has none', async () => {
    const t = harness({ rows: [{ id: 'v_1', durationSeconds: 0, width: null, height: null, thumbnailKey: null }] });

    await t.svc.markMobileReady('v_1', result);

    expect(t.writes.at(-1)?.data).toMatchObject({ durationSeconds: 100, width: 1280, height: 720, thumbnailKey: 'thumbnails/videos/v_1.jpg' });
  });
});

describe('markMobileProcessing', () => {
  it('claims only a row whose source still matches the job', async () => {
    const t = harness();
    await t.svc.markMobileProcessing('v_1', 'source/v_1.mp4', 'job_1');
    expect(t.prisma.video.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'v_1', sourceKey: 'source/v_1.mp4', deletedAt: null }),
        data: expect.objectContaining({ mobileStatus: 'PROCESSING', mobileJobId: 'job_1' }),
      }),
    );
  });
});

describe('mobilePipelineOverview', () => {
  it('reports every state, including the empty ones', async () => {
    const t = harness();
    const overview = await t.svc.mobilePipelineOverview();
    expect(overview.byStatus).toEqual({ NONE: 5, QUEUED: 0, PROCESSING: 0, READY: 2, FAILED: 0 });
    expect(overview.liveVideos).toBe(7);
    expect(overview.worker.workerOnline).toBe(true);
  });

  it('reports progress, throughput-based ETA, output size, queue counts and the worker host view', async () => {
    const t = harness();
    // Two finished videos: 1 h of content in 30 min, 2 h in 1 h → 0.5 s per content second.
    const started = new Date('2026-11-09T10:00:00Z');
    (t.prisma.video.findMany as jest.Mock).mockImplementation(async ({ where }: { where: { mobileStatus?: string } }) =>
      where.mobileStatus === 'READY'
        ? [
            { durationSeconds: 3600, mobileProcessingStartedAt: started, mobileProcessedAt: new Date(started.getTime() + 1800_000) },
            { durationSeconds: 7200, mobileProcessingStartedAt: started, mobileProcessedAt: new Date(started.getTime() + 3600_000) },
          ]
        : where.mobileStatus === 'FAILED'
          ? [{ id: 'v_bad', mobileError: 'ffmpeg exited with 1', updatedAt: started }]
          : [],
    );

    const o = await t.svc.mobilePipelineOverview();
    expect(o.migratable).toBe(3); // count() stub
    expect(o.remaining).toBe(3);
    expect(o.progressPercent).toBe(0);
    expect(o.throughput).toEqual({
      secondsPerContentSecond: 0.5,
      sampleSize: 2,
      remainingContentSeconds: 10800,
      estimatedRemainingHours: 1.5,
      estimatedRemainingMinutes: 90,
    });
    expect(o.output.totalBytes).toBe(2_400_000_000);
    expect(o.output.averageBytesPerContentHour).toBe(1_200_000_000);
    expect(o.queue).toEqual(expect.objectContaining({ waiting: 2, active: 1 }));
    expect(o.pause.paused).toBe(false);
    expect(o.deliveryOverride).toBeNull();
    expect(o.worker.detail).toEqual(expect.objectContaining({ host: 'laptop', queues: 'all' }));
    expect(o.recentFailures).toEqual([{ videoId: 'v_bad', error: 'ffmpeg exited with 1', at: started.toISOString() }]);
  });

  it('pauses and resumes mobile encodes through a persistent flag, with an audit row', async () => {
    const t = harness();
    const store: Record<string, unknown> = {};
    t.redis.getJson.mockImplementation(async (key: string) => store[key] ?? null);
    (t.redis as unknown as { setJsonPersistent: jest.Mock }).setJsonPersistent = jest.fn(async (k: string, v: unknown) => {
      store[k] = v;
    });
    (t.redis as unknown as { del: jest.Mock }).del = jest.fn(async (k: string) => {
      delete store[k];
    });

    const paused = await t.svc.setMobileProcessingPaused(true, { id: 'admin_1', role: 'ADMIN' as never }, 'laptop in use');
    expect(paused).toMatchObject({ paused: true, reason: 'laptop in use', by: 'admin_1' });
    const resumed = await t.svc.setMobileProcessingPaused(false, { id: 'admin_1', role: 'ADMIN' as never });
    expect(resumed.paused).toBe(false);
    expect(t.audit.record).toHaveBeenCalledTimes(2);
  });

  it('sets and clears the runtime delivery override', async () => {
    const t = harness();
    const store: Record<string, unknown> = {};
    t.redis.getJson.mockImplementation(async (key: string) => store[key] ?? null);
    (t.redis as unknown as { setJsonPersistent: jest.Mock }).setJsonPersistent = jest.fn(async (k: string, v: unknown) => {
      store[k] = v;
    });
    (t.redis as unknown as { del: jest.Mock }).del = jest.fn(async (k: string) => {
      delete store[k];
    });
    const actor = { id: 'admin_1', role: 'ADMIN' as never };
    expect(await t.svc.setMobileDeliveryOverride({ delivery: 'gumlet' }, actor)).toMatchObject({ delivery: 'gumlet', by: 'admin_1' });
    expect(await t.svc.setMobileDeliveryOverride(null, actor)).toBeNull();
  });
});
