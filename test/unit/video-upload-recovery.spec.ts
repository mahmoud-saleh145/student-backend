import { VideosService } from 'src/modules/videos/videos.service';

/**
 * RECOVERING AN UPLOAD THAT WAS INTERRUPTED
 * =========================================
 *
 * THE FAILURE THIS EXISTS FOR
 * ---------------------------
 * On 2026-10-21 a 522 MB lecture was uploaded to the Student Center dashboard
 * from a phone. The browser's direct PUT to Cloudflare R2 was answered with
 * **HTTP 500** — R2's documented `InternalError`, whose own remedy is "retry
 * the request". The object had in fact been COMMITTED: it is in the `edu-uploads`
 * bucket, byte-exact, with a valid `ftyp`/`mdat`/`moov` structure.
 *
 * Because the browser saw the 500 it never called `complete`, and so:
 *
 *   - `sourceSizeBytes` stayed NULL, so the row did not describe reality;
 *   - no transcode job was enqueued, so nothing ever processed the file;
 *   - no Gumlet asset was created — the ingest is driven by that job — so the
 *     dashboard's "Gumlet is packaging this video" panel was telling the
 *     administrator that a provider was busy with a video it had never heard
 *     of;
 *   - the row sat at `UPLOADING` forever, with five upload attempts recorded
 *     against it and no way to finish the job without sending 522 MB again.
 *
 * These tests pin the behaviour that fixes it.
 *
 * WHAT IS ASSERTED
 * ----------------
 *   - `complete` RECOVERS a stranded upload: the object is found, the job is
 *     queued, the row is made to describe what is actually stored, and nobody
 *     has to upload anything again;
 *   - `complete` is IDEMPOTENT: calling it again on a video that is already
 *     queued returns the current state instead of enqueuing a second job, so a
 *     client that retries after a dropped response cannot start the pipeline
 *     twice;
 *   - `complete` REFUSES a truncated upload: an object whose length differs
 *     from what the client sent is rejected rather than processed into a
 *     lecture that ends mid-sentence;
 *   - `complete` never marks a video READY. Readiness is the worker's verdict
 *     and is reached only after the provider reports the asset ready AND the
 *     manifest is confirmed CENC-encrypted;
 *   - the superseded source objects left by earlier attempts are removed, so a
 *     retried upload does not accumulate unreachable originals.
 */

const ACTOR = { id: 'staff_1', role: 'TEACHER' } as never;

const VIDEO_ID = 'v_1';
const SOURCE_KEY = 'source/videos/v_1/8ebc0e1e.mp4';
const STORED_BYTES = 522_940_365;

interface Row {
  status: string;
  sourceKey: string | null;
  processingJobId: string | null;
  gumletAssetId: string | null;
}

function build(options?: {
  row?: Partial<Row>;
  /** What storage reports for the source object. `null` = not there. */
  storedSize?: number | null;
  /** The state of the recorded queue job. `null` = the job is gone. */
  jobState?: 'waiting' | 'active' | 'completed' | null;
  pruneThrows?: boolean;
}) {
  const updates: Record<string, unknown>[] = [];

  const row: Row & { courseId: string; id: string; lessonId: string | null } = {
    id: VIDEO_ID,
    courseId: 'course_1',
    lessonId: 'lesson_1',
    status: 'UPLOADING',
    sourceKey: SOURCE_KEY,
    processingJobId: null,
    gumletAssetId: null,
    ...options?.row,
  };

  const storedSize = options?.storedSize === undefined ? STORED_BYTES : options.storedSize;
  const jobState = options?.jobState === undefined ? 'waiting' : options.jobState;

  const prisma = {
    video: {
      findFirst: jest.fn(async () => row),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { id: VIDEO_ID };
      }),
    },
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
  };

  const storage = {
    objectSize: jest.fn(async () => storedSize),
    pruneSupersededSources: jest.fn(async () => {
      if (options?.pruneThrows) throw new Error('list failed');
      return [];
    }),
    exists: jest.fn(async () => true),
    presignUpload: jest.fn(async () => ({ uploadUrl: 'https://up.example', requiredHeaders: {} })),
  };

  const queue = {
    add: jest.fn(async () => ({ id: 'job-1' })),
    getJob: jest.fn(async () => {
      if (jobState === null) return null;
      return { getState: async () => jobState };
    }),
  };

  const redis = { getJson: jest.fn(async () => null) };

  const audit = { record: jest.fn(async () => undefined) };

  const config = {
    getOrThrow: () => ({ ladder: ['720p'], encryptionEnabled: true }),
  };

  // Constructor order: prisma, storage, access, courses, notifications, audit,
  // redis, queue, config, lessonVideos, gumletIngest.
  const service = new VideosService(
    prisma as never,
    storage as never,
    access as never,
    {} as never,
    {} as never,
    audit as never,
    redis as never,
    queue as never,
    config as never,
    {} as never,
    {} as never,
  );

  return { service, updates, prisma, access, storage, queue };
}

const complete = (t: ReturnType<typeof build>, declaredSizeBytes?: number | null) =>
  (
    t.service as unknown as {
      completeUpload: (
        id: string,
        actor: unknown,
        declaredSizeBytes?: number | null,
      ) => Promise<Record<string, unknown>>;
    }
  ).completeUpload(VIDEO_ID, ACTOR, declaredSizeBytes);

describe('completing an upload that was interrupted', () => {
  it('finishes the upload when the file is already in storage', async () => {
    // This is the production case: the object landed, the browser never got
    // to say so, and the row was left at UPLOADING with no job.
    const t = build();

    const result = await complete(t);

    // The job is queued, so the worker will drive the video to Gumlet.
    expect(t.queue.add).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('QUEUED');
    expect(result.jobId).toBe('job-1');
  });

  it('records the size that is actually stored, so the row describes reality', async () => {
    const t = build();

    await complete(t);

    const written = t.updates.find((u) => 'sourceSizeBytes' in u);
    expect(written).toBeDefined();
    expect(written!.sourceSizeBytes).toBe(BigInt(STORED_BYTES));
  });

  it('never claims the video is READY', async () => {
    // Readiness is the worker's verdict, after the provider reports ready and
    // the manifest is confirmed encrypted. The upload endpoint has no business
    // writing it.
    const t = build();

    await complete(t);

    for (const update of t.updates) {
      expect(update.status).not.toBe('READY');
    }
  });

  it('queues the job with the source key that was stored', async () => {
    const t = build();

    await complete(t);

    expect(t.queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ videoId: VIDEO_ID, sourceKey: SOURCE_KEY }),
      expect.anything(),
    );
  });
});

describe('completing an upload whose bytes never arrived', () => {
  it('refuses, and says what to do about it', async () => {
    const t = build({ storedSize: null });

    await expect(complete(t)).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });

    // Nothing is queued: there is nothing to process.
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('leaves the row alone, so the truth is not overwritten', async () => {
    const t = build({ storedSize: null });

    await expect(complete(t)).rejects.toBeDefined();

    expect(t.updates.find((u) => 'sourceSizeBytes' in u)).toBeUndefined();
  });

  it('refuses a truncated upload rather than processing half a lecture', async () => {
    // The client says it sent 522,940,365 bytes and the bucket holds fewer:
    // the transfer was cut short. Processing that would produce a lecture
    // that ends mid-sentence.
    const t = build({ storedSize: STORED_BYTES - 1 });

    await expect(complete(t, STORED_BYTES)).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    });
    expect(t.queue.add).not.toHaveBeenCalled();
  });

  it('accepts a length that matches what the client sent', async () => {
    const t = build();

    const result = await complete(t, STORED_BYTES);

    expect(result.status).toBe('QUEUED');
  });

  it('refuses when there was never an upload to confirm', async () => {
    const t = build({ row: { sourceKey: null } });

    await expect(complete(t)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(t.queue.add).not.toHaveBeenCalled();
  });
});

describe('completing an upload twice', () => {
  it('does not queue a second job for a video that is already queued', async () => {
    // A client that retries `complete` after a dropped response must not
    // start the pipeline twice: two jobs would transcode the same source and
    // race each other to write the output.
    const t = build({
      row: { status: 'QUEUED', processingJobId: 'job-existing' },
      jobState: 'waiting',
    });

    const result = await complete(t);

    expect(t.queue.add).not.toHaveBeenCalled();
    expect(result.alreadyQueued).toBe(true);
    expect(result.jobId).toBe('job-existing');
  });

  it('does not queue a second job for a video that is already processing', async () => {
    const t = build({
      row: { status: 'PROCESSING', processingJobId: 'job-existing' },
      jobState: 'active',
    });

    const result = await complete(t);

    expect(t.queue.add).not.toHaveBeenCalled();
    expect(result.alreadyQueued).toBe(true);
  });

  it('re-queues a video whose job was lost, instead of leaving it stranded', async () => {
    // QUEUED with no job is the "stranded" state the maintenance sweep exists
    // for. A repeated `complete` is the cheapest way to notice and fix it.
    const t = build({
      row: { status: 'QUEUED', processingJobId: 'job-gone' },
      jobState: null,
    });

    const result = await complete(t);

    expect(t.queue.add).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('QUEUED');
  });

  it('does not re-queue a video that is already READY', async () => {
    // Transcoding a finished lecture again would be pointless work and would
    // replace a good rendition.
    const t = build({ row: { status: 'READY' } });

    const result = await complete(t);

    expect(t.queue.add).not.toHaveBeenCalled();
    expect(result.status).toBe('READY');
  });
});

describe('cleaning up after a retried upload', () => {
  it('removes the objects earlier attempts left behind', async () => {
    // Every attempt mints a fresh key, so a retried upload leaves the
    // previous attempt's object behind — for a lecture, hundreds of
    // megabytes of it, unreachable by anything.
    const t = build();

    await complete(t);

    expect(t.storage.pruneSupersededSources).toHaveBeenCalledWith(VIDEO_ID, SOURCE_KEY);
  });

  it('does not fail the upload when the cleanup fails', async () => {
    // Housekeeping. The file is there and the job is queued; a listing
    // failure must not turn a good upload into an error.
    const t = build({ pruneThrows: true });

    const result = await complete(t);

    expect(result.status).toBe('QUEUED');
    expect(t.queue.add).toHaveBeenCalledTimes(1);
  });
});

describe('authorisation', () => {
  it('checks the course before anything else', async () => {
    const t = build();

    await complete(t);

    expect(t.access.assertCanManageCourse).toHaveBeenCalledWith(
      'staff_1',
      'TEACHER',
      'course_1',
      'content',
    );
  });

  it('does not touch storage when the caller may not manage the course', async () => {
    const t = build();
    (t.access.assertCanManageCourse as jest.Mock).mockRejectedValueOnce(
      new Error('forbidden'),
    );

    await expect(complete(t)).rejects.toBeDefined();

    expect(t.storage.objectSize).not.toHaveBeenCalled();
    expect(t.queue.add).not.toHaveBeenCalled();
  });
});
