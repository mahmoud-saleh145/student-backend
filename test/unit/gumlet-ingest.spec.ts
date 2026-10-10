import { GumletIngestService } from 'src/modules/videos/gumlet-ingest.service';

/**
 * Fail-closed behaviour for the Gumlet-backed lifecycle.
 *
 * These tests deliberately avoid the network: the asset API is a stub, so what
 * is under test is the decision logic - when a video may become PLAYABLE, and
 * when it must be blocked.
 */

type Row = {
  id: string;
  status: string;
  drmProvider: string | null;
  gumletAssetId: string | null;
  gumletWorkspaceId: string | null;
  gumletStatus: string | null;
  gumletError: string | null;
  lesson?: { title: string } | null;
};

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

function build(opts: {
  row: Row | null;
  asset?: { status: string; progress?: number; error?: string | null; dashPlaybackUrl?: string | null };
  manifestBody?: string;
  manifestOk?: boolean;
}) {
  const updates: Record<string, unknown>[] = [];
  const row: Row = opts.row ?? {
    id: 'v1',
    status: 'UPLOADING',
    drmProvider: null,
    gumletAssetId: null,
    gumletWorkspaceId: null,
    gumletStatus: null,
    gumletError: null,
    lesson: { title: 'Lesson' },
  };

  const prisma = {
    video: {
      findFirst: jest.fn(async () => row),
      findUniqueOrThrow: jest.fn(async () => ({ status: updates.at(-1)?.status ?? row.status })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => {
        updates.push(args.data);
        Object.assign(row, args.data);
        return row;
      }),
    },
  };

  const storage = {
    signMediaUrl: jest.fn(async () => 'https://r2.example/source?sig=REDACTED'),
  };

  const gumlet = {
    isAssetApiConfigured: () => true,
    isAssetPlayable: (s: string) => s === 'ready',
    assetHasDrm: (text: string) =>
      /urn:mpeg:dash:mp4protection:2011/.test(text) && /cenc:default_KID=/.test(text),
    createAsset: jest.fn(async () => ({ assetId: 'asset_1', status: 'pre-queued', playbackUrl: null })),
    getAsset: jest.fn(async () => ({
      assetId: 'asset_1',
      status: opts.asset?.status ?? 'processing',
      progress: opts.asset?.progress ?? 0,
      playbackUrl: null,
      dashPlaybackUrl: opts.asset?.dashPlaybackUrl ?? null,
      error: opts.asset?.error ?? null,
    })),
    dashManifestUrl: ({ assetId }: { assetId: string }) => `https://video.gumlet.io/ws/${assetId}/main.mpd`,
  };

  const config = {
    getOrThrow: () => ({
      drm: { gumlet: { workspaceId: 'ws', resolutions: ['720p', '1080p'] } },
    }),
  };

  const service = new GumletIngestService(
    prisma as never,
    storage as never,
    gumlet as never,
    config as never,
  );

  return { service, updates, row, gumlet, storage };
}

describe('GumletIngestService.adopt', () => {
  it('is idempotent: an existing asset is re-synced, not recreated', async () => {
    const t = build({ row: null });
    (t.service as unknown as { prisma: { video: { findFirst: jest.Mock } } }).prisma.video.findFirst.mockResolvedValue({
      id: 'v1',
      status: 'PROCESSING',
      drmProvider: 'gumlet',
      sourceKey: 'uploads/v1/source.mp4',
      gumletAssetId: 'asset_existing',
      gumletWorkspaceId: 'ws',
      gumletStatus: 'processing',
      gumletError: null,
      lesson: { title: 'Lesson' },
    });
    const res = await t.service.adopt('v1');
    expect(res.assetId).toBe('asset_existing');
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('refuses to adopt a video with no uploaded source', async () => {
    const t = build({ row: null });
    (t.service as unknown as { prisma: { video: { findFirst: jest.Mock } } }).prisma.video.findFirst.mockResolvedValue({
      id: 'v1',
      sourceKey: null,
      lesson: { title: 'Lesson' },
    });
    await expect(t.service.adopt('v1')).rejects.toThrow(/no uploaded source/i);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('refuses to adopt when the asset API is not configured', async () => {
    const t = build({ row: baseRow() });
    (t.gumlet as unknown as { isAssetApiConfigured: () => boolean }).isAssetApiConfigured = () => false;
    await expect(t.service.adopt('v1')).rejects.toThrow(/not configured/i);
    expect(t.gumlet.createAsset).not.toHaveBeenCalled();
  });

  it('sends a short-lived source URL and never returns it in the creation call', async () => {
    const t = build({ row: baseRow() });
    await t.service.adopt('v1');
    expect(t.gumlet.createAsset).toHaveBeenCalledTimes(1);
    const arg = (t.gumlet.createAsset as jest.Mock).mock.calls[0][0] as { sourceUrl: string };
    // The presigned URL is used to fetch, but must not be persisted.
    expect(arg.sourceUrl).toContain('r2.example');
  });
});

describe('GumletIngestService.sync', () => {
  it('does not mark a video PLAYABLE while Gumlet is still processing', async () => {
    const t = build({ row: { ...baseRow(), gumletAssetId: 'a1' }, asset: { status: 'processing' } });
    const res = await t.service.sync('v1');
    expect(res.playable).toBe(false);
    expect(t.updates.every((u) => u.status !== 'READY')).toBe(true);
  });

  it('marks READY only when ready AND the manifest is CENC-encrypted', async () => {
    const t = build({ row: { ...baseRow(), gumletAssetId: 'a1' }, asset: { status: 'ready' } });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => DRM_MANIFEST,
    } as never);

    const res = await t.service.sync('v1');
    expect(res.playable).toBe(true);
    expect(t.updates.at(-1)?.status).toBe('READY');
    (global.fetch as unknown as { mockRestore: () => void }).mockRestore();
  });

  it('BLOCKS playback when Gumlet reports ready but the manifest is not encrypted', async () => {
    const t = build({ row: { ...baseRow(), gumletAssetId: 'a1' }, asset: { status: 'ready' } });
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      text: async () => PLAIN_MANIFEST,
    } as never);

    const res = await t.service.sync('v1');
    expect(res.playable).toBe(false);
    expect(t.updates.at(-1)?.status).toBe('FAILED');
    expect(String(t.updates.at(-1)?.gumletError)).toMatch(/not CENC-encrypted/i);
    (global.fetch as unknown as { mockRestore: () => void }).mockRestore();
  });

  it('marks FAILED when Gumlet reports an errored asset', async () => {
    const t = build({
      row: { ...baseRow(), gumletAssetId: 'a1' },
      asset: { status: 'errored', error: 'source decode failed' },
    });
    const res = await t.service.sync('v1');
    expect(res.playable).toBe(false);
    expect(t.updates.at(-1)?.status).toBe('FAILED');
    expect(String(t.updates.at(-1)?.gumletError)).toContain('source decode failed');
  });

  it('refuses to sync a video that has no Gumlet asset', async () => {
    const t = build({ row: { ...baseRow(), gumletAssetId: null } });
    await expect(t.service.sync('v1')).rejects.toThrow(/not backed/i);
  });

  it('treats an unknown success-like status as NOT playable (fail-closed)', async () => {
    const t = build({ row: { ...baseRow(), gumletAssetId: 'a1' }, asset: { status: 'finished' } });
    const res = await t.service.sync('v1');
    expect(res.playable).toBe(false);
    expect(t.updates.every((u) => u.status !== 'READY')).toBe(true);
  });
});

function baseRow(): Row {
  return {
    id: 'v1',
    status: 'UPLOADING',
    drmProvider: null,
    gumletAssetId: null,
    gumletWorkspaceId: null,
    gumletStatus: null,
    gumletError: null,
    lesson: { title: 'Lesson' },
    sourceKey: 'uploads/v1/source.mp4',
  } as Row;
}
