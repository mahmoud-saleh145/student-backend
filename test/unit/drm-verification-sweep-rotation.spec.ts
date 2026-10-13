/**
 * F3 - the verification sweep must not starve.
 *
 * Every blocked or never-verified video has drmVerifiedAt = null, so ordering
 * by drmVerifiedAt (nulls first) put all of them at the front in a fixed
 * order, and a failing check left them exactly there. With 25 or more of them,
 * every run re-checked the same 25: nothing behind them - other blocked videos
 * waiting to recover, proofs about to lapse - was ever reached. Blocked videos
 * only recover through the sweep (the playback path does not re-check a
 * recorded failure), so for them that was permanent.
 *
 * Real DrmVerificationSweepService, real DrmVerificationService and real
 * GumletDrmService (Gumlet's HTTP stubbed per asset). The fake table applies
 * the sweep's actual `where`, `orderBy` and `take`; the fake Redis implements
 * the sorted-set commands the rotation uses.
 */
import { DrmVerificationSweepService, SWEEP_ATTEMPTS_KEY_PARTS } from '../../src/modules/playback/drm-verification-sweep.service';
import { DrmVerificationService } from '../../src/modules/playback/drm-verification.service';
import { GumletDrmService } from '../../src/modules/playback/gumlet-drm.service';
import { fakeSweepRedis } from './helpers/drm-doubles';

type Row = Record<string, unknown>;

const CENC =
  '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="k"/></AdaptationSet></MPD>';

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((c) => matches(row, c));
    if (cond === null) return row[key] === null || row[key] === undefined;
    if (cond instanceof Date || typeof cond !== 'object') return row[key] === cond;
    const op = cond as { lt?: Date; not?: null };
    if ('not' in op) return row[key] !== op.not && row[key] !== undefined;
    if (op.lt) return row[key] instanceof Date && (row[key] as Date) < op.lt;
    throw new Error(`unsupported where operator for ${key}: ${JSON.stringify(cond)}`);
  });
}

type Order = Record<string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;
function compare(a: Row, b: Row, orderBy: Order | Order[]): number {
  for (const clause of Array.isArray(orderBy) ? orderBy : [orderBy]) {
    const [field, spec] = Object.entries(clause)[0];
    const { sort, nulls } = typeof spec === 'string' ? { sort: spec, nulls: undefined } : spec;
    const va = a[field] as Date | string | null;
    const vb = b[field] as Date | string | null;
    if (va === vb) continue;
    if (va === null || vb === null) {
      // Postgres default: NULLS LAST for ASC.
      const nullFirst = (nulls ?? (sort === 'asc' ? 'last' : 'first')) === 'first';
      return (va === null ? -1 : 1) * (nullFirst ? 1 : -1);
    }
    const c = va < vb ? -1 : 1;
    return sort === 'asc' ? c : -c;
  }
  return 0;
}

const pad = (n: number) => String(n).padStart(2, '0');
const tick = () => new Promise((r) => setTimeout(r, 3));

function world(videos: { id: string; good: boolean; drmVerifiedAt?: Date | null; drmBlockedReason?: string | null }[], opts: { redisDown?: boolean } = {}) {
  const table: Row[] = videos.map((v) => ({
    id: v.id, status: 'READY', drmProvider: 'gumlet', drmRequested: true,
    drmVerifiedAt: v.drmVerifiedAt ?? null, drmBlockedReason: v.drmBlockedReason ?? null,
    gumletAssetId: `asset_${v.id}`, gumletWorkspaceId: 'ws', gumletStatus: 'ready', gumletError: null, deletedAt: null,
  }));
  const good = new Set(videos.filter((v) => v.good).map((v) => `asset_${v.id}`));
  const byId = (id: string) => table.find((r) => r.id === id) as Row;

  const prisma = {
    video: {
      findMany: jest.fn(async (a: { where: Row; take: number; orderBy: Order | Order[]; select: Record<string, true> }) =>
        table
          .filter((r) => matches(r, a.where))
          .sort((x, y) => compare(x, y, a.orderBy))
          .slice(0, a.take)
          .map((r) => Object.fromEntries(Object.keys(a.select).map((k) => [k, r[k]])))),
      findFirst: jest.fn(async (a: { where: Row }) => {
        const r = table.find((x) => matches(x, a.where));
        return r ? { ...r } : null;
      }),
      updateMany: jest.fn(async (a: { where: Row; data: Row }) => {
        const r = table.find((x) => matches(x, a.where));
        if (r) Object.assign(r, a.data);
        return { count: r ? 1 : 0 };
      }),
    },
  };

  /** asset id -> number of times its manifest was checked */
  const checks = new Map<string, number>();
  global.fetch = jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.startsWith('https://api.gumlet.com/')) {
      const assetId = /assets\/([^/?]+)/.exec(url)![1];
      return { ok: true, status: 200, json: async () => ({ asset_id: assetId, status: 'ready', input: { transformations: { drm: { type: 'widevine' } } } }) };
    }
    const assetId = /\/ws\/([^/]+)\//.exec(url)![1];
    checks.set(assetId, (checks.get(assetId) ?? 0) + 1);
    // A deleted / unservable asset answers 404 every time: a permanent, definitive failure.
    return good.has(assetId)
      ? { ok: true, status: 200, text: async () => CENC }
      : { ok: false, status: 404, text: async () => '' };
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
  const verification = new DrmVerificationService(prisma as never, gumlet, config as never);
  const redis = fakeSweepRedis({ down: opts.redisDown });
  const sweeper = new DrmVerificationSweepService(prisma as never, verification, redis as never);

  return {
    sweeper, redis, byId,
    checked: (id: string) => checks.get(`asset_${id}`) ?? 0,
    sweep: async () => {
      const r = await sweeper.sweep();
      await tick();
      return r;
    },
  };
}

const bad = (n: number, from = 0) => Array.from({ length: n }, (_v, i) => ({ id: `a${pad(from + i)}`, good: false }));
const goodOnes = (n: number) => Array.from({ length: n }, (_v, i) => ({ id: `z${pad(i)}`, good: true }));

describe('the DRM sweep rotates instead of starving', () => {
  const savedTtl = process.env.DRM_VERIFICATION_TTL_SECONDS;
  beforeAll(() => delete process.env.DRM_VERIFICATION_TTL_SECONDS);
  afterAll(() => {
    if (savedTtl !== undefined) process.env.DRM_VERIFICATION_TTL_SECONDS = savedTtl;
  });

  it('40 permanently failing videos sorted first no longer hide the 10 behind them', async () => {
    const w = world([...bad(40), ...goodOnes(10)]);
    const first = await w.sweep();
    expect(first.checked).toBe(25);
    const second = await w.sweep();
    expect(second.checked).toBe(25);
    // Everything was attempted within ceil(50 / 25) = 2 runs...
    for (const v of [...bad(40), ...goodOnes(10)]) expect(w.checked(v.id)).toBeGreaterThanOrEqual(1);
    // ...and the verifiable ones are now verified.
    for (const v of goodOnes(10)) expect(w.byId(v.id).drmVerifiedAt).toBeInstanceOf(Date);
  });

  it('repeatedly failing videos all keep getting re-attempted, evenly', async () => {
    const all = bad(60);
    const w = world(all);
    for (let i = 0; i < 6; i += 1) {
      const r = await w.sweep();
      expect(r.checked).toBe(25); // the batch bound (and so the sweep lock sizing) is unchanged
      expect(r.failed).toBe(25);
    }
    // 6 runs x 25 = 150 attempts over 60 videos: every one attempted 2 or 3 times.
    const counts = all.map((v) => w.checked(v.id));
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(3);
  });

  it('a blocked video that becomes verifiable again recovers even when it sorts last', async () => {
    // a29 sorts after 29 others with no proof; it is fixed at Gumlet meanwhile.
    const videos = [...bad(29), { id: 'a29', good: true, drmBlockedReason: 'The DASH manifest returned HTTP 404' }];
    const w = world(videos);
    await w.sweep();
    expect(w.byId('a29').drmVerifiedAt).toBeNull();
    await w.sweep();
    expect(w.byId('a29')).toMatchObject({ drmVerifiedAt: expect.any(Date), drmBlockedReason: null });
  });

  it('a proof about to lapse is renewed promptly despite many recently-attempted blocked videos', async () => {
    const lapsing = { id: 'm00', good: true, drmVerifiedAt: new Date(Date.now() - 20_000 * 1000) };
    const w = world([...bad(30), lapsing]);
    await w.sweep(); // 25 of the blocked ones (all due, never attempted, nulls first)
    const before = w.byId('m00').drmVerifiedAt as Date;
    await w.sweep(); // never-attempted first: the other 5 blocked AND the lapsing proof
    expect((w.byId('m00').drmVerifiedAt as Date).getTime()).toBeGreaterThan(before.getTime());
  });

  it('videos that are no longer due are pruned from the rotation record', async () => {
    const w = world([...bad(26), ...goodOnes(5)]);
    await w.sweep();
    await w.sweep(); // z00-z04 verified here: no longer due
    await w.sweep(); // ...so this run drops them from the record
    const recorded = w.redis.members(...SWEEP_ATTEMPTS_KEY_PARTS);
    expect(recorded.filter((id) => id.startsWith('z'))).toEqual([]);
    expect(recorded.length).toBeLessThanOrEqual(31);
  });

  it('with Redis unavailable the sweep still runs, in database order, and does not throw', async () => {
    const w = world([...bad(30)], { redisDown: true });
    const r = await w.sweep();
    expect(r).toMatchObject({ checked: 25, failed: 25 });
    expect(w.checked('a00')).toBe(1);
    expect(w.checked('a29')).toBe(0);
  });

  it('25 or fewer due videos: all of them, no Redis round trip needed', async () => {
    const w = world([...bad(20), ...goodOnes(5)]);
    const r = await w.sweep();
    expect(r.checked).toBe(25);
    expect(w.redis.client.zrange).not.toHaveBeenCalled();
  });
});
