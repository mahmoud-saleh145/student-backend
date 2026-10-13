import { VideosService } from 'src/modules/videos/videos.service';

/**
 * Every NEW upload must enter the Gumlet workflow automatically.
 *
 * Previously `drmProvider` was only ever set by a staff member calling
 * `POST /videos/:id/gumlet/adopt`. An upload that nobody remembered to adopt
 * therefore stayed on the legacy R2/AES-128 pipeline and became a
 * non-DRM-protected lesson video - exactly the silent fallback this feature
 * must not have.
 *
 * The provider is now chosen in `initUpload`:
 *
 *   - platform not using Gumlet DRM  -> legacy (unchanged, explicit)
 *   - Gumlet DRM fully configured    -> 'gumlet'
 *   - Gumlet DRM but misconfigured   -> REFUSED, never silently legacy
 *
 * Only NEW rows are affected. Replacing the file of an existing video keeps its
 * provider, so the legacy library is never migrated as a side effect.
 */

const ACTOR = { id: 'staff_1', role: 'TEACHER' } as never;

type DrmCfg = {
  enabled?: boolean;
  provider?: string;
  gumlet?: Record<string, unknown>;
};

const FULL_GUMLET = {
  apiKey: 'api-key-for-tests',
  workspaceId: 'ws',
  orgId: 'org_1',
  signSecret: 'c2VjcmV0LWtleS1mb3ItdGVzdGluZw==',
  tokenLifetimeSeconds: 300,
  resolutions: ['720p', '1080p'],
};

function build(opts: { drm: DrmCfg; existing?: { drmProvider: string | null } | null }) {
  const creates: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  const lesson = opts.existing
    ? {
        id: 'lesson_1',
        courseId: 'course_1',
        video: {
          id: 'v_1',
          status: 'READY',
          deletedAt: null,
          hlsPrefix: 'hls/v_1/',
          drmProvider: opts.existing.drmProvider,
          gumletAssetId: null,
        },
        // The owned video's own attachment: unshared, so nothing else plays it.
        videoLinks: [{ videoId: 'v_1', video: { deletedAt: null } }],
      }
    : { id: 'lesson_1', courseId: 'course_1', video: null, videoLinks: [] };

  const prisma = {
    $transaction: jest.fn(async (fn: (tx: unknown) => unknown): Promise<unknown> => fn(prisma)),
    lesson: { findFirst: jest.fn(async () => lesson) },
    lessonVideo: {
      upsert: jest.fn(async () => ({})),
      findMany: jest.fn(async () => [{ lessonId: 'l_1' }]),
      deleteMany: jest.fn(async () => ({ count: 1 })),
      // "How many OTHER lectures use this video": none, it is unshared.
      count: jest.fn(async () => 0),
    },
    video: {
      create: jest.fn(async (args: { data: Record<string, unknown> }) => {
        creates.push(args.data);
        return { id: 'v_new' };
      }),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return { id: 'v_1' };
      }),
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
      drm: {
        enabled: opts.drm.enabled ?? true,
        provider: opts.drm.provider ?? 'gumlet',
        widevineLicenseUrl: null,
        fairplayLicenseUrl: null,
        fairplayCertUrl: null,
        providerToken: null,
        gumlet: opts.drm.gumlet ?? FULL_GUMLET,
      },
    }),
  };

  const lessonVideos = { countLiveAttachments: jest.fn().mockResolvedValue(1) };
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
    lessonVideos as never,
  );

  return { service, creates, updates, storage };
}

const upload = (service: VideosService) =>
  service.initUpload(
    { lessonId: 'lesson_1', filename: 'lecture.mp4', contentType: 'video/mp4', sizeBytes: 1024 },
    ACTOR,
  );

describe('a new upload on a Gumlet platform', () => {
  it('is routed to Gumlet without any staff action', async () => {
    const t = build({ drm: { enabled: true, provider: 'gumlet' } });
    await upload(t.service);
    expect(t.creates).toHaveLength(1);
    expect(t.creates[0]!.drmProvider).toBe('gumlet');
  });

  it('records the lesson, course and uploader alongside the provider', async () => {
    const t = build({ drm: { enabled: true, provider: 'gumlet' } });
    await upload(t.service);
    expect(t.creates[0]).toMatchObject({
      lessonId: 'lesson_1',
      courseId: 'course_1',
      uploadedById: 'staff_1',
      drmProvider: 'gumlet',
    });
  });
});

describe('a new upload fails closed when Gumlet DRM cannot be delivered', () => {
  it.each([
    ['missing api key', { ...FULL_GUMLET, apiKey: null }],
    ['missing workspace id', { ...FULL_GUMLET, workspaceId: null }],
    ['missing org id', { ...FULL_GUMLET, orgId: null }],
    ['missing signing secret', { ...FULL_GUMLET, signSecret: null }],
  ])('is refused with %s', async (_label, gumlet) => {
    const t = build({ drm: { enabled: true, provider: 'gumlet', gumlet } });
    // Must NOT fall back to legacy: that is the whole point.
    await expect(upload(t.service)).rejects.toThrow(/not fully configured|unprotected/i);
    expect(t.creates).toHaveLength(0);
    expect(t.storage.presignUpload).not.toHaveBeenCalled();
  });
});

describe('a platform not using Gumlet DRM', () => {
  it('keeps the legacy provider when DRM is switched off platform-wide', async () => {
    const t = build({ drm: { enabled: false, provider: 'none' } });
    await upload(t.service);
    expect(t.creates[0]!.drmProvider).toBeNull();
  });

  it('keeps the legacy provider when another provider is configured', async () => {
    const t = build({ drm: { enabled: true, provider: 'somethingelse' } });
    await upload(t.service);
    expect(t.creates[0]!.drmProvider).toBeNull();
  });

  it('does not demand Gumlet credentials it will not use', async () => {
    // DRM off + no credentials must succeed, not be refused.
    const t = build({ drm: { enabled: false, provider: 'none', gumlet: { apiKey: null } } });
    await upload(t.service);
    expect(t.creates).toHaveLength(1);
  });
});

describe('replacing the file of an existing video', () => {
  it('moves a legacy row onto Gumlet so NEW content is never unprotected', async () => {
    // The regression this covers: a lesson created before the policy kept
    // drmProvider=null, and replacing its file sent the new recording down the
    // legacy ffmpeg/AES-128 pipeline.
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: null },
    });
    await upload(t.service);
    expect(t.creates).toHaveLength(0);
    expect(t.updates[0]).toHaveProperty('drmProvider', 'gumlet');
  });

  it('leaves an already-Gumlet row on Gumlet without re-deciding it', async () => {
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: 'gumlet' },
    });
    await upload(t.service);
    // Preserved by NOT writing the field; writing it would also be correct,
    // what must never happen is it becoming anything else.
    expect(t.updates[0]!.drmProvider ?? 'gumlet').toBe('gumlet');
  });

  it('still clears the stale Gumlet asset identity so adopt builds a new asset', async () => {
    // Otherwise adopt() would treat the old asset as current, re-sync it, find
    // it still ready, and mark the lesson READY while students watch the
    // previous recording.
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: 'gumlet' },
    });
    await upload(t.service);
    expect(t.updates[0]).toHaveProperty('gumletAssetId', null);
    expect(t.updates[0]).toHaveProperty('gumletStatus', null);
    expect(t.updates[0]).toHaveProperty('gumletError', null);
  });

  it('resets status and processing state so no ticket survives the replacement', async () => {
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: null },
    });
    await upload(t.service);
    expect(t.updates[0]).toMatchObject({
      status: 'UPLOADING',
      processingError: null,
      processingJobId: null,
      processingStartedAt: null,
      processedAt: null,
    });
  });

  it('does not touch a legacy row when the platform explicitly disables DRM', async () => {
    const t = build({
      drm: { enabled: false, provider: 'none' },
      existing: { drmProvider: null },
    });
    await upload(t.service);
    expect(t.updates[0]).not.toHaveProperty('drmProvider');
  });

  it.each([
    ['missing api key', { ...FULL_GUMLET, apiKey: null }],
    ['missing workspace id', { ...FULL_GUMLET, workspaceId: null }],
    ['missing org id', { ...FULL_GUMLET, orgId: null }],
    ['missing signing secret', { ...FULL_GUMLET, signSecret: null }],
  ])('refuses the replacement closed with %s', async (_label, gumlet) => {
    // The critical ordering property: resolution happens BEFORE the write, so a
    // misconfigured platform leaves the existing lesson exactly as it was rather
    // than stranding it half-reset and unprotected.
    const t = build({
      drm: { enabled: true, provider: 'gumlet', gumlet },
      existing: { drmProvider: null },
    });
    await expect(upload(t.service)).rejects.toThrow(/not fully configured|unprotected/i);
    expect(t.updates).toHaveLength(0);
    expect(t.creates).toHaveLength(0);
    expect(t.storage.presignUpload).not.toHaveBeenCalled();
  });

  it('still uploads onto a ready Gumlet row without altering the provider', async () => {
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: 'gumlet' },
    });
    await upload(t.service);
    expect(t.storage.presignUpload).toHaveBeenCalledTimes(1);
    expect(t.updates[0]!.drmProvider ?? 'gumlet').toBe('gumlet');
  });
});

/**
 * The failure mode that made the replace gap dangerous: a replacement whose
 * Gumlet ingest fails must NOT be rescued by the legacy pipeline.
 *
 * `processFromJob` is the single gate. It reads `drmProvider` from the DATABASE
 * rather than from the job payload, so the only thing standing between a failed
 * Gumlet video and the legacy ffmpeg/AES-128 path is the column written in
 * `initUpload`. These tests assert that column is what it claims to be.
 */
describe('a replacement whose Gumlet ingest fails', () => {
  it('is left on the Gumlet provider, so no legacy rescue is possible', async () => {
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: null },
    });
    await upload(t.service);
    const storedProvider = t.updates[0]!.drmProvider;
    // This is the exact predicate `processFromJob` uses to decide the pipeline.
    expect(storedProvider !== 'gumlet').toBe(false);
  });

  it('is left unplayable: UPLOADING cannot mint a playback ticket', async () => {
    // playback.service.ts issues a ticket only when status === READY, so the
    // replacement is unavailable until Gumlet ingest and DRM packaging are both
    // verified. Nothing downgrades it to a playable legacy rendition.
    const t = build({
      drm: { enabled: true, provider: 'gumlet' },
      existing: { drmProvider: null },
    });
    await upload(t.service);
    expect(t.updates[0]!.status).not.toBe('READY');
  });
});
