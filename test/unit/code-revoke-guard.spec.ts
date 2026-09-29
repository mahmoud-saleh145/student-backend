import { CodeStatus, UserRole } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { CodesService } from '../../src/modules/codes/codes.service';

/**
 * Cancelling an access card is only ever valid on a card still worth cancelling.
 *
 * Revoking a REDEEMED or EXHAUSTED card used to succeed and stamp it REVOKED,
 * which rewrites its commercial history: the row stops reading "sold and used"
 * and starts reading "cancelled". The redemption rows survive either way, but
 * the code's own status is what the Codes screen and the revenue
 * reconciliation read, so the two stop agreeing.
 *
 * The dashboard only offers Cancel on an ACTIVE card, which is not a defence —
 * it decides from a list that may be seconds stale, and a card redeemed
 * between the page load and the click would have been overwritten.
 */

function build(status: CodeStatus, updatedCount = 1) {
  // Typed argument: an untyped `jest.fn(async () => …)` infers its parameter
  // list as `[]`, and `mock.calls[0][0]` then refuses to compile under strict.
  const updateMany = jest.fn(
    async (_args: { where: { id: string; status: CodeStatus } }) => ({ count: updatedCount }),
  );

  const prisma = {
    accessCode: {
      findUnique: jest.fn(async () => ({
        id: 'cod_1',
        status,
        code: 'ABCD-EFGH-JKMN',
      })),
      updateMany,
    },
  };

  const service = new CodesService(
    prisma as never,
    { record: jest.fn(async () => undefined) } as never,
    {} as never,
  );

  return { service, updateMany };
}

const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };

describe('cancelling an access card', () => {
  it('cancels one that is still active', async () => {
    const { service, updateMany } = build(CodeStatus.ACTIVE);

    await expect(service.revoke('cod_1', ADMIN, 'printed in error')).resolves.toMatchObject({
      status: CodeStatus.REVOKED,
    });

    // Conditional on the status, so a redemption landing mid-flight cannot be
    // overwritten by a cancel that read a stale row.
    const call = updateMany.mock.calls[0];
    if (!call) throw new Error('updateMany was never called');
    expect(call[0].where.status).toBe(CodeStatus.ACTIVE);
  });

  // The states a card can already be in. `EXHAUSTED` is the shipped label for
  // "fully used"; there is no separate REDEEMED value in this schema.
  for (const status of [CodeStatus.EXHAUSTED, CodeStatus.EXPIRED, CodeStatus.REVOKED] as const) {
    it(`refuses one that is already ${status}`, async () => {
      const { service, updateMany } = build(status);

      await expect(service.revoke('cod_1', ADMIN, 'tidying up')).rejects.toBeInstanceOf(
        AppException,
      );
      expect(updateMany).not.toHaveBeenCalled();
    });
  }

  it('refuses when the row changed underneath it', async () => {
    // Read as ACTIVE, but the conditional update matched nothing — someone
    // redeemed it in between. Reporting success here would tell the operator
    // a card was cancelled when a student had just used it.
    const { service } = build(CodeStatus.ACTIVE, 0);

    await expect(service.revoke('cod_1', ADMIN, 'race')).rejects.toBeInstanceOf(AppException);
  });
});
