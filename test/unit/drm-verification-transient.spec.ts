/**
 * Transient provider failures must not erase a valid DRM proof.
 *
 * Previously verify() cleared `drmVerifiedAt` on ANY error reading Gumlet's
 * asset API or the manifest - including timeouts and 5xx - and fetch() had no
 * timeout at all. A provider blip during a sweep therefore revoked playback for
 * every video it touched. These tests pin the classified behaviour, using the
 * real GumletDrmService (timeouts, status classification) and the real
 * DrmVerificationService over an in-memory row.
 */
import { DrmVerificationSweepService } from '../../src/modules/playback/drm-verification-sweep.service';
import { DrmVerificationService } from '../../src/modules/playback/drm-verification.service';
import { GumletDrmService, GumletRequestError } from '../../src/modules/playback/gumlet-drm.service';

const CENC =
  '<MPD><AdaptationSet><ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" cenc:default_KID="k"/></AdaptationSet></MPD>';
const SECRET_B64 = 'c2VjcmV0LWtleS1tYXRlcmlhbC1mb3ItdGVzdGluZy1wdXJwb3Nlcy1vbmx5'; // not a real secret

type Answer = 'ok' | 'hang' | 'network' | number;

function setup(opts: { asset?: Answer[]; manifest?: Answer[]; row?: Record<string, unknown>; timeoutMs?: number } = {}) {
  const assetAnswers = [...(opts.asset ?? ['ok'])];
  const manifestAnswers = [...(opts.manifest ?? ['ok'])];
  const calls = { asset: 0, manifest: 0 };

  const answer = (a: Answer, signal: AbortSignal | undefined, body: () => unknown) => {
    if (a === 'network') return Promise.reject(new TypeError('fetch failed'));
    if (a === 'hang') {
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' })));
      });
    }
    const status = a === 'ok' ? 200 : a;
    return Promise.resolve({ ok: status < 300, status, json: async () => body(), text: async () => CENC });
  };

  global.fetch = jest.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    const url = String(input);
    if (url.startsWith('https://api.gumlet.com/')) {
      calls.asset += 1;
      const a = assetAnswers.length > 1 ? assetAnswers.shift()! : assetAnswers[0];
      return answer(a, init?.signal, () => ({
        asset_id: 'asset_1',
        status: 'ready',
        input: { duration: 100, transformations: { drm: { type: 'widevine,fairplay' } } },
      }));
    }
    calls.manifest += 1;
    const m = manifestAnswers.length > 1 ? manifestAnswers.shift()! : manifestAnswers[0];
    return answer(m, init?.signal, () => ({}));
  }) as never;

  const row: Record<string, unknown> = {
    id: 'v_1',
    drmProvider: 'gumlet',
    drmRequested: true,
    drmVerifiedAt: null,
    drmBlockedReason: null,
    gumletAssetId: 'asset_1',
    gumletStatus: 'ready',
    gumletWorkspaceId: 'ws_1',
    status: 'READY',
    ...opts.row,
  };
  const writes: Record<string, unknown>[] = [];
  const prisma = {
    video: {
      findFirst: jest.fn(async () => ({ ...row })),
      findMany: jest.fn(async () => [{ id: 'v_1', drmVerifiedAt: row.drmVerifiedAt }]),
      update: jest.fn(async (a: { data: Record<string, unknown> }) => {
        writes.push(a.data);
        Object.assign(row, a.data);
        return row;
      }),
      updateMany: jest.fn(async (a: { data: Record<string, unknown> }) => {
        writes.push(a.data);
        Object.assign(row, a.data);
        return { count: 1 };
      }),
    },
  };
  const config = {
    getOrThrow: () => ({
      drm: {
        enabled: true,
        provider: 'gumlet',
        gumlet: {
          apiKey: 'k',
          workspaceId: 'ws_1',
          orgId: 'org_1',
          signSecret: SECRET_B64,
          tokenLifetimeSeconds: 300,
          httpTimeoutMs: opts.timeoutMs ?? 50,
        },
      },
    }),
  };
  const gumlet = new GumletDrmService(config as never);
  const verification = new DrmVerificationService(prisma as never, gumlet, config as never);
  return { gumlet, verification, row, writes, calls, prisma };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);

describe('GumletDrmService: bounded, classified provider calls', () => {
  it('a hung asset request times out and is TRANSIENT', async () => {
    const { gumlet } = setup({ asset: ['hang'], timeoutMs: 30 });
    const err = await gumlet.getAsset('asset_1').catch((e) => e);
    expect(err).toBeInstanceOf(GumletRequestError);
    expect(err).toMatchObject({ transient: true });
    expect(String(err.message)).toMatch(/timed out after 30 ms/);
  });

  it.each([500, 502, 503, 429, 401, 403])('HTTP %i from the asset API is TRANSIENT', async (status) => {
    const { gumlet } = setup({ asset: [status] });
    await expect(gumlet.getAsset('asset_1')).rejects.toMatchObject({ transient: true, httpStatus: status });
  });

  it.each([404, 410])('HTTP %i from the asset API is DEFINITIVE', async (status) => {
    const { gumlet } = setup({ asset: [status] });
    await expect(gumlet.getAsset('asset_1')).rejects.toMatchObject({ transient: false, httpStatus: status });
  });

  it('a manifest network failure is TRANSIENT; any HTTP answer is returned for the caller to judge', async () => {
    const down = setup({ manifest: ['network'] });
    await expect(down.gumlet.fetchManifest('https://video.gumlet.io/ws/a/main.mpd')).rejects.toMatchObject({ transient: true });
    const gone = setup({ manifest: [403] });
    await expect(gone.gumlet.fetchManifest('https://video.gumlet.io/ws/a/main.mpd')).resolves.toMatchObject({ ok: false, status: 403 });
  });
});

describe('verify(): transient failures write nothing; definitive failures clear', () => {
  it.each<[string, Parameters<typeof setup>[0]]>([
    ['asset API timeout', { asset: ['hang'], timeoutMs: 20 }],
    ['asset API 503', { asset: [503] }],
    ['asset API network error', { asset: ['network'] }],
    ['manifest 502', { manifest: [502] }],
    ['manifest network error', { manifest: ['network'] }],
  ])('%s: VERIFICATION_UNAVAILABLE, earlier proof untouched', async (_label, o) => {
    const proof = hoursAgo(1);
    const t = setup({ ...o, row: { drmVerifiedAt: proof } });
    await expect(t.verification.verify('v_1')).resolves.toMatchObject({ reason: 'VERIFICATION_UNAVAILABLE' });
    expect(t.writes).toEqual([]);
    expect(t.row.drmVerifiedAt).toBe(proof);
  });

  it('retries a transient failure and succeeds on the second attempt', async () => {
    const t = setup({ asset: [503, 'ok'] });
    await expect(t.verification.verify('v_1', { attempts: 2 })).resolves.toEqual({ playable: true, reason: null });
    expect(t.calls.asset).toBe(2);
  });

  it('does not retry a definitive failure', async () => {
    const t = setup({ asset: [404], row: { drmVerifiedAt: hoursAgo(1) } });
    await expect(t.verification.verify('v_1', { attempts: 3 })).resolves.toMatchObject({ reason: 'NO_GUMLET_ASSET' });
    expect(t.calls.asset).toBe(1);
    expect(t.row.drmVerifiedAt).toBeNull();
  });

  it('a manifest 403 (how Gumlet answers for a deleted asset) is definitive: proof cleared', async () => {
    const t = setup({ manifest: [403], row: { drmVerifiedAt: hoursAgo(1) } });
    await expect(t.verification.verify('v_1')).resolves.toMatchObject({ reason: 'NOT_VERIFIED' });
    expect(t.row.drmVerifiedAt).toBeNull();
    expect(String(t.row.drmBlockedReason)).toMatch(/HTTP 403/);
  });
});

describe('ensurePlayable(): the playback-path gate', () => {
  it('concurrent requests for one lapsed video share ONE provider check', async () => {
    const t = setup({ row: { drmVerifiedAt: hoursAgo(7) } });
    const verdicts = await Promise.all([1, 2, 3, 4, 5].map(() => t.verification.ensurePlayable('v_1')));
    expect(verdicts.every((v) => v.playable)).toBe(true);
    expect(t.calls.asset).toBe(1);
  });

  it('after the provider was unreachable it is not asked again for a while (backoff), grace still applies', async () => {
    const t = setup({ asset: ['network'], row: { drmVerifiedAt: hoursAgo(7) } });
    expect(await t.verification.ensurePlayable('v_1')).toEqual({ playable: true, reason: null });
    expect(await t.verification.ensurePlayable('v_1')).toEqual({ playable: true, reason: null });
    expect(t.calls.asset).toBe(1);
  });

  it('never applies the grace after a recorded definitive failure', async () => {
    const t = setup({ asset: ['network'], row: { drmVerifiedAt: hoursAgo(7), drmBlockedReason: 'manifest not CENC' } });
    await expect(t.verification.ensurePlayable('v_1')).resolves.toMatchObject({ playable: false });
  });

  it('never applies the grace when DRM intent is not on record', async () => {
    const t = setup({ asset: ['network'], row: { drmVerifiedAt: hoursAgo(7), drmRequested: false } });
    await expect(t.verification.ensurePlayable('v_1')).resolves.toMatchObject({ playable: false });
  });

  it('platform gates are answered without asking the provider', async () => {
    const t = setup({ row: { drmProvider: null, gumletAssetId: null } });
    await expect(t.verification.ensurePlayable('v_1')).resolves.toMatchObject({ reason: 'NO_GUMLET_ASSET' });
    expect(t.calls.asset).toBe(0);
  });

  it('a fresh proof costs no provider call', async () => {
    const t = setup({ row: { drmVerifiedAt: new Date() } });
    await expect(t.verification.ensurePlayable('v_1')).resolves.toEqual({ playable: true, reason: null });
    expect(t.calls.asset + t.calls.manifest).toBe(0);
  });
});

describe('the sweep under provider failure', () => {
  it('counts an unreachable provider as errored (retry next run), not failed, and keeps the proof', async () => {
    const proof = hoursAgo(5); // due for refresh (age > TTL - margin = 4 h)
    const t = setup({ asset: ['network'], row: { drmVerifiedAt: proof } });
    const sweep = new DrmVerificationSweepService(t.prisma as never, t.verification);
    const result = await sweep.sweep();
    expect(result).toMatchObject({ checked: 1, refreshed: 0, failed: 0, errored: 1 });
    expect(t.row.drmVerifiedAt).toBe(proof);
  });
});
