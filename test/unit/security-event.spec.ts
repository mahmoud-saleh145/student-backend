import { Prisma, SecurityEventType, SecuritySeverity } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { ERROR_MESSAGE } from '../../src/common/errors/error-codes';
import { AuthService } from '../../src/modules/auth/auth.service';
import { SecurityEventService } from '../../src/modules/security/security-event.service';

/**
 * Security telemetry must never cost us the request it describes — and,
 * equally, a request failing must never cost us the telemetry.
 *
 * The case that forced this: a refresh token whose signature still verifies
 * against a `sub` that no longer exists in `users`. The account is gone (a
 * reset database, a deleted user), the client still holds the token, and the
 * TOKEN_REUSE event written on that path carried the claimed id straight into
 * a foreign key. Postgres refused the row with
 * `security_events_userId_fkey`, and the event — the single most interesting
 * one in the whole system, a valid signature for a user who does not exist —
 * was dropped on the floor.
 *
 * `SecurityEvent.userId` is nullable by design ("some events have no user"),
 * so the fix detaches the reference rather than inventing one.
 */

// A faithful stand-in for what Prisma raises on a foreign-key violation.
function fkViolation(constraint: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    `\nInvalid \`this.prisma.securityEvent.create()\` invocation\n\nForeign key constraint violated on the constraint: \`${constraint}\``,
    {
      code: 'P2003',
      clientVersion: 'test',
      meta: { modelName: 'SecurityEvent', field_name: `${constraint} (index)` },
    },
  );
}

/**
 * The first argument of a mock's nth call.
 *
 * `noUncheckedIndexedAccess` is on, and a `jest.fn()` whose implementation
 * takes no parameters records its calls as an empty tuple, so the index has to
 * be guarded rather than asserted away.
 */
function nthCallArg<T>(mock: jest.Mock, index: number): T {
  const call = mock.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`expected at least ${index + 1} call(s), got ${mock.mock.calls.length}`);
  }
  return call[0] as T;
}

/** The `data` payload handed to `prisma.securityEvent.create` on the nth call. */
function createdData(mock: jest.Mock, index = 0): Record<string, unknown> {
  return nthCallArg<{ data: Record<string, unknown> }>(mock, index).data;
}

function buildService(createImpl: jest.Mock) {
  const prisma = { securityEvent: { create: createImpl } };
  const incrementWindow = jest.fn(async (_key: string, _ttl: number) => 1);
  const redis = { incrementWindow };

  const service = new SecurityEventService(prisma as never, redis as never);
  // Silence the expected warn/error output; the assertions are on behaviour.
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

  return { service, createImpl, incrementWindow };
}

const EVENT = {
  type: SecurityEventType.TOKEN_REUSE,
  severity: SecuritySeverity.CRITICAL,
  sessionId: 'ses_1',
  ipAddress: '10.0.0.1',
  message: 'Refresh token not found for a valid signature',
};

describe('SecurityEventService.record — a user that still exists', () => {
  it('writes the event against the real user and scores it', async () => {
    const create = jest.fn(async () => ({ id: 'sec_1' }));
    const { service, incrementWindow } = buildService(create);

    await service.record({ ...EVENT, userId: 'usr_live' });

    expect(create).toHaveBeenCalledTimes(1);
    expect(createdData(create)).toMatchObject({
      userId: 'usr_live',
      type: SecurityEventType.TOKEN_REUSE,
      severity: SecuritySeverity.CRITICAL,
    });
    // The relationship is real, so the risk counters are bumped.
    expect(incrementWindow).toHaveBeenCalled();
  });

  it('records an event that never had a user at all', async () => {
    // A failed login for an unknown phone: nobody to attribute it to, and
    // that is a legitimate row rather than an error.
    const create = jest.fn(async () => ({ id: 'sec_2' }));
    const { service, incrementWindow } = buildService(create);

    await service.record({
      type: SecurityEventType.LOGIN_FAILED,
      message: 'Login attempt for unknown phone',
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(createdData(create).userId).toBeNull();
    expect(incrementWindow).not.toHaveBeenCalled();
  });
});

describe('SecurityEventService.record — a user that no longer exists', () => {
  it('keeps the event, detaching the dangling user reference', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(fkViolation('security_events_userId_fkey'))
      .mockResolvedValueOnce({ id: 'sec_3' });
    const { service } = buildService(create);

    await service.record({ ...EVENT, userId: 'usr_deleted' });

    expect(create).toHaveBeenCalledTimes(2);

    // The audit trail survives: same event, no foreign key.
    const retried = createdData(create, 1);
    expect(retried.userId).toBeNull();
    expect(retried.type).toBe(SecurityEventType.TOKEN_REUSE);
    expect(retried.message).toBe(EVENT.message);
    expect(retried.sessionId).toBe('ses_1');

    // …and the claimed identity is still legible, as plain data rather than
    // as a relationship the database cannot vouch for.
    expect(retried.metadata).toMatchObject({ orphanedUserId: 'usr_deleted' });
  });

  it('preserves metadata the caller supplied', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(fkViolation('security_events_userId_fkey'))
      .mockResolvedValueOnce({ id: 'sec_4' });
    const { service } = buildService(create);

    await service.record({
      ...EVENT,
      userId: 'usr_deleted',
      metadata: { familyId: 'fam_9' },
    });

    expect(createdData(create, 1).metadata).toMatchObject({
      familyId: 'fam_9',
      orphanedUserId: 'usr_deleted',
    });
  });

  it('does not score a user who does not exist', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(fkViolation('security_events_userId_fkey'))
      .mockResolvedValueOnce({ id: 'sec_5' });
    const { service, incrementWindow } = buildService(create);

    await service.record({ ...EVENT, userId: 'usr_deleted' });

    // The counters feed a risk score for an account. There is no account.
    expect(incrementWindow).not.toHaveBeenCalled();
  });

  it('detaches a dangling playback ticket the same way', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(fkViolation('security_events_ticketId_fkey'))
      .mockResolvedValueOnce({ id: 'sec_6' });
    const { service } = buildService(create);

    await service.record({
      type: SecurityEventType.TICKET_DENIED,
      userId: 'usr_live',
      ticketId: 'tkt_gone',
    });

    const retried = createdData(create, 1);
    expect(retried.ticketId).toBeNull();
    // The user was never the problem, so that relationship is left intact.
    expect(retried.userId).toBe('usr_live');
    expect(retried.metadata).toMatchObject({ orphanedTicketId: 'tkt_gone' });
  });
});

describe('SecurityEventService.record — never throws', () => {
  it('swallows a failure that is not a foreign-key violation', async () => {
    const create = jest.fn().mockRejectedValue(new Error('connection reset'));
    const { service } = buildService(create);

    await expect(service.record({ ...EVENT, userId: 'usr_live' })).resolves.toBeUndefined();
    // Nothing to detach, so no pointless second write.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('swallows a retry that also fails', async () => {
    const create = jest
      .fn()
      .mockRejectedValueOnce(fkViolation('security_events_userId_fkey'))
      .mockRejectedValueOnce(new Error('still broken'));
    const { service } = buildService(create);

    await expect(
      service.record({ ...EVENT, userId: 'usr_deleted' }),
    ).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not retry forever', async () => {
    const create = jest.fn().mockRejectedValue(fkViolation('security_events_userId_fkey'));
    const { service } = buildService(create);

    await service.record({ ...EVENT, userId: 'usr_deleted' });

    expect(create).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// The refresh path that produced the bug
// ---------------------------------------------------------------------------

/**
 * `AuthService.refresh` with a signature that verifies and no stored token.
 *
 * Only the collaborators this branch reaches are supplied; anything it would
 * touch on a different path is deliberately absent, so a change of behaviour
 * shows up as a failure here rather than passing quietly.
 */
function buildAuthService(security: { record: jest.Mock }) {
  const prisma = {
    refreshToken: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    session: { updateMany: jest.fn(async () => ({ count: 0 })) },
    $transaction: jest.fn(async (ops: unknown) =>
      Array.isArray(ops) ? [] : (ops as (tx: unknown) => Promise<unknown>)({}),
    ),
  };

  const tokens = {
    verifyRefresh: jest.fn(async () => ({
      sub: 'usr_deleted',
      sid: 'ses_1',
      fam: 'fam_1',
    })),
  };

  const config = { getOrThrow: () => ({}) };

  return new AuthService(
    prisma as never,
    {} as never, // users
    {} as never, // passwords
    tokens as never,
    {} as never, // devices
    security as never,
    {} as never, // audit
    config as never,
  );
}

describe('POST /auth/refresh with a token for a user who no longer exists', () => {
  const meta = { ip: '10.0.0.1', userAgent: 'jest', device: { deviceKey: 'dev_1' } };

  it('answers 401 SESSION_EXPIRED with the canonical message', async () => {
    const security = { record: jest.fn(async () => undefined) };
    const auth = buildAuthService(security);

    await expect(auth.refresh('token', meta as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_EXPIRED,
    });

    // The wire contract the app branches on.
    expect(ERROR_MESSAGE[ErrorCode.SESSION_EXPIRED]).toBe('Session is no longer valid');
    try {
      await auth.refresh('token', meta as never);
    } catch (e) {
      expect(e).toBeInstanceOf(AppException);
      expect((e as AppException).getStatus()).toBe(401);
    }
  });

  it('still attempts the security event, carrying the claimed id', async () => {
    const security = { record: jest.fn(async () => undefined) };
    const auth = buildAuthService(security);

    await expect(auth.refresh('token', meta as never)).rejects.toThrow();

    expect(security.record).toHaveBeenCalledTimes(1);
    expect(nthCallArg<Record<string, unknown>>(security.record, 0)).toMatchObject({
      type: SecurityEventType.TOKEN_REUSE,
      severity: SecuritySeverity.CRITICAL,
      userId: 'usr_deleted',
    });
  });

  /**
   * The property that matters most: telemetry is best-effort, and a failure
   * inside it must not become the response.
   *
   * Wired to the **real** service with a database that refuses every write, so
   * this exercises the production path rather than a mock that throws — the
   * guarantee lives inside `record`, and that is where it has to hold.
   */
  it('returns the original 401 when every security write fails', async () => {
    const create = jest.fn().mockRejectedValue(new Error('database is down'));
    const { service } = buildService(create);
    const auth = buildAuthService({
      record: jest.fn((input: never) => service.record(input)) as jest.Mock,
    });

    await expect(auth.refresh('token', meta as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_EXPIRED,
    });
  });

  /**
   * And the same again for the one failure mode that actually happened: the
   * foreign key. Both the insert and the detached retry are refused here.
   */
  it('returns the original 401 when the foreign key and the retry both fail', async () => {
    const create = jest.fn().mockRejectedValue(fkViolation('security_events_userId_fkey'));
    const { service } = buildService(create);
    const auth = buildAuthService({
      record: jest.fn((input: never) => service.record(input)) as jest.Mock,
    });

    await expect(auth.refresh('token', meta as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_EXPIRED,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  /** `record` is contractually incapable of rejecting, whatever goes wrong. */
  it('record() never rejects, even on an unexpected internal failure', async () => {
    const create = jest.fn(() => {
      throw new TypeError('something no one anticipated');
    });
    const { service } = buildService(create);

    await expect(
      service.record({ ...EVENT, userId: 'usr_x' }),
    ).resolves.toBeUndefined();
  });

  it('records the event with no foreign key when the user is gone', async () => {
    // End to end across the two units: the id the refresh path hands over is
    // the one the service has to detach.
    const create = jest
      .fn()
      .mockRejectedValueOnce(fkViolation('security_events_userId_fkey'))
      .mockResolvedValueOnce({ id: 'sec_7' });
    const { service } = buildService(create);

    const auth = buildAuthService({
      record: jest.fn((input: never) => service.record(input)) as jest.Mock,
    });

    await expect(auth.refresh('token', meta as never)).rejects.toMatchObject({
      code: ErrorCode.SESSION_EXPIRED,
    });

    expect(create).toHaveBeenCalledTimes(2);
    expect(createdData(create, 1).userId).toBeNull();
    expect(createdData(create, 1).metadata).toMatchObject({
      orphanedUserId: 'usr_deleted',
    });
  });
});
