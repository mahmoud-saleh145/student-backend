import { ErrorCode } from 'src/common/errors/error-codes';
import { classifyGumletFailure, sanitizeProviderText } from 'src/modules/videos/gumlet-failure';
import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';

/**
 * Telling a provider failure apart from itself.
 * ---------------------------------------------------------------------------
 *
 * A quota rejection and an unreachable input read almost the same in prose and
 * need completely different remedies:
 *
 *   * a quota rejection is permanent until an operator changes the plan, and a
 *     fresh asset is rejected exactly like the old one;
 *   * an unreachable input is fixed by a fresh ingest, because the provider
 *     simply could not read the URL it was given.
 *
 * Before this classification existed, every one of them arrived as one flat
 * string and every one of them was repaired the same way - by re-reading the
 * same dead asset. That is the mechanism behind a Retry button that could
 * never work.
 *
 * The second half of this file pins the consequence: the account's LIVE
 * allowance, not the recorded error, decides whether a replacement is minted.
 * That is what lets a video recover the moment a plan is increased, instead of
 * staying stuck on a reason that stopped being true.
 */

const QUOTA_ERROR =
  'The uploaded video duration exceeds the storage minutes quota for your account. ' +
  'Please consider upgrading your account to increase storage minutes quota.';

const UNREACHABLE_ERROR =
  'We had trouble downloading the input video/audio file from the URL or path that is used. ' +
  'Please check the URL or path and try again.';

describe('classifyGumletFailure', () => {
  it('recognises an exhausted allowance, and says an operator has to act', () => {
    const f = classifyGumletFailure({ message: QUOTA_ERROR });

    expect(f.kind).toBe('QUOTA_EXCEEDED');
    expect(f.retryable).toBe(false);
    expect(f.requiresOperatorAction).toBe(true);
    // A fresh asset is rejected exactly like the old one, so re-ingesting
    // cannot help until the plan changes.
    expect(f.requiresReingest).toBe(false);
    expect(f.adminMessage).toMatch(/allowance is exhausted/i);
  });

  it('recognises an unreachable input, which a fresh ingest does fix', () => {
    const f = classifyGumletFailure({
      code: 'ERR_ASSET_NOT_FOUND',
      message: UNREACHABLE_ERROR,
    });

    expect(f.kind).toBe('SOURCE_UNREACHABLE');
    expect(f.requiresReingest).toBe(true);
    expect(f.requiresOperatorAction).toBe(false);
  });

  it('recognises a broken credential, which only an operator can fix', () => {
    const f = classifyGumletFailure({ message: 'Unauthorized: the API key is not valid' });

    expect(f.kind).toBe('ACCOUNT_OR_CREDENTIALS');
    expect(f.requiresOperatorAction).toBe(true);
    expect(f.retryable).toBe(false);
  });

  it('recognises a rate limit as transient', () => {
    const f = classifyGumletFailure({ status: 429, message: 'Too many requests' });

    expect(f.kind).toBe('TRANSIENT');
    expect(f.retryable).toBe(true);
  });

  it('recognises a timeout as transient', () => {
    const f = classifyGumletFailure({ message: 'Gumlet asset lookup timed out after 5000 ms' });

    expect(f.kind).toBe('TRANSIENT');
    expect(f.retryable).toBe(true);
  });

  it('treats an unrecognised failure conservatively: not retryable, not a reason to re-ingest', () => {
    const f = classifyGumletFailure({ message: 'source decode failed' });

    expect(f.kind).toBe('UNKNOWN');
    expect(f.retryable).toBe(false);
    expect(f.requiresReingest).toBe(false);
  });

  it('prefers the quota reading over the account reading when the message mentions both', () => {
    // The real quota message talks about "your account" AND about upgrading.
    // Reading it as a credential problem would send the operator to the API
    // key instead of to the plan.
    const f = classifyGumletFailure({ message: QUOTA_ERROR });

    expect(f.kind).toBe('QUOTA_EXCEEDED');
  });
});

describe('sanitizeProviderText', () => {
  it('removes a signed URL', () => {
    const out = sanitizeProviderText(
      'failed to fetch https://acct.r2.cloudflarestorage.com/b/k?X-Amz-Signature=deadbeefcafe',
    );

    expect(out).not.toContain('deadbeefcafe');
    expect(out).toContain('[url]');
  });

  it('removes a bare secret-shaped token', () => {
    const out = sanitizeProviderText('token aGVsbG8gdGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ1234567890 rejected');

    expect(out).not.toContain('aGVsbG8gdGhpcyBpcyBhIHNlY3JldCB2YWx1ZQ1234567890');
  });

  it('keeps the useful part of a provider message', () => {
    expect(sanitizeProviderText(QUOTA_ERROR)).toContain('storage minutes quota');
  });

  it('is safe on an empty value', () => {
    expect(sanitizeProviderText(null)).toBe('');
    expect(sanitizeProviderText(undefined)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// The account allowance decides whether a replacement may be minted.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  status: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletStatus: string | null;
  gumletError: string | null;
  sourceKey: string | null;
  durationSeconds: number;
  lessonId: string | null;
  courseId: string | null;
}

function build(opts: {
  gumletError?: string | null;
  gumletStatus?: string | null;
  quota?: { storage: number; usage: number } | Error;
} = {}) {
  const row: Row = {
    id: 'vid_1',
    status: 'FAILED',
    drmProvider: 'gumlet',
    gumletAssetId: 'asset_dead',
    gumletStatus: opts.gumletStatus ?? 'errored',
    gumletError: opts.gumletError === undefined ? QUOTA_ERROR : opts.gumletError,
    sourceKey: 'source/videos/vid_1/abc.mp4',
    durationSeconds: 0,
    lessonId: 'les_1',
    courseId: 'crs_1',
  };

  let created = 0;
  const gumlet = {
    isAssetApiConfigured: () => true,
    isSigningConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    createAsset: jest.fn(async () => {
      created += 1;
      return { assetId: `asset_new_${created}`, status: 'pre-queued', playbackUrl: null };
    }),
    getAsset: jest.fn(async () => ({
      assetId: 'asset_new_1',
      status: 'processing',
      progress: 0,
      playbackUrl: null,
      dashPlaybackUrl: null,
      error: null,
    })),
    getAccountQuota: jest.fn(async () => {
      if (opts.quota instanceof Error) throw opts.quota;
      const storage = opts.quota?.storage ?? 900_000;
      const usage = opts.quota?.usage ?? 201_745;
      return {
        plan: 'businessVideoMay26',
        planDisplayName: 'Business',
        storageQuotaSeconds: storage,
        storageUsageSeconds: usage,
        bandwidthQuota: null,
        maxProcessingDurationSeconds: 14_400,
        storageDataUnit: 'min',
      };
    }),
    dashManifestUrl: ({ assetId }: { assetId: string }) => `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };

  const prisma = {
    video: {
      findFirst: jest.fn(async () => row),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => row),
      findUniqueOrThrow: jest.fn(async () => ({ status: row.status })),
    },
  };

  const storage = {
    isConfigured: true,
    exists: jest.fn(async () => true),
    presignIngestionUrl: jest.fn(async () => 'https://r2.example/ingest?X-Amz-Signature=REDACTED'),
  };

  const config = {
    getOrThrow: () => ({
      drm: {
        enabled: true,
        provider: 'gumlet',
        gumlet: {
          apiKey: 'k',
          workspaceId: 'ws',
          orgId: 'o',
          signSecret: 's',
          ingestUrlTtlSeconds: 6 * 60 * 60,
        },
      },
    }),
  };

  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    { evaluate: jest.fn(), verify: jest.fn(), isPlatformUsable: () => true } as never,
    config as never,
    { propagateDurationToAttachedLessons: jest.fn().mockResolvedValue(0) } as never,
    { record: jest.fn() } as never,
  );

  return {
    service,
    gumlet,
    get createdCount() {
      return created;
    },
  };
}

const REPAIR = { allowGumletProviderReplacement: true } as const;

describe('replaceFailedAsset - the account allowance is consulted', () => {
  it('refuses to mint an asset the account has no room for, and says why', async () => {
    const h = build({ quota: { storage: 900_000, usage: 900_000 } });

    await expect(h.service.replaceFailedAsset('vid_1', REPAIR)).rejects.toMatchObject({
      code: ErrorCode.VIDEO_PROCESSING_FAILED,
    });

    // No second dead asset was created for a plan that cannot hold it.
    expect(h.gumlet.createAsset).not.toHaveBeenCalled();
    expect(h.createdCount).toBe(0);
  });

  it('names the allowance in the refusal, in minutes, so an operator can act', async () => {
    const h = build({ quota: { storage: 900_000, usage: 900_000 } });

    await expect(h.service.replaceFailedAsset('vid_1', REPAIR)).rejects.toThrow(
      /15000 of 15000 minutes used/,
    );
  });

  it('RECOVERY: a video that failed on an exhausted plan is replaced once the plan allows it', async () => {
    // Same recorded error, same dead asset - but the account now has room,
    // because the plan was increased. The LIVE numbers decide, not the stale
    // recorded reason, which is what makes the upgrade actually take effect.
    const h = build({ quota: { storage: 900_000, usage: 201_745 } });

    const result = await h.service.replaceFailedAsset('vid_1', REPAIR);

    expect(result).toMatchObject({ assetId: 'asset_new_1' });
    expect(h.createdCount).toBe(1);
    expect(h.gumlet.getAccountQuota).toHaveBeenCalled();
  });

  it('proceeds when the account cannot be read: the provider is the authority', async () => {
    const h = build({ quota: new Error('account read timed out') });

    const result = await h.service.replaceFailedAsset('vid_1', REPAIR);

    expect(result).toMatchObject({ assetId: 'asset_new_1' });
    expect(h.createdCount).toBe(1);
  });

  it('does not interrogate the account for an unreachable input - a fresh ingest is the fix', async () => {
    const h = build({
      gumletError: UNREACHABLE_ERROR,
      quota: { storage: 900_000, usage: 900_000 },
    });

    const result = await h.service.replaceFailedAsset('vid_1', REPAIR);

    expect(result).toMatchObject({ assetId: 'asset_new_1' });
    expect(h.gumlet.getAccountQuota).not.toHaveBeenCalled();
  });

  it('refuses a video whose own length cannot fit in the remaining allowance', async () => {
    const h = build({ quota: { storage: 900_000, usage: 899_000 } });
    // 1,000 seconds of allowance left, and a video that needs 3,600.
    (h.service as unknown as { prisma: { video: { findFirst: jest.Mock } } }).prisma.video.findFirst
      .mockResolvedValue({
        id: 'vid_1',
        status: 'FAILED',
        drmProvider: 'gumlet',
        gumletAssetId: 'asset_dead',
        gumletStatus: 'errored',
        gumletError: QUOTA_ERROR,
        sourceKey: 'source/videos/vid_1/abc.mp4',
        durationSeconds: 3_600,
        lessonId: 'les_1',
        courseId: 'crs_1',
      });

    await expect(h.service.replaceFailedAsset('vid_1', REPAIR)).rejects.toMatchObject({
      code: ErrorCode.VIDEO_PROCESSING_FAILED,
    });
    expect(h.gumlet.createAsset).not.toHaveBeenCalled();
  });
});
