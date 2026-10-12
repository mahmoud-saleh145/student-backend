import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { PrismaService } from '../../database/prisma.service';
import { DrmVerificationService } from '../playback/drm-verification.service';

/**
 * Gumlet asset-lifecycle webhooks.
 *
 * WHY THIS EXISTS
 *
 * Without it, a video stays "processing" until something polls it. Polling works
 * (the dashboard does it), but it is wasteful and adds latency to the moment a
 * student can first watch their lesson. A webhook lets the platform react when
 * the asset actually changes state.
 *
 * SECURITY - THIS IS A PUBLIC, UNAUTHENTICATED ENDPOINT
 *
 * A webhook endpoint is reachable by anyone who learns the URL, so it is treated
 * as hostile input throughout:
 *
 *   1. The signature is verified BEFORE the body is parsed or trusted, using a
 *      constant-time comparison. An unverified body never reaches the database.
 *   2. A missing/blank secret refuses EVERY event rather than accepting unsigned
 *      ones. Failing open here would let anyone mark any asset "ready".
 *   3. The event only ever names an ASSET ID. We look the video up ourselves and
 *      re-read the true state from Gumlet via `DrmVerificationService.verify()`.
 *      The payload is a notification, never a source of truth - so a forged or
 *      replayed event cannot make an unverified video playable.
 *   4. Processing is idempotent. Duplicate and out-of-order deliveries converge,
 *      because each one re-reads the provider instead of trusting the payload.
 *   5. Only after the work has been safely persisted (or safely declined) does the
 *      endpoint acknowledge with 2xx.
 *
 * Re-verification on every event is deliberate. It costs one asset read and one
 * manifest fetch per real lifecycle change, and buys immunity to spoofed states.
 */

/** Statuses that mean "this asset is finished, successfully or not". */
const TERMINAL = new Set(['ready', 'errored', 'failed']);

export interface GumletWebhookEvent {
  asset_id?: string;
  assetId?: string;
  status?: string;
  type?: string;
  event?: string;
  [k: string]: unknown;
}

@Injectable()
export class GumletWebhookService {
  private readonly logger = new Logger(GumletWebhookService.name);
  private readonly secret: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly drmVerification: DrmVerificationService,
    config: ConfigService,
  ) {
    this.secret = (config.get<string>('video.drm.gumlet.webhookSecret') ?? '').trim();
  }

  /** True when a shared secret is configured. Without it nothing is accepted. */
  isConfigured(): boolean {
    return this.secret.length > 0;
  }

  /**
   * Verify `X-Gumlet-Signature` against the RAW request body.
   *
   * The raw bytes matter: re-serialising the parsed JSON changes whitespace and
   * key order, and the HMAC would not match. That is why the controller passes
   * `req.rawBody` rather than the parsed object.
   */
  verifySignature(rawBody: Buffer | string, header: string | undefined): boolean {
    if (!this.secret) {
      // Refuse rather than accept. An unconfigured webhook must never be a
      // bypass that lets anyone mark assets ready.
      this.logger.error('Gumlet webhook received but no webhook secret is configured; refusing');
      return false;
    }
    if (!header) return false;

    // Accept the common framings so a provider change does not silently break us.
    const provided = header.trim().replace(/^sha256=/i, '');
    let expected: string;
    try {
      expected = createHmac('sha256', this.secret).update(rawBody).digest('hex');
    } catch {
      return false;
    }

    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    // timingSafeEqual throws on length mismatch, so compare lengths first.
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /**
   * Handle one verified event.
   *
   * Returns a small summary so the controller can log and acknowledge. Never
   * throws for a well-formed but uninteresting event - a 500 would make the
   * provider retry forever.
   */
  async handle(event: GumletWebhookEvent): Promise<{
    matched: boolean;
    assetId: string | null;
    status: string | null;
    action: 'ignored' | 'verified' | 'blocked';
    detail: string;
  }> {
    const assetId = (event.asset_id ?? event.assetId ?? null) as string | null;
    const status = typeof event.status === 'string' ? event.status : null;

    if (!assetId) {
      return { matched: false, assetId: null, status, action: 'ignored', detail: 'No asset id in event.' };
    }

    const video = await this.prisma.video.findFirst({
      where: { gumletAssetId: assetId, ...notDeleted() },
      select: { id: true, gumletAssetId: true, gumletStatus: true },
    });

    if (!video) {
      // Could be a video we deleted, or an asset from another workspace.
      this.logger.warn(`Gumlet webhook for unknown asset ${assetId} ignored`);
      return {
        matched: false, assetId, status,
        action: 'ignored', detail: 'No video references this asset.',
      };
    }

    if (!status || !TERMINAL.has(status)) {
      // Still processing. Nothing to do; the dashboard poll will catch up.
      return {
        matched: true, assetId, status,
        action: 'ignored', detail: `Status "${status ?? 'unknown'}" is not terminal.`,
      };
    }

    // Re-verify against the provider rather than believing the payload. This is
    // what makes a forged "ready" harmless.
    const verdict = await this.drmVerification.verify(video.id);
    if (verdict.playable) {
      this.logger.log(`Gumlet webhook: video ${video.id} verified DRM and is playable`);
      return { matched: true, assetId, status, action: 'verified', detail: 'DRM verified.' };
    }

    this.logger.warn(
      `Gumlet webhook: video ${video.id} is NOT playable (${verdict.reason}) - ${verdict.detail}`,
    );
    return {
      matched: true, assetId, status, action: 'blocked',
      detail: verdict.playable ? '' : `${verdict.reason}: ${verdict.detail}`,
    };
  }
}

function notDeleted() {
  return { deletedAt: null } as const;
}

/** Thrown by the controller when a signature fails. */
export class WebhookSignatureError extends AppException {
  constructor() {
    super(ErrorCode.FORBIDDEN, { message: 'Invalid webhook signature' });
  }
}