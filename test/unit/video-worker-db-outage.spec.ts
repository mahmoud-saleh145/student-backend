import { Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UnrecoverableError, type Job } from 'bullmq';

import {
  describeDatabaseError,
  isTransientDatabaseError,
  withDatabaseRetry,
} from 'src/database/transient-db-error';
import { VIDEO_JOBS, type TranscodeJobData } from 'src/jobs/queue.constants';
import { databaseOperationTimeout } from 'src/database/bounded-operations';
import { VideoProcessor } from 'src/jobs/processors/video.processor';
import {
  GumletCreationOutcomeUnknownError,
  GumletDrmService,
  GumletRequestError,
} from 'src/modules/playback/gumlet-drm.service';
import {
  GumletAdoptionNotRecordedError,
  GumletIngestAbandonedError,
  GumletIngestService,
} from 'src/modules/videos/gumlet-ingest.service';
import { buildDrmVerification, fetchManifestViaGlobalFetch } from './helpers/drm-doubles';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn(async () => undefined),
  rm: jest.fn(async () => undefined),
  readdir: jest.fn(async () => [] as string[]),
  readFile: jest.fn(async () => Buffer.alloc(0)),
  stat: jest.fn(async () => ({ size: 10 })),
  writeFile: jest.fn(async () => undefined),
}));

/**
 * The PC-hosted video worker losing Neon in the middle of a Gumlet ingest.
 *
 * THE INCIDENT THIS REPRODUCES
 *
 * Video cmvpsko6v0216dg014ut9lw0v: Gumlet created asset 6adfcba970824baa596270c7
 * (`pre-queued`) and the row recorded it, then a Prisma call failed with
 * `P1001 Can't reach database server` at the Neon pooler.
 *
 * What the code did with that:
 *   - the poll loop counted the database error as a "Gumlet timeout" and gave
 *     up after five of them (~25 s), then made one more database write, which
 *     failed the same way and escaped;
 *   - the worker then called `markFailed`. With the database still down that
 *     threw and replaced the original error; once it came back, a video with a
 *     healthy asset was stamped FAILED, which the recovery sweep never revisits,
 *     with the raw Prisma text (naming the database host) as the reason;
 *   - and if the blip hit the write that records a NEW asset id, the retry
 *     found no id and created a second, separately billed asset.
 */

const ASSET = '6adfcba970824baa596270c7';
const DB_HOST = 'ep-example-pooler.c-5.eu-central-1.aws.neon.tech';

const unreachable = (method = 'findFirst') =>
  new Prisma.PrismaClientKnownRequestError(
    `Invalid \`prisma.video.${method}()\` invocation:\n\nCan't reach database server at \`${DB_HOST}:5432\``,
    { code: 'P1001', clientVersion: '6.0.0' },
  );

const DRM_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013">
  <Period id="0">
    <AdaptationSet contentType="video">
      <ContentProtection value="cbcs" schemeIdUri="urn:mpeg:dash:mp4protection:2011"
        cenc:default_KID="6fcf5dd7-7260-5a02-9d73-cd2cac0b573e"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/>
    </AdaptationSet>
  </Period>
</MPD>`;

function quietLogs() {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
}

/** Resolve every sleep at once, so backoffs are driven by call counts. */
function instantSleeps() {
  return jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as never);
}

// ---------------------------------------------------------------------------
// Classification and the retry helper
// ---------------------------------------------------------------------------

describe('isTransientDatabaseError', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])('treats %s as transient', (code) => {
    const e = new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '6.0.0' });
    expect(isTransientDatabaseError(e)).toBe(true);
  });

  it('treats an initialization failure to reach the server as transient', () => {
    expect(
      isTransientDatabaseError(new Prisma.PrismaClientInitializationError('x', '6.0.0', 'P1001')),
    ).toBe(true);
  });

  it('does NOT retry authentication, configuration or data errors', () => {
    expect(
      isTransientDatabaseError(new Prisma.PrismaClientInitializationError('auth', '6.0.0', 'P1000')),
    ).toBe(false);
    expect(isTransientDatabaseError(new Prisma.PrismaClientInitializationError('x', '6.0.0'))).toBe(false);
    for (const code of ['P2002', 'P2025', 'P2034']) {
      const e = new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: '6.0.0' });
      expect(isTransientDatabaseError(e)).toBe(false);
    }
  });

  it('does not claim provider or ordinary errors', () => {
    expect(isTransientDatabaseError(new Error("Can't reach database server"))).toBe(false);
    expect(isTransientDatabaseError(new GumletRequestError('timed out', true, null))).toBe(false);
  });

  it('describes an error without the database host', () => {
    const text = describeDatabaseError(unreachable());
    expect(text).toBe('database error P1001');
    expect(text).not.toContain(DB_HOST);
  });
});

describe('withDatabaseRetry', () => {
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };
  beforeEach(() => {
    sleeps.length = 0;
  });

  it('retries a transient failure and returns the eventual result', async () => {
    const op = jest
      .fn()
      .mockRejectedValueOnce(unreachable())
      .mockRejectedValueOnce(unreachable())
      .mockResolvedValue('ok');

    await expect(withDatabaseRetry(op, { sleep, random: () => 1 })).resolves.toBe('ok');
    expect(op).toHaveBeenCalledTimes(3);
    // Exponential windows, 500 then 1000 ms, at their upper bound here.
    expect(sleeps).toEqual([500, 1000]);
  });

  it('jitters inside the window and respects the ceiling', async () => {
    const op = jest.fn().mockRejectedValue(unreachable());
    await expect(
      withDatabaseRetry(op, { sleep, attempts: 6, baseDelayMs: 1000, maxDelayMs: 3000, random: () => 0.5 }),
    ).rejects.toThrow();
    expect(sleeps).toEqual([500, 1000, 1500, 1500, 1500]);
  });

  it('is bounded, and rethrows the ORIGINAL error when it gives up', async () => {
    const original = unreachable();
    const op = jest.fn().mockRejectedValue(original);

    await expect(withDatabaseRetry(op, { sleep, attempts: 4 })).rejects.toBe(original);
    expect(op).toHaveBeenCalledTimes(4);
  });

  it('never retries a permanent error', async () => {
    const op = jest
      .fn()
      .mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('not found', { code: 'P2025', clientVersion: '6.0.0' }),
      );
    await expect(withDatabaseRetry(op, { sleep })).rejects.toThrow('not found');
    expect(op).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The ingest flow
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function ingestHarness(opts: { reads?: () => boolean; writes?: () => boolean } = {}) {
  // `reads()` / `writes()` return true when THIS call should fail with P1001.
  const failRead = { fn: opts.reads ?? (() => false) };
  const failWrite = { fn: opts.writes ?? (() => false) };

  const row: Row = {
    id: 'v1',
    lessonId: null,
    courseId: 'c1',
    sourceKey: 'key',
    sourceMimeType: 'video/mp4',
    sourceSizeBytes: 100,
    status: 'PROCESSING',
    drmProvider: 'gumlet',
    drmRequested: false,
    drmVerifiedAt: null,
    drmBlockedReason: null,
    gumletAssetId: null,
    gumletWorkspaceId: null,
    gumletStatus: null,
    gumletError: null,
    width: null,
    height: null,
    frameRate: null,
    lesson: { title: 'Sheet 1 part 1' },
  };
  const writes: Row[] = [];

  const prisma = {
    video: {
      findFirst: jest.fn(async () => {
        if (failRead.fn()) throw unreachable('findFirst');
        return { ...row };
      }),
      findUniqueOrThrow: jest.fn(async () => {
        if (failRead.fn()) throw unreachable('findUniqueOrThrow');
        return { status: row.status };
      }),
      update: jest.fn(async (a: { data: Row }) => {
        if (failWrite.fn()) throw unreachable('update');
        writes.push(a.data);
        Object.assign(row, a.data);
        return { ...row };
      }),
      updateMany: jest.fn(async (a: { where?: Row; data: Row }) => {
        if (failWrite.fn()) throw unreachable('updateMany');
        if (a.where?.gumletAssetId !== undefined && a.where.gumletAssetId !== row.gumletAssetId) {
          return { count: 0 };
        }
        // The status guards the conditional writes rely on.
        const status = a.where?.status as { not?: string; in?: string[] } | undefined;
        if (status?.not !== undefined && row.status === status.not) return { count: 0 };
        if (status?.in !== undefined && !status.in.includes(row.status as string)) return { count: 0 };
        writes.push(a.data);
        Object.assign(row, a.data);
        return { count: 1 };
      }),
    },
  };

  let assetStatus = 'pre-queued';
  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    fetchManifest: jest.fn(fetchManifestViaGlobalFetch),
    assetHasDrm: (t: string) =>
      /urn:mpeg:dash:mp4protection:2011/.test(t) && /cenc:default_KID=/.test(t),
    createAsset: jest.fn(async () => ({ assetId: ASSET, status: 'pre-queued', playbackUrl: null })),
    getAsset: jest.fn(async () => {
      // Gumlet moves on by itself: first poll processing, then ready.
      const status = assetStatus;
      assetStatus = 'ready';
      return {
        assetId: ASSET,
        status,
        progress: status === 'ready' ? 100 : 10,
        playbackUrl: null,
        dashPlaybackUrl: null,
        error: null,
        errorCode: null,
        durationSeconds: status === 'ready' ? 600 : null,
        width: null,
        height: null,
        frameRate: null,
        drmSystems: null,
      };
    }),
    dashManifestUrl: ({ assetId }: { assetId: string }) => `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };

  const drmVerification = buildDrmVerification({
    prisma: prisma as never,
    gumlet: gumlet as never,
    enabled: true,
    provider: 'gumlet',
    signingConfigured: true,
  });

  const service = new GumletIngestService(
    prisma as never,
    {
      presignIngestionUrl: jest.fn(async () => 'https://r2.example/ingest?X-Amz-Signature=REDACTED'),
      exists: jest.fn(async () => true),
      isConfigured: true,
    } as never,
    gumlet as never,
    drmVerification as never,
    {
      getOrThrow: () => ({ drm: { enabled: true, provider: 'gumlet', gumlet: { workspaceId: 'ws' } } }),
    } as never,
    { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) } as never,
  );

  return { service, row, writes, prisma, gumlet, failRead, failWrite };
}

describe('Gumlet ingest survives the database dropping out', () => {
  let sleep: jest.SpyInstance;
  beforeEach(() => {
    quietLogs();
    sleep = instantSleeps();
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => DRM_MANIFEST } as never);
  });
  afterEach(() => {
    sleep.mockRestore();
    jest.restoreAllMocks();
  });

  it('REPRODUCTION: a P1001 blip after adoption is waited out, not counted as a Gumlet timeout', async () => {
    // Five consecutive failures used to end the poll. Make it five.
    let blips = 0;
    const t = ingestHarness({
      reads: () => t.row.gumletAssetId !== null && blips < 5 && ++blips > 0,
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res).toEqual({ handled: true, status: 'ready', playable: true });
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    expect(t.row.gumletAssetId).toBe(ASSET);
    expect(t.row.status).toBe('READY');
    expect(t.writes.some((w) => w.status === 'FAILED')).toBe(false);
  });

  it('hands a long outage back to the queue with the database error, writing nothing', async () => {
    let down = false;
    const t = ingestHarness({ reads: () => down, writes: () => down });
    t.gumlet.createAsset.mockImplementation(async () => {
      down = true; // the database goes away right after the asset is recorded
      return { assetId: ASSET, status: 'pre-queued', playbackUrl: null };
    });
    // createAsset runs BEFORE markAdopted, so let the adoption write through.
    // (markAdopted is a conditional updateMany: it never replaces another asset.)
    const realUpdateMany = t.prisma.video.updateMany.getMockImplementation()!;
    let adopted = false;
    t.prisma.video.updateMany.mockImplementation(async (a: { where?: Row; data: Row }) => {
      if (!adopted && a.data.gumletAssetId === ASSET) {
        adopted = true;
        down = false;
        const r = await realUpdateMany(a);
        down = true;
        return r;
      }
      return realUpdateMany(a);
    });

    const error = await t.service.processFromJob('v1', 'key').catch((e: unknown) => e);

    expect(isTransientDatabaseError(error)).toBe(true);
    expect(t.row.gumletAssetId).toBe(ASSET);
    expect(t.row.status).toBe('PROCESSING');
    expect(t.writes.some((w) => w.status === 'FAILED')).toBe(false);
  });

  it('a retry after the outage RESUMES the recorded asset instead of creating another', async () => {
    const t = ingestHarness();
    Object.assign(t.row, {
      gumletAssetId: ASSET,
      gumletWorkspaceId: 'ws',
      gumletStatus: 'pre-queued',
      drmRequested: true,
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res.playable).toBe(true);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
    expect(t.row.gumletAssetId).toBe(ASSET);
  });

  it('retries the write that records a new asset id, so one blip cannot orphan it', async () => {
    let failures = 0;
    const t = ingestHarness({ writes: () => failures < 2 && ++failures > 0 });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res.playable).toBe(true);
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    expect(t.row.gumletAssetId).toBe(ASSET);
  });

  it('stops WITHOUT retry, naming the asset, when the new asset id cannot be recorded', async () => {
    let assetCreated = false;
    const t = ingestHarness({ writes: () => assetCreated });
    t.gumlet.createAsset.mockImplementation(async () => {
      assetCreated = true;
      return { assetId: ASSET, status: 'pre-queued', playbackUrl: null };
    });

    const error = await t.service.processFromJob('v1', 'key').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GumletAdoptionNotRecordedError);
    expect((error as GumletAdoptionNotRecordedError).assetId).toBe(ASSET);
    expect((error as Error).message).toContain(ASSET);
    expect((error as Error).message).not.toContain(DB_HOST);
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    // Not misread as a provider refusal: nothing was written as FAILED.
    expect(t.writes.some((w) => w.status === 'FAILED')).toBe(false);
  });

  it('a database failure before anything was created is simply re-thrown', async () => {
    const t = ingestHarness({ reads: () => true });

    const error = await t.service.processFromJob('v1', 'key').catch((e: unknown) => e);

    expect(isTransientDatabaseError(error)).toBe(true);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2026-11-11: the connection that drops silently
// ---------------------------------------------------------------------------

/** Lets pending promise callbacks run (setTimeout is mocked to run instantly). */
const flush = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
};

describe('a Neon connection drop during Gumlet polling (bounded operations, P1008)', () => {
  let sleep: jest.SpyInstance;
  beforeEach(() => {
    quietLogs();
    sleep = instantSleeps();
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => DRM_MANIFEST } as never);
  });
  afterEach(() => {
    sleep.mockRestore();
    jest.restoreAllMocks();
  });

  // In production the poll's query never settled. The worker now races each
  // operation against DATABASE_OPERATION_TIMEOUT_MS and turns the loser into
  // this error - so the poll sees exactly what a bounded hang produces.
  const hung = () => {
    throw databaseOperationTimeout('Video.findFirst', 60_000);
  };

  it('a few hung polls are waited out: one asset, READY, nothing marked FAILED', async () => {
    let drops = 0;
    const t = ingestHarness({ reads: () => t.row.gumletAssetId !== null && drops < 3 && ++drops > 0 });
    t.prisma.video.findFirst.mockImplementation(async () => {
      if (t.failRead.fn()) hung();
      return { ...t.row };
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(drops).toBe(3);
    expect(res).toEqual({ handled: true, status: 'ready', playable: true });
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    expect(t.row.status).toBe('READY');
    expect(t.writes.some((w) => w.status === 'FAILED')).toBe(false);
  });

  it('a long drop hands the job back; the retry REUSES the recorded asset (no second asset)', async () => {
    let down = false;
    const t = ingestHarness({ reads: () => down });
    t.prisma.video.findFirst.mockImplementation(async () => {
      if (t.failRead.fn()) hung();
      return { ...t.row };
    });
    t.prisma.video.findUniqueOrThrow.mockImplementation(async () => {
      if (t.failRead.fn()) hung();
      return { status: t.row.status };
    });
    // The connection dies right after the row records the new asset: every
    // poll after that hangs.
    const realUpdateMany = t.prisma.video.updateMany.getMockImplementation()!;
    t.prisma.video.updateMany.mockImplementation(async (a: { where?: Row; data: Row }) => {
      const r = await realUpdateMany(a);
      if (a.data.gumletAssetId === ASSET) down = true;
      return r;
    });

    const first = await t.service.processFromJob('v1', 'key').catch((e: unknown) => e);
    expect(isTransientDatabaseError(first)).toBe(true);
    expect(t.row.gumletAssetId).toBe(ASSET);
    expect(t.row.status).toBe('PROCESSING');

    // The queue's retry, after Neon is back.
    down = false;
    const second = await t.service.processFromJob('v1', 'key');

    expect(second.playable).toBe(true);
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    expect(t.row.gumletAssetId).toBe(ASSET);
    expect(t.row.status).toBe('READY');
  });
});

describe('an ingest abandoned at the job deadline writes nothing', () => {
  let sleep: jest.SpyInstance;
  beforeEach(() => {
    quietLogs();
    sleep = instantSleeps();
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => DRM_MANIFEST } as never);
  });
  afterEach(() => {
    sleep.mockRestore();
    jest.restoreAllMocks();
  });

  it('a poll that resumes after the abort neither verifies nor writes', async () => {
    const t = ingestHarness();
    Object.assign(t.row, { gumletAssetId: ASSET, gumletWorkspaceId: 'ws', gumletStatus: 'pre-queued' });

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    t.gumlet.getAsset.mockImplementation(async () => {
      await gate; // the provider (or the database before it) is stuck
      // ...and when it answers, the asset is READY: the one answer that would
      // otherwise run the DRM verification and write READY.
      return {
        assetId: ASSET, status: 'ready', progress: 100, playbackUrl: null, dashPlaybackUrl: null,
        error: null, errorCode: null, durationSeconds: 600, width: null, height: null, frameRate: null, drmSystems: null,
      };
    });

    const controller = new AbortController();
    const outcome = t.service.processFromJob('v1', 'key', { signal: controller.signal }).catch((e: unknown) => e);
    await flush();
    const writesBefore = t.writes.length;

    controller.abort(); // the worker's deadline gave up on this call
    release();

    expect(await outcome).toBeInstanceOf(GumletIngestAbandonedError);
    expect(t.writes.length).toBe(writesBefore);
    expect(global.fetch).not.toHaveBeenCalled(); // no DRM verification either
    expect(t.row.status).toBe('PROCESSING');
  });

  it('an abort before the asset exists means no asset is ever created', async () => {
    const t = ingestHarness();
    // processFromJob's own read is answered; adopt()'s read hangs.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let reads = 0;
    t.prisma.video.findFirst.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) await gate;
      return { ...t.row };
    });

    const controller = new AbortController();
    const outcome = t.service.processFromJob('v1', 'key', { signal: controller.signal }).catch((e: unknown) => e);
    await flush();
    controller.abort();
    release();

    expect(await outcome).toBeInstanceOf(GumletIngestAbandonedError);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
    expect(t.writes).toEqual([]);
  });
});

describe('a READY video is protected from stale PROCESSING writes', () => {
  let sleep: jest.SpyInstance;
  beforeEach(() => {
    quietLogs();
    sleep = instantSleeps();
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => DRM_MANIFEST } as never);
  });
  afterEach(() => {
    sleep.mockRestore();
    jest.restoreAllMocks();
  });

  it('a stale "processing" observation of a READY video changes nothing', async () => {
    const t = ingestHarness();
    Object.assign(t.row, { gumletAssetId: ASSET, gumletWorkspaceId: 'ws', status: 'READY', gumletStatus: 'ready' });
    t.gumlet.getAsset.mockImplementation(async () => ({
      assetId: ASSET, status: 'processing', progress: 50, playbackUrl: null, dashPlaybackUrl: null,
      error: null, errorCode: null, durationSeconds: null, width: null, height: null, frameRate: null, drmSystems: null,
    }));

    await t.service.sync('v1');

    expect(t.row.status).toBe('READY');
    expect(t.row.gumletStatus).toBe('ready');
    expect(t.writes).toEqual([]);
  });

  it('a poll that runs out its budget after the sweep made the video READY leaves it READY', async () => {
    const t = ingestHarness();
    Object.assign(t.row, { gumletAssetId: ASSET, gumletWorkspaceId: 'ws', gumletStatus: 'pre-queued' });
    t.gumlet.getAsset.mockImplementation(async () => ({
      assetId: ASSET, status: 'processing', progress: 50, playbackUrl: null, dashPlaybackUrl: null,
      error: null, errorCode: null, durationSeconds: null, width: null, height: null, frameRate: null, drmSystems: null,
    }));
    // Each clock read moves time 5 minutes, so the 20-minute budget runs out.
    // At the very moment it does - after the last poll, before the "still
    // processing" write - the recovery sweep verifies the asset and makes the
    // video READY. (Any earlier and the poll itself would see READY and stop.)
    const start = Date.now();
    let clock = start;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      clock += 5 * 60_000;
      if (clock >= start + 25 * 60_000) t.row.status = 'READY';
      return clock;
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res.playable).toBeFalsy();
    expect(t.gumlet.getAsset).toHaveBeenCalled();
    expect(t.row.status).toBe('READY');
    // The budget-exhausted write ("still PROCESSING") was conditional and skipped.
    expect(t.writes.some((w) => w.status === 'PROCESSING')).toBe(false);
  });
});

describe('no duplicate Gumlet asset', () => {
  let sleep: jest.SpyInstance;
  beforeEach(() => {
    quietLogs();
    sleep = instantSleeps();
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => DRM_MANIFEST } as never);
  });
  afterEach(() => {
    sleep.mockRestore();
    jest.restoreAllMocks();
  });

  it('an existing asset is reused on recovery, even when the row is FAILED', async () => {
    const t = ingestHarness();
    Object.assign(t.row, {
      gumletAssetId: ASSET,
      gumletWorkspaceId: 'ws',
      status: 'FAILED',
      gumletStatus: 'processing',
      drmRequested: true,
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res.playable).toBe(true);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
    expect(t.row.gumletAssetId).toBe(ASSET);
  });

  it('a late adoption never overwrites an asset another run already recorded', async () => {
    const t = ingestHarness();
    t.gumlet.createAsset.mockImplementation(async () => {
      t.row.gumletAssetId = 'asset-recorded-by-the-newer-run';
      return { assetId: ASSET, status: 'pre-queued', playbackUrl: null };
    });

    const error = await t.service.processFromJob('v1', 'key').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GumletAdoptionNotRecordedError);
    expect((error as Error).message).toContain(ASSET);
    expect(t.row.gumletAssetId).toBe('asset-recorded-by-the-newer-run');
  });

  it('a create request without an answer is reported as an unknown outcome, never as a refusal', async () => {
    const t = ingestHarness();
    t.gumlet.createAsset.mockRejectedValue(new GumletCreationOutcomeUnknownError(['edu-video:v1'], 'no answer'));

    const error = await t.service.processFromJob('v1', 'key').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GumletCreationOutcomeUnknownError);
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    expect(t.writes.some((w) => w.status === 'FAILED')).toBe(false);
  });
});

describe('GumletDrmService.createAsset without an answer', () => {
  const service = () =>
    new GumletDrmService({
      getOrThrow: () => ({
        drm: { enabled: true, provider: 'gumlet', gumlet: { apiKey: 'k', workspaceId: 'ws', resolutions: [720] } },
      }),
    } as never);
  beforeEach(quietLogs);
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ['a timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['a dropped connection', new TypeError('fetch failed')],
  ])('turns %s into GumletCreationOutcomeUnknownError naming the tag, and sends one request', async (_, cause) => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(cause);

    const error = await service()
      .createAsset({ sourceUrl: 'https://r2.example/x', tag: ['edu-video:v1'] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GumletCreationOutcomeUnknownError);
    expect((error as Error).message).toContain('edu-video:v1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(AbortSignal);
  });

  it('a success status whose body never arrives is an unknown outcome too (Gumlet accepted it)', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => {
        throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
      },
    } as never);

    const error = await service()
      .createAsset({ sourceUrl: 'https://r2.example/x', tag: ['edu-video:v1'] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GumletCreationOutcomeUnknownError);
  });

  it('a request that provably never left (DNS, refused) stays an ordinary retryable blip', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }));

    const error = await service()
      .createAsset({ sourceUrl: 'https://r2.example/x', tag: ['edu-video:v1'] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GumletRequestError);
    expect((error as GumletRequestError).transient).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

function processorHarness(processFromJob: jest.Mock, markProcessing?: jest.Mock) {
  const videos = {
    markProcessing: markProcessing ?? jest.fn(async () => true),
    markReady: jest.fn(async () => undefined),
    markFailed: jest.fn(async () => undefined),
  };
  const processor = new VideoProcessor(
    { putObject: jest.fn(), putFile: jest.fn(), downloadToFile: jest.fn() } as never,
    videos as never,
    { processFromJob } as never,
    {
      getOrThrow: () => ({
        workDir: '/tmp/work',
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        keyRoot: 'k',
        segmentSeconds: 4,
      }),
    } as never,
  );
  const job = {
    name: VIDEO_JOBS.transcode,
    id: 'transcode:v1:1',
    attemptsMade: 0,
    opts: { attempts: 2 },
    data: { videoId: 'v1', sourceKey: 'key', lessonId: null, courseId: 'c1', ladder: [720], encrypt: true },
    updateProgress: jest.fn(async () => undefined),
  } as unknown as Job<TranscodeJobData>;
  return { processor, videos, job };
}

describe('VideoProcessor on database errors', () => {
  beforeEach(quietLogs);
  afterEach(() => jest.restoreAllMocks());

  it('does NOT mark the video FAILED when the database is unreachable, and lets BullMQ retry', async () => {
    const original = unreachable();
    const t = processorHarness(jest.fn().mockRejectedValue(original));

    await expect(t.processor.process(t.job)).rejects.toBe(original);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('treats a failed claim (markProcessing) the same way', async () => {
    const original = unreachable('updateMany');
    const t = processorHarness(jest.fn(), jest.fn().mockRejectedValue(original));

    await expect(t.processor.process(t.job)).rejects.toBe(original);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('stops retries when an asset exists that the database could not record', async () => {
    const t = processorHarness(
      jest.fn().mockRejectedValue(new GumletAdoptionNotRecordedError('v1', ASSET, unreachable('update'))),
    );

    const error = await t.processor.process(t.job).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnrecoverableError);
    expect((error as Error).message).toContain(ASSET);
    expect(t.videos.markFailed).not.toHaveBeenCalled();
  });

  it('still marks a genuine failure FAILED', async () => {
    const t = processorHarness(jest.fn().mockRejectedValue(new Error('ffprobe exited with 1')));

    await expect(t.processor.process(t.job)).rejects.toThrow('ffprobe exited with 1');
    expect(t.videos.markFailed).toHaveBeenCalledWith('v1', 'ffprobe exited with 1');
  });

  it('keeps the ORIGINAL error when recording the failure itself fails', async () => {
    const t = processorHarness(jest.fn().mockRejectedValue(new Error('source decode failed')));
    t.videos.markFailed.mockRejectedValue(unreachable('update'));

    await expect(t.processor.process(t.job)).rejects.toThrow('source decode failed');
    expect(t.videos.markFailed).toHaveBeenCalledTimes(1);
  });
});
