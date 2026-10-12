import { createHmac } from 'node:crypto';

import {
  GumletWebhookService,
} from 'src/modules/videos/gumlet-webhook.service';
import { GumletWebhookController } from 'src/modules/videos/gumlet-webhook.controller';

/**
 * Webhook security.
 *
 * The endpoint is public and unauthenticated in the usual sense - anyone who
 * learns the URL can POST to it. These tests prove that nothing useful can be
 * done without the shared secret, and that even WITH a valid signature the
 * payload is never believed.
 */

const SECRET = 'gumlet-webhook-shared-secret';
const BODY = JSON.stringify({ asset_id: 'a_1', status: 'ready' });
const SIGNATURE = createHmac('sha256', SECRET).update(Buffer.from(BODY)).digest('hex');

function build(opts?: {
  secret?: string;
  video?: { id: string; gumletAssetId: string } | null;
  verdict?: { playable: boolean; reason?: string; detail?: string };
}) {
  const verify = jest.fn(async () =>
    opts?.verdict?.playable === false
      ? { playable: false, reason: (opts.verdict.reason ?? 'NOT_VERIFIED') as never, detail: opts.verdict.detail ?? 'not verified' }
      : { playable: true, reason: null },
  );
  const prisma = {
    video: {
      findFirst: jest.fn(async () => opts?.video ?? null),
      update: jest.fn(async () => ({})),
    },
  };
  const service = new GumletWebhookService(
    prisma as never,
    { verify } as never,
    { get: () => opts?.secret ?? SECRET } as never,
  );
  return { service, verify, prisma };
}

describe('webhook signature verification', () => {
  it('accepts a correctly signed body', () => {
    const { service } = build();
    expect(service.verifySignature(Buffer.from(BODY), SIGNATURE)).toBe(true);
  });

  it('accepts the sha256= prefixed form', () => {
    const { service } = build();
    expect(service.verifySignature(Buffer.from(BODY), `sha256=${SIGNATURE}`)).toBe(true);
  });

  it('REJECTS a tampered body', () => {
    const { service } = build();
    const tampered = JSON.stringify({ asset_id: 'a_1', status: 'ready', force: true });
    expect(service.verifySignature(Buffer.from(tampered), SIGNATURE)).toBe(false);
  });

  it('REJECTS a wrong signature', () => {
    const { service } = build();
    expect(service.verifySignature(Buffer.from(BODY), 'deadbeef')).toBe(false);
  });

  it('REJECTS a missing signature', () => {
    const { service } = build();
    expect(service.verifySignature(Buffer.from(BODY), undefined)).toBe(false);
  });

  it('REJECTS EVERYTHING when no secret is configured, rather than failing open', () => {
    // The critical fail-closed property: an unconfigured webhook must not become
    // a way for anyone to mark assets ready.
    const { service } = build({ secret: '' });
    expect(service.isConfigured()).toBe(false);
    expect(service.verifySignature(Buffer.from(BODY), SIGNATURE)).toBe(false);
    expect(service.verifySignature(Buffer.from(BODY), undefined)).toBe(false);
  });
});

describe('webhook event handling', () => {
  it('re-verifies against the provider instead of trusting the payload', async () => {
    const { service, verify } = build({ video: { id: 'v_1', gumletAssetId: 'a_1' } });
    const result = await service.handle({ asset_id: 'a_1', status: 'ready' });
    expect(verify).toHaveBeenCalledWith('v_1');
    expect(result.action).toBe('verified');
  });

  it('does NOT make a video playable when re-verification fails, even for status "ready"', async () => {
    // A forged or stale "ready" must be powerless.
    const { service } = build({
      video: { id: 'v_1', gumletAssetId: 'a_1' },
      verdict: { playable: false, reason: 'NOT_VERIFIED', detail: 'manifest not encrypted' },
    });
    const result = await service.handle({ asset_id: 'a_1', status: 'ready' });
    expect(result.action).toBe('blocked');
    expect(result.detail).toMatch(/NOT_VERIFIED/);
  });

  it('ignores an asset that belongs to no video', async () => {
    const { service, verify } = build({ video: null });
    const result = await service.handle({ asset_id: 'unknown', status: 'ready' });
    expect(result.matched).toBe(false);
    // And crucially: no verification was attempted against nothing.
    expect(verify).not.toHaveBeenCalled();
  });

  it('ignores non-terminal statuses instead of churning', async () => {
    const { service, verify } = build({ video: { id: 'v_1', gumletAssetId: 'a_1' } });
    const result = await service.handle({ asset_id: 'a_1', status: 'processing' });
    expect(result.action).toBe('ignored');
    expect(verify).not.toHaveBeenCalled();
  });

  it('handles a duplicate delivery identically (idempotent)', async () => {
    const { service } = build({ video: { id: 'v_1', gumletAssetId: 'a_1' } });
    const first = await service.handle({ asset_id: 'a_1', status: 'ready' });
    const second = await service.handle({ asset_id: 'a_1', status: 'ready' });
    expect(second).toEqual(first);
  });

  it('handles an out-of-order event without granting playback', async () => {
    // A late "processing" arriving after "ready" must not revoke a legitimately
    // verified video by writing anything itself - it simply takes no action.
    const { service } = build({ video: { id: 'v_1', gumletAssetId: 'a_1' } });
    const result = await service.handle({ asset_id: 'a_1', status: 'processing' });
    expect(result.action).toBe('ignored');
  });

  it('ignores an event with no asset id', async () => {
    const { service } = build();
    const result = await service.handle({ status: 'ready' });
    expect(result.matched).toBe(false);
  });
});

describe('webhook controller', () => {
  const controller = (service: unknown) => new GumletWebhookController(service as never);

  it('rejects an unsigned request before touching the body', async () => {
    const handle = jest.fn();
    await expect(
      controller({ verifySignature: () => false, handle }).handle(
        { asset_id: 'a_1', status: 'ready' } as never,
        undefined,
        { rawBody: Buffer.from(BODY) } as never,
      ),
    ).rejects.toThrow();
    expect(handle).not.toHaveBeenCalled();
  });

  it('acknowledges a verified event with 200 semantics', async () => {
    const svc = build({ video: { id: 'v_1', gumletAssetId: 'a_1' } }).service;
    const result = await controller(svc).handle(
      { asset_id: 'a_1', status: 'ready' } as never,
      SIGNATURE,
      { rawBody: Buffer.from(BODY) } as never,
    );
    expect(result).toEqual({ received: true, matched: true, action: 'verified' });
  });

  it('acknowledges an uninteresting event rather than erroring', async () => {
    // A 5xx would make Gumlet retry an event that can never become actionable.
    const svc = build().service;
    const result = await controller(svc).handle(
      {} as never,
      createHmac('sha256', SECRET).update(Buffer.from('{}')).digest('hex'),
      { rawBody: Buffer.from('{}') } as never,
    );
    expect(result.received).toBe(true);
  });
});