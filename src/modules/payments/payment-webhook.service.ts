import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { PaymentConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';

import { PaymentsService } from './payments.service';

/**
 * Provider webhooks.
 *
 * Three rules, all of them learned the hard way in payment integrations:
 *
 *  1. **Verify the signature before trusting anything**, using the RAW body.
 *     Re-serializing the parsed JSON changes key order and whitespace, and the
 *     HMAC stops matching — which is why main.ts enables `_rawBody`.
 *
 *  2. **De-duplicate.** Providers retry aggressively and deliver out of order.
 *     Every delivery is fingerprinted into IdempotencyRecord, so a replay is a
 *     no-op rather than a second capture.
 *
 *  3. **Always answer 200 once the signature checks out.** A non-2xx makes the
 *     provider retry forever; internal problems are logged and reconciled, not
 *     pushed back onto the provider.
 */
@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);
  private readonly cfg: PaymentConfig;

  constructor(
    private readonly payments: PaymentsService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.cfg = config.getOrThrow<PaymentConfig>('payment');
  }

  async handlePaymob(body: Record<string, unknown>, hmac: string, _rawBody?: Buffer) {
    if (!this.cfg.paymob.hmacSecret) {
      this.logger.error('Paymob webhook received but PAYMOB_HMAC_SECRET is not set');
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Webhook not configured' });
    }

    const object = (body.obj ?? {}) as Record<string, unknown>;

    // Paymob signs a concatenation of specific fields in a fixed order rather
    // than the raw body — hence the explicit field list.
    const canonical = [
      'amount_cents',
      'created_at',
      'currency',
      'error_occured',
      'has_parent_transaction',
      'id',
      'integration_id',
      'is_3d_secure',
      'is_auth',
      'is_capture',
      'is_refunded',
      'is_standalone_payment',
      'is_voided',
      'order.id',
      'owner',
      'pending',
      'source_data.pan',
      'source_data.sub_type',
      'source_data.type',
      'success',
    ]
      .map((path) => this.readPath(object, path))
      .join('');

    const expected = createHmac('sha512', this.cfg.paymob.hmacSecret)
      .update(canonical)
      .digest('hex');

    if (!this.safeCompare(expected, hmac)) {
      this.logger.warn('Paymob webhook rejected: HMAC mismatch');
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Invalid signature' });
    }

    const fingerprint = PaymentsService.webhookFingerprint('paymob', body);
    if (await this.alreadyProcessed(fingerprint)) {
      return { ok: true, deduplicated: true };
    }

    const success = object.success === true || object.success === 'true';
    const orderId = this.readPath(object, 'order.id');
    const transactionId = String(object.id ?? '');

    // The merchant order id carries our payment id; without it we cannot
    // reconcile, so log loudly rather than guessing.
    const paymentId = this.extractPaymentId(object);
    if (!paymentId) {
      this.logger.error(
        `Paymob webhook has no resolvable payment id (order=${orderId}, txn=${transactionId})`,
      );
      await this.markProcessed(fingerprint, 'unresolved');
      return { ok: true, unresolved: true };
    }

    try {
      if (success) {
        await this.payments.capture({
          paymentId,
          providerReference: transactionId,
          rawPayload: body,
        });
      } else {
        await this.payments.fail(paymentId, String(object.data_message ?? 'declined'), body);
      }
    } catch (e) {
      this.logger.error(`Paymob webhook processing failed: ${(e as Error).message}`);
    }

    await this.markProcessed(fingerprint, success ? 'captured' : 'failed');
    return { ok: true };
  }

  async handleStripe(body: Record<string, unknown>, signature: string, _rawBody?: Buffer) {
    if (!this.cfg.stripe.webhookSecret) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Webhook not configured' });
    }
    if (!_rawBody) {
      throw new AppException(ErrorCode.VALIDATION_ERROR, { message: 'Raw body unavailable' });
    }

    // Stripe's scheme: t=<timestamp>,v1=<hmac of "timestamp._rawBody">.
    const parts = Object.fromEntries(
      signature.split(',').map((p) => {
        const [k, v] = p.split('=');
        return [k ?? '', v ?? ''];
      }),
    );

    const timestamp = parts.t;
    const provided = parts.v1;

    if (!timestamp || !provided) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Malformed signature header' });
    }

    // Reject replays of an old but validly signed payload.
    const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
    if (!Number.isFinite(ageSeconds) || ageSeconds > 300) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Signature timestamp out of range' });
    }

    const expected = createHmac('sha256', this.cfg.stripe.webhookSecret)
      .update(`${timestamp}.${_rawBody.toString('utf8')}`)
      .digest('hex');

    if (!this.safeCompare(expected, provided)) {
      throw new AppException(ErrorCode.FORBIDDEN, { message: 'Invalid signature' });
    }

    const fingerprint = PaymentsService.webhookFingerprint('stripe', body);
    if (await this.alreadyProcessed(fingerprint)) {
      return { ok: true, deduplicated: true };
    }

    const type = String(body.type ?? '');
    const data = ((body.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
    const metadata = (data.metadata ?? {}) as Record<string, unknown>;
    const paymentId = String(metadata.paymentId ?? '');

    if (paymentId) {
      try {
        if (type === 'checkout.session.completed' || type === 'payment_intent.succeeded') {
          await this.payments.capture({
            paymentId,
            providerReference: String(data.id ?? ''),
            rawPayload: body,
          });
        } else if (type === 'payment_intent.payment_failed') {
          await this.payments.fail(paymentId, 'stripe_failed', body);
        }
      } catch (e) {
        this.logger.error(`Stripe webhook processing failed: ${(e as Error).message}`);
      }
    }

    await this.markProcessed(fingerprint, type);
    return { ok: true };
  }

  // ---------------------------------------------------------------------------

  private extractPaymentId(object: Record<string, unknown>): string | null {
    const order = (object.order ?? {}) as Record<string, unknown>;
    const merchantOrderId = String(order.merchant_order_id ?? '');
    if (merchantOrderId) return merchantOrderId;

    const extras = (object.payment_key_claims ?? {}) as Record<string, unknown>;
    const extra = (extras.extra ?? {}) as Record<string, unknown>;
    return extra.paymentId ? String(extra.paymentId) : null;
  }

  private readPath(source: Record<string, unknown>, path: string): string {
    const value = path
      .split('.')
      .reduce<unknown>((acc, key) => (acc as Record<string, unknown>)?.[key], source);
    return value === undefined || value === null ? '' : String(value);
  }

  private safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  private async alreadyProcessed(fingerprint: string): Promise<boolean> {
    const existing = await this.prisma.idempotencyRecord.findUnique({
      where: { key: fingerprint },
    });
    return Boolean(existing);
  }

  private async markProcessed(fingerprint: string, outcome: string): Promise<void> {
    await this.prisma.idempotencyRecord
      .create({
        data: {
          key: fingerprint,
          scope: 'payment-webhook',
          statusCode: 200,
          response: { outcome },
          expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
        },
      })
      .catch(() => undefined);
  }
}
