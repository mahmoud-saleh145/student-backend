import { PaymentWebhookService } from '../../src/modules/payments/payment-webhook.service';
import { PaymentsService } from '../../src/modules/payments/payments.service';

/**
 * No online payments — anywhere, under any configuration.
 *
 * Owner decision (2026-10-30, Phase 6 §4.1): there are no online payments in
 * Student Center, in any application or on any platform. Course and part
 * purchases run through the approved offline process — a payment created by
 * the enrolment flow stays PENDING with `checkoutUrl: null`, and an authorized
 * administrator confirms it (POST admin/payments/:id/confirm) after the money
 * changes hands outside the app.
 *
 * The enforcement is layered, and each layer has its own pin:
 *   1. env.validation.ts accepts only PAYMENT_PROVIDER=none
 *      → env-validation.spec.ts
 *   2. CourseAccessService never offers the PAYMENT method
 *      → online-payment-disabled.spec.ts, join-options.spec.ts
 *   3. PaymentsService.buildCheckoutUrl returns null unconditionally — this
 *      file
 *   4. PaymentWebhookService refuses every provider webhook before reading the
 *      payload, even with an HMAC secret configured — this file
 *
 * Historical Payment rows, the capture/refund code paths and the offline
 * admin-confirmation flow are deliberately preserved.
 */

type CheckoutSeam = {
  buildCheckoutUrl: (id: string, currency: string, amount: number) => Promise<string | null>;
};

function paymentsService(cfg: Record<string, unknown>): CheckoutSeam {
  return new PaymentsService(
    null as never, // prisma — buildCheckoutUrl must not touch it
    null as never, // audit
    null as never, // access
    { getOrThrow: () => cfg } as never,
  ) as unknown as CheckoutSeam;
}

const PAYMOB_CFG = {
  provider: 'paymob',
  currency: 'EGP',
  returnUrl: 'eduplatform://payment/return',
  paymob: { apiKey: 'k', integrationId: 'i', iframeId: 'f', hmacSecret: 's'.repeat(32) },
  stripe: { secretKey: '', webhookSecret: '' },
};

const STRIPE_CFG = {
  ...PAYMOB_CFG,
  provider: 'stripe',
  stripe: { secretKey: 'sk_test_x', webhookSecret: 'whsec_x' },
};

const NONE_CFG = {
  ...PAYMOB_CFG,
  provider: 'none',
  paymob: { apiKey: '', integrationId: '', iframeId: '', hmacSecret: '' },
  stripe: { secretKey: '', webhookSecret: '' },
};

describe('checkout initiation is dead under every configuration', () => {
  it('provider none: no checkout URL', async () => {
    await expect(paymentsService(NONE_CFG).buildCheckoutUrl('pay_1', 'EGP', 100)).resolves.toBeNull();
  });

  it('a fully-credentialed paymob config still gets no checkout URL', async () => {
    // Before Phase 6 this configuration produced an accept.paymob.com iframe
    // URL. The owner abolished online payment, so the same configuration now
    // proves the hand-off is gone, not merely unconfigured.
    await expect(paymentsService(PAYMOB_CFG).buildCheckoutUrl('pay_1', 'EGP', 100)).resolves.toBeNull();
  });

  it('a fully-credentialed stripe config still gets no checkout URL', async () => {
    await expect(paymentsService(STRIPE_CFG).buildCheckoutUrl('pay_1', 'EGP', 100)).resolves.toBeNull();
  });
});

function webhookService(cfg: Record<string, unknown>) {
  return new PaymentWebhookService(
    // Both doubles throw on contact: the refusal must happen before the
    // handler reaches a payment or the database.
    new Proxy({}, { get: () => () => { throw new Error('payments touched'); } }) as never,
    new Proxy({}, { get: () => () => { throw new Error('prisma touched'); } }) as never,
    { getOrThrow: () => cfg } as never,
  );
}

describe('provider webhooks are refused before the payload is read', () => {
  it('paymob webhook: refused even with an HMAC secret configured', async () => {
    await expect(
      webhookService(NONE_CFG).handlePaymob({ obj: { id: 1, success: true } }, 'deadbeef'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // The old guard only checked the secret. With a secret present and the
    // provider abolished, the refusal must still hold.
    const withSecret = { ...NONE_CFG, paymob: { ...NONE_CFG.paymob, hmacSecret: 'x'.repeat(64) } };
    await expect(
      webhookService(withSecret).handlePaymob({ obj: { id: 1, success: true } }, 'deadbeef'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('stripe webhook: refused the same way', async () => {
    await expect(
      webhookService(NONE_CFG).handleStripe({ type: 'checkout.session.completed' }, 't=1,v1=x'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const withSecret = { ...NONE_CFG, stripe: { secretKey: 'sk', webhookSecret: 'whsec_y' } };
    await expect(
      webhookService(withSecret).handleStripe({ type: 'checkout.session.completed' }, 't=1,v1=x'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('the refusal never consults the database or the payments service', async () => {
    // The proxies above throw plain Errors on any property access. Seeing the
    // FORBIDDEN AppException (and not 'payments touched'/'prisma touched')
    // proves the guard fires first.
    await expect(webhookService(NONE_CFG).handlePaymob({}, '')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
