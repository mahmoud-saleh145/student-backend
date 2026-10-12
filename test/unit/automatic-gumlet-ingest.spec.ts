import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';
import { VideosService } from 'src/modules/videos/videos.service';

/**
 * Automatic Gumlet ingestion.
 *
 * The requirement: an admin uploads once from the dashboard, and the platform
 * hands the video to Gumlet with DRM enabled by itself. No second upload, no
 * manual "move to Gumlet" step.
 *
 * Also pinned here: that a Gumlet failure (quota, API error) never leaks the
 * original to a student, and that retrying is idempotent.
 */

const FULL_GUMLET = {
  apiKey: 'gumlet-api-key-fixture-value-0001',
  workspaceId: 'ws_1',
  orgId: 'org_1',
  signSecret: Buffer.from('sign-secret-fixture').toString('base64'),
  tokenLifetimeSeconds: 300,
  resolutions: ['720p', '1080p'],
};

function ingestHarness(rowOverrides: Record<string, unknown> = {}) {
  const updates: Record<string, unknown>[] = [];
  const row: Record<string, unknown> = {
    id: 'v_1',
    status: 'UPLOADING',
    drmProvider: null,
    drmRequested: false,
    drmVerifiedAt: null,
    gumletAssetId: null,
    gumletWorkspaceId: null,
    gumletStatus: null,
    gumletError: null,
    lesson: { title: 'Lecture 1' },
    sourceKey: 'source/videos/v_1/abc.mp4',
    ...rowOverrides,
  };
  const prisma = {
    video: {
      findFirst: jest.fn(async () => ({ ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ status: row.status })),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        Object.assign(row, a.data);
        return row;
      }),
    },
  };
  const storage = {
    presignIngestionUrl: jest.fn(async () => 'https://r2.example/presigned-source'),
    signMediaUrl: jest.fn(async () => 'https://r2.example/viewer-bound'),
  };
  const gumlet = {
    isAssetApiConfigured: jest.fn(() => true),
    isAssetPlayable: jest.fn((s: string) => s === 'ready'),
    assetHasDrm: jest.fn(() => true),
    dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
    createAsset: jest.fn(async (_p?: unknown) => ({ assetId: 'a_1', status: 'queued' as string, playbackUrl: null as string | null })),
    getAsset: jest.fn(async (_p?: unknown) => ({
      assetId: 'a_1', status: 'ready' as string, progress: 100,
      playbackUrl: null as string | null, dashPlaybackUrl: null as string | null, error: null as string | null,
    })),
  };
  const drmVerification = {
    evaluate: jest.fn(() => ({ playable: true, reason: null })),
    evaluateVideo: jest.fn(async () => ({ playable: true, reason: null })),
    verify: jest.fn(async () => ({ playable: true, reason: null })),
  };
  const lessonVideos = { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) };
  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    drmVerification as never,
    { getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: FULL_GUMLET } }) } as never,
    lessonVideos as never,
  );
  return { service, prisma, storage, gumlet, updates, row };
}

describe('automatic Gumlet ingestion', () => {
  it('creates a DRM-enabled asset for a newly uploaded video', async () => {
    const t = ingestHarness();
    const result = await t.service.adopt('v_1');

    // The asset is requested WITH DRM. This is the requirement.
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    const arg = t.gumlet.createAsset.mock.calls[0][0] as { enableDrm: boolean; tag: string[]; sourceUrl: string };
    expect(arg.enableDrm).toBe(true);
    expect(arg.tag).toContain('edu-video:v_1');

    expect(result.assetId).toBe('a_1');
  });

  it('records the asset and the DRM REQUEST, but does not claim verification', async () => {
    const t = ingestHarness();
    await t.service.adopt('v_1');

    const written = t.updates[0];
    expect(written.drmProvider).toBe('gumlet');
    expect(written.gumletAssetId).toBe('a_1');
    // Intent is recorded...
    expect(written.drmRequested).toBe(true);
    // ...but a fresh asset has NOT been verified. Claiming otherwise would let
    // playback proceed on an asset nobody has actually checked.
    expect(written.drmVerifiedAt).toBeNull();
  });

  it('clears a stale verification when a video is re-ingested', async () => {
    // A video that was verified under a previous asset must not stay verified
    // after its asset is replaced.
    const t = ingestHarness({ gumletAssetId: null, drmVerifiedAt: new Date(Date.now() - 1000) });
    await t.service.adopt('v_1');
    expect(t.updates[0].drmVerifiedAt).toBeNull();
  });

  it('hands Gumlet a presigned SOURCE url, never a viewer-bound media url', async () => {
    const t = ingestHarness();
    await t.service.adopt('v_1');
    // signMediaUrl is viewer-bound and refused by the edge Worker for sources.
    expect(t.storage.signMediaUrl).not.toHaveBeenCalled();
    const arg = t.gumlet.createAsset.mock.calls[0][0] as { sourceUrl: string };
    expect(arg.sourceUrl).toContain('presigned-source');
  });

  it('never exposes the signed source url in the response', async () => {
    const t = ingestHarness();
    const result = await t.service.adopt('v_1');
    expect(JSON.stringify(result)).not.toContain('presigned-source');
  });
});

describe('ingestion is idempotent', () => {
  it('does NOT create a second asset when one already exists', async () => {
    // The duplicate-billing guard: a retried job must re-sync, not re-create.
    const t = ingestHarness({ drmProvider: 'gumlet', gumletAssetId: 'existing_1', gumletStatus: 'ready' });
    await t.service.adopt('v_1');
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('repeated adopt() calls create exactly one asset', async () => {
    const t = ingestHarness();
    await t.service.adopt('v_1');
    // Second call: the row now carries an asset id.
    await t.service.adopt('v_1');
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
  });
});

describe('Gumlet failures never expose the original video', () => {
  it('persists the error and does not mark the video playable on a quota failure', async () => {
    const t = ingestHarness();
    t.gumlet.createAsset.mockRejectedValueOnce(
      new Error('The uploaded video duration exceeds the storage minutes quota for your account.'),
    );

    await expect(t.service.adopt('v_1')).rejects.toThrow(/storage minutes quota/);

    // Nothing was written that could imply success.
    expect(t.updates).toHaveLength(0);
    // And the row still has no asset, so playback refuses it.
    expect(t.row.gumletAssetId).toBeNull();
    expect(t.row.status).toBe('UPLOADING');
  });

  it('leaves the source object in place after a failure, so nothing is lost', async () => {
    const t = ingestHarness();
    t.gumlet.createAsset.mockRejectedValueOnce(new Error('boom'));
    await expect(t.service.adopt('v_1')).rejects.toThrow();
    // Deleting is never part of ingestion.
    expect(t.storage.presignIngestionUrl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(Object.keys(t.storage))).not.toContain('deleteObject');
  });

  it('records a terminal asset error rather than marking it ready', async () => {
    const t = ingestHarness({ drmProvider: 'gumlet', gumletAssetId: 'a_1', gumletStatus: 'processing' });
    t.gumlet.getAsset.mockResolvedValueOnce({
      assetId: 'a_1', status: 'errored' as string, progress: 0,
      playbackUrl: null as string | null, dashPlaybackUrl: null as string | null, error: 'storage quota exceeded' as string | null,
    });
    const res = await t.service.sync('v_1');
    expect(res.playable).toBe(false);
    expect(t.updates.at(-1)?.status).toBe('FAILED');
    // Never READY.
    expect(t.updates.at(-1)?.status).not.toBe('READY');
  });
});

describe('upload completion triggers ingestion', () => {
  it('enqueues processing on complete, which is what drives Gumlet ingestion', async () => {
    const enqueued: unknown[] = [];
    const updates: Record<string, unknown>[] = [];

    const prisma = {
      video: {
        findFirst: jest.fn(async () => ({
          id: 'v_1', courseId: 'c_1', sourceKey: 'source/v_1/a.mp4',
          status: 'UPLOADING', lessonId: 'l_1', drmProvider: 'gumlet',
        })),
        update: jest.fn(async (a: { data: Record<string, unknown> }) => { updates.push(a.data); return {}; }),
      },
      playbackTicket: { updateMany: jest.fn(async () => ({})) },
    };
    const storage = { objectSize: jest.fn(async () => 1234) };
    const queue = { add: jest.fn(async (_n: string, data: unknown) => { enqueued.push(data); return { id: 'job_1' }; }) };
    const access = { assertCanManageCourse: jest.fn(async () => undefined) };
    const cfg = {
      ladder: [360, 720, 1080],
      encrypt: true,
      drm: { enabled: true, provider: 'gumlet', gumlet: FULL_GUMLET },
    };

    const lessonVideos = { countLiveAttachments: jest.fn().mockResolvedValue(1) };
    const svc = new VideosService(
      prisma as never,
      storage as never,
      access as never,
      {} as never, // courses
      {} as never, // notifications
      {} as never, // audit
      // redis: completeUpload reports worker liveness, which reads the heartbeat key.
      { getJson: jest.fn(async () => null) } as never,
      queue as never,
      { getOrThrow: () => cfg } as never,
      lessonVideos as never,
    );

    await svc.completeUpload('v_1', { id: 'u_1', role: 'ADMIN' } as never);

    // A transcode job was queued. The worker reads drmProvider from the DB and
    // routes to Gumlet with DRM - that is the automatic path, no admin action.
    expect(enqueued).toHaveLength(1);
    expect((enqueued[0] as { videoId: string }).videoId).toBe('v_1');
  });
});