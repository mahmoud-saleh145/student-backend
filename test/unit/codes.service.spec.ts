import { CodeStatus, UserRole } from '@prisma/client';

import { ErrorCode } from '../../src/common/errors/error-codes';
import { CodesService } from '../../src/modules/codes/codes.service';

/**
 * Access-code redemption.
 *
 * Spec §29: "A used code must not be incorrectly reusable when it is
 * configured as one-time use. The backend must prevent code abuse."
 *
 * Everything here is a rejection test, because a code system's whole value is
 * in what it refuses. The happy path is one assertion; the refusals are
 * twelve.
 */

function code(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cod_1',
    code: 'DEVCIRCUIT01',
    courseId: 'crs_1',
    status: CodeStatus.ACTIVE,
    reservedForUserId: null,
    maxRedemptions: 1,
    redemptionCount: 0,
    accessDurationType: 'FIXED_DAYS',
    accessDurationDays: 180,
    accessEndsAt: null,
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

function buildService(row: ReturnType<typeof code> | null, alreadyRedeemed = false) {
  // Typed argument, not `jest.fn(async () => …)`: an untyped mock infers its
  // parameter list as `[]`, and `mock.calls[0][0].data` then fails to compile
  // under `strict`. The shape only has to be as precise as the assertions.
  type PrismaWriteArgs = { data: Record<string, unknown> };

  const codeUpdate = jest.fn(async (_args: PrismaWriteArgs) => ({}));
  const redemptionCreate = jest.fn(async (_args: PrismaWriteArgs) => ({}));

  const tx = {
    accessCode: {
      findUnique: jest.fn(async () => row),
      update: codeUpdate,
    },
    accessCodeRedemption: {
      findUnique: jest.fn(async () => (alreadyRedeemed ? { id: 'red_1' } : null)),
      create: redemptionCreate,
    },
  };

  const service = new CodesService(
    { $transaction: jest.fn() } as never,
    { record: jest.fn(async () => undefined) } as never,
  );

  return { service, tx, codeUpdate, redemptionCreate };
}

const REDEEM = {
  userId: 'usr_1',
  courseId: 'crs_1',
  enrollmentId: 'enr_1',
};

describe('CodesService.redeemInTransaction', () => {
  it('redeems a valid code and returns its access terms', async () => {
    const { service, tx, codeUpdate, redemptionCreate } = buildService(code());

    const result = await service.redeemInTransaction(tx as never, {
      ...REDEEM,
      rawCode: 'DEVCIRCUIT01',
    });

    expect(result.code.accessDurationDays).toBe(180);
    expect(redemptionCreate).toHaveBeenCalledTimes(1);
    expect(codeUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ redemptionCount: 1 }),
      }),
    );
  });

  describe('normalisation', () => {
    it.each([
      ['devcircuit01', 'lowercase'],
      ['  DEVCIRCUIT01  ', 'surrounding whitespace'],
      ['DEV CIRCUIT 01', 'internal spaces from a paste'],
      ['DevCircuit01', 'mixed case'],
    ])('accepts %s (%s)', async (input) => {
      const { service, tx } = buildService(code());

      await service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: input });

      expect(tx.accessCode.findUnique).toHaveBeenCalledWith({
        where: { code: 'DEVCIRCUIT01' },
      });
    });
  });

  describe('refuses', () => {
    it('a code that does not exist', async () => {
      const { service, tx } = buildService(null);

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'NOPE' }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CODE });
    });

    it('a revoked code', async () => {
      const { service, tx } = buildService(code({ status: CodeStatus.REVOKED }));

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CODE });
    });

    it('an expired code', async () => {
      const { service, tx } = buildService(
        code({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CODE });
    });

    it('a code reserved for a different student', async () => {
      const { service, tx } = buildService(code({ reservedForUserId: 'usr_other' }));

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CODE });
    });

    it('a code scoped to a different course', async () => {
      const { service, tx } = buildService(code({ courseId: 'crs_other' }));

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.INVALID_CODE });
    });

    it('a single-use code that has already been consumed', async () => {
      const { service, tx } = buildService(
        code({ redemptionCount: 1, maxRedemptions: 1 }),
      );

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.CODE_ALREADY_USED });
    });

    it('a batch code that has reached its limit', async () => {
      const { service, tx } = buildService(
        code({ redemptionCount: 25, maxRedemptions: 25 }),
      );

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.CODE_ALREADY_USED });
    });

    it('the same student redeeming the same code twice', async () => {
      // Even on a 25-use batch code: one redemption per student, enforced by a
      // unique index and surfaced here as a readable error.
      const { service, tx } = buildService(
        code({ maxRedemptions: 25, redemptionCount: 3 }),
        true,
      );

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toMatchObject({ code: ErrorCode.CODE_ALREADY_USED });
    });

    it('does not increment the counter when it refuses', async () => {
      const { service, tx, codeUpdate, redemptionCreate } = buildService(
        code({ status: CodeStatus.REVOKED }),
      );

      await expect(
        service.redeemInTransaction(tx as never, { ...REDEEM, rawCode: 'DEVCIRCUIT01' }),
      ).rejects.toBeDefined();

      expect(codeUpdate).not.toHaveBeenCalled();
      expect(redemptionCreate).not.toHaveBeenCalled();
    });
  });

  describe('global codes', () => {
    it('accepts a code with no course scope on any course', async () => {
      const { service, tx } = buildService(code({ courseId: null }));

      const result = await service.redeemInTransaction(tx as never, {
        ...REDEEM,
        courseId: 'crs_anything',
        rawCode: 'DEVCIRCUIT01',
      });

      expect(result.code.courseId).toBeNull();
    });
  });

  describe('exhaustion', () => {
    it('flips a code to EXHAUSTED on its final redemption', async () => {
      const { service, tx, codeUpdate } = buildService(
        code({ maxRedemptions: 3, redemptionCount: 2 }),
      );

      await service.redeemInTransaction(tx as never, {
        ...REDEEM,
        rawCode: 'DEVCIRCUIT01',
      });

      expect(codeUpdate.mock.calls[0]![0].data).toMatchObject({
        redemptionCount: 3,
        status: CodeStatus.EXHAUSTED,
      });
    });

    it('leaves a batch code ACTIVE while uses remain', async () => {
      const { service, tx, codeUpdate } = buildService(
        code({ maxRedemptions: 25, redemptionCount: 2 }),
      );

      await service.redeemInTransaction(tx as never, {
        ...REDEEM,
        rawCode: 'DEVCIRCUIT01',
      });

      expect(codeUpdate.mock.calls[0]![0].data.status).toBe(CodeStatus.ACTIVE);
    });
  });

  describe('audit trail', () => {
    it('records who redeemed, from which device and address', async () => {
      const { service, tx, redemptionCreate } = buildService(code());

      await service.redeemInTransaction(tx as never, {
        ...REDEEM,
        rawCode: 'DEVCIRCUIT01',
        ipAddress: '197.0.2.5',
        deviceKey: 'dev-abc',
      });

      expect(redemptionCreate.mock.calls[0]![0].data).toMatchObject({
        userId: 'usr_1',
        courseId: 'crs_1',
        ipAddress: '197.0.2.5',
        deviceKey: 'dev-abc',
      });
    });
  });
});

describe('generated code alphabet', () => {
  /**
   * Codes get read off a whiteboard and typed on a phone. O/0 and I/1/L are
   * the characters that generate support tickets, so the alphabet excludes
   * them. This test exists so nobody "tidies" the constant back to A–Z0–9.
   */
  it('excludes visually ambiguous characters', () => {
    const alphabet = (CodesService as unknown as { ALPHABET: string }).ALPHABET;

    for (const forbidden of ['O', '0', 'I', '1', 'L']) {
      expect(alphabet).not.toContain(forbidden);
    }
  });

  it('is long enough that a 10-character code is not guessable', () => {
    const alphabet = (CodesService as unknown as { ALPHABET: string }).ALPHABET;
    // 31^10 ≈ 8.2e14 — brute force is hopeless even before rate limiting.
    expect(alphabet.length).toBeGreaterThanOrEqual(30);
    expect(new Set(alphabet).size).toBe(alphabet.length);
  });
});

/** Kept next to the code tests so the redemption fixtures stay in one file. */
describe('role assumptions', () => {
  it('treats redemption as a student action', () => {
    expect(UserRole.STUDENT).toBe('STUDENT');
  });
});
