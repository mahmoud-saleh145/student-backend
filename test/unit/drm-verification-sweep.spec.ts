import {
  DrmVerificationSweepService,
  SWEEP_VERIFY_ATTEMPTS,
} from '../../src/modules/playback/drm-verification-sweep.service';

/**
 * The six-hour TTL is only safe because something renews the proof. These tests
 * pin the behaviour of that renewal: who is picked, when, and - just as
 * important - what happens when the provider misbehaves.
 */

const TTL = 21600; // 6h, the default
const MARGIN = DrmVerificationSweepService.defaultMarginSeconds(TTL); // 7200

function at(minutesAgo: number, now: Date): Date {
  return new Date(now.getTime() - minutesAgo * 60_000);
}

describe('DrmVerificationSweepService.selectCandidates', () => {
  const now = new Date('2026-10-12T00:00:00.000Z');

  it('renews a proof well BEFORE it expires, not at expiry', () => {
    // TTL 6h, margin 2h -> renewal starts once 4h have elapsed. At 4.5h the
    // proof still has 1.5h of life, so a student would see no interruption at
    // all; it is renewed anyway because the window is open.
    const ids = DrmVerificationSweepService.selectCandidates(TTL, MARGIN, now, [
      { id: 'due', drmVerifiedAt: at(270, now) },
    ]);
    expect(ids).toEqual(['due']);
  });

  it('leaves a proof that still has more than the margin left', () => {
    // One hour old: five hours of life remain, far beyond the 2h margin.
    const ids = DrmVerificationSweepService.selectCandidates(TTL, MARGIN, now, [
      { id: 'fresh', drmVerifiedAt: at(60, now) },
    ]);
    expect(ids).toEqual([]);
  });

  it('picks up a proof that has never been verified', () => {
    const ids = DrmVerificationSweepService.selectCandidates(TTL, MARGIN, now, [
      { id: 'never', drmVerifiedAt: null },
    ]);
    expect(ids).toEqual(['never']);
  });

  it('picks up an already-expired proof', () => {
    const ids = DrmVerificationSweepService.selectCandidates(TTL, MARGIN, now, [
      { id: 'stale', drmVerifiedAt: at(400, now) },
    ]);
    expect(ids).toEqual(['stale']);
  });

  it('derives the margin from the TTL rather than hard-coding it', () => {
    // A 1h TTL must not get a 33-minute refresh window with a 30-minute sweep.
    expect(DrmVerificationSweepService.defaultMarginSeconds(3600)).toBe(1200);
    expect(DrmVerificationSweepService.defaultMarginSeconds(60)).toBe(60); // floor
  });
});

describe('DrmVerificationSweepService.sweep', () => {
  function build(opts: {
    rows?: { id: string; drmVerifiedAt: Date | null }[];
    platformUsable?: boolean;
    verify?: (id: string) => Promise<{ playable: boolean; reason: string | null; detail: string }>;
  } = {}) {
    const findMany = jest.fn(async (_args: { where?: Record<string, unknown> }) => opts.rows ?? []);
    const prisma = { video: { findMany } };
    const verify =
      opts.verify ?? (async () => ({ playable: true, reason: null, detail: 'ok' }));
    const drmVerification = {
      ttl: TTL,
      isPlatformUsable: jest.fn(() => opts.platformUsable ?? true),
      verify: jest.fn(verify),
    };
    const service = new DrmVerificationSweepService(prisma as never, drmVerification as never);
    return { service, prisma, drmVerification, findMany };
  }

  it('stands down entirely when the platform is not configured for DRM', async () => {
    const { service, drmVerification, findMany } = build({ platformUsable: false });
    const r = await service.sweep();
    expect(r.skippedPlatform).toBe(1);
    expect(r.checked).toBe(0);
    // Crucially it does not even read the library, let alone fail every video.
    expect(findMany).not.toHaveBeenCalled();
    expect(drmVerification.verify).not.toHaveBeenCalled();
  });

  it('only considers READY videos on the Gumlet path with an asset', async () => {
    const { service, findMany } = build({ rows: [] });
    await service.sweep();
    const where = findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.drmProvider).toBe('gumlet');
    expect(where.gumletAssetId).toEqual({ not: null });
    expect(where.status).toBe('READY');
    expect(where.deletedAt).toBeNull();
  });

  it('refreshes a due proof through the real verifier', async () => {
    const { service, drmVerification } = build({
      rows: [{ id: 'v_1', drmVerifiedAt: null }],
    });
    const r = await service.sweep();
    // Same as verify()'s own default (2); now explicit so the scheduler can size its lock from it.
    expect(drmVerification.verify).toHaveBeenCalledWith('v_1', { attempts: SWEEP_VERIFY_ATTEMPTS });
    expect(r.checked).toBe(1);
    expect(r.refreshed).toBe(1);
  });

  it('counts a refused verification as failed without inventing a result', async () => {
    const { service } = build({
      rows: [{ id: 'v_1', drmVerifiedAt: null }],
      verify: async () => ({ playable: false, reason: 'NOT_VERIFIED', detail: 'not CENC' }),
    });
    const r = await service.sweep();
    expect(r.failed).toBe(1);
    expect(r.refreshed).toBe(0);
  });

  it('treats a thrown error as transient: neither refreshed nor failed', async () => {
    // A provider outage must not clear a proof that is still working. The sweep
    // records the error and leaves the stored proof alone for the next run.
    const { service } = build({
      rows: [{ id: 'v_1', drmVerifiedAt: null }],
      verify: async () => {
        throw new Error('provider 503');
      },
    });
    const r = await service.sweep();
    expect(r.errored).toBe(1);
    expect(r.failed).toBe(0);
    expect(r.refreshed).toBe(0);
  });

  it('keeps going after one video errors', async () => {
    const { service } = build({
      rows: [
        { id: 'v_1', drmVerifiedAt: null },
        { id: 'v_2', drmVerifiedAt: null },
      ],
      verify: async (id) => {
        if (id === 'v_1') throw new Error('boom');
        return { playable: true, reason: null, detail: 'ok' };
      },
    });
    const r = await service.sweep();
    expect(r.errored).toBe(1);
    expect(r.refreshed).toBe(1);
    expect(r.checked).toBe(2);
  });

  it('bounds the work per run and defers the remainder', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ id: `v_${i}`, drmVerifiedAt: null }));
    const { service, drmVerification } = build({ rows });
    const r = await service.sweep({ batchSize: 5 });
    expect(r.checked).toBe(5);
    expect(drmVerification.verify).toHaveBeenCalledTimes(5);
  });

  it('does no work at all when every proof is still fresh', async () => {
    const now = Date.now();
    const { service, drmVerification } = build({
      rows: [{ id: 'v_1', drmVerifiedAt: new Date(now - 60_000) }],
    });
    const r = await service.sweep();
    expect(drmVerification.verify).not.toHaveBeenCalled();
    expect(r.checked).toBe(0);
    expect(r.skippedFresh).toBe(1);
  });

  it('is safe to run repeatedly - a restart or double tick changes nothing extra', async () => {
    const { service, drmVerification } = build({
      rows: [{ id: 'v_1', drmVerifiedAt: null }],
    });
    await service.sweep();
    await service.sweep();
    // Verification is idempotent, so a second occurrence re-verifies and is a
    // no-op at the storage layer thanks to the verifier's own concurrency guard.
    expect(drmVerification.verify).toHaveBeenCalledTimes(2);
    const r = await service.sweep();
    expect(r.refreshed).toBe(1);
  });
});
