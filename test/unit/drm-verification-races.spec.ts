/**
 * F2 - an older verification result must never overwrite a newer one, and a
 * result for a REPLACED asset must never change its replacement's state.
 *
 * Before: the failure write was an unconditional update. A slow check that
 * started first and failed (e.g. a CDN edge still answering 404 for a just-
 * published manifest) could finish after a newer check succeeded and erase the
 * new proof - and since a recorded failure stops the playback path from
 * re-checking, the video then stayed refused until the next sweep reached it.
 * Neither write was tied to the asset that was checked.
 *
 * Real DrmVerificationService and real GumletDrmService (Gumlet's HTTP is
 * stubbed and gated so the interleaving is exact). The fake table applies the
 * `where` of every update the way Postgres would, including `OR` and `lt`, so
 * the conditions themselves are what is being tested.
 */
import { DrmVerificationService } from '../../src/modules/playback/drm-verification.service';
import { GumletDrmService } from '../../src/modules/playback/gumlet-drm.service';

type Row = Record<string, unknown>;

const CENC =
  '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="k"/></AdaptationSet></MPD>';

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (cond instanceof Date || typeof cond !== 'object') return row[key] === cond;
    const op = cond as { lt?: Date };
    if (op.lt) return row[key] instanceof Date && (row[key] as Date) < op.lt;
    throw new Error(`unsupported where operator for ${key}: ${JSON.stringify(cond)}`);
  });
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

/** Per-asset scripted Gumlet answers; `gate` holds that asset's manifest read open. */
type Script = { status?: string; manifest?: { status: number; body?: string }; gate?: Promise<void> };

function world(row: Row, script: Record<string, Script[]>) {
  const video: Row = {
    id: 'vid_1', status: 'READY', drmProvider: 'gumlet', drmRequested: true,
    drmVerifiedAt: null, drmBlockedReason: null, gumletAssetId: 'asset_1',
    gumletWorkspaceId: 'ws', gumletStatus: 'ready', gumletError: null, deletedAt: null,
    ...row,
  };
  const updates: { where: Row; data: Row; applied: boolean }[] = [];
  const prisma = {
    video: {
      findFirst: jest.fn(async (a: { where: Row }) => (matches(video, a.where) ? { ...video } : null)),
      // An unconditional write, as Postgres would apply it (the old failure path).
      update: jest.fn(async (a: { where: Row; data: Row }) => {
        updates.push({ ...a, applied: true });
        Object.assign(video, a.data);
        return { ...video };
      }),
      updateMany: jest.fn(async (a: { where: Row; data: Row }) => {
        const applied = matches(video, a.where);
        updates.push({ ...a, applied });
        if (applied) Object.assign(video, a.data);
        return { count: applied ? 1 : 0 };
      }),
    },
  };

  const calls: string[] = [];
  const next = (assetId: string, which: 'asset' | 'manifest'): Script => {
    const queue = script[assetId] ?? [];
    // Each verification consumes one entry at its manifest read.
    return which === 'asset' ? queue[0] ?? {} : queue.shift() ?? {};
  };
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    const assetId = /assets\/([^/?]+)/.exec(url)?.[1] ?? /\/ws\/([^/]+)\//.exec(url)?.[1] ?? 'unknown';
    if (url.startsWith('https://api.gumlet.com/')) {
      calls.push(`asset:${assetId}`);
      const s = next(assetId, 'asset');
      if (s.status && s.status !== 'ready') {
        // Not playable: no manifest read follows, so consume the entry now.
        script[assetId]?.shift();
        await s.gate;
      }
      return {
        ok: true, status: 200,
        json: async () => ({ asset_id: assetId, status: s.status ?? 'ready', input: { transformations: { drm: { type: 'widevine' } } } }),
      };
    }
    calls.push(`manifest:${assetId}`);
    const s = next(assetId, 'manifest');
    await s.gate;
    const m = s.manifest ?? { status: 200, body: CENC };
    return { ok: m.status === 200, status: m.status, text: async () => m.body ?? '' };
  }) as never;

  const config = {
    getOrThrow: () => ({
      drm: {
        enabled: true, provider: 'gumlet',
        gumlet: { apiKey: 'k', workspaceId: 'ws', orgId: 'org', signSecret: 'c2VjcmV0LWZvci10ZXN0cw==', tokenLifetimeSeconds: 300, resolutions: [] },
      },
    }),
  };
  const gumlet = new GumletDrmService(config as never);
  const drm = new DrmVerificationService(prisma as never, gumlet, config as never);
  return { video, drm, updates, calls: () => [...calls], prisma };
}

/** Lets the in-flight check reach its gated provider read. */
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('an older failing check that finishes AFTER a newer successful one', () => {
  it('leaves the newer success intact, reports it, and playback needs no provider call', async () => {
    const slow = deferred();
    const w = world({}, {
      asset_1: [
        { manifest: { status: 404 }, gate: slow.promise }, // older check: CDN edge 404, slow
        { manifest: { status: 200, body: CENC } },          // newer check: succeeds
      ],
    });

    const older = w.drm.verify('vid_1', { attempts: 1 });
    await tick();
    const newer = await w.drm.verify('vid_1', { attempts: 1 });
    expect(newer.playable).toBe(true);
    const proof = w.video.drmVerifiedAt as Date;
    expect(proof).toBeInstanceOf(Date);

    slow.release();
    const olderVerdict = await older;

    // The newer proof survived, and no failure was recorded against it.
    expect(w.video).toMatchObject({ drmVerifiedAt: proof, drmBlockedReason: null });
    expect(w.updates.at(-1)).toMatchObject({ data: { drmVerifiedAt: null }, applied: false });
    // The loser reports the stored state rather than its own stale failure.
    expect(olderVerdict.playable).toBe(true);

    const before = w.calls().length;
    await expect(w.drm.ensurePlayable('vid_1')).resolves.toMatchObject({ playable: true });
    expect(w.calls().length).toBe(before);
    // Every write was conditional; nothing used an unconditional update.
    expect(w.prisma.video.update).not.toHaveBeenCalled();
  });

  it('a definitive failure still clears a proof recorded BEFORE the check started', async () => {
    const earlier = new Date(Date.now() - 60_000);
    const w = world({ drmVerifiedAt: earlier }, { asset_1: [{ manifest: { status: 404 } }] });
    const verdict = await w.drm.verify('vid_1', { attempts: 1 });
    expect(verdict).toMatchObject({ playable: false, reason: 'NOT_VERIFIED' });
    expect(w.video).toMatchObject({ drmVerifiedAt: null, drmBlockedReason: expect.stringContaining('HTTP 404') });
  });
});

describe('a result for a REPLACED asset cannot change the replacement', () => {
  /** What adopt() writes when it swaps in a new asset (gumlet-ingest.service.ts). */
  const adoptNewAsset = (video: Row) =>
    Object.assign(video, {
      gumletAssetId: 'asset_2', drmVerifiedAt: null, drmBlockedReason: null,
      drmRequested: true, gumletStatus: 'queued', gumletError: null, status: 'PROCESSING',
    });

  it('an old-asset SUCCESS does not verify the new asset, and reports "not verified"', async () => {
    const slow = deferred();
    const w = world({}, { asset_1: [{ manifest: { status: 200, body: CENC }, gate: slow.promise }] });

    const check = w.drm.verify('vid_1', { attempts: 1 });
    await tick();
    adoptNewAsset(w.video);
    slow.release();
    const verdict = await check;

    expect(w.video).toMatchObject({ gumletAssetId: 'asset_2', drmVerifiedAt: null, drmBlockedReason: null, gumletStatus: 'queued' });
    expect(w.updates).toEqual([expect.objectContaining({ applied: false })]);
    // Not playable: a caller such as sync() must not mark the video READY on it.
    expect(verdict.playable).toBe(false);
  });

  it('an old-asset definitive FAILURE does not block the new asset', async () => {
    const slow = deferred();
    const w = world({}, { asset_1: [{ manifest: { status: 410 }, gate: slow.promise }] });

    const check = w.drm.verify('vid_1', { attempts: 1 });
    await tick();
    adoptNewAsset(w.video);
    slow.release();
    await check;

    expect(w.video).toMatchObject({ gumletAssetId: 'asset_2', drmBlockedReason: null, drmVerifiedAt: null });
  });

  it("an old asset's provider status (errored) never lands on the new asset's row", async () => {
    const slow = deferred();
    const w = world({}, { asset_1: [{ status: 'errored', gate: slow.promise }] });

    const check = w.drm.verify('vid_1', { attempts: 1 });
    await tick();
    adoptNewAsset(w.video);
    slow.release();
    await check;

    expect(w.video).toMatchObject({ gumletAssetId: 'asset_2', gumletStatus: 'queued', drmBlockedReason: null });
  });

  it('without a replacement, the provider status and the failure are recorded together', async () => {
    const w = world({}, { asset_1: [{ status: 'errored' }] });
    await expect(w.drm.verify('vid_1', { attempts: 1 })).resolves.toMatchObject({ reason: 'ASSET_FAILED' });
    expect(w.updates).toHaveLength(1);
    expect(w.video).toMatchObject({ gumletStatus: 'errored', drmVerifiedAt: null, drmBlockedReason: expect.any(String) });
  });
});

describe('recovery paths still work', () => {
  it('after a recorded failure, a later successful verify() (sweep / staff / webhook) restores playback', async () => {
    const w = world(
      { drmVerifiedAt: null, drmBlockedReason: 'The DASH manifest returned HTTP 404; this asset cannot be played.' },
      { asset_1: [{ manifest: { status: 200, body: CENC } }] },
    );
    await expect(w.drm.ensurePlayable('vid_1')).resolves.toMatchObject({ playable: false });
    expect(w.calls()).toEqual([]);
    await expect(w.drm.verify('vid_1')).resolves.toMatchObject({ playable: true });
    expect(w.video).toMatchObject({ drmBlockedReason: null, drmVerifiedAt: expect.any(Date) });
    await expect(w.drm.ensurePlayable('vid_1')).resolves.toMatchObject({ playable: true });
  });
});
