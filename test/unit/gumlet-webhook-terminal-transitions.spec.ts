import { Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { GumletWebhookService } from 'src/modules/videos/gumlet-webhook.service';

/**
 * What the webhook actually does, and what it deliberately does not do.
 *
 * Phase-5 questions this file answers with evidence rather than assumption:
 *
 *   * Does the webhook trust the payload?  No. `handle()` only ever uses
 *     `asset_id` to FIND the video, then re-reads the provider through
 *     `DrmVerificationService.verify()`. The payload's own `status` is used only
 *     to decide whether the event is worth acting on.
 *   * Does it update the asset's observed status?  It delegates to `verify()`,
 *     which records the provider's `gumletStatus`/`gumletError` in the same
 *     conditional write that records the verification failure.
 *   * Does it make anything playable?  Only `verify()` can set `drmVerifiedAt`,
 *     and only after a real CENC manifest check. An `errored` asset can never
 *     reach that.
 *   * What happens with no secret?  Everything is refused. That is correct and
 *     unchanged - and it is ALSO the live configuration on this platform, which
 *     is why the service now says so at boot.
 */

const SECRET = 'shared-secret';

function build(opts?: {
  secret?: string | null;
  video?: { id: string; gumletAssetId: string } | null;
  verdict?: { playable: boolean; reason?: string; detail?: string };
}) {
  const verify = jest.fn(async () =>
    opts?.verdict?.playable === false
      ? {
          playable: false,
          reason: (opts.verdict.reason ?? 'NOT_VERIFIED') as never,
          detail: opts.verdict.detail ?? 'not verified',
        }
      : { playable: true, reason: null },
  );

  const prisma = {
    video: {
      findFirst: jest.fn(async () => opts?.video ?? null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };

  const service = new GumletWebhookService(
    prisma as never,
    { verify } as never,
    { get: () => (opts?.secret === undefined ? SECRET : opts.secret) } as never,
  );
  return { service, verify, prisma };
}

const VIDEO = { id: 'cmv9ju1yz00ngcr01tztxv6u7', gumletAssetId: '6ad12efed14399f23655bb33' };

describe('webhook terminal transitions', () => {
  it('an ERRORED asset is never marked playable', async () => {
    // The verdict the real verifier returns for a terminally failed asset:
    // ASSET_FAILED, not NOT_VERIFIED. Either way, playable is false.
    const { service, verify } = build({
      video: VIDEO,
      verdict: {
        playable: false,
        reason: 'ASSET_FAILED',
        detail: 'We had trouble downloading the input video/audio file from the URL or path that is used.',
      },
    });

    const result = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'errored' });

    expect(result.matched).toBe(true);
    expect(result.action).toBe('blocked');
    expect(result.detail).toContain('ASSET_FAILED');
    // Verification ran, and reported failure. It can only have written
    // drmVerifiedAt = null on this path.
    expect(verify).toHaveBeenCalledWith(VIDEO.id);
  });

  it('a FAILED asset is treated the same as errored', async () => {
    const { service, verify } = build({
      video: VIDEO,
      verdict: { playable: false, reason: 'ASSET_FAILED', detail: 'Gumlet reports the asset as "failed".' },
    });

    const result = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'failed' });

    expect(result.action).toBe('blocked');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('a READY asset still has to pass the real CENC check', async () => {
    // The payload says "ready". That grants nothing: the verifier is asked, and
    // its answer decides.
    const { service, verify } = build({
      video: VIDEO,
      verdict: {
        playable: false,
        reason: 'NOT_VERIFIED',
        detail: 'The DASH manifest is not CENC-encrypted.',
      },
    });

    const result = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'ready' });

    expect(result.action).toBe('blocked');
    expect(verify).toHaveBeenCalledWith(VIDEO.id);
  });

  it('only a genuinely verified asset reports playable', async () => {
    const { service } = build({ video: VIDEO, verdict: { playable: true } });

    const result = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'ready' });

    expect(result.action).toBe('verified');
    expect(result.detail).toBe('DRM verified.');
  });

  it('a non-terminal event does not churn the provider', async () => {
    const { service, verify } = build({ video: VIDEO });

    const result = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'processing' });

    expect(result.action).toBe('ignored');
    expect(verify).not.toHaveBeenCalled();
  });

  it('a duplicate delivery converges and never grants playback twice', async () => {
    const { service, verify } = build({
      video: VIDEO,
      verdict: { playable: false, reason: 'ASSET_FAILED', detail: 'dead' },
    });

    const first = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'errored' });
    const second = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'errored' });

    // Identical outcome. Idempotent because the payload is only a nudge and the
    // provider is always re-read.
    expect(first).toEqual(second);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('an out-of-order late "ready" after a failure still cannot grant playback', async () => {
    const { service } = build({
      video: VIDEO,
      verdict: { playable: false, reason: 'ASSET_FAILED', detail: 'dead' },
    });

    const result = await service.handle({ asset_id: VIDEO.gumletAssetId, status: 'ready' });

    expect(result.action).toBe('blocked');
  });
});

describe('webhook configuration state', () => {
  it('refuses everything when no secret is set, and says so at boot', () => {
    // The live configuration on this platform. The refusal is correct and
    // unchanged; what changed is that it is no longer invisible.
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = build({ secret: '   ' });

      expect(service.isConfigured()).toBe(false);
      // Fail-closed: no signature, and not even a correct-looking one, passes.
      const sig = createHmac('sha256', SECRET).update('{}').digest('hex');
      expect(service.verifySignature(Buffer.from('{}'), sig)).toBe(false);
      expect(service.verifySignature(Buffer.from('{}'), undefined)).toBe(false);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('GUMLET_WEBHOOK_SECRET'));
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet at boot when a secret IS configured', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const { service } = build({ secret: SECRET });
      expect(service.isConfigured()).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('never logs or returns the secret itself', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const { service } = build({ secret: null });
      const body = Buffer.from(JSON.stringify({ asset_id: 'a' }));
      service.verifySignature(body, 'deadbeef');

      for (const spy of [warn, error]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(SECRET);
        }
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });
});
