import { Logger } from '@nestjs/common';

import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';
import { GumletRequestError } from 'src/modules/playback/gumlet-drm.service';
import { buildDrmVerification, fetchManifestViaGlobalFetch } from './helpers/drm-doubles';

/**
 * Poll resilience for Gumlet ingestion.
 *
 * THREE PRODUCTION DEFECTS THESE PIN DOWN
 *
 * 1. A false claim. `sync()` wrote "the DASH manifest is not CENC-encrypted"
 *    whenever `verdict.playable` was false. On a process that is not configured
 *    for Gumlet DRM, `DrmVerificationService.verify()` returns from its
 *    platform precheck (drm-verification.service.ts:383) WITHOUT ever reaching
 *    `fetchManifest()`. So the packaged media was never read, and the row was
 *    stamped with a confident statement about media nobody had looked at. Two
 *    healthy, fully CENC-encrypted assets carried that text.
 *
 * 2. One blip discarded the whole budget. `timedFetch` aborts after
 *    GUMLET_HTTP_TIMEOUT_MS (5 s) and `sync()` lets that throw escape, so a
 *    single timeout failed the job outright. Two production jobs died that way
 *    while their assets were already `ready`.
 *
 * 3. A 20-minute busy loop. For a `ready` asset that stayed unplayable, NEITHER
 *    exit condition matched, so the loop spun to the end of its budget - one
 *    database write and one ERROR log every ~6 seconds, per video.
 *
 * The fail-closed posture is unchanged throughout: nothing here ever marks a
 * video playable without a real CENC check of the real manifest.
 */

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

const PLAIN_MANIFEST = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"><Period id="0"></Period></MPD>`;

/**
 * A row already adopted for Gumlet, as `processFromJob` expects to find it.
 *
 * The DRM fields are not decoration: `verify()` reads this same row through the
 * shared Prisma stub, and at drm-verification.service.ts:480 it refuses with
 * DRM_NOT_REQUESTED unless `drmRequested` is set (or the provider reports
 * Widevine). Leaving it undefined makes an otherwise-perfect asset fail for a
 * reason that has nothing to do with what is under test.
 */
function baseRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'v1',
    lessonId: null,
    courseId: 'c1',
    // `processFromJob` refuses a job whose stored source no longer matches the
    // one it was handed, so the row must carry the same key the tests pass in -
    // otherwise every loop test exits at that guard instead of reaching the poll.
    sourceKey: 'key',
    status: 'PROCESSING',
    drmProvider: 'gumlet',
    drmRequested: true,
    drmVerifiedAt: null,
    drmBlockedReason: null,
    gumletAssetId: 'a1',
    gumletWorkspaceId: 'ws',
    gumletStatus: 'ready',
    width: null,
    height: null,
    frameRate: null,
    ...over,
  };
}

function harness(opts: {
  /** False models DRM_ENABLED=false / provider!=gumlet / signing missing. */
  platformUsable?: boolean;
  assetStatus?: string;
} = {}) {
  const platformUsable = opts.platformUsable ?? true;
  const updates: Record<string, unknown>[] = [];
  const row = baseRow();

  const prisma = {
    video: {
      findFirst: jest.fn(async () => ({ ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ status: updates.at(-1)?.status ?? row.status })),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        Object.assign(row, a.data);
        return row;
      }),
      // verify() writes through updateMany with a conditional `where`, so a
      // stub returning {count: 0} would read as "lost the race".
      updateMany: jest.fn(async (a: { data: Record<string, unknown> }) => {
        updates.push(a.data);
        Object.assign(row, a.data);
        return { count: 1 };
      }),
    },
  };

  const getAsset = jest.fn(async () => ({
    assetId: 'a1',
    status: opts.assetStatus ?? 'ready',
    progress: 100,
    playbackUrl: null,
    dashPlaybackUrl: null,
    error: null,
    durationSeconds: 600,
    width: null,
    height: null,
    frameRate: null,
    drmSystems: null,
  }));
  const fetchManifest = jest.fn(fetchManifestViaGlobalFetch);

  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => platformUsable,
    isAssetPlayable: (s: string) => s === 'ready',
    fetchManifest,
    assetHasDrm: (t: string) =>
      /urn:mpeg:dash:mp4protection:2011/.test(t) && /cenc:default_KID=/.test(t),
    getAsset,
    dashManifestUrl: ({ assetId }: { assetId: string }) =>
      `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };

  // A REAL DrmVerificationService, so `isPlatformUsable()` and the early return
  // under test are the production ones rather than a stubbed answer.
  const drmVerification = buildDrmVerification({
    prisma: prisma as never,
    gumlet: gumlet as never,
    enabled: platformUsable,
    provider: platformUsable ? 'gumlet' : 'none',
    signingConfigured: platformUsable,
  });

  const service = new GumletIngestService(
    prisma as never,
    { exists: jest.fn(async () => true), isConfigured: true } as never,
    gumlet as never,
    drmVerification as never,
    {
      getOrThrow: () => ({
        drm: {
          enabled: platformUsable,
          provider: platformUsable ? 'gumlet' : 'none',
          gumlet: { workspaceId: 'ws' },
        },
      }),
    } as never,
    { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) } as never,
  );

  return { service, updates, gumlet, getAsset, fetchManifest, drmVerification };
}

/** Resolve the poll `sleep` immediately so the loop is driven by call counts. */
function instantSleeps() {
  return jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as never);
}

/**
 * Make `Date.now()` advance, so the 20-minute poll budget is actually reachable
 * in a test. Without this, instant sleeps would make a non-terminating loop spin
 * forever; with it, the loop ends at the budget exactly as it does in production.
 */
function advancingClock(stepMs = 5000) {
  let t = Date.parse('2026-10-13T00:00:00.000Z');
  return jest.spyOn(Date, 'now').mockImplementation(() => (t += stepMs));
}

describe('gumletError reports the cause it actually observed', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does NOT claim an unencrypted manifest when this process never read one', async () => {
    const t = harness({ platformUsable: false });
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, text: async () => DRM_MANIFEST } as never);

    const res = await t.service.sync('v1');

    expect(res.playable).toBe(false);

    // The decisive assertion. sync() reads the asset itself to learn its status,
    // so getAsset IS called once - but the MANIFEST is never fetched, because
    // verify() returns at its platform precheck first. Nothing about the
    // packaged media may therefore be asserted in the row.
    expect(t.fetchManifest).not.toHaveBeenCalled();

    const written = t.updates.at(-1);
    expect(String(written?.gumletError)).not.toMatch(/not CENC-encrypted/i);
    expect(String(written?.gumletError)).toMatch(/could not be established|not configured/i);
  });

  it('DOES report an unencrypted manifest when this process could read one', async () => {
    const t = harness({ platformUsable: true });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => PLAIN_MANIFEST } as never);

    const res = await t.service.sync('v1');

    expect(res.playable).toBe(false);
    expect(t.fetchManifest).toHaveBeenCalled();
    expect(t.updates.at(-1)?.status).toBe('FAILED');
    expect(String(t.updates.at(-1)?.gumletError)).toMatch(/not CENC-encrypted/i);
  });

  it('still marks READY when the platform is usable and the manifest is encrypted', async () => {
    const t = harness({ platformUsable: true });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => DRM_MANIFEST } as never);

    const res = await t.service.sync('v1');

    expect(res.playable).toBe(true);
    expect(t.updates.at(-1)?.status).toBe('READY');
    expect(t.updates.at(-1)?.gumletError).toBeNull();
  });

  it('keeps FAILED for an unverifiable asset on the Gumlet path (documented, unchanged)', async () => {
    // The status semantics are deliberately NOT changed by this fix - see the
    // KNOWN AMBIGUITY block in processFromJob(). This pins the current behaviour
    // so that changing it later is a visible, tested edit rather than a drift.
    const t = harness({ platformUsable: false });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => DRM_MANIFEST } as never);

    await t.service.sync('v1');

    expect(t.updates.at(-1)?.status).toBe('FAILED');
  });

  it('never marks a ready asset playable without a real CENC check', async () => {
    // Belt and braces: whatever the poll loop decides, sync() is the only writer
    // of READY and it only does so behind assetHasDrm() on a fetched manifest.
    const t = harness({ platformUsable: true });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => PLAIN_MANIFEST } as never);

    const res = await t.service.sync('v1');

    expect(res.playable).toBe(false);
    expect(t.updates.every((u) => u.status !== 'READY')).toBe(true);
  });
});

describe('processFromJob tolerates transient Gumlet timeouts', () => {
  let sleep: jest.SpyInstance;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    sleep = instantSleeps();
    clock = advancingClock();
  });
  afterEach(() => {
    sleep.mockRestore();
    clock.mockRestore();
    jest.restoreAllMocks();
  });

  const stubAdopt = (service: GumletIngestService) =>
    jest.spyOn(service, 'adopt').mockResolvedValue({ assetId: 'a1', status: 'pre-queued' });

  const timeout = () =>
    new GumletRequestError('Gumlet asset lookup failed: timed out after 5000 ms', true, null);

  it('survives transient timeouts and still succeeds', async () => {
    const t = harness();
    stubAdopt(t.service);
    const sync = jest
      .spyOn(t.service, 'sync')
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockRejectedValueOnce(timeout())
      .mockResolvedValue({ assetId: 'a1', status: 'ready', playable: true });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res).toEqual({ handled: true, status: 'ready', playable: true });
    expect(sync).toHaveBeenCalledTimes(5);
  });

  it('gives up after 5 consecutive timeouts instead of spinning forever', async () => {
    const t = harness();
    stubAdopt(t.service);
    const sync = jest.spyOn(t.service, 'sync').mockRejectedValue(timeout());

    // Must not throw: a provider outage hands the video back for the recovery
    // sweep. And it must be bounded, not an unbounded retry.
    await expect(t.service.processFromJob('v1', 'key')).resolves.toEqual({
      handled: true,
      status: 'unknown',
      playable: false,
    });
    expect(sync).toHaveBeenCalledTimes(5);
  });

  it('resets the streak after a success, so blips are not cumulative', async () => {
    const t = harness();
    stubAdopt(t.service);

    // Four timeouts, one good read, then four MORE timeouts. With the streak
    // reset the run survives all ten; without the reset the streak would carry
    // the first four forward, reach 5 partway through the second run, and bail
    // out having never seen the asset become playable.
    const steps = [
      'timeout', 'timeout', 'timeout', 'timeout', 'processing',
      'timeout', 'timeout', 'timeout', 'timeout', 'ready',
    ];
    let i = 0;
    const sync = jest.spyOn(t.service, 'sync').mockImplementation(async () => {
      const step = steps[i++];
      if (step === 'timeout') throw timeout();
      return {
        assetId: 'a1',
        status: step,
        playable: step === 'ready',
      };
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res.playable).toBe(true);
    expect(sync).toHaveBeenCalledTimes(steps.length);
  });

  it('still fails immediately on a DEFINITIVE provider error', async () => {
    const t = harness();
    stubAdopt(t.service);
    const sync = jest
      .spyOn(t.service, 'sync')
      .mockRejectedValue(
        new GumletRequestError('Gumlet asset lookup failed with HTTP 404', false, 404),
      );

    await expect(t.service.processFromJob('v1', 'key')).rejects.toThrow(/404/);
    // A definitive answer is not retried at all.
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe('processFromJob stops spinning on a ready-but-unplayable asset', () => {
  let sleep: jest.SpyInstance;
  let clock: jest.SpyInstance;
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    sleep = instantSleeps();
    clock = advancingClock();
  });
  afterEach(() => {
    sleep.mockRestore();
    clock.mockRestore();
    jest.restoreAllMocks();
  });

  it('returns after ONE poll when the platform is genuinely DRM-capable', async () => {
    const t = harness({ platformUsable: true });
    jest.spyOn(t.service, 'adopt').mockResolvedValue({ assetId: 'a1', status: 'pre-queued' });
    // Unencrypted manifest => sync() reports ready + not playable. Only a
    // DRM-capable process is entitled to treat that as final.
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => PLAIN_MANIFEST } as never);

    let iterations = 0;
    const realSync = t.service.sync.bind(t.service);
    jest.spyOn(t.service, 'sync').mockImplementation(async (id: string) => {
      iterations += 1;
      return realSync(id);
    });

    const res = await t.service.processFromJob('v1', 'key');

    expect(res).toEqual({ handled: true, status: 'ready', playable: false });
    // Before this change the loop ran to the end of the 20-minute budget,
    // re-reading the provider every ~6 s.
    expect(iterations).toBe(1);
    expect(t.updates.at(-1)?.status).toBe('FAILED');
  });

  it('does NOT exit early when this process cannot judge the media', async () => {
    const t = harness({ platformUsable: false });
    jest.spyOn(t.service, 'adopt').mockResolvedValue({ assetId: 'a1', status: 'pre-queued' });
    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, text: async () => DRM_MANIFEST } as never);

    let iterations = 0;
    const realSync = t.service.sync.bind(t.service);
    jest.spyOn(t.service, 'sync').mockImplementation(async (id: string) => {
      iterations += 1;
      return realSync(id);
    });

    // The terminal condition is gated on isPlatformUsable(). Here the verdict is
    // not the process's to give, so the loop must keep going and end on the
    // budget instead - which the advancing clock makes reachable.
    const res = await t.service.processFromJob('v1', 'key');

    expect(iterations).toBeGreaterThan(1);
    expect(res).toEqual({ handled: true, status: 'ready', playable: false });
    // Never playable, on either path.
    expect(t.updates.every((u) => u.status !== 'READY')).toBe(true);
  });
});
