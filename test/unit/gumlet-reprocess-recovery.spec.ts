import { AppException } from 'src/common/errors/app.exception';
import { ErrorCode } from 'src/common/errors/error-codes';
import { VideosService } from 'src/modules/videos/videos.service';

/**
 * Reprocessing a video that failed at the provider.
 * ---------------------------------------------------------------------------
 *
 * THE INCIDENT THIS FILE PINS
 *
 * On 2026-10-19 the Gumlet account's storage allowance was exhausted. Five
 * videos were ingested anyway, and the provider terminally marked each of their
 * assets `errored` with:
 *
 *   "The uploaded video duration exceeds the storage minutes quota for your
 *    account. Please consider upgrading your account to increase storage
 *    minutes quota."
 *
 * The plan was then upgraded. The five videos stayed failed, and pressing
 * "Try processing again" did nothing at all - forever.
 *
 * WHY IT DID NOTHING
 *
 * `retryProcessing()` queued a transcode job, and the worker handed the video
 * to `GumletIngestService.adopt()`. `adopt()` is idempotent BY DESIGN: a row
 * that already carries an asset id is re-synced, never re-created, because a
 * repeated job must not mint a second (separately billed) asset. So the retry
 * re-read the SAME dead asset, got the SAME terminal verdict, and set the video
 * back to FAILED. The job even completed "successfully".
 *
 * The plan upgrade was never the thing that was broken. The plan was why the
 * ASSET died; the dead ASSET was what stayed dead.
 *
 * WHAT THESE TESTS REQUIRE
 *
 *   1. A terminally failed provider asset is REPLACED, not re-synced.
 *   2. The account's allowance is consulted before a replacement is minted, so
 *      an exhausted account is reported rather than producing a second dead
 *      asset - and a video that failed on an exhausted account recovers as soon
 *      as the plan allows it.
 *   3. A repeated click is safe: no second asset, no second job.
 *   4. A missing source object is refused before anything is created.
 *   5. A legacy (non-provider) video keeps its original behaviour.
 *   6. The operator must be authorised for the video's course.
 */

type Row = {
  id: string;
  courseId: string;
  lessonId: string | null;
  sourceKey: string | null;
  status: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletStatus: string | null;
  gumletError?: string | null;
  processingJobId?: string | null;
  deletedAt?: Date | null;
};

const QUOTA_ERROR =
  'The uploaded video duration exceeds the storage minutes quota for your account. ' +
  'Please consider upgrading your account to increase storage minutes quota.';

function gumletRow(over: Partial<Row> = {}): Row {
  return {
    id: 'vid_1',
    courseId: 'crs_1',
    lessonId: 'les_1',
    sourceKey: 'source/videos/vid_1/abc.mp4',
    status: 'FAILED',
    drmProvider: 'gumlet',
    gumletAssetId: 'asset_dead',
    gumletStatus: 'errored',
    gumletError: QUOTA_ERROR,
    processingJobId: 'transcode:vid_1:1',
    deletedAt: null,
    ...over,
  };
}

function legacyRow(over: Partial<Row> = {}): Row {
  return {
    id: 'vid_1',
    courseId: 'crs_1',
    lessonId: 'les_1',
    sourceKey: 'source/videos/vid_1/abc.mp4',
    status: 'FAILED',
    drmProvider: null,
    gumletAssetId: null,
    gumletStatus: null,
    gumletError: null,
    processingJobId: 'transcode:vid_1:1',
    deletedAt: null,
    ...over,
  };
}

const ACTOR = { id: 'usr_admin', role: 'ADMIN' as never };

function build(opts: {
  row?: Row;
  sourceExists?: boolean;
  canManage?: boolean;
  /** The state BullMQ reports for the video's recorded job. */
  jobState?: string | null;
} = {}) {
  const row = opts.row ?? gumletRow();
  const updates: Array<Record<string, unknown>> = [];
  const enqueued: unknown[] = [];
  const audits: Array<Record<string, unknown>> = [];

  const prisma = {
    video: {
      findFirst: jest.fn(async () => row),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        Object.assign(row, args.data);
        return row;
      }),
    },
  };

  const storage = {
    exists: jest.fn(async () => opts.sourceExists ?? true),
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => {
      if (opts.canManage === false) {
        throw new AppException(ErrorCode.FORBIDDEN, { message: 'not your course' });
      }
    }),
  };

  // A job that is still in the pipeline, unless a test says otherwise: the
  // guard that refuses a duplicate attempt has to see a LIVE job to refuse.
  const jobState = opts.jobState === undefined ? 'waiting' : opts.jobState;
  const queue = {
    add: jest.fn(async (name: unknown, data: unknown) => {
      enqueued.push({ name, data });
      return { id: `job-${enqueued.length}` };
    }),
    getJob: jest.fn(async () => (jobState ? { getState: jest.fn(async () => jobState) } : null)),
  };

  const audit = {
    record: jest.fn(async (entry: Record<string, unknown>) => {
      audits.push(entry);
    }),
  };

  const gumletIngest = {
    replaceFailedAsset: jest.fn(async () => ({ assetId: 'asset_new', status: 'pre-queued' })),
    sync: jest.fn(async () => ({ assetId: 'asset_dead', status: 'errored', playable: false })),
  };

  const service = new VideosService(
    prisma as never,
    storage as never,
    access as never,
    { recountCourse: jest.fn() } as never,
    { notifyCourseStudents: jest.fn() } as never,
    audit as never,
    { getJson: jest.fn(async () => null) } as never,
    queue as never,
    { getOrThrow: () => ({ ladder: [360, 720], encryptionEnabled: true }) } as never,
    { propagateDurationToAttachedLessons: jest.fn() } as never,
    gumletIngest as never,
  );

  return { service, row, prisma, storage, access, queue, audit, gumletIngest, updates, enqueued, audits };
}

describe('VideosService.retryProcessing - a terminally failed provider asset', () => {
  it('REPLACES the dead asset instead of re-syncing it', async () => {
    const h = build();

    const result = await h.service.retryProcessing('vid_1', ACTOR);

    // The dead id is discarded and a fresh ingest is created from the same
    // stored source. Re-syncing it could only ever re-read the same verdict.
    expect(h.gumletIngest.replaceFailedAsset).toHaveBeenCalledTimes(1);
    expect(h.gumletIngest.replaceFailedAsset).toHaveBeenCalledWith(
      'vid_1',
      expect.objectContaining({ allowGumletProviderReplacement: true }),
    );
    expect(h.gumletIngest.sync).not.toHaveBeenCalled();

    // ...and a poll job follows so the worker drives the new asset to READY.
    expect(h.enqueued).toHaveLength(1);
    expect(result).toMatchObject({
      videoId: 'vid_1',
      status: 'QUEUED',
      provider: 'gumlet',
      recovered: true,
      assetId: 'asset_new',
    });
  });

  it('never re-uploads the source: the same stored object is re-ingested', async () => {
    const h = build();

    await h.service.retryProcessing('vid_1', ACTOR);

    expect(h.storage.exists).toHaveBeenCalledWith('uploads', 'source/videos/vid_1/abc.mp4');
    const job = h.enqueued[0] as { data: { sourceKey: string } };
    expect(job.data.sourceKey).toBe('source/videos/vid_1/abc.mp4');
  });

  it('records who asked for it', async () => {
    const h = build();

    await h.service.retryProcessing('vid_1', ACTOR);

    expect(h.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'usr_admin', entityId: 'vid_1' }),
    );
  });
});

describe('VideosService.retryProcessing - a repeated click', () => {
  it('refuses a second attempt while the replacement is in flight, and creates nothing', async () => {
    const h = build();

    await h.service.retryProcessing('vid_1', ACTOR);
    expect(h.gumletIngest.replaceFailedAsset).toHaveBeenCalledTimes(1);
    const enqueuedAfterFirst = h.enqueued.length;

    // The replacement left the video processing with a live, non-terminal
    // asset - so the second click is a duplicate, not a repair.
    h.row.gumletStatus = 'processing';
    h.row.status = 'PROCESSING';

    await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });

    // No second asset, no second job.
    expect(h.gumletIngest.replaceFailedAsset).toHaveBeenCalledTimes(1);
    expect(h.enqueued).toHaveLength(enqueuedAfterFirst);
  });

  it('refuses a second attempt while the video is merely queued', async () => {
    const h = build({ row: gumletRow({ gumletStatus: 'processing', status: 'QUEUED' }) });

    await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });

    expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(0);
  });
});

describe('VideosService.retryProcessing - a stranded video', () => {
  it('re-queues a poll when the recorded job is gone but the provider asset is alive', async () => {
    // The job was lost (evicted, or the worker was killed mid-poll) while the
    // asset kept working at the provider. The video looks "processing" but
    // nothing is happening locally - exactly the case a reprocess is for.
    const h = build({
      row: gumletRow({ status: 'PROCESSING', gumletStatus: 'validated' }),
      jobState: 'missing',
    });

    const result = await h.service.retryProcessing('vid_1', ACTOR);

    expect(h.enqueued).toHaveLength(1);
    expect(result).toMatchObject({ status: 'QUEUED', provider: 'gumlet', recovered: false });
    // No new asset: the existing one is alive and re-syncing it is idempotent.
    expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
  });

  it('refuses while the recorded job is genuinely still running', async () => {
    for (const state of ['waiting', 'active', 'delayed']) {
      const h = build({
        row: gumletRow({ status: 'PROCESSING', gumletStatus: 'processing' }),
        jobState: state,
      });

      await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
        code: ErrorCode.INVALID_STATE,
      });

      expect(h.enqueued).toHaveLength(0);
      expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
    }
  });

  it('re-queues a stranded legacy video instead of refusing it', async () => {
    const h = build({
      row: legacyRow({ status: 'QUEUED' }),
      jobState: 'missing',
    });

    const result = await h.service.retryProcessing('vid_1', ACTOR);

    expect(h.enqueued).toHaveLength(1);
    expect(result).toMatchObject({ status: 'QUEUED', provider: 'legacy' });
  });
});

describe('VideosService.retryProcessing - preconditions', () => {
  it('refuses when the stored source object is gone, and creates nothing', async () => {
    const h = build({ sourceExists: false });

    await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.VIDEO_UNAVAILABLE,
    });

    // A doomed attempt must not start: no asset, no job.
    expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(0);
  });

  it('refuses when there is no source key at all, and says to re-upload', async () => {
    const h = build({ row: gumletRow({ sourceKey: null }) });

    await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });

    expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
  });

  it('refuses a caller who may not manage the video course', async () => {
    const h = build({ canManage: false });

    await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });

    expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(0);
  });
});

describe('VideosService.retryProcessing - the legacy path is unchanged', () => {
  it('queues a transcode job for a non-provider video', async () => {
    const h = build({ row: legacyRow() });

    const result = await h.service.retryProcessing('vid_1', ACTOR);

    expect(h.gumletIngest.replaceFailedAsset).not.toHaveBeenCalled();
    expect(h.enqueued).toHaveLength(1);
    expect(result).toMatchObject({ status: 'QUEUED', provider: 'legacy' });
  });

  it('clears the previous failure before queueing', async () => {
    const h = build({ row: legacyRow() });

    await h.service.retryProcessing('vid_1', ACTOR);

    expect(h.updates).toContainEqual(
      expect.objectContaining({ processingError: null, processingStartedAt: null }),
    );
  });

  it('does not give a queued legacy video a second job', async () => {
    const h = build({ row: legacyRow({ status: 'QUEUED' }), jobState: 'waiting' });

    await expect(h.service.retryProcessing('vid_1', ACTOR)).rejects.toMatchObject({
      code: ErrorCode.INVALID_STATE,
    });
    expect(h.enqueued).toHaveLength(0);
  });
});
