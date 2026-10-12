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

type GumletDouble = {
  isSigningConfigured?: () => boolean;
  dashManifestUrl?: (p: { assetId: string; workspaceId?: string | null }) => string;
  assetHasDrm?: (manifestText: string) => boolean;
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