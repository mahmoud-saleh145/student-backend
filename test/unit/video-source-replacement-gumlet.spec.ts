import { VideosService } from 'src/modules/videos/videos.service';

/**
 * Replacing the source file of a lecture's video.
 *
 * A lecture holds ONE video row, so an upload over an existing video reuses it.
 * For the legacy path that is harmless - the worker re-transcodes from whatever
 * `sourceKey` is now on the row.
 *
 * For a Gumlet video it was NOT harmless. The row kept `gumletAssetId` from the
 * previous recording, and `GumletIngestService.adopt()` treats a present asset
 * id as "already adopted, just re-sync". The result was the worst possible
 * failure for this feature: the new file was never sent to Gumlet, the OLD asset
 * was re-checked, it still verified as encrypted and ready, and the lesson was
 * marked READY - while students continued to watch the previous lecture.
 *
 * These tests drive the real `initUpload` and assert the reset happens, and
 * that it resets the ASSET rather than the provider.
 */

const ACTOR = { id: 'staff_1', role: 'TEACHER' } as never;

function build(existing: {
  drmProvider: string | null;
  gumletAssetId: string | null;
} | null) {
  const updates: Record<string, unknown>[] = [];

  const lesson = existing
    ? {
        id: 'lesson_1',
        courseId: 'course_1',
        video: {
          id: 'v_1',
          status: 'READY',
          deletedAt: null,
          hlsPrefix: 'hls/v_1/',
          drmProvider: existing.drmProvider,
          gumletAssetId: existing.gumletAssetId,
        },
      }
    : { id: 'lesson_1', courseId: 'course_1', video: null };

  const prisma = {
    lesson: {
      findFirst: jest.fn(async () => lesson),
    },
    video: {
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { id: 'v_1' };
      }),
      create: jest.fn(async () => ({ id: 'v_new' })),
    },
  };

  const access = {
    assertCanManageCourse: jest.fn(async () => undefined),
    assertTeacherCapability: jest.fn(async () => undefined),
  };

  const storage = {
    presignUpload: jest.fn(async () => ({ url: 'https://up.example', fields: {} })),
  };

  const audit = { record: jest.fn(async () => undefined) };

  const config = {
    getOrThrow: () => ({
      maxSourceBytes: 8 * 1024 ** 3,
      allowedVideoTypes: ['video/mp4'],
    }),
  };

  // Constructor order: prisma, storage, access, courses, notifications, audit,
// redis, queue, config. Only the first three and audit are on this path.
  const service = new VideosService(
    prisma as never,
    storage as never,
    access as never,
    {} as never,
    {} as never,
    audit as never,
    {} as never,
    {} as never,
    config as never,
  );

  return { service, updates, prisma, access, storage };
}

const upload = (s: { initUpload: unknown }) =>
  (
    s as unknown as {
      initUpload: (
        p: { lessonId: string; filename: string; contentType: string; sizeBytes: number },
        a: unknown,
      ) => Promise<unknown>;
    }
  ).initUpload(
    {
      lessonId: 'lesson_1',
      filename: 'lecture-v2.mp4',
      contentType: 'video/mp4',
      sizeBytes: 1024,
    },
    ACTOR,
  );

describe('replacing the file of a Gumlet-backed video', () => {
  it('clears the stale asset so the new source is ingested', async () => {
    const t = build({ drmProvider: 'gumlet', gumletAssetId: 'asset_old' });

    await upload(t.service as never);

    const reset = t.updates.find((u) => 'gumletAssetId' in u);
    expect(reset).toBeDefined();
    // The old asset describes content that no longer exists.
    expect(reset!.gumletAssetId).toBeNull();
  });

  it('clears the provisioning status and any stale error', async () => {
    const t = build({ drmProvider: 'gumlet', gumletAssetId: 'asset_old' });

    await upload(t.service as never);

    const reset = t.updates.find((u) => 'gumletAssetId' in u)!;
    expect(reset.gumletStatus).toBeNull();
    expect(reset.gumletError).toBeNull();
    expect(reset.gumletUpdatedAt).toBeNull();
  });

  it('keeps the provider, so the lesson stays on the DRM path', async () => {
    // Dropping the provider here would silently return the lesson to legacy
    // HLS - a protection downgrade nobody asked for.
    const t = build({ drmProvider: 'gumlet', gumletAssetId: 'asset_old' });

    await upload(t.service as never);

    // `initUpload` has no `drmProvider` write at all: it is untouched by the
    // upload, which is exactly the intent.
    const reset = t.updates.find((u) => 'gumletAssetId' in u)!;
    expect('drmProvider' in reset).toBe(false);
    expect(reset.status).toBe('UPLOADING');
  });

  it('returns the video to UPLOADING so nothing plays the stale rendition', async () => {
    const t = build({ drmProvider: 'gumlet', gumletAssetId: 'asset_old' });

    await upload(t.service as never);

    const reset = t.updates.find((u) => 'gumletAssetId' in u)!;
    expect(reset.status).toBe('UPLOADING');
    expect(reset.processedAt).toBeNull();
    expect(reset.processingError).toBeNull();
  });
});

describe('replacing the file of a legacy video', () => {
  it('applies the same reset without changing behaviour', async () => {
    const t = build({ drmProvider: null, gumletAssetId: null });

    await upload(t.service as never);

    const reset = t.updates.find((u) => 'gumletAssetId' in u)!;
    expect(reset.status).toBe('UPLOADING');
    // Nothing to clear, and nothing that was not already null.
    expect(reset.gumletAssetId).toBeNull();
  });
});

describe('a first upload onto an empty lecture', () => {
  it('creates the row and applies no reset', async () => {
    const t = build(null);

    await upload(t.service as never);

    expect(t.prisma.video.create).toHaveBeenCalled();
    expect(t.updates.some((u) => 'gumletAssetId' in u)).toBe(false);
  });
});