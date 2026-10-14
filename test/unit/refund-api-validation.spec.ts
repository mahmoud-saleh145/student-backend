import { BadRequestException, ValidationPipe, type ArgumentMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PaymentStatus, UserRole } from '@prisma/client';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import {
  CompleteRefundDto,
  FailRefundDto,
  PaymentsController,
  RefundDto,
} from '../../src/modules/payments/payments.controller';
import { PaymentsService } from '../../src/modules/payments/payments.service';
import { refundStateOf } from '../../src/modules/payments/refund-state';

/**
 * The refund API at its boundary.
 *
 *  - Request validation, run through a ValidationPipe configured exactly as
 *    `main.ts` configures the global one (whitelist, forbidNonWhitelisted,
 *    transform, NO implicit conversion — so "true" is not a boolean and a
 *    float is not silently accepted as money).
 *  - Route authorization: every refund route is ADMIN/MASTER only.
 *  - Payment lists: a pending refund is shown beside the payment's own status,
 *    never by relabelling a PAID payment as refunded.
 *
 * Service-level rules (balance, attestation, transitions, idempotency) are in
 * refunds.spec.ts and, against real PostgreSQL, refunds.e2e-spec.ts.
 */

const pipe = new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
  transformOptions: { enableImplicitConversion: false },
  stopAtFirstError: false,
});

const validate = (metatype: ArgumentMetadata['metatype'], body: unknown) =>
  pipe.transform(body, { type: 'body', metatype, data: '' });

/** The property names a rejected body was rejected for. */
async function rejectedFields(metatype: ArgumentMetadata['metatype'], body: unknown): Promise<string> {
  try {
    await validate(metatype, body);
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as { message: string[] };
    return response.message.join(' | ');
  }
  throw new Error(`expected ${JSON.stringify(body)} to be rejected`);
}

const KEY = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const valid = { type: 'PARTIAL', amount: '10.50', idempotencyKey: KEY, confirmMoneyReturned: true };

describe('POST admin/payments/:id/refund — request validation', () => {
  it('accepts a well-formed request', async () => {
    await expect(validate(RefundDto, valid)).resolves.toMatchObject(valid);
    await expect(
      validate(RefundDto, { type: 'FULL', idempotencyKey: KEY, completion: 'PENDING' }),
    ).resolves.toMatchObject({ completion: 'PENDING' });
  });

  it.each([
    ['letters', 'ten'],
    ['three decimals', '10.005'],
    ['a negative amount', '-5'],
    ['an exponent', '1e3'],
    ['a comma decimal', '10,50'],
    ['whitespace padding', ' 10 '],
  ])('rejects an amount with %s', async (_label, amount) => {
    expect(await rejectedFields(RefundDto, { ...valid, amount })).toMatch(/amount/);
  });

  it('rejects a float that does not survive as a 2-decimal amount', async () => {
    // 0.1 + 0.2 arrives as 0.30000000000000004 — refused, never rounded.
    expect(await rejectedFields(RefundDto, { ...valid, amount: 0.1 + 0.2 })).toMatch(/amount/);
  });

  it('accepts an exact numeric amount by converting it to its decimal string', async () => {
    await expect(validate(RefundDto, { ...valid, amount: 12.5 })).resolves.toMatchObject({ amount: '12.5' });
  });

  it('leaves zero to the service, which refuses it', async () => {
    // "0" is a well-formed amount; "must be greater than 0" is a business rule
    // enforced by RefundsService (see refunds.spec.ts › amount validation).
    await expect(validate(RefundDto, { ...valid, amount: '0' })).resolves.toBeDefined();
  });

  it.each([
    ['missing', undefined],
    ['too short', 'abc'],
    ['with forbidden characters', 'bad key!!'],
    ['too long', 'x'.repeat(101)],
  ])('rejects an idempotency key that is %s', async (_label, idempotencyKey) => {
    expect(await rejectedFields(RefundDto, { ...valid, idempotencyKey })).toMatch(/idempotencyKey/);
  });

  it('rejects an unknown refund type or completion mode', async () => {
    expect(await rejectedFields(RefundDto, { ...valid, type: 'HALF' })).toMatch(/type/);
    expect(await rejectedFields(RefundDto, { ...valid, completion: 'LATER' })).toMatch(/completion/);
  });

  it('does not treat the string "true" as the money-returned attestation', async () => {
    expect(await rejectedFields(RefundDto, { ...valid, confirmMoneyReturned: 'true' })).toMatch(
      /confirmMoneyReturned/,
    );
  });

  it('rejects fields the API does not define (e.g. the old confirmManualRefund)', async () => {
    expect(await rejectedFields(RefundDto, { ...valid, confirmManualRefund: true })).toMatch(
      /confirmManualRefund/,
    );
  });

  it('rejects a reason longer than 500 characters', async () => {
    expect(await rejectedFields(RefundDto, { ...valid, reason: 'x'.repeat(501) })).toMatch(/reason/);
  });
});

describe('completing and failing a pending refund — request validation', () => {
  it('requires the boolean attestation to complete', async () => {
    expect(await rejectedFields(CompleteRefundDto, {})).toMatch(/confirmMoneyReturned/);
    expect(await rejectedFields(CompleteRefundDto, { confirmMoneyReturned: 'yes' })).toMatch(
      /confirmMoneyReturned/,
    );
    await expect(validate(CompleteRefundDto, { confirmMoneyReturned: true })).resolves.toBeDefined();
  });

  it('rejects an over-long reference and the old providerReference field', async () => {
    expect(
      await rejectedFields(CompleteRefundDto, { confirmMoneyReturned: true, reference: 'r'.repeat(201) }),
    ).toMatch(/reference/);
    expect(
      await rejectedFields(CompleteRefundDto, { confirmMoneyReturned: true, providerReference: 'x' }),
    ).toMatch(/providerReference/);
  });

  it('requires a reason of at least 3 characters to fail', async () => {
    expect(await rejectedFields(FailRefundDto, {})).toMatch(/reason/);
    expect(await rejectedFields(FailRefundDto, { reason: 'no' })).toMatch(/reason/);
    await expect(validate(FailRefundDto, { reason: 'Card closed' })).resolves.toBeDefined();
  });
});

describe('refund routes are administrators only', () => {
  const reflector = new Reflector();
  it.each(['refundSummary', 'refund', 'completeRefund', 'failRefund'] as const)(
    '%s is restricted to MASTER and ADMIN',
    (method) => {
      const roles = reflector.get<UserRole[]>(
        ROLES_KEY,
        PaymentsController.prototype[method] as (...args: unknown[]) => unknown,
      );
      expect([...roles].sort()).toEqual([UserRole.ADMIN, UserRole.MASTER].sort());
    },
  );
});

describe('payment lists show a pending refund without relabelling the payment', () => {
  const request = (id: string, amount: string) => ({
    id,
    type: 'refund_request',
    amount,
    rawPayload: {},
  });
  const resolution = (id: string, type: 'refund' | 'refund_failed', requestId: string, amount: string | null) => ({
    id,
    type,
    amount,
    rawPayload: { requestId },
  });

  it('keeps a PAID payment PAID while a refund is pending', () => {
    expect(refundStateOf({ status: PaymentStatus.PAID }, [request('r1', '100.00')])).toEqual({
      refundStatus: 'PENDING',
      pendingRefundAmount: 100,
    });
  });

  it('a failed request is no longer pending; a completed one is reported by the payment status', () => {
    expect(
      refundStateOf({ status: PaymentStatus.PAID }, [
        request('r1', '100.00'),
        resolution('f1', 'refund_failed', 'r1', null),
      ]),
    ).toEqual({ refundStatus: 'NONE', pendingRefundAmount: 0 });
    expect(
      refundStateOf({ status: PaymentStatus.PARTIALLY_REFUNDED }, [
        request('r1', '100.00'),
        resolution('c1', 'refund', 'r1', '100.00'),
      ]),
    ).toEqual({ refundStatus: 'PARTIALLY_REFUNDED', pendingRefundAmount: 0 });
  });

  it('reports pending alongside earlier completed refunds', () => {
    expect(
      refundStateOf({ status: PaymentStatus.PARTIALLY_REFUNDED }, [
        { id: 'c0', type: 'refund', amount: '50.00', rawPayload: {} },
        request('r1', '25.50'),
      ]),
    ).toEqual({ refundStatus: 'PENDING', pendingRefundAmount: 25.5 });
  });

  function buildPayments(rows: Record<string, unknown>[]) {
    const aggregate = jest.fn(async () => ({ _sum: { amount: 300, refundedAmount: 120.5 } }));
    const findMany = jest.fn(async () => rows);
    const prisma = {
      payment: { findMany, count: jest.fn(async () => rows.length), aggregate },
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const access = { readableCourseIds: jest.fn(async () => null) };
    const service = new PaymentsService(
      prisma as never,
      {} as never,
      access as never,
      { getOrThrow: () => ({ provider: 'none', defaultPlatformSharePercent: 30 }) } as never,
    );
    return { service, findMany, aggregate };
  }

  const row = {
    id: 'pay_1',
    amount: '300.00',
    currency: 'EGP',
    status: PaymentStatus.PAID,
    provider: 'MANUAL',
    providerReference: null,
    refundedAmount: '0.00',
    paidAt: new Date('2026-09-01T10:00:00Z'),
    createdAt: new Date('2026-09-01T09:00:00Z'),
    checkoutUrl: null,
    course: { id: 'crs_a', title: 'Anatomy I' },
    user: { id: 'usr_1', fullName: 'Sara', phone: '0100' },
    coursePrice: null,
    transactions: [request('r1', '300.00')],
  };

  it('the student list (payments/mine) shows status PAID with refundStatus PENDING', async () => {
    const { service, findMany } = buildPayments([row]);
    const page = await service.listForUser('usr_1', 1, 20);

    expect(page.items[0]).toMatchObject({
      status: PaymentStatus.PAID,
      refundStatus: 'PENDING',
      refundedAmount: 0,
      pendingRefundAmount: 300,
    });
    expect(JSON.stringify((findMany.mock.calls[0] as unknown[])[0])).toContain('refund_request');
  });

  it('the admin list shows the same, and totals cover refunded payments too', async () => {
    const { service, aggregate } = buildPayments([row]);
    const page = await service.listForAdmin({
      page: 1,
      pageSize: 20,
      actor: { id: 'usr_admin', role: UserRole.ADMIN },
    });

    expect(page.items[0]).toMatchObject({ status: 'PAID', refundStatus: 'PENDING', pendingRefundAmount: 300 });
    // Totals used to sum PAID only, so refunded payments vanished and
    // `refunded` was always 0.
    const where = JSON.stringify((aggregate.mock.calls[0] as unknown[])[0]);
    expect(where).toContain('PARTIALLY_REFUNDED');
    expect(where).toContain('REFUNDED');
    expect(page.meta.totals).toEqual({ paid: 300, refunded: 120.5, net: 179.5 });
  });
});
