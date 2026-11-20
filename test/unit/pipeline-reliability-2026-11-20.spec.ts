import { Prisma } from '@prisma/client';
import { DelayedError } from 'bullmq';

jest.mock('node:fs/promises', () => ({
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => []),
}));

import { isTransientDatabaseError } from '../../src/database/transient-db-error';
import { MobileVideoProcessor } from '../../src/jobs/processors/mobile-video.processor';
import { transientKindOfWebFailure, VideoProcessor } from '../../src/jobs/processors/video.processor';
import { MOBILE_VIDEO_JOBS, VIDEO_JOBS } from '../../src/jobs/queue.constants';
import {
  planTransientDeferral,
  TRANSIENT_DEFERRAL_POLICIES,
  type TransientDeferralState,
} from '../../src/jobs/transient-deferral';
import {
  GumletCreationOutcomeUnknownError,
  GumletRequestError,
  gumletVideoTag,
  normalizeGumletTag,
  toCandidate,
} from '../../src/modules/playback/gumlet-drm.service';
import {
  GUMLET_ASSET_CREATING,
  GUMLET_CREATE_CLAIM_STALE_MS,
  GumletAdoptionNotRecordedError,
  GumletCreationPendingError,
  GumletIngestService,
  selectAdoptableAsset,
} from '../../src/modules/videos/gumlet-ingest.service';
import { VideosService } from '../../src/modules/videos/videos.service';

/**
 * Regression suite for the 2026-11-20 incident.
 *
 * The laptop worker lost the database for 5.5 h (Wi-Fi without a working DNS
 * resolver). Two things went wrong that this suite pins:
 *
 *   1. Video cmwp0i2sx001rho01ap2is9gu: Gumlet CREATED asset
 *      6b006a5ec442db95b9458a51, but the create's answer was lost, so the row
 *      never recorded it. The only recovery was a hand-written database update;
 *      a staff "retry" would have created a second, billed asset.
 *   2. Web and mobile jobs spent all their attempts on P1001 within seconds to
 *      minutes, although nothing was wrong with the videos.
 *
 * Everything here is mocked: no network, no database, no Redis, no Gumlet.
 */

// ---------------------------------------------------------------------------
// Production-shaped fixtures (from the read-only audit of 2026-11-20)
// ---------------------------------------------------------------------------

const WS = '6ac7f59d5990b730fc3f3c92';
const VIDEO = 'cmwp0i2sx001rho01ap2is9gu';
const ASSET = '6b006a5ec442db95b9458a51';
const SOURCE_KEY = `source/videos/${VIDEO}/sheet-4-part-3.mp4`;
const SIZE = 386112742;

/** A raw list item as Gumlet returns it (only the fields we read, plus noise). */
function rawAsset(over: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
  return {
    asset_id: ASSET,
    status: 'ready',
    progress: 100,
    created_at: 1795189342049,
    tag: [normalizeGumletTag(gumletVideoTag(VIDEO))],
    workspace_id: WS,
    collection_id: WS,
    input: {
      // Virtual-hosted R2 URL with a SigV4 query: only the path may be used.
      source_url: `https://edu-uploads.acct.r2.cloudflarestorage.com/${SOURCE_KEY}?X-Amz-Signature=secret`,
      size: SIZE,
      transformations: { drm: { type: 'widevine,fairplay' } },
      ...input,
    },
    output: { playback_url: 'https://video.gumlet.io/x/main.m3u8' },
    ...over,
  };
}

const p1001 = () =>
  new Prisma.PrismaClientKnownRequestError("Can't reach database server at `db.example:5432`", {
    code: 'P1001',
    clientVersion: 'test',
  });

// ---------------------------------------------------------------------------
// A fake Gumlet (stores what was "created", answers list-by-tag like the API)
// ---------------------------------------------------------------------------

class FakeGumlet {
  assets: Array<ReturnType<typeof rawAsset>> = [];
  creates = 0;
  /** 'ok' | 'lost-answer' (Gumlet creates it, the answer never arrives) | 'refuse' */
  mode: 'ok' | 'lost-answer' | 'refuse' = 'ok';
  lookupFails = false;
  createDelayMs = 0;

  isAssetApiConfigured = () => true;
  isSigningConfigured = () => true;
  isAssetPlayable = (s: string) => s === 'ready';

  findAssetsByTag = jest.fn(async (tag: string) => {
    if (this.lookupFails) throw new GumletRequestError('Gumlet asset lookup by tag failed: timed out after 5000 ms', true, null);
    const wanted = normalizeGumletTag(tag);
    return this.assets.filter((a) => a.tag.includes(wanted)).map((a) => toCandidate(a));
  });

  createAsset = jest.fn(async (params: { sourceUrl: string; tag?: string[] }) => {
    this.creates += 1;
    if (this.createDelayMs) await new Promise((r) => setTimeout(r, this.createDelayMs));
    if (this.mode === 'refuse') throw new Error('Gumlet asset creation failed with HTTP 400');
    const id = `asset_${this.creates}`;
    const key = new URL(params.sourceUrl).pathname.replace(/^\//, '');
    this.assets.push(
      rawAsset(
        { asset_id: id, status: 'pre-queued', created_at: Date.now(), tag: (params.tag ?? []).map(normalizeGumletTag) },
        { source_url: `https://edu-uploads.acct.r2.cloudflarestorage.com/${key}?sig=x` },
      ),
    );
    if (this.mode === 'lost-answer') throw new GumletCreationOutcomeUnknownError(params.tag ?? [], 'no answer within 30000 ms');
    return { assetId: id, status: 'pre-queued', playbackUrl: null };
  });

  getAsset = jest.fn(async (assetId: string) => {
    const a = this.assets.find((x) => x.asset_id === assetId);
    return {
      assetId,
      status: a?.status ?? 'deleted',
      progress: 100,
      playbackUrl: null,
      dashPlaybackUrl: 'https://video.gumlet.io/x/main.mpd',
      error: null,
      errorCode: null,
      durationSeconds: 750,
      width: 864,
      height: 480,
      frameRate: 30,
      drmSystems: ['widevine', 'fairplay'],
    };
  });
}

// ---------------------------------------------------------------------------
// A Prisma fake that honours the guards these writes rely on
// ---------------------------------------------------------------------------

type VideoRow = {
  id: string;
  status: string;
  deletedAt: Date | null;
  drmProvider: string | null;
  sourceKey: string | null;
  sourceSizeBytes: bigint | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
  gumletStatus: string | null;
  gumletUpdatedAt: Date | null;
  gumletError: string | null;
  drmVerifiedAt: Date | null;
  drmRequested: boolean;
  lessonId: string | null;
  courseId: string;
  width: number | null;
  height: number | null;
  frameRate: number | null;
  durationSeconds: number;
  processingStartedAt: Date | null;
  processingJobId: string | null;
  lesson?: { title: string };
};

function videoRow(over: Partial<VideoRow> = {}): VideoRow {
  return {
    id: VIDEO,
    status: 'PROCESSING',
    deletedAt: null,
    drmProvider: 'gumlet',
    sourceKey: SOURCE_KEY,
    sourceSizeBytes: BigInt(SIZE),
    gumletAssetId: null,
    gumletWorkspaceId: null,
    gumletStatus: null,
    gumletUpdatedAt: null,
    gumletError: null,
    drmVerifiedAt: null,
    drmRequested: false,
    lessonId: 'lesson_1',
    courseId: 'course_1',
    width: null,
    height: null,
    frameRate: null,
    durationSeconds: 0,
    processingStartedAt: new Date('2026-11-20T15:42:20Z'),
    processingJobId: `transcode:${VIDEO}:1795189216119`,
    lesson: { title: 'Sheet 4 part 3' },
    ...over,
  };
}

function matchesValue(cond: unknown, value: unknown): boolean {
  if (cond === null) return value === null || value === undefined;
  if (cond instanceof Date || typeof cond !== 'object') return value === cond;
  const c = cond as { not?: unknown; in?: unknown[]; lt?: Date };
  if ('not' in c) return value !== null && value !== undefined && value !== c.not; // SQL: NULL <> x is not true
  if (c.in) return c.in.includes(value);
  if (c.lt) return value instanceof Date && value < c.lt;
  return true;
}

function whereMatches(where: Record<string, unknown>, row: VideoRow): boolean {
  for (const [k, cond] of Object.entries(where)) {
    if (k === 'OR') {
      if (!(cond as Array<Record<string, unknown>>).some((c) => whereMatches(c, row))) return false;
      continue;
    }
    if (k === 'deletedAt' && (cond as { equals?: null })?.equals === null) {
      if (row.deletedAt !== null) return false;
      continue;
    }
    if (!matchesValue(cond, (row as Record<string, unknown>)[k])) return false;
  }
  return true;
}

function fakePrisma(row: VideoRow, opts: { failWrites?: () => boolean } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  const apply = (data: Record<string, unknown>) => {
    writes.push(data);
    Object.assign(row, data);
  };
  return {
    writes,
    video: {
      findFirst: jest.fn(async () => (row.deletedAt ? null : { ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        if (opts.failWrites?.()) throw p1001();
        apply(a.data);
        return { ...row };
      }),
      updateMany: jest.fn(async (a: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (opts.failWrites?.()) throw p1001();
        if (!whereMatches(a.where, row)) return { count: 0 };
        apply(a.data);
        return { count: 1 };
      }),
    },
  };
}

function ingestService(row: VideoRow, gumlet: FakeGumlet, opts: { failWrites?: () => boolean; drmPlayable?: boolean } = {}) {
  const prisma = fakePrisma(row, opts);
  const drmVerification = {
    verify: jest.fn(async () => {
      if (opts.drmPlayable === false) return { playable: false, reason: 'NOT_ENCRYPTED' };
      row.drmVerifiedAt = new Date();
      return { playable: true, reason: null };
    }),
    isPlatformUsable: () => true,
  };
  const lessonVideos = { propagateDurationToAttachedLessons: jest.fn(async () => undefined) };
  const storage = {
    presignIngestionUrl: jest.fn(async (p: { objectKey: string }) => `https://edu-uploads.acct.r2.cloudflarestorage.com/${p.objectKey}?X-Amz-Signature=s`),
    exists: jest.fn(async () => true),
    isConfigured: true,
  };
  const audit = { record: jest.fn(async () => undefined) };
  const config = {
    getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: { workspaceId: WS, ingestUrlTtlSeconds: 21600 } } }),
  };
  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    drmVerification as never,
    config as never,
    lessonVideos as never,
    audit as never,
  );
  return { service, prisma, drmVerification, lessonVideos, audit };
}

beforeAll(() => {
  // Keep the expected error/warn lines out of the test output.
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

// ===========================================================================
// 5. An existing asset is discovered and SAFELY adopted (selection rules)
// ===========================================================================

describe('selectAdoptableAsset: only this video\'s own asset is ever adopted', () => {
  const video = { id: VIDEO, sourceKey: SOURCE_KEY, sourceSizeBytes: BigInt(SIZE) };
  const pick = (raws: unknown[], exclude?: string[]) =>
    selectAdoptableAsset(video, raws.map(toCandidate), { workspaceId: WS, excludeAssetIds: exclude });

  it('REGRESSION cmwp0i2sx: adopts the asset Gumlet holds for the stored file', () => {
    const r = pick([rawAsset()]);
    expect(r.chosen?.assetId).toBe(ASSET);
    expect(r.rejected).toEqual([]);
  });

  it('parses the source path without the signed query string', () => {
    const c = toCandidate(rawAsset());
    expect(c.sourceObjectPath).toBe(SOURCE_KEY);
    expect(JSON.stringify(c)).not.toContain('Signature');
  });

  it('also accepts a path-style URL (bucket first)', () => {
    const r = pick([rawAsset({}, { source_url: `https://acct.r2.cloudflarestorage.com/edu-uploads/${SOURCE_KEY}?x=1` })]);
    expect(r.chosen?.assetId).toBe(ASSET);
  });

  it.each([
    ['another video\'s tag', rawAsset({ tag: ['edu-videocmwOTHER0000000000000000'] }), 'tag-mismatch'],
    ['another workspace (not ours)', rawAsset({ workspace_id: 'ws_other', collection_id: 'ws_other' }), 'other-workspace'],
    ['a failed asset', rawAsset({ status: 'errored' }), 'terminal-status'],
    ['a deleted asset', rawAsset({ status: 'deleted' }), 'terminal-status'],
    ['an asset of a PREVIOUS file (re-upload)', rawAsset({}, { source_url: 'https://edu-uploads.a.r2.cloudflarestorage.com/source/videos/old.mp4?s=1' }), 'source-mismatch'],
    ['a different size', rawAsset({}, { size: SIZE + 1 }), 'size-mismatch'],
    ['no DRM', rawAsset({}, { transformations: { drm: { type: '' } } }), 'drm-missing'],
    ['unknown source', rawAsset({}, { source_url: undefined }), 'source-unknown'],
  ])('refuses %s', (_label, raw, reason) => {
    const r = pick([raw]);
    expect(r.chosen).toBeNull();
    expect(r.rejected).toEqual([{ assetId: ASSET, reason }]);
  });

  it('never re-adopts the asset a replacement is replacing', () => {
    expect(pick([rawAsset()], [ASSET]).chosen).toBeNull();
  });

  it('resolves pre-existing duplicates deterministically (ready first, then oldest) and reports the rest', () => {
    const r = pick([
      rawAsset({ asset_id: 'newer_processing', status: 'processing', created_at: 3 }),
      rawAsset({ asset_id: 'older_ready', status: 'ready', created_at: 2 }),
      rawAsset({ asset_id: 'oldest_queued', status: 'queued', created_at: 1 }),
    ]);
    expect(r.chosen?.assetId).toBe('older_ready');
    expect(r.duplicates.map((d) => d.assetId)).toEqual(['oldest_queued', 'newer_processing']);
  });
});

// ===========================================================================
// 1-5, 10. GumletIngestService.adopt / reconcile, against the fake Gumlet
// ===========================================================================

describe('Gumlet asset creation is idempotent', () => {
  it('5. REGRESSION cmwp0i2sx: the sweep entry point records the existing asset and creates nothing', async () => {
    const gumlet = new FakeGumlet();
    gumlet.assets.push(rawAsset());
    const row = videoRow();
    const t = ingestService(row, gumlet);

    await expect(t.service.reconcileUnrecordedAsset(VIDEO)).resolves.toEqual({ assetId: ASSET });

    expect(gumlet.createAsset).not.toHaveBeenCalled();
    expect(row.gumletAssetId).toBe(ASSET);
    expect(row.gumletWorkspaceId).toBe(WS);
    expect(row.drmRequested).toBe(true);
    // 10. Recording an asset is NOT readiness: READY needs the DRM check.
    expect(row.status).toBe('PROCESSING');
    expect(row.drmVerifiedAt).toBeNull();
    expect(t.audit.record).toHaveBeenCalledWith(expect.objectContaining({ entityId: VIDEO, action: 'UPDATE' }));
  });

  it('5. the sweep entry point never touches a row that already records an asset', async () => {
    const gumlet = new FakeGumlet();
    gumlet.assets.push(rawAsset());
    const row = videoRow({ gumletAssetId: 'already_recorded', status: 'READY' });
    const t = ingestService(row, gumlet);

    await expect(t.service.reconcileUnrecordedAsset(VIDEO)).resolves.toBeNull();
    expect(gumlet.findAssetsByTag).not.toHaveBeenCalled();
    expect(row.gumletAssetId).toBe('already_recorded');
    expect(t.prisma.writes).toEqual([]);
  });

  it('5. a staff retry (adopt) records the existing asset instead of creating a second one', async () => {
    const gumlet = new FakeGumlet();
    gumlet.assets.push(rawAsset());
    const row = videoRow({ status: 'FAILED' });
    const t = ingestService(row, gumlet);

    await expect(t.service.adopt(VIDEO)).resolves.toEqual({ assetId: ASSET, status: 'ready' });
    expect(gumlet.createAsset).not.toHaveBeenCalled();
    expect(row.gumletAssetId).toBe(ASSET);
  });

  it('1. Gumlet accepts the asset but the answer times out: the next attempt records THAT asset', async () => {
    const gumlet = new FakeGumlet();
    gumlet.mode = 'lost-answer';
    const row = videoRow();
    const t = ingestService(row, gumlet);

    await expect(t.service.adopt(VIDEO)).rejects.toBeInstanceOf(GumletCreationOutcomeUnknownError);
    // The claim is KEPT: it is the record that an asset may exist.
    expect(row.gumletStatus).toBe(GUMLET_ASSET_CREATING);
    expect(row.gumletAssetId).toBeNull();

    gumlet.mode = 'ok';
    await expect(t.service.adopt(VIDEO)).resolves.toEqual({ assetId: 'asset_1', status: 'pre-queued' });
    expect(gumlet.creates).toBe(1);
    expect(gumlet.assets).toHaveLength(1);
    expect(row.gumletAssetId).toBe('asset_1');
  });

  it('1. ...and if Gumlet does NOT list it yet, no second asset is created while the claim is fresh', async () => {
    const gumlet = new FakeGumlet();
    gumlet.mode = 'lost-answer';
    const row = videoRow();
    const t = ingestService(row, gumlet);
    await t.service.adopt(VIDEO).catch(() => undefined);
    gumlet.assets = []; // not listed (yet)
    gumlet.mode = 'ok';

    await expect(t.service.adopt(VIDEO)).rejects.toBeInstanceOf(GumletCreationPendingError);
    expect(gumlet.creates).toBe(1);

    // Once the claim is stale with still nothing found, Gumlet never got it: create.
    row.gumletUpdatedAt = new Date(Date.now() - GUMLET_CREATE_CLAIM_STALE_MS - 1000);
    await expect(t.service.adopt(VIDEO)).resolves.toMatchObject({ assetId: 'asset_2' });
    expect(gumlet.creates).toBe(2);
  });

  it('2. Gumlet creates the asset but the database write fails: retryable, and the retry records it (no second asset)', async () => {
    const gumlet = new FakeGumlet();
    const row = videoRow();
    let dbDown = false;
    const t = ingestService(row, gumlet, { failWrites: () => dbDown });
    gumlet.createAsset.mockImplementationOnce(async (params) => {
      const r = await new FakeGumlet().createAsset(params); // same shape
      gumlet.assets.push({ ...rawAsset({ asset_id: r.assetId, status: 'pre-queued' }) });
      gumlet.creates += 1;
      dbDown = true; // the database drops right after Gumlet answered
      return r;
    });

    const error = await t.service.adopt(VIDEO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GumletAdoptionNotRecordedError);
    expect((error as GumletAdoptionNotRecordedError).retryable).toBe(true);
    expect(transientKindOfWebFailure(error)).toBe('database');
    expect(row.gumletAssetId).toBeNull();

    dbDown = false;
    await expect(t.service.adopt(VIDEO)).resolves.toMatchObject({ assetId: 'asset_1' });
    expect(gumlet.creates).toBe(1);
    expect(row.gumletAssetId).toBe('asset_1');
  }, 20_000); // waits through the real (jittered, ~7.5 s max) database retry backoff

  it('3. the same job retried many times with intermittent failures still yields ONE asset', async () => {
    const gumlet = new FakeGumlet();
    const row = videoRow();
    let call = 0;
    const t = ingestService(row, gumlet);
    const modes: Array<FakeGumlet['mode']> = ['lost-answer', 'ok', 'ok', 'ok', 'ok'];
    for (const mode of modes) {
      gumlet.mode = mode;
      call += 1;
      await t.service.adopt(VIDEO).catch(() => undefined);
    }
    expect(call).toBe(5);
    expect(gumlet.creates).toBe(1);
    expect(gumlet.assets).toHaveLength(1);
    expect(row.gumletAssetId).toBe('asset_1');
  });

  it('4. two workers creating the same asset at once: one creates, the other defers', async () => {
    const gumlet = new FakeGumlet();
    gumlet.createDelayMs = 20;
    const row = videoRow();
    const a = ingestService(row, gumlet);
    const b = ingestService(row, gumlet); // a second worker process, same database row

    const results = await Promise.allSettled([a.service.adopt(VIDEO), b.service.adopt(VIDEO)]);

    expect(gumlet.creates).toBe(1);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(GumletCreationPendingError);
    expect(transientKindOfWebFailure(rejected.reason)).toBe('gumlet-create-pending');
    expect(row.gumletAssetId).toBe('asset_1');
  });

  it('never creates when the lookup itself cannot complete ("could not look" is not "nothing there")', async () => {
    const gumlet = new FakeGumlet();
    gumlet.lookupFails = true;
    const row = videoRow();
    const t = ingestService(row, gumlet);

    const error = await t.service.adopt(VIDEO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GumletRequestError);
    expect(transientKindOfWebFailure(error)).toBe('provider');
    expect(gumlet.createAsset).not.toHaveBeenCalled();
    expect(t.prisma.writes).toEqual([]);
  });

  it('a refused create releases the claim, so the video is not blocked', async () => {
    const gumlet = new FakeGumlet();
    gumlet.mode = 'refuse';
    const row = videoRow();
    const t = ingestService(row, gumlet);

    await expect(t.service.adopt(VIDEO)).rejects.toThrow(/HTTP 400/);
    expect(row.gumletStatus).toBeNull();
    expect(row.gumletAssetId).toBeNull();
  });

  it('a late recording of the SAME asset (already recorded by the sweep) is not reported as an orphan', async () => {
    const gumlet = new FakeGumlet();
    const row = videoRow();
    const t = ingestService(row, gumlet);
    gumlet.createAsset.mockImplementationOnce(async () => {
      gumlet.creates += 1;
      gumlet.assets.push(rawAsset({ asset_id: 'asset_1' }));
      // The sweep reconciles it while this create is still "in flight".
      row.gumletAssetId = 'asset_1';
      return { assetId: 'asset_1', status: 'pre-queued', playbackUrl: null };
    });

    await expect(t.service.adopt(VIDEO)).resolves.toMatchObject({ assetId: 'asset_1' });
  });

  it('4. RACE: a worker frozen after its claim (laptop standby) does not create once its claim was taken over', async () => {
    const gumlet = new FakeGumlet();
    const row = videoRow();
    const t = ingestService(row, gumlet);
    const claimWrite = t.prisma.video.updateMany.getMockImplementation()!;
    t.prisma.video.updateMany.mockImplementation(async (a) => {
      const r = await claimWrite(a);
      // While this worker "sleeps", another attempt takes the stale claim over.
      if (a.data.gumletStatus === GUMLET_ASSET_CREATING) row.gumletUpdatedAt = new Date(Date.now() + 60_000);
      return r;
    });

    await expect(t.service.adopt(VIDEO)).rejects.toBeInstanceOf(GumletCreationPendingError);
    expect(gumlet.createAsset).not.toHaveBeenCalled();
    // The other attempt's claim is untouched.
    expect(row.gumletStatus).toBe(GUMLET_ASSET_CREATING);
  });

  it('4. RACE: releasing a claim never clears ANOTHER attempt\'s newer claim', async () => {
    const gumlet = new FakeGumlet();
    const row = videoRow();
    const t = ingestService(row, gumlet);
    const newer = new Date(Date.now() + 60_000);
    gumlet.createAsset.mockImplementationOnce(async () => {
      gumlet.creates += 1;
      row.gumletUpdatedAt = newer; // a newer attempt took the claim over meanwhile
      throw new Error('Gumlet asset creation failed with HTTP 400');
    });

    await expect(t.service.adopt(VIDEO)).rejects.toThrow(/HTTP 400/);
    expect(row.gumletStatus).toBe(GUMLET_ASSET_CREATING);
    expect(row.gumletUpdatedAt).toBe(newer);
  });

  it('10. after adoption, READY is set only by sync() once DRM verification passes', async () => {
    const gumlet = new FakeGumlet();
    gumlet.assets.push(rawAsset());
    const row = videoRow();

    const refused = ingestService(row, gumlet, { drmPlayable: false });
    await refused.service.reconcileUnrecordedAsset(VIDEO);
    await refused.service.sync(VIDEO);
    expect(refused.drmVerification.verify).toHaveBeenCalled();
    expect(row.status).not.toBe('READY');

    const row2 = videoRow();
    const ok = ingestService(row2, gumlet);
    await ok.service.reconcileUnrecordedAsset(VIDEO);
    expect(row2.status).toBe('PROCESSING');
    await ok.service.sync(VIDEO);
    expect(ok.drmVerification.verify).toHaveBeenCalledTimes(1);
    expect(row2.status).toBe('READY');
    expect(row2.drmVerifiedAt).toBeInstanceOf(Date);
    expect(ok.lessonVideos.propagateDurationToAttachedLessons).toHaveBeenCalledWith(VIDEO, 750);
  });
});

// ===========================================================================
// 6. Neon unavailable for several hours: the deferral policy
// ===========================================================================

describe('transient deferral policy', () => {
  const HOUR = 3600_000;
  const t0 = Date.parse('2026-11-20T12:14:00Z');

  it('6. carries a job through a 5.5 h database outage without using an attempt, with bounded growth', () => {
    let state: TransientDeferralState | null = null;
    let now = t0;
    const delays: number[] = [];
    while (now < t0 + 5.5 * HOUR) {
      const plan = planTransientDeferral(state, 'database', now, { random: () => 0.5 });
      expect(plan.exhausted).toBe(false);
      if (plan.exhausted) break;
      delays.push(plan.delayMs);
      state = plan.state;
      now += plan.delayMs;
    }
    const p = TRANSIENT_DEFERRAL_POLICIES.database;
    expect(delays[0]).toBeGreaterThanOrEqual(p.baseDelayMs / 2);
    expect(Math.max(...delays)).toBeLessThanOrEqual(p.maxDelayMs);
    // Exponential, capped: a 5.5 h outage costs about 40 retries, not thousands.
    expect(delays.length).toBeLessThan(50);
    expect(state?.count).toBe(delays.length);
  });

  it('6. is bounded: past the window the job falls back to its attempts (no infinite loop)', () => {
    const p = TRANSIENT_DEFERRAL_POLICIES.database;
    const state: TransientDeferralState = {
      kind: 'database',
      since: new Date(t0).toISOString(),
      last: new Date(t0 + p.maxWindowMs - 60_000).toISOString(),
      count: 70,
    };
    expect(planTransientDeferral(state, 'database', t0 + p.maxWindowMs).exhausted).toBe(true);
  });

  it('a new outage long after the last one starts a fresh window', () => {
    const old: TransientDeferralState = { kind: 'database', since: new Date(t0).toISOString(), last: new Date(t0).toISOString(), count: 40 };
    const plan = planTransientDeferral(old, 'database', t0 + 24 * HOUR, { random: () => 0 });
    expect(plan.exhausted).toBe(false);
    expect(plan.exhausted === false && plan.state.count).toBe(1);
  });

  it('jitter keeps every delay in [window/2, window]', () => {
    for (const r of [0, 0.25, 0.999]) {
      const plan = planTransientDeferral(null, 'database', t0, { random: () => r });
      expect(plan.exhausted === false && plan.delayMs).toBeGreaterThanOrEqual(15_000);
      expect(plan.exhausted === false && plan.delayMs).toBeLessThanOrEqual(30_000);
    }
  });
});

// ===========================================================================
// 6-7. The processors defer instead of spending attempts
// ===========================================================================

function bullJob<T>(name: string, data: T, over: Record<string, unknown> = {}) {
  const job = {
    id: `${name}:${VIDEO}:1`,
    name,
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
    updateData: jest.fn(async (d: T) => void (job.data = d)),
    moveToDelayed: jest.fn(async () => undefined),
    updateProgress: jest.fn(async () => undefined),
    ...over,
  };
  return job as unknown as {
    data: T & { transientDeferral?: TransientDeferralState };
    attemptsMade: number;
    moveToDelayed: jest.Mock;
    updateData: jest.Mock;
  };
}

function webProcessor(processFromJob: jest.Mock) {
  const videos = { markProcessing: jest.fn(async () => true), markFailed: jest.fn(async () => true), markReady: jest.fn() };
  const processor = new VideoProcessor(
    { run: jest.fn() } as never,
    videos as never,
    { processFromJob } as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
  );
  return { processor, videos };
}

describe('VideoProcessor: infrastructure failures are deferred, not counted', () => {
  const data = { videoId: VIDEO, sourceKey: SOURCE_KEY, ladder: [480, 720], encrypt: true };

  it('7. P1001 during the ingest: DelayedError, no attempt, row not marked FAILED', async () => {
    const t = webProcessor(jest.fn().mockRejectedValue(p1001()));
    const job = bullJob(VIDEO_JOBS.transcode, data);
    const before = Date.now();

    await expect(t.processor.process(job as never, 'tok')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'tok');
    const due = (job.moveToDelayed.mock.calls[0] as unknown as [number])[0];
    expect(due - before).toBeGreaterThanOrEqual(15_000);
    expect(job.data.transientDeferral).toMatchObject({ kind: 'database', count: 1 });
    expect(job.attemptsMade).toBe(0);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('7. P1001 again and again: the streak grows and stays bounded', async () => {
    const t = webProcessor(jest.fn().mockRejectedValue(p1001()));
    const job = bullJob(VIDEO_JOBS.transcode, data);
    for (let i = 0; i < 6; i += 1) {
      await expect(t.processor.process(job as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    }
    expect(job.data.transientDeferral?.count).toBe(6);
    expect(job.moveToDelayed).toHaveBeenCalledTimes(6);
  });

  it('6. after the window is used up, the attempt path takes over (as before the fix)', async () => {
    const err = p1001();
    const t = webProcessor(jest.fn().mockRejectedValue(err));
    const long = Date.now() - 13 * 3600_000;
    const job = bullJob(VIDEO_JOBS.transcode, {
      ...data,
      transientDeferral: { kind: 'database' as const, since: new Date(long).toISOString(), last: new Date(Date.now() - 60_000).toISOString(), count: 80 },
    });

    await expect(t.processor.process(job as never, 'tok')).rejects.toBe(err);
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('1. a lost Gumlet create answer is deferred for reconciliation, not failed (old behaviour: FAILED + no retry)', async () => {
    const t = webProcessor(jest.fn().mockRejectedValue(new GumletCreationOutcomeUnknownError([gumletVideoTag(VIDEO)], 'no answer')));
    const job = bullJob(VIDEO_JOBS.transcode, data);

    await expect(t.processor.process(job as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(job.data.transientDeferral).toMatchObject({ kind: 'gumlet-outcome-unknown' });
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('credentials refused (401) are NOT deferred: an operator must see them', () => {
    expect(transientKindOfWebFailure(new GumletRequestError('HTTP 401', true, 401))).toBeNull();
    expect(transientKindOfWebFailure(new GumletRequestError('HTTP 503', true, 503))).toBe('provider');
    expect(transientKindOfWebFailure(new Error('ffmpeg exited 1'))).toBeNull();
  });
});

function mobileProcessor() {
  const videos = {
    markMobileProcessing: jest.fn(async () => true),
    markMobileReady: jest.fn(async () => undefined),
    markMobileFailed: jest.fn(async () => undefined),
    markMobileRetrying: jest.fn(async () => undefined),
    markMobileDeferred: jest.fn(async () => undefined),
  };
  const transcoder = {
    preflight: jest.fn(async () => ({ sourceMissing: false, sourceBytes: 1, budgetBytes: 1, assessment: { ok: true, freeBytes: 1, reservedByOthers: 0, minFreeBytes: 0, shortfallBytes: 0 } })),
    run: jest.fn(async () => ({
      probe: { durationSeconds: 1056, width: 864, height: 480, frameRate: 30, videoCodec: 'h264', audioCodec: 'aac' },
      renditions: [{ height: 480, width: 864, bitrateKbps: 1200, playlistKey: `hls/${VIDEO}/480p/index.m3u8` }],
      hlsPrefix: `hls/${VIDEO}/`,
      masterPlaylistKey: `hls/${VIDEO}/master.m3u8`,
      isEncrypted: true,
      encryptionKeyId: `derived:v2:r1:${VIDEO}`,
    })),
  };
  const guard = {
    pauseState: jest.fn(async () => ({ paused: true, scope: 'historical', reason: null, by: null, at: null })),
    noteActive: jest.fn(),
    noteProgress: jest.fn(),
    noteFinished: jest.fn(),
    noteDeferred: jest.fn(),
  };
  const slot = { holder: 'h', release: jest.fn(async () => undefined) };
  const scheduler = { uploadPressure: jest.fn(), acquireEncodeSlot: jest.fn(async () => slot) };
  const processor = new MobileVideoProcessor(
    transcoder as never,
    videos as never,
    { getOrThrow: () => ({ workDir: '/tmp/edu-transcode' }) } as never,
    guard as never,
    scheduler as never,
  );
  (processor as unknown as { dbRetryDelaysMs: number[] }).dbRetryDelaysMs = [1, 1];
  return { processor, videos, transcoder, slot };
}

describe('MobileVideoProcessor: a database outage does not spend attempts or encodes', () => {
  const data = { videoId: VIDEO, sourceKey: SOURCE_KEY, ladder: [480], encrypt: true, trigger: 'upload' as const, durationSeconds: 1056 };

  it('7. the claim keeps failing with P1001: deferred before any encode, slot released, row untouched', async () => {
    const t = mobileProcessor();
    t.videos.markMobileProcessing.mockRejectedValue(p1001());
    const job = bullJob(MOBILE_VIDEO_JOBS.transcode, data);

    await expect(t.processor.process(job as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(t.transcoder.run).not.toHaveBeenCalled();
    expect(t.videos.markMobileRetrying).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
    expect(t.slot.release).toHaveBeenCalled();
    expect(job.data.transientDeferral).toMatchObject({ kind: 'database', count: 1 });
  });

  it('REGRESSION: "Unable to start a transaction" on the finish write is an outage, not a video failure', async () => {
    const t = mobileProcessor();
    const p2028 = new Prisma.PrismaClientKnownRequestError(
      'Transaction API error: Unable to start a transaction in the given time.',
      { code: 'P2028', clientVersion: 'test' },
    );
    t.videos.markMobileReady.mockRejectedValue(p2028);
    const job = bullJob(MOBILE_VIDEO_JOBS.transcode, data);

    await expect(t.processor.process(job as never, 'tok')).rejects.toBeInstanceOf(DelayedError);
    // Before the fix this called markMobileRetrying/markMobileFailed and spent an attempt.
    expect(t.videos.markMobileRetrying).not.toHaveBeenCalled();
    expect(t.videos.markMobileFailed).not.toHaveBeenCalled();
    expect(t.videos.markMobileReady).toHaveBeenCalledTimes(3); // in-place retries first
  });

  it('classifies P2028 narrowly', () => {
    const p = (message: string) => new Prisma.PrismaClientKnownRequestError(message, { code: 'P2028', clientVersion: 't' });
    expect(isTransientDatabaseError(p('Transaction API error: Unable to start a transaction in the given time.'))).toBe(true);
    expect(isTransientDatabaseError(p('Transaction API error: Transaction already closed: timeout.'))).toBe(false);
  });
});

// ===========================================================================
// 9. The recovery sweep reconciles instead of failing (no requeue, no duplicate)
// ===========================================================================

describe('recovery sweep: a Gumlet row with no recorded asset', () => {
  // The 19:00Z sweep: 3 h 18 min after the job started at 15:42:20Z.
  const now = new Date('2026-11-20T19:00:00Z');

  function sweep(row: Record<string, unknown>, gumletIngest: Record<string, jest.Mock>, jobState: string | null = 'failed') {
    const failed: string[] = [];
    const enqueued: unknown[] = [];
    const prisma = {
      video: {
        findMany: jest.fn(async (a: { where: { OR?: Array<Record<string, unknown>> } }) =>
          // Mobile sweep shares findMany; only the web query has a drmProvider clause.
          a.where.OR?.some((c) => 'drmProvider' in c) ? [row] : [],
        ),
        updateMany: jest.fn(async () => {
          failed.push(row.id as string);
          return { count: 1 };
        }),
      },
    };
    const queue = {
      add: jest.fn(async (j: unknown) => void enqueued.push(j)),
      getJob: jest.fn(async () => (jobState ? { getState: async () => jobState } : null)),
    };
    const service = new VideosService(
      prisma as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
      queue as never,
      { getOrThrow: () => ({ ladder: [480], encryptionEnabled: true }) } as never,
      {} as never,
      gumletIngest as never,
    );
    return { service, failed, enqueued };
  }

  const base = {
    id: VIDEO,
    status: 'PROCESSING',
    sourceKey: SOURCE_KEY,
    lessonId: 'l',
    courseId: 'c',
    processingJobId: `transcode:${VIDEO}:1795189216119`,
    processingStartedAt: new Date('2026-11-20T15:42:20Z'), // > 3 h before `now`
    drmProvider: 'gumlet',
    gumletAssetId: null,
  };

  it('9. REGRESSION cmwp0i2sx: finds the asset, records it, syncs it - never marks FAILED, never re-queues', async () => {
    const gi = { reconcileUnrecordedAsset: jest.fn(async () => ({ assetId: ASSET })), sync: jest.fn(async () => ({})) };
    const t = sweep(base, gi);

    const result = await t.service.recoverStrandedVideos(now);

    expect(gi.reconcileUnrecordedAsset).toHaveBeenCalledWith(VIDEO);
    expect(gi.sync).toHaveBeenCalledWith(VIDEO);
    expect(t.failed).toEqual([]);
    expect(t.enqueued).toEqual([]);
    expect(result.synced).toBe(1);
  });

  it('9. a job that is still alive (e.g. deferred) is left alone: no reconcile, no duplicate job', async () => {
    const gi = { reconcileUnrecordedAsset: jest.fn(), sync: jest.fn() };
    const t = sweep(base, gi, 'delayed');
    await t.service.recoverStrandedVideos(now);
    expect(gi.reconcileUnrecordedAsset).not.toHaveBeenCalled();
    expect(t.failed).toEqual([]);
    expect(t.enqueued).toEqual([]);
  });

  it('a lookup that cannot complete decides nothing (no FAILED during an outage)', async () => {
    const gi = { reconcileUnrecordedAsset: jest.fn(async () => { throw new Error('Gumlet asset lookup by tag failed: timed out'); }), sync: jest.fn() };
    const t = sweep(base, gi);
    await t.service.recoverStrandedVideos(now);
    expect(t.failed).toEqual([]);
  });

  it('nothing at Gumlet and younger than 3 h: left PROCESSING; older: the legacy rule applies (retryable FAILED)', async () => {
    const gi = { reconcileUnrecordedAsset: jest.fn(async () => null), sync: jest.fn() };
    const young = sweep({ ...base, processingStartedAt: new Date('2026-11-20T18:00:00Z') }, gi);
    await young.service.recoverStrandedVideos(now);
    expect(young.failed).toEqual([]);

    const old = sweep(base, gi);
    await old.service.recoverStrandedVideos(now);
    expect(old.failed).toEqual([VIDEO]);
  });
});
