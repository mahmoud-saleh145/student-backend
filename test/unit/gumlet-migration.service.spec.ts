import { GumletMigrationService, MigrationReport } from 'src/modules/videos/gumlet-migration.service';
import { VideoRow } from 'src/modules/videos/gumlet-migration.plan';

/**
 * Batch behaviour of the migration runner.
 *
 * `GumletIngestService` is stubbed here on purpose. The runner's contract with
 * production is that it DELEGATES adoption and sync rather than reimplementing
 * them, so what these tests pin is:
 *
 *   * it refuses to start on bad configuration,
 *   * a dry run changes nothing and calls nothing,
 *   * it tolerates partial failure and retries within bounds,
 *   * resume is a property of the data, and
 *   * no secret, token or signed URL reaches the report.
 *
 * The stub throwing on an un-stubbed method is deliberate: if the runner ever
 * grows its own private copy of the adoption logic, these tests fail loudly
 * instead of quietly diverging from production.
 */

const FULL_GUMLET = {
  // Realistic length. A 1-character fixture value would match any string and
  // make the "secret never leaks" assertions meaningless.
  apiKey: 'gumlet-api-key-fixture-value-0001',
  workspaceId: 'ws_1',
  orgId: 'org_1',
  signSecret: Buffer.from('secret').toString('base64'),
  tokenLifetimeSeconds: 300,
  resolutions: ['720p', '1080p'],
};

const row = (over: Partial<VideoRow> = {}): VideoRow => ({
  id: 'v_1',
  status: 'READY',
  drmProvider: null,
  gumletAssetId: null,
  gumletStatus: null,
  sourceKey: 'source/v_1/master.mp4',
  masterPlaylistKey: 'media/v_1/master.m3u8',
  deletedAt: null,
  ...over,
});

function build(opts?: {
  rows?: VideoRow[];
  drm?: { enabled?: boolean; provider?: 'none' | 'gumlet'; gumlet?: Record<string, unknown> };
  /** Per-video behaviour of the stubbed ingest service. */
  adopt?: (videoId: string) => Promise<{ assetId: string; status: string }>;
  sync?: (
    videoId: string,
  ) => Promise<{ assetId: string; status: string; playable: boolean }>;
  /** Whether R2 credentials are present. Default true. */
  storageConfigured?: boolean;
  /** Whether the stored source object is present in R2. Default true. */
  sourceExists?: boolean;
}) {
  const drm = {
    enabled: opts?.drm?.enabled ?? true,
    provider: opts?.drm?.provider ?? ('gumlet' as const),
    gumlet: { ...FULL_GUMLET, ...(opts?.drm?.gumlet ?? {}) },
  };

  const rows = opts?.rows ?? [row()];
  const adopts: string[] = [];
  const syncs: string[] = [];
  const updates: Record<string, unknown>[] = [];

  const prisma = {
    video: {
      findMany: jest.fn(async () => rows),
      groupBy: jest.fn(async () => [{ status: 'READY', _count: { _all: rows.length } }]),
      count: jest.fn(async () => 0),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        return {};
      }),
    },
  };

  const gumlet = {
    isAssetApiConfigured: jest.fn(
      () => Boolean(drm.gumlet.apiKey) && Boolean(drm.gumlet.workspaceId),
    ),
    isSigningConfigured: jest.fn(() => Boolean(drm.gumlet.orgId) && Boolean(drm.gumlet.signSecret)),
    // Kept on the double deliberately: the service must never CALL it, and
    // `expect(gumlet.signSecretFingerprint).not.toHaveBeenCalled()` in the
    // logging test is what proves no secret-derived value reaches the report.
    signSecretFingerprint: jest.fn(() => 'abc123def456'),
  };

  // Object storage. `isConfigured` is what preflight now checks first, so a test
  // can reproduce the exact incident: Gumlet fully configured, R2 missing.
  const storage = {
    isConfigured: opts?.storageConfigured ?? true,
    exists: jest.fn(async () => opts?.sourceExists ?? true),
  };

  const ingest = {
    adopt: jest.fn(async (videoId: string) => {
      adopts.push(videoId);
      if (opts?.adopt) return opts.adopt(videoId);
      return { assetId: `asset_${videoId}`, status: 'processing' };
    }),
    sync: jest.fn(async (videoId: string) => {
      syncs.push(videoId);
      if (opts?.sync) return opts.sync(videoId);
      return { assetId: `asset_${videoId}`, status: 'processing', playable: false };
    }),
  };

  const service = new GumletMigrationService(
    prisma as never,
    gumlet as never,
    ingest as never,
    storage as never,
    { getOrThrow: () => ({ drm }) } as never,
  );

  return { service, prisma, gumlet, ingest, storage, adopts, syncs, updates, drm };
}

const ids = (r: MigrationReport, result: string) =>
  r.outcomes.filter((o) => o.result === result).map((o) => o.videoId);

describe('preflight', () => {
  it('passes when Gumlet is fully configured', () => {
    const { service } = build();
    const pre = service.preflight();
    expect(pre.ok).toBe(true);
    expect(pre.blockers).toEqual([]);
  });

  it('blocks when the asset API is not configured', () => {
    const { service } = build({ drm: { gumlet: { apiKey: null } } });
    const pre = service.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.blockers.join(' ')).toMatch(/GUMLET_API_KEY/);
  });

  it('blocks when signing is not configured, because migrated videos could not play', () => {
    const { service } = build({ drm: { gumlet: { signSecret: null } } });
    expect(service.preflight().ok).toBe(false);
    expect(service.preflight().blockers.join(' ')).toMatch(/GUMLET_SIGN_SECRET/);
  });

  it('blocks when DRM_ENABLED is false, because that would take lessons offline', () => {
    const { service } = build({ drm: { enabled: false } });
    const pre = service.preflight();
    expect(pre.ok).toBe(false);
    expect(pre.blockers.join(' ')).toMatch(/DRM_ENABLED/);
  });

  it('blocks when the provider is not gumlet', () => {
    const { service } = build({ drm: { provider: 'none' } });
    expect(service.preflight().ok).toBe(false);
  });

  it('never derives or returns any secret-derived value', () => {
    const { service, gumlet } = build();
    const pre = service.preflight();
    // The old contract exposed a truncated HMAC of the signing secret. Removed:
    // it is derived from the secret, it is not needed to decide anything, and
    // routine operator output has no reason to carry it.
    expect(Object.keys(pre)).not.toContain('signSecretFingerprint');
    expect(gumlet.signSecretFingerprint).not.toHaveBeenCalled();
    expect(JSON.stringify(pre)).not.toContain(FULL_GUMLET.signSecret);
    expect(JSON.stringify(pre)).not.toContain(Buffer.from(FULL_GUMLET.signSecret, 'base64').toString('utf8'));
  });

  it('never returns the secret or the API key from any report', async () => {
    const { service } = build();
    const report = await service.dryRun();
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain(FULL_GUMLET.signSecret);
    expect(serialised).not.toContain(FULL_GUMLET.apiKey);
  });
});

describe('dry run', () => {
  it('changes nothing and calls nothing', async () => {
    const { service, ingest, prisma, updates } = build({
      rows: [row({ id: 'v_a' }), row({ id: 'v_b', drmProvider: 'gumlet', gumletAssetId: 'x', status: 'READY' })],
    });
    const report = await service.dryRun();

    expect(report.dryRun).toBe(true);
    // The decisive assertion: a dry run must not touch Gumlet or the database.
    expect(ingest.adopt).not.toHaveBeenCalled();
    expect(ingest.sync).not.toHaveBeenCalled();
    expect(prisma.video.update).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('reports what WOULD happen, matching the real action', async () => {
    const { service } = build({
      rows: [
        row({ id: 'v_migrate' }),
        row({ id: 'v_verify', drmProvider: 'gumlet', gumletAssetId: 'x', status: 'READY' }),
        row({ id: 'v_skip', deletedAt: new Date() }),
      ],
    });
    const report = await service.dryRun();
    const byId = Object.fromEntries(report.outcomes.map((o) => [o.videoId, o]));

    expect(byId.v_migrate.action).toBe('adopt');
    expect(byId.v_migrate.result).toBe('PENDING');
    expect(byId.v_verify.action).toBe('verify');
    expect(byId.v_verify.result).toBe('VERIFIED_READY');
    expect(byId.v_skip.result).toBe('SKIPPED');
    expect(report.planned).toBe(2);
  });

  it('reports a bad configuration rather than throwing', async () => {
    const { service } = build({ drm: { enabled: false } });
    const report = await service.dryRun();
    expect(report.dryRun).toBe(true);
    expect(report.allPlayable).toBe(false);
  });

  it('never claims a dry run made videos playable', async () => {
    const { service } = build();
    expect((await service.dryRun()).allPlayable).toBe(false);
  });

  it('honours a limit', async () => {
    const { service } = build({
      rows: [row({ id: 'v_1' }), row({ id: 'v_2' }), row({ id: 'v_3' })],
    });
    expect((await service.dryRun(2)).outcomes).toHaveLength(2);
  });
});

describe('run - delegation, not reimplementation', () => {
  it('delegates adoption to the existing ingest service', async () => {
    const { service, adopts } = build({ rows: [row({ id: 'v_1' })] });
    await service.run();
    expect(adopts).toEqual(['v_1']);
  });

  it('delegates verification to sync, never to adopt', async () => {
    const { service, adopts, syncs } = build({
      rows: [row({ id: 'v_1', drmProvider: 'gumlet', gumletAssetId: 'x', status: 'READY' })],
    });
    await service.run();
    expect(syncs).toEqual(['v_1']);
    // Adopting here would be exactly the duplicate-asset bug this tool exists
    // to avoid.
    expect(adopts).toEqual([]);
  });
});

describe('run - replacing a permanently failed asset', () => {
  const deadAssetRow = (id: string) =>
    row({ id, drmProvider: null, gumletAssetId: `dead_${id}`, gumletStatus: 'errored' });

  function buildReplace(over?: Parameters<typeof build>[0]) {
    const replaces: string[] = [];
    const base = build(over);
    const ingest = { ...base.ingest, replaceFailedAsset: jest.fn() };
    // Re-create the service with a replaceFailedAsset double.
    const service = new GumletMigrationService(
      base.prisma as never,
      base.gumlet as never,
      ingest as never,
      base.storage as never,
      { getOrThrow: () => ({ drm: base.drm }) } as never,
    );
    ingest.replaceFailedAsset.mockImplementation(async (videoId: string) => {
      replaces.push(videoId);
      return { assetId: `new_${videoId}`, status: 'processing' };
    });
    return { ...base, service, ingest, replaces };
  }

  it('never replaces unless the caller opts in', async () => {
    const t = buildReplace({ rows: [deadAssetRow('v_1')] });
    const report = await t.service.run();
    expect(t.replaces).toEqual([]);
    expect(report.outcomes[0].action).toBe('verify');
  });

  it('replaces through the ingest service when opted in', async () => {
    const t = buildReplace({ rows: [deadAssetRow('v_1')] });
    const report = await t.service.run({ allowAssetReplacement: true });
    expect(t.replaces).toEqual(['v_1']);
    expect(report.outcomes[0].action).toBe('replace');
    expect(report.outcomes[0].result).toBe('PENDING');
  });

  it('does not touch healthy Gumlet videos when replacing', async () => {
    const t = buildReplace({
      rows: [row({ id: 'v_ok', drmProvider: 'gumlet', gumletAssetId: 'live', status: 'READY' })],
    });
    await t.service.run({ allowAssetReplacement: true });
    expect(t.replaces).toEqual([]);
    expect(t.syncs).toEqual(['v_ok']);
  });

  it('reports a replacement failure without retrying forever', async () => {
    const t = buildReplace({ rows: [deadAssetRow('v_1')] });
    let calls = 0;
    (t.ingest.replaceFailedAsset as jest.Mock).mockImplementation(async () => {
      calls++;
      throw new Error('Gumlet asset creation failed with HTTP 429 rate limit');
    });
    const report = await t.service.run({ allowAssetReplacement: true, maxAttempts: 2, baseDelayMs: 1 });
    expect(calls).toBe(2);
    expect(report.outcomes[0].result).toBe('FAILED');
    expect(report.failures.RATE_LIMITED).toBe(1);
  });

  it('does not touch skipped rows at all', async () => {
    const { service, adopts, syncs } = build({ rows: [row({ id: 'v_x', deletedAt: new Date() })] });
    const report = await service.run();
    expect(report.outcomes[0].result).toBe('SKIPPED');
    expect(adopts).toEqual([]);
    expect(syncs).toEqual([]);
  });
});

describe('run - refusals', () => {
  it('refuses to run at all on an incomplete configuration', async () => {
    const { service, adopts } = build({ drm: { enabled: false } });
    await expect(service.run()).rejects.toThrow(/Refusing to migrate/);
    expect(adopts).toEqual([]);
  });

  it('never puts the signing secret into the refusal message', async () => {
    const { service } = build({ drm: { gumlet: { signSecret: null } } });
    await expect(service.run()).rejects.toThrow(
      expect.not.stringContaining(FULL_GUMLET.signSecret),
    );
  });
});

describe('run - outcomes', () => {
  it('reports ADOPTED only when Gumlet reports ready', async () => {
    const { service } = build({
      adopt: async () => ({ assetId: 'a', status: 'ready' }),
    });
    const report = await service.run();
    expect(report.outcomes[0].result).toBe('ADOPTED');
    expect(report.allPlayable).toBe(true);
  });

  it('treats an in-progress asset as PENDING, not as a failure', async () => {
    const { service } = build({ adopt: async () => ({ assetId: 'a', status: 'processing' }) });
    const report = await service.run();
    expect(report.outcomes[0].result).toBe('PENDING');
    expect(report.allPlayable).toBe(false);
    expect(report.failures).toEqual({});
  });

  it('marks a provider-side terminal error FAILED without retrying it', async () => {
    let calls = 0;
    const { service, ingest } = build({
      adopt: async () => {
        calls++;
        return { assetId: 'a', status: 'errored' };
      },
    });
    const report = await service.run({ maxAttempts: 3, baseDelayMs: 1 });
    expect(report.outcomes[0].result).toBe('FAILED');
    expect(report.outcomes[0].attempts).toBe(1);
    expect(calls).toBe(1);
    expect(ingest.adopt).toHaveBeenCalledTimes(1);
  });

  it('never claims a video is playable when any video in the batch failed', async () => {
    const { service } = build({
      rows: [row({ id: 'v_ok' }), row({ id: 'v_bad' })],
      adopt: async (id: string) =>
        id === 'v_bad'
          ? { assetId: 'a', status: 'failed' }
          : { assetId: 'a', status: 'ready' },
    });
    const report = await service.run();
    expect(report.allPlayable).toBe(false);
  });
});

describe('run - retries and partial failure', () => {
  it('retries a transient failure and succeeds', async () => {
    let calls = 0;
    const { service } = build({
      adopt: async () => {
        calls++;
        if (calls < 3) throw new Error('fetch failed: ECONNRESET');
        return { assetId: 'a', status: 'ready' };
      },
    });
    const report = await service.run({ maxAttempts: 3, baseDelayMs: 1 });
    expect(report.outcomes[0].result).toBe('ADOPTED');
    expect(report.outcomes[0].attempts).toBe(3);
  });

  it('gives up after exactly maxAttempts', async () => {
    let calls = 0;
    const { service } = build({
      adopt: async () => {
        calls++;
        throw new Error('Gumlet asset creation failed with HTTP 500');
      },
    });
    const report = await service.run({ maxAttempts: 3, baseDelayMs: 1 });
    expect(calls).toBe(3);
    expect(report.outcomes[0].result).toBe('FAILED');
    expect(report.outcomes[0].attempts).toBe(3);
  });

  it('classifies rate limiting separately from other errors', async () => {
    const { service } = build({
      adopt: async () => {
        throw new Error('Gumlet asset creation failed with HTTP 429 rate limit');
      },
    });
    const report = await service.run({ maxAttempts: 1 });
    expect(report.failures.RATE_LIMITED).toBe(1);
  });

  it('does not retry a configuration error', async () => {
    let calls = 0;
    const { service } = build({
      adopt: async () => {
        calls++;
        throw new Error('Gumlet asset API is not configured (GUMLET_API_KEY)');
      },
    });
    await service.run({ maxAttempts: 5, baseDelayMs: 1 });
    expect(calls).toBe(1);
  });

  it('keeps going after one video fails and still migrates the rest', async () => {
    const { service } = build({
      rows: [
        row({ id: 'v_1' }),
        row({ id: 'v_2' }),
        row({ id: 'v_3' }),
      ],
      adopt: async (id: string) => {
        if (id === 'v_2') throw new Error('Gumlet asset creation failed with HTTP 500');
        return { assetId: 'a', status: 'ready' };
      },
    });
    const report = await service.run({ maxAttempts: 1 });
    // Partial completion is the important property: one poison row must not
    // strand the others.
    expect(ids(report, 'ADOPTED')).toEqual(['v_1', 'v_3']);
    expect(ids(report, 'FAILED')).toEqual(['v_2']);
    expect(report.allPlayable).toBe(false);
  });

  it('groups failures by reason in the report', async () => {
    const { service } = build({
      rows: [row({ id: 'v_1' }), row({ id: 'v_2' })],
      adopt: async (id: string) => {
        throw new Error(id === 'v_1' ? 'fetch failed' : 'HTTP 429 rate limit');
      },
    });
    const report = await service.run({ maxAttempts: 1 });
    expect(report.failures).toEqual({ NETWORK_ERROR: 1, RATE_LIMITED: 1 });
  });

  it('never leaks the provider error text, which can contain a signed URL', async () => {
    const { service } = build({
      adopt: async () => {
        throw new Error(
          'failed to fetch https://uploads.example/source/v.mp4?X-Amz-Signature=deadbeefcafe',
        );
      },
    });
    const report = await service.run({ maxAttempts: 1 });
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('X-Amz-Signature');
    expect(serialised).not.toContain('deadbeefcafe');
    expect(report.outcomes[0].detail).not.toContain('http');
  });
});

describe('run - resume', () => {
  it('re-running never adopts a video that already has an asset', async () => {
    // First run: the video is a legacy candidate.
    const first = build({ rows: [row({ id: 'v_1' })] });
    await first.service.run();

    // Second run: the row now carries an asset, exactly as GumletIngestService
    // wrote it. Resume must verify, not re-adopt.
    const second = build({
      rows: [
        row({ id: 'v_1', drmProvider: 'gumlet', gumletAssetId: 'asset_v_1', status: 'PROCESSING' }),
      ],
    });
    await second.service.run();
    expect(second.adopts).toEqual([]);
    expect(second.syncs).toEqual(['v_1']);
  });

  it('a resumed run converges: repeat runs stop calling adopt once adopted', async () => {
    let status = 'processing';
    const rows: VideoRow[] = [row({ id: 'v_1' })];

    // Simulate the row the ingest service would have written after adoption.
    const runOnce = async () => {
      const b = build({
        rows,
        adopt: async () => {
          rows[0] = { ...rows[0], drmProvider: 'gumlet', gumletAssetId: 'asset_v_1', status: 'PROCESSING' };
          return { assetId: 'asset_v_1', status };
        },
        sync: async () => ({ assetId: 'asset_v_1', status, playable: status === 'ready' }),
      });
      return b;
    };

    const r1 = await runOnce();
    await r1.service.run();
    expect(r1.adopts).toHaveLength(1);

    const r2 = await runOnce();
    await r2.service.run();
    // Second run saw the asset and only synced. No duplicate was possible.
    expect(r2.adopts).toHaveLength(0);
    expect(r2.syncs).toEqual(['v_1']);
  });

  it('respects the batch limit so a run can be advanced a slice at a time', async () => {
    const rows = [row({ id: 'v_1' }), row({ id: 'v_2' }), row({ id: 'v_3' })];
    const first = build({ rows });
    const r1 = await first.service.run({ limit: 2 });
    expect(r1.outcomes).toHaveLength(2);
    expect(first.adopts).toEqual(['v_1', 'v_2']);
  });
});

describe('census and reporting', () => {
  it('counts live videos by status without writing', async () => {
    const { service, prisma } = build();
    const census = await service.census();
    expect(census.total).toBe(1);
    expect(census.byStatus).toEqual({ READY: 1 });
    expect(prisma.video.update).not.toHaveBeenCalled();
  });

  it('reports started and finished timestamps', async () => {
    const { service } = build();
    const report = await service.run();
    expect(Date.parse(report.startedAt)).not.toBeNaN();
    expect(Date.parse(report.finishedAt)).not.toBeNaN();
  });

  it('counts skips by reason', async () => {
    const { service } = build({
      rows: [row({ id: 'v_1', deletedAt: new Date() }), row({ id: 'v_2', sourceKey: null })],
    });
    const report = await service.run();
    expect(report.skipped).toEqual({ SOFT_DELETED: 1, NO_SOURCE_OBJECT: 1 });
  });

  it('notifies a caller for every outcome as it happens', async () => {
    const { service } = build({ rows: [row({ id: 'v_1' })] });
    const seen: string[] = [];
    await service.run({ onOutcome: (o) => seen.push(`${o.videoId}:${o.result}`) });
    expect(seen).toEqual(['v_1:PENDING']);
  });
});