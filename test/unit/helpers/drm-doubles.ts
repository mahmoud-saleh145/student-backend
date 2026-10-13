/**
 * Test doubles for the DRM verification gate.
 *
 * Playback now refuses anything not verifiably DRM-protected, so every harness
 * that constructs `PlaybackService`, `ManifestService` or
 * `GumletIngestService` needs a `DrmVerificationService`.
 *
 * `allowDrm()` is the permissive default for tests that are about something else
 * (rate limits, device limits, key-system selection). Tests that are specifically
 * about DRM enforcement must NOT use it - they should construct a real
 * `DrmVerificationService` or use `denyDrm()`, so a broken gate cannot be
 * masked by a permissive double.
 */
import { DrmVerificationService, VideoForVerdict } from 'src/modules/playback/drm-verification.service';
import { GumletRequestError } from 'src/modules/playback/gumlet-drm.service';

/**
 * `GumletDrmService.fetchManifest` for doubles: reads through the global
 * `fetch` mock the suites already install. A mocked response without a status
 * keeps the historical meaning of "not ok" (an answer: 404, definitive); a
 * rejected fetch is what the real method reports for timeouts and network
 * failures (transient).
 */
export async function fetchManifestViaGlobalFetch(url: string): Promise<{ status: number; ok: boolean; text: string }> {
  let response: { ok: boolean; status?: number; text: () => Promise<string> };
  try {
    response = (await fetch(url)) as never;
  } catch {
    throw new GumletRequestError('Manifest read failed: network error', true, null);
  }
  const status = response.status ?? (response.ok ? 200 : 404);
  return { status, ok: response.ok, text: response.ok ? await response.text() : '' };
}

type GumletDouble = {
  isSigningConfigured?: () => boolean;
  dashManifestUrl?: (p: { assetId: string; workspaceId?: string | null }) => string;
  assetHasDrm?: (manifestText: string) => boolean;
  fetchManifest?: (url: string) => Promise<{ status: number; ok: boolean; text: string }>;
  getAsset?: (assetId: string) => Promise<{
    assetId: string;
    status: string;
    progress: number;
    playbackUrl: string | null;
    dashPlaybackUrl: string | null;
    error: string | null;
  }>;
  isAssetPlayable?: (status: string) => boolean;
};

type PrismaLike = {
  video: {
    findFirst: jest.Mock;
    update: jest.Mock;
    /**
     * `verify()` writes its success through `updateMany` with a conditional
     * `where`, so that two overlapping verifications cannot let a slower one
     * overwrite a newer timestamp. A stub returning `{ count: 0 }` would read as
     * "lost the race" and silently skip the success branch, so the default
     * reports a write.
     */
    updateMany?: jest.Mock;
  };
};

/** Build a real service over a stubbed Prisma + Gumlet client. */
export function buildDrmVerification(opts?: {
  prisma?: PrismaLike;
  enabled?: boolean;
  provider?: 'none' | 'gumlet';
  signingConfigured?: boolean;
  /**
   * Share the harness's own Gumlet stub so the verifier and the code under test
   * observe the SAME asset status. A verifier with its own defaulting stub could
   * report "ready" while the code under test sees "processing" — the two would
   * then disagree about the very thing being tested.
   */
  gumlet?: Partial<GumletDouble>;
  /**
   * Row returned by `prisma.video.findFirst`. Defaults to a verified row.
   * A function may be supplied so the stub can mirror the video actually under
   * test — without that, a suite testing a legacy row would still be judged as
   * a happy-path Gumlet video and would pass for the wrong reason.
   */
  row?: Partial<VideoForVerdict> | ((id: string) => Partial<VideoForVerdict>);
}): DrmVerificationService {
  const videoCfg = {
    drm: {
      enabled: opts?.enabled ?? true,
      provider: opts?.provider ?? 'gumlet',
      gumlet: {
        apiKey: 'k',
        workspaceId: 'ws_1',
        orgId: 'org_1',
        signSecret: Buffer.from('s').toString('base64'),
      },
    },
  };

  return new DrmVerificationService(
    (opts?.prisma ?? {
      video: {
        // Defaults to a fully verified Gumlet row so a suite that is about
        // something else (key-system selection, workspace resolution) passes
        // through the real gate rather than being short-circuited by a double.
        findFirst: jest.fn(async (args?: { where?: { id?: string } }) => {
          const id = args?.where?.id ?? 'v_1';
          const override = typeof opts?.row === 'function' ? opts.row(id) : opts?.row;
          return {
            id,
            drmProvider: 'gumlet',
            drmRequested: true,
            drmVerifiedAt: new Date(),
            drmBlockedReason: null,
            gumletAssetId: 'a_1',
            gumletStatus: 'ready',
            gumletWorkspaceId: 'ws_1',
            status: 'READY',
            ...(override ?? {}),
          };
        }),
        update: jest.fn(async () => ({})),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
    }) as never,
    {
      isSigningConfigured: jest.fn(() => opts?.signingConfigured ?? true),
      dashManifestUrl: jest.fn(() => 'https://video.gumlet.io/ws_1/a_1/main.mpd'),
      fetchManifest: fetchManifestViaGlobalFetch,
      assetHasDrm: jest.fn(() => true),
      getAsset: jest.fn(async () => ({
        assetId: 'a_1',
        status: 'ready',
        progress: 100,
        playbackUrl: null,
        dashPlaybackUrl: null,
        error: null,
      })),
      isAssetPlayable: jest.fn((s: string) => s === 'ready'),
      ...(opts?.gumlet ?? {}),
    } as never,
    { getOrThrow: () => videoCfg } as never,
  );
}

/** A permissive double: every video is treated as verified DRM. */
export function allowDrm(): DrmVerificationService {
  return {
    evaluate: () => ({ playable: true, reason: null }),
    evaluateVideo: async () => ({ playable: true, reason: null }),
    ensurePlayable: async () => ({ playable: true, reason: null }),
    verify: async () => ({ playable: true, reason: null }),
  } as unknown as DrmVerificationService;
}

/** A double that refuses everything, with a fixed reason. */
export function denyDrm(
  reason = 'NOT_VERIFIED',
  detail = 'DRM has not been verified against the live manifest yet.',
): DrmVerificationService {
  return {
    evaluate: () => ({ playable: false, reason, detail }),
    evaluateVideo: async () => ({ playable: false, reason, detail }),
    ensurePlayable: async () => ({ playable: false, reason, detail }),
    verify: async () => ({ playable: false, reason, detail }),
  } as unknown as DrmVerificationService;
}

/** A ready, verified video row - the happy path. */
export const verifiedVideo = (over: Partial<VideoForVerdict> = {}): VideoForVerdict => ({
  id: 'v_1',
  drmProvider: 'gumlet',
  drmRequested: true,
  drmVerifiedAt: new Date(),
  drmBlockedReason: null,
  gumletAssetId: 'a_1',
  gumletStatus: 'ready',
  gumletWorkspaceId: 'ws_1',
  status: 'READY',
  ...over,
});
/**
 * RedisService as the DRM sweep uses it: one sorted set, read with
 * ZRANGE ... WITHSCORES and written through MULTI (ZREM / ZADD / EXPIRE), with
 * ioredis's reply shapes. `down: true` makes every command fail, as an
 * unreachable Redis does.
 */
export function fakeSweepRedis(opts: { down?: boolean } = {}) {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => {
    let s = sets.get(key);
    if (!s) sets.set(key, (s = new Map()));
    return s;
  };
  const fail = () => Promise.reject(new Error('connect ECONNREFUSED'));
  const client = {
    zrange: jest.fn(async (key: string, _start: number, _stop: number, _withScores: 'WITHSCORES') => {
      if (opts.down) return fail();
      return [...set(key).entries()]
        .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1))
        .flatMap(([member, score]) => [member, String(score)]);
    }),
    multi: jest.fn(() => {
      const ops: (() => void)[] = [];
      const chain = {
        zrem: (key: string, ...members: string[]) => (ops.push(() => members.forEach((m) => set(key).delete(m))), chain),
        zadd: (key: string, ...scoreMembers: (string | number)[]) => {
          ops.push(() => {
            for (let i = 0; i + 1 < scoreMembers.length; i += 2) set(key).set(String(scoreMembers[i + 1]), Number(scoreMembers[i]));
          });
          return chain;
        },
        expire: (_key: string, _seconds: number) => chain,
        exec: async () => {
          if (opts.down) return fail();
          ops.forEach((op) => op());
          return [];
        },
      };
      return chain;
    }),
  };
  return {
    key: (...parts: (string | number)[]) => ['test', ...parts].join(':'),
    client,
    /** Members of a sorted set by its key parts, for assertions. */
    members: (...parts: string[]) => [...set(['test', ...parts].join(':')).keys()],
  };
}
