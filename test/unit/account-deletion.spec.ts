import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Logger, ValidationPipe } from '@nestjs/common';
import { AccountDeletionStatus, AccountStatus, UserRole } from '@prisma/client';

import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import {
  AccountDeletionAdminController,
  AccountDeletionController,
} from '../../src/modules/account-deletion/account-deletion.controller';
import {
  CancelAccountDeletionDto,
  ConfirmSettlementDto,
  RecoverAccountDeletionDto,
  RequestAccountDeletionDto,
} from '../../src/modules/account-deletion/account-deletion.dto';
import {
  AccountDeletionScheduler,
  normalizeDeletionSweepIntervalSeconds,
} from '../../src/modules/account-deletion/account-deletion.scheduler';
import {
  AccountDeletionService,
  DELETED_USER_NAME,
  DELETION_ALERT_MARKER,
  DELETION_MAX_ATTEMPTS,
  describeEraseError,
  DELETION_GRACE_DAYS,
  DELETION_SETTLEMENT_MARKER,
  REDACTED_TEXT,
  UNUSABLE_PASSWORD_HASH,
} from '../../src/modules/account-deletion/account-deletion.service';
import { AuthService } from '../../src/modules/auth/auth.service';

/**
 * Owner decision D5: in-app account deletion with a 30-day cancellation
 * period, a durable scheduled erase, use blocked while pending (but never the
 * cancellation), personal data erased and financial/audit records retained.
 */

const DAY = 24 * 3600 * 1000;
const STUDENT = { id: 'usr_s', role: UserRole.STUDENT, sessionId: 'ses_1' } as never;
const META = { ip: '203.0.113.7', userAgent: 'jest', requestId: 'req_1', device: {} } as never;

type Row = {
  id: string;
  userId: string;
  status: AccountDeletionStatus;
  requestedAt: Date;
  scheduledFor: Date;
  attempts?: number;
};

function build(opts: { password?: boolean; open?: Row | null } = {}) {
  const calls: string[] = [];
  const track = (name: string, impl: (...a: never[]) => unknown = async () => ({ count: 1 })) =>
    jest.fn(async (...a: never[]) => {
      calls.push(name);
      return impl(...a);
    });

  // Every model the erase may touch. Payments, wallet, ledger, enrollments,
  // redemption amounts, revenue and audit history are deliberately ABSENT
  // except where named: touching them would throw here.
  const tx = {
    accountDeletionRequest: {
      create: track('deletion.create', async () => ({
        id: 'del_1',
        status: AccountDeletionStatus.PENDING,
        requestedAt: new Date(),
        scheduledFor: new Date(Date.now() + DELETION_GRACE_DAYS * DAY),
      })),
      update: track('deletion.update'),
      updateMany: track('deletion.updateMany'),
      // erase() re-reads its own request inside the transaction.
      findUnique: jest.fn(async () => ({ userId: 'usr_s', status: AccountDeletionStatus.PROCESSING })),
    },
    // READ-ONLY: the settlement guard checks the balance; nothing here may
    // write to the wallet. No update/updateMany/delete exists on this double,
    // so a write attempt throws.
    wallet: { findUnique: jest.fn(async (): Promise<{ balance: unknown } | null> => null) },
    user: {
      update: track('user.update'),
      findUnique: jest.fn(async () => ({ role: UserRole.STUDENT })),
    },
    studentProfile: { updateMany: track('studentProfile.updateMany') },
    session: { updateMany: track('session.updateMany') },
    refreshToken: { updateMany: track('refreshToken.updateMany') },
    playbackTicket: { updateMany: track('playbackTicket.updateMany') },
    pushToken: { updateMany: track('pushToken.updateMany'), deleteMany: track('pushToken.deleteMany') },
    securityEvent: { updateMany: track('securityEvent.updateMany') },
    accessCodeRedemption: { updateMany: track('accessCodeRedemption.updateMany') },
    device: {
      findMany: track('device.findMany', async () => [{ id: 'dev_1' }, { id: 'dev_2' }]),
      update: track('device.update'),
    },
    deviceChangeRequest: { deleteMany: track('deviceChangeRequest.deleteMany') },
    notification: { deleteMany: track('notification.deleteMany') },
    notificationPreference: { deleteMany: track('notificationPreference.deleteMany') },
    supportTicket: { updateMany: track('supportTicket.updateMany') },
    supportMessage: { updateMany: track('supportMessage.updateMany') },
  };

  const prisma = {
    user: {
      findFirst: jest.fn(async () => ({ id: 'usr_s', passwordHash: 'hash' })),
    },
    accountDeletionRequest: {
      findFirst: jest.fn(async () => opts.open ?? null),
      findMany: jest.fn(async () => [] as Row[]),
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
    wallet: { findUnique: jest.fn(async (): Promise<{ balance: unknown } | null> => null) },
    // Lifetime ledger totals for the settlements list. Read-only.
    walletTransaction: {
      groupBy: jest.fn(async (): Promise<unknown[]> => []),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  const passwords = { verify: jest.fn(async () => opts.password ?? true) };
  const auth = {
    verifyCredentials: jest.fn(async () => ({ id: 'usr_s', role: UserRole.STUDENT })),
  };
  const audit = { record: jest.fn(async () => undefined), recordTx: jest.fn(async () => undefined) };
  const redis = { del: jest.fn(async () => undefined) };
  const storage = { isConfigured: true, deletePrefix: jest.fn(async () => 1) };

  const wallet = { debit: jest.fn(async () => ({ id: 'wtx_1', replayed: false })) };

  const service = new AccountDeletionService(
    prisma as never,
    auth as never,
    passwords as never,
    audit as never,
    redis as never,
    storage as never,
    wallet as never,
  );
  return { service, prisma, tx, passwords, auth, audit, redis, storage, wallet, calls };
}

describe('requesting deletion', () => {
  it('needs the current password and creates nothing without it', async () => {
    const { service, tx } = build({ password: false });
    await expect(service.request(STUDENT, 'wrong', META)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(tx.accountDeletionRequest.create).not.toHaveBeenCalled();
  });

  it('schedules the erase 30 days out and cuts off every way back in, in one transaction', async () => {
    const { service, tx, audit, redis, calls } = build();

    const before = Date.now();
    const result = await service.request(STUDENT, 'Str0ngPass', META);

    expect(result.status).toBe(AccountDeletionStatus.PENDING);
    expect(result.cancellable).toBe(true);
    const created = (tx.accountDeletionRequest.create.mock.calls[0] as unknown as [{ data: { scheduledFor: Date } }])[0];
    const days = (created.data.scheduledFor.getTime() - before) / DAY;
    expect(days).toBeGreaterThan(29.99);
    expect(days).toBeLessThan(30.01);

    expect(calls).toEqual(
      expect.arrayContaining([
        'deletion.create',
        'session.updateMany',
        'refreshToken.updateMany',
        'playbackTicket.updateMany',
        'pushToken.updateMany',
      ]),
    );
    expect(audit.recordTx).toHaveBeenCalledTimes(1);
    expect(redis.del).toHaveBeenCalledWith('pb:slots:usr_s');
    // Nothing is erased at request time - that is what the 30 days are for.
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('is idempotent: asking again returns the open request with its original date', async () => {
    const original = {
      id: 'del_0',
      userId: 'usr_s',
      status: AccountDeletionStatus.PENDING,
      requestedAt: new Date(Date.now() - 5 * DAY),
      scheduledFor: new Date(Date.now() + 25 * DAY),
    };
    const { service, tx } = build({ open: original });

    const result = await service.request(STUDENT, 'Str0ngPass', META);

    expect(result.id).toBe('del_0');
    expect(result.scheduledFor).toBe(original.scheduledFor.toISOString());
    expect(tx.accountDeletionRequest.create).not.toHaveBeenCalled();
  });

  it('answers a concurrent duplicate with the request that won the unique index', async () => {
    const { service, prisma } = build();
    const winner = {
      id: 'del_w',
      userId: 'usr_s',
      status: AccountDeletionStatus.PENDING,
      requestedAt: new Date(),
      scheduledFor: new Date(Date.now() + 30 * DAY),
    };
    prisma.accountDeletionRequest.findFirst
      .mockResolvedValueOnce(null as never) // the pre-check saw nothing
      .mockResolvedValueOnce(winner as never); // after the P2002
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }) as never);

    await expect(service.request(STUDENT, 'Str0ngPass', META)).resolves.toMatchObject({ id: 'del_w' });
  });

  it('is for students; staff accounts stay with the administrators', async () => {
    const { service, passwords } = build();
    await expect(
      service.request({ id: 'usr_t', role: UserRole.TEACHER } as never, 'x', META),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_ROLE' });
    expect(passwords.verify).not.toHaveBeenCalled();
  });
});

describe('cancelling', () => {
  it('checks phone + password through the sign-in path and only moves a PENDING, not-yet-due request', async () => {
    const { service, prisma, auth, audit } = build({
      open: { id: 'del_1' } as never,
    });

    await expect(service.cancel('01001234567', 'Str0ngPass', META)).resolves.toEqual({
      cancelled: true,
      requestId: 'del_1',
    });

    expect(auth.verifyCredentials).toHaveBeenCalledWith('01001234567', 'Str0ngPass', META);
    const where = (prisma.accountDeletionRequest.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ id: 'del_1', status: AccountDeletionStatus.PENDING });
    expect((where.scheduledFor as { gt: Date }).gt).toBeInstanceOf(Date);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('refuses once the sweep has claimed the request (the race is decided by the conditional update)', async () => {
    const { service, prisma } = build({ open: { id: 'del_1' } as never });
    prisma.accountDeletionRequest.updateMany.mockResolvedValueOnce({ count: 0 } as never);

    await expect(service.cancel('01001234567', 'Str0ngPass', META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringContaining('can no longer be cancelled in the app'),
    });
  });

  it('never cancels on a wrong password', async () => {
    const { service, prisma, auth } = build({ open: { id: 'del_1' } as never });
    auth.verifyCredentials.mockRejectedValueOnce(Object.assign(new Error('bad'), { code: 'INVALID_CREDENTIALS' }) as never);

    await expect(service.cancel('01001234567', 'nope', META)).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
  });
});

describe('the scheduled sweep', () => {
  const due = (status: AccountDeletionStatus): Row => ({
    id: 'del_1',
    userId: 'usr_s',
    status,
    requestedAt: new Date(Date.now() - 31 * DAY),
    scheduledFor: new Date(Date.now() - DAY),
    attempts: 0,
  });

  it('claims a due request atomically before erasing it', async () => {
    const { service, prisma, tx } = build();
    prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([due(AccountDeletionStatus.PENDING)]);

    const result = await service.sweep();

    expect(result).toEqual({ claimed: 1, completed: 1, failed: 0, skipped: 0, needsAttention: 0, needsSettlement: 0 });
    const claim = (prisma.accountDeletionRequest.updateMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(claim.where).toMatchObject({ id: 'del_1', status: AccountDeletionStatus.PENDING });
    expect(claim.data).toMatchObject({ status: AccountDeletionStatus.PROCESSING });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('skips a request that was cancelled between the read and the claim', async () => {
    const { service, prisma, tx } = build();
    prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([due(AccountDeletionStatus.PENDING)]);
    prisma.accountDeletionRequest.updateMany.mockResolvedValueOnce({ count: 0 } as never);

    await expect(service.sweep()).resolves.toMatchObject({ claimed: 0, skipped: 1 });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('picks up a request a crashed sweep left PROCESSING (erase is idempotent)', async () => {
    const { service, prisma, tx } = build();
    prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([due(AccountDeletionStatus.PROCESSING)]);

    await expect(service.sweep()).resolves.toMatchObject({ completed: 1 });
    expect(tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('puts a failed erase back to PENDING with the error, for the next sweep', async () => {
    const { service, prisma } = build();
    prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([due(AccountDeletionStatus.PENDING)]);
    prisma.$transaction.mockRejectedValueOnce(new Error('deadlock detected') as never);

    await expect(service.sweep()).resolves.toMatchObject({ failed: 1, completed: 0 });
    const revert = (prisma.accountDeletionRequest.updateMany.mock.calls[1] as unknown as [{ where: Record<string, unknown>; data: Record<string, unknown> }])[0];
    expect(revert.where).toMatchObject({ status: AccountDeletionStatus.PROCESSING });
    // The error class is stored, never the message (messages can echo data).
    expect(revert.data).toEqual({ status: AccountDeletionStatus.PENDING, lastError: 'Error' });
  });

  it('only ever asks for due PENDING rows or stranded PROCESSING rows, skipping requests that ran out of attempts or hold for settlement', async () => {
    const { service, prisma } = build();
    await service.sweep();
    const where = (prisma.accountDeletionRequest.findMany.mock.calls[0] as unknown as [{ where: { AND: unknown[]; failedAt: unknown } }])[0].where;
    expect(where.failedAt).toBeNull();
    expect(where.AND).toEqual([
      // Held for settlement (and not yet settled) = excluded until confirmed.
      { OR: [{ settlementRequiredAt: null }, { settledAt: { not: null } }] },
      {
        OR: [
          { status: AccountDeletionStatus.PENDING, scheduledFor: { lte: expect.any(Date) } },
          { status: AccountDeletionStatus.PROCESSING },
        ],
      },
    ]);
  });
});

describe('what the erase removes and what it keeps', () => {
  it('overwrites identity, strips identifiers, deletes personal-only rows, and completes the request', async () => {
    const { service, tx, storage, redis } = build();

    await service.erase('del_1', 'usr_s');

    const userData = (tx.user.update.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(userData).toMatchObject({
      fullName: DELETED_USER_NAME,
      phone: 'deleted:usr_s',
      email: null,
      avatarUrl: null,
      gender: null,
      passwordHash: UNUSABLE_PASSWORD_HASH,
      status: AccountStatus.DISABLED,
    });
    expect(userData.deletedAt).toBeInstanceOf(Date);

    expect(tx.device.update).toHaveBeenCalledTimes(2);
    for (const name of ['deviceChangeRequest', 'pushToken', 'notification', 'notificationPreference'] as const) {
      expect(tx[name].deleteMany).toHaveBeenCalledWith({ where: { userId: 'usr_s' } });
    }
    expect(tx.supportMessage.updateMany).toHaveBeenCalledWith({
      where: { authorId: 'usr_s' },
      data: { body: REDACTED_TEXT },
    });
    expect(tx.accountDeletionRequest.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: AccountDeletionStatus.COMPLETED }) }),
    );
    expect(storage.deletePrefix).toHaveBeenCalledWith('media', 'avatars/usr_s/');
    expect(redis.del).toHaveBeenCalledWith('pb:slots:usr_s');
  });

  it('never touches payments, ledger, enrollments, purchases, revenue or audit history; the wallet is only READ', async () => {
    const { service, tx } = build();
    await service.erase('del_1', 'usr_s');
    // The settlement guard reads the balance; the double exposes nothing but
    // findUnique, so any write to the wallet would have thrown above.
    expect(tx.wallet.findUnique).toHaveBeenCalledWith({ where: { userId: 'usr_s' }, select: { balance: true } });
    expect(Object.keys(tx.wallet)).toEqual(['findUnique']);
    for (const kept of [
      'payment',
      'walletTransaction',
      'enrollment',
      'coursePartPurchase',
      'libraryPurchase',
      'rechargeRevenue',
      'auditLog',
      'watchProgress',
    ]) {
      // The transaction double has no such delegate; the erase would have thrown.
      expect(tx).not.toHaveProperty(kept);
    }
  });
});

describe('sign-in while a deletion is pending', () => {
  function auth(deletion: { status: AccountDeletionStatus; scheduledFor: Date } | null) {
    const prisma = {
      user: {
        findUnique: jest.fn(async () => ({
          id: 'usr_s',
          passwordHash: 'hash',
          role: UserRole.STUDENT,
          status: AccountStatus.ACTIVE,
          deletedAt: null,
          failedLoginCount: 0,
          lockedUntil: null,
        })),
      },
      accountDeletionRequest: { findFirst: jest.fn(async () => deletion) },
    };
    const passwords = { verify: jest.fn(async () => true), needsRehash: jest.fn(() => false) };
    const config = { getOrThrow: () => ({}) };
    return new AuthService(
      prisma as never,
      {} as never,
      passwords as never,
      {} as never,
      {} as never,
      { record: jest.fn() } as never,
      {} as never,
      config as never,
    );
  }

  it('is refused with ACCOUNT_DELETION_PENDING, saying it can still be cancelled', async () => {
    const scheduledFor = new Date(Date.now() + 10 * DAY);
    await expect(
      auth({ status: AccountDeletionStatus.PENDING, scheduledFor }).login(
        { phone: '01001234567', password: 'Str0ngPass' },
        META,
      ),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_DELETION_PENDING',
      details: { cancellable: true, scheduledFor: scheduledFor.toISOString() },
    });
  });

  it('says it cannot be cancelled once processing has started', async () => {
    await expect(
      auth({ status: AccountDeletionStatus.PROCESSING, scheduledFor: new Date(Date.now() - DAY) }).login(
        { phone: '01001234567', password: 'Str0ngPass' },
        META,
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING', details: { cancellable: false } });
  });

  it('stays refused while a failed erasure waits for an administrator (never silently reactivated)', async () => {
    // A request that ran out of attempts is still PENDING with its date past.
    await expect(
      auth({ status: AccountDeletionStatus.PENDING, scheduledFor: new Date(Date.now() - 5 * DAY) }).login(
        { phone: '01001234567', password: 'Str0ngPass' },
        META,
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_PENDING', details: { cancellable: false } });
  });
});

describe('routes and validation', () => {
  it('requesting is a signed-in student action; cancelling is public (the sessions are gone)', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AccountDeletionController.prototype.request)).toEqual([UserRole.STUDENT]);
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AccountDeletionController.prototype.request)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, AccountDeletionController.prototype.cancel)).toBe(true);
  });

  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  it('the request body is the password and nothing else (no userId to delete someone else)', async () => {
    await expect(
      pipe.transform({ password: 'x', userId: 'usr_other' }, { type: 'body', metatype: RequestAccountDeletionDto }),
    ).rejects.toBeDefined();
    await expect(pipe.transform({ password: 'x' }, { type: 'body', metatype: RequestAccountDeletionDto })).resolves.toBeDefined();
  });

  it('the cancel body is exactly the sign-in body', async () => {
    await expect(
      pipe.transform({ phone: '01001234567', password: 'x' }, { type: 'body', metatype: CancelAccountDeletionDto }),
    ).resolves.toBeDefined();
    await expect(
      pipe.transform({ phone: 'not-a-phone', password: 'x' }, { type: 'body', metatype: CancelAccountDeletionDto }),
    ).rejects.toBeDefined();
  });
});

describe('the scheduler', () => {
  it('does nothing when another process holds the lock', async () => {
    const sweep = jest.fn();
    const scheduler = new AccountDeletionScheduler({ sweep } as never, { acquireLock: jest.fn(async () => null) } as never);
    await expect(scheduler.tick()).resolves.toBeNull();
    expect(sweep).not.toHaveBeenCalled();
  });

  it('sweeps under the lock and always releases it', async () => {
    const release = jest.fn(async () => undefined);
    const sweep = jest.fn(async () => {
      throw new Error('db down');
    });
    const scheduler = new AccountDeletionScheduler({ sweep } as never, { acquireLock: jest.fn(async () => release) } as never);
    await expect(scheduler.tick()).resolves.toBeNull();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    [undefined, 3600],
    ['', 3600],
    ['0', 0],
    ['60', 300],
    ['7200', 7200],
    ['nonsense', 3600],
  ])('interval %p -> %p seconds', (raw, expected) => {
    expect(normalizeDeletionSweepIntervalSeconds(raw)).toBe(expected);
  });
});

describe('the prepared migration', () => {
  const root = join(__dirname, '..', '..');
  const sql = readFileSync(
    join(root, 'prisma/migrations/20261027120000_account_deletion_requests/migration.sql'),
    'utf8',
  );

  it('allows at most one PENDING request per user at the database level', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "account_deletion_requests_one_pending_per_user"\s+ON "account_deletion_requests"\("userId"\)\s+WHERE "status" = 'PENDING'/,
    );
  });

  it('cannot cascade-delete a user (the row is the anchor for retained records)', () => {
    expect(sql).toMatch(/REFERENCES "users"\("id"\) ON DELETE RESTRICT/);
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n');
    expect(statements).not.toMatch(/DROP|TRUNCATE|DELETE FROM|ALTER TABLE "users"/i);
  });
});


// ---------------------------------------------------------------------------
// Stuck erasures: ten failures, retries, recovery (Phase 2 remediation)
// ---------------------------------------------------------------------------

/**
 * A stateful stand-in for the request table: one row, with the conditional
 * updates the service relies on applied for real, so repeated sweeps behave
 * like repeated sweeps.
 */
function stateful(failErase: () => boolean) {
  const harness = build();
  const row = {
    id: 'del_1',
    userId: 'usr_s',
    status: AccountDeletionStatus.PENDING as AccountDeletionStatus,
    requestedAt: new Date(Date.now() - 31 * DAY),
    scheduledFor: new Date(Date.now() - DAY),
    attempts: 0,
    failedAt: null as Date | null,
    lastError: null as string | null,
    cancelledAt: null as Date | null,
  };
  const r = harness.prisma.accountDeletionRequest;
  const fits = (where: Record<string, unknown>) =>
    (where.id === undefined || where.id === row.id) &&
    (where.status === undefined || where.status === row.status) &&
    (where.failedAt === undefined ||
      (where.failedAt === null ? row.failedAt === null : row.failedAt !== null)) &&
    (where.scheduledFor === undefined ||
      ((where.scheduledFor as { gt?: Date; lte?: Date }).gt
        ? row.scheduledFor > (where.scheduledFor as { gt: Date }).gt
        : row.scheduledFor <= (where.scheduledFor as { lte: Date }).lte));
  r.findMany.mockImplementation((async ({ where }: { where: Record<string, unknown> }) => {
    if (where.failedAt === null && row.failedAt !== null) return [];
    const pendingDue = row.status === AccountDeletionStatus.PENDING && row.scheduledFor <= new Date();
    return pendingDue || row.status === AccountDeletionStatus.PROCESSING ? [{ ...row }] : [];
  }) as never);
  r.updateMany.mockImplementation((async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
    if (!fits(where)) return { count: 0 };
    for (const [k, v] of Object.entries(data)) {
      if (k === 'attempts' && typeof v === 'object' && v) row.attempts += (v as { increment: number }).increment;
      else (row as Record<string, unknown>)[k] = v;
    }
    return { count: 1 };
  }) as never);
  r.update.mockImplementation((async ({ data }: { data: { attempts?: { increment: number } } }) => {
    if (data.attempts) row.attempts += data.attempts.increment;
    return {};
  }) as never);
  r.count.mockImplementation((async ({ where }: { where: Record<string, unknown> } = { where: {} }) =>
    where && where.settlementRequiredAt !== undefined
      ? 0 // no settlement holds in these scenarios
      : row.failedAt !== null && row.status === AccountDeletionStatus.PENDING
        ? 1
        : 0) as never);
  harness.prisma.$transaction.mockImplementation((async (fn: (t: typeof harness.tx) => unknown) => {
    if (failErase()) {
      // A message that echoes personal data, which must never be stored or logged.
      throw Object.assign(new Error('could not update user 01001234567 Ahmed Mohamed'), { code: 'P2034' });
    }
    harness.tx.accountDeletionRequest.update.mockImplementation((async ({ data }: { data: Record<string, unknown> }) => {
      Object.assign(row, data);
      return {};
    }) as never);
    return fn(harness.tx);
  }) as never);
  return { ...harness, row };
}

const ADMIN_ACTOR = { id: 'usr_admin', role: UserRole.ADMIN } as never;

describe('an erasure that keeps failing', () => {
  let errors: jest.SpyInstance;
  beforeEach(() => {
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => errors.mockRestore());

  it(`stops after ${DELETION_MAX_ATTEMPTS} failures, marks the request, raises the alert, and erases nothing`, async () => {
    const { service, row, tx } = stateful(() => true);

    for (let i = 0; i < DELETION_MAX_ATTEMPTS; i += 1) {
      await service.sweep();
      if (i < DELETION_MAX_ATTEMPTS - 1) expect(row.failedAt).toBeNull();
    }

    expect(row.attempts).toBe(DELETION_MAX_ATTEMPTS);
    expect(row.failedAt).toBeInstanceOf(Date);
    expect(row.status).toBe(AccountDeletionStatus.PENDING);
    expect(row.lastError).toBe('Error:P2034');
    expect(tx.user.update).not.toHaveBeenCalled();

    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain(DELETION_ALERT_MARKER);
    expect(logged).not.toMatch(/01001234567|Ahmed/);
  });

  it('is not retried again automatically, but keeps signalling until someone acts', async () => {
    const { service, row } = stateful(() => true);
    for (let i = 0; i < DELETION_MAX_ATTEMPTS; i += 1) await service.sweep();
    errors.mockClear();

    const result = await service.sweep();

    expect(result).toMatchObject({ claimed: 0, needsAttention: 1 });
    expect(row.attempts).toBe(DELETION_MAX_ATTEMPTS);
    expect(JSON.stringify(errors.mock.calls)).toContain(DELETION_ALERT_MARKER);
  });

  it('retries normally below the limit and completes once the cause is gone', async () => {
    let failures = 3;
    const { service, row } = stateful(() => failures-- > 0);
    for (let i = 0; i < 4; i += 1) await service.sweep();
    expect(row.status).toBe(AccountDeletionStatus.COMPLETED);
    expect(row.failedAt).toBeNull();
    expect(row.attempts).toBe(4);
  });

  it('cannot be cancelled from the app once its 30 days are over', async () => {
    const { service, row, prisma } = stateful(() => true);
    for (let i = 0; i < DELETION_MAX_ATTEMPTS; i += 1) await service.sweep();
    prisma.accountDeletionRequest.findFirst.mockResolvedValue({ id: row.id } as never);

    await expect(service.cancel('01001234567', 'Str0ngPass', META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
      message: expect.stringContaining('contact support'),
    });
    expect(row.status).toBe(AccountDeletionStatus.PENDING);
  });
});

describe('administrator recovery of a failed erasure', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  async function failed() {
    let failing = true;
    const harness = stateful(() => failing);
    for (let i = 0; i < DELETION_MAX_ATTEMPTS; i += 1) await harness.service.sweep();
    return { ...harness, fix: () => (failing = false) };
  }

  it('retry re-queues it with fresh attempts, audited, and the next sweep erases', async () => {
    const { service, row, audit, fix } = await failed();
    fix();

    await expect(service.retryFailed(row.id, ADMIN_ACTOR, 'Support ticket SC-1042, cause fixed', META)).resolves.toEqual({
      id: row.id,
      requeued: true,
    });
    expect(row).toMatchObject({ failedAt: null, attempts: 0, lastError: null, status: AccountDeletionStatus.PENDING });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: 'usr_admin', entityId: row.id, note: expect.stringContaining('SC-1042') }),
    );

    await service.sweep();
    expect(row.status).toBe(AccountDeletionStatus.COMPLETED);
  });

  it("cancel ends the request at the holder's confirmed request, audited; nothing was erased", async () => {
    const { service, row, audit, tx } = await failed();

    await expect(service.cancelFailed(row.id, ADMIN_ACTOR, 'Holder confirmed by phone, ticket SC-7', META)).resolves.toEqual({
      id: row.id,
      cancelled: true,
    });
    expect(row.status).toBe(AccountDeletionStatus.CANCELLED);
    expect(row.cancelledAt).toBeInstanceOf(Date);
    expect(tx.user.update).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ note: expect.stringContaining('SC-7') }));
  });

  it('cannot touch a normal pending deletion (only failed ones)', async () => {
    const { service, row, audit } = stateful(() => false);
    row.scheduledFor = new Date(Date.now() + 10 * DAY);

    await expect(service.retryFailed(row.id, ADMIN_ACTOR, 'should not be possible', META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    await expect(service.cancelFailed(row.id, ADMIN_ACTOR, 'should not be possible', META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(row.status).toBe(AccountDeletionStatus.PENDING);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('lists ids, timings and the error class only - no name, phone or email', async () => {
    const { service, prisma } = await failed();
    prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([
      {
        id: 'del_1',
        userId: 'usr_s',
        status: AccountDeletionStatus.PENDING,
        requestedAt: new Date(),
        scheduledFor: new Date(),
        attempts: 10,
        failedAt: new Date(),
        lastError: 'Error:P2034',
      },
    ] as never);

    const [item] = await service.listNeedingAttention();
    expect(Object.keys(item).sort()).toEqual(
      ['attempts', 'failedAt', 'id', 'lastError', 'requestedAt', 'scheduledFor', 'status', 'userId'].sort(),
    );
    const select = (prisma.accountDeletionRequest.findMany.mock.calls.at(-1) as unknown as [{ select: Record<string, unknown> }])[0].select;
    expect(select).not.toHaveProperty('user');
  });

  it('is administrator-only and needs a written reason', async () => {
    const roles = (h: object) => (Reflect.getMetadata(ROLES_KEY, h) as string[]).slice().sort();
    for (const h of [
      AccountDeletionAdminController.prototype.attention,
      AccountDeletionAdminController.prototype.retry,
      AccountDeletionAdminController.prototype.cancel,
    ]) {
      expect(roles(h)).toEqual(['ADMIN', 'MASTER']);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, h)).toBeUndefined();
    }
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    await expect(pipe.transform({ reason: 'short' }, { type: 'body', metatype: RecoverAccountDeletionDto })).rejects.toBeDefined();
    await expect(
      pipe.transform({ reason: 'Support ticket SC-1042', userId: 'x' }, { type: 'body', metatype: RecoverAccountDeletionDto }),
    ).rejects.toBeDefined();
  });
});

describe('erasure can never hit the wrong account', () => {
  it('refuses when the request is not claimed for exactly this account', async () => {
    const { service, tx } = build();
    tx.accountDeletionRequest.findUnique.mockResolvedValueOnce({ userId: 'usr_other', status: AccountDeletionStatus.PROCESSING } as never);
    await expect(service.erase('del_1', 'usr_s')).rejects.toMatchObject({ name: 'DeletionRequestMismatch' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuses a request that is no longer PROCESSING (cancelled or completed meanwhile)', async () => {
    const { service, tx } = build();
    tx.accountDeletionRequest.findUnique.mockResolvedValueOnce({ userId: 'usr_s', status: AccountDeletionStatus.CANCELLED } as never);
    await expect(service.erase('del_1', 'usr_s')).rejects.toMatchObject({ name: 'DeletionRequestMismatch' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });

  it('refuses a target that is not a student account', async () => {
    const { service, tx } = build();
    tx.user.findUnique.mockResolvedValueOnce({ role: UserRole.TEACHER } as never);
    await expect(service.erase('del_1', 'usr_s')).rejects.toMatchObject({ name: 'DeletionTargetNotStudent' });
    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('describeEraseError', () => {
  it.each([
    [Object.assign(new Error('phone 01001234567'), { code: 'P2002' }), 'Error:P2002'],
    [Object.assign(new Error('x'), { name: 'PrismaClientKnownRequestError', code: 'P2034' }), 'PrismaClientKnownRequestError:P2034'],
    [Object.assign(new Error('x'), { name: 'evil name with spaces 0100' }), 'Error'],
    ['a string', 'UnknownError'],
    [null, 'UnknownError'],
  ])('%p -> %p', (input, expected) => {
    expect(describeEraseError(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Settlement before erasure (Phase 6 §4.2)
// ---------------------------------------------------------------------------

describe('settlement before erasure (Phase 6 §4.2)', () => {
  let warns: jest.SpyInstance;
  let errors: jest.SpyInstance;
  beforeEach(() => {
    warns = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    errors = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warns.mockRestore();
    errors.mockRestore();
  });

  const dueRow = (settledAt: Date | null = null) => ({
    id: 'del_1',
    userId: 'usr_s',
    status: AccountDeletionStatus.PENDING,
    requestedAt: new Date(Date.now() - 31 * DAY),
    scheduledFor: new Date(Date.now() - DAY),
    attempts: 0,
    settledAt,
  });

  it('a due request with money in the wallet holds instead of erasing', async () => {
    const h = build();
    h.prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([dueRow()] as never);
    h.prisma.wallet.findUnique.mockResolvedValueOnce({ balance: '150.00' });

    const result = await h.service.sweep();

    expect(result).toMatchObject({ claimed: 0, completed: 0, failed: 0, heldForSettlement: 1 });
    const hold = (h.prisma.accountDeletionRequest.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ])[0];
    // The conditional write is what makes two sweeps racing on the same row safe.
    expect(hold.where).toEqual({ id: 'del_1', settlementRequiredAt: null, settledAt: null });
    expect(hold.data.settlementRequiredAt).toBeInstanceOf(Date);
    expect(hold.data.outstandingAmount).toBe('150.00');
    // Nothing was claimed and nothing was erased: identity survives the hold.
    expect(h.tx.user.update).not.toHaveBeenCalled();
    expect(warns.mock.calls.some((c) => String(c[0]).includes(DELETION_SETTLEMENT_MARKER))).toBe(true);
  });

  it('erase refuses while the wallet holds money — the authoritative in-transaction guard', async () => {
    const h = build();
    h.tx.wallet.findUnique.mockResolvedValueOnce({ balance: 25 });
    await expect(h.service.erase('del_1', 'usr_s')).rejects.toMatchObject({
      name: 'DeletionSettlementRequired',
    });
    expect(h.tx.user.update).not.toHaveBeenCalled();
  });

  it('an account with no wallet row, or a zero balance, erases normally', async () => {
    const h = build();
    h.prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([dueRow()] as never);
    // build() defaults both wallet reads to null — no wallet row at all.
    await expect(h.service.sweep()).resolves.toMatchObject({ claimed: 1, completed: 1 });
    expect(h.tx.user.update).toHaveBeenCalledTimes(1);
  });

  it('a settled request rejoins the sweep and erases', async () => {
    const h = build();
    h.prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([dueRow(new Date())] as never);
    await expect(h.service.sweep()).resolves.toMatchObject({ claimed: 1, completed: 1 });
  });

  it('money reappearing AFTER a settlement is never erased and never re-held silently', async () => {
    const h = build();
    h.prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([dueRow(new Date())] as never);
    h.prisma.wallet.findUnique.mockResolvedValueOnce({ balance: '10.00' });

    const result = await h.service.sweep();

    expect(result).toMatchObject({ claimed: 0, completed: 0, skipped: 1 });
    // No hold overwrote the settlement record, nothing was claimed or erased,
    // and the marker calls for an administrator.
    expect(h.prisma.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
    expect(h.tx.user.update).not.toHaveBeenCalled();
    expect(errors.mock.calls.some((c) => String(c[0]).includes(DELETION_SETTLEMENT_MARKER))).toBe(true);
  });

  // ---- confirmation -------------------------------------------------------

  function holding(h: ReturnType<typeof build>, opts: { settledAt?: Date | null; balance?: string | null } = {}) {
    h.tx.accountDeletionRequest.findUnique.mockResolvedValueOnce({
      id: 'del_1',
      userId: 'usr_s',
      settlementRequiredAt: new Date(),
      settledAt: opts.settledAt ?? null,
    } as never);
    h.tx.wallet.findUnique.mockResolvedValueOnce(
      opts.balance === null ? null : ({ balance: opts.balance ?? '150.00' } as never),
    );
  }

  const CONFIRM = {
    amount: 150,
    method: 'cash at the centre',
    reference: 'RCPT-9',
    reason: 'Settled in person, support ticket SC-11',
  };

  it('confirming records the ledger debit and the settlement, audited, with the actor', async () => {
    const h = build();
    holding(h);

    const out = await h.service.confirmSettlement('del_1', ADMIN_ACTOR, CONFIRM, META);

    expect(out).toEqual({ id: 'del_1', settled: true, amount: 150, transactionId: 'wtx_1' });
    // Every financial change is a ledger transaction (§4.4): a REFUND from the
    // ADMIN source, idempotent per request, attributed to the actor.
    expect(h.wallet.debit).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({
        userId: 'usr_s',
        amount: '150.00',
        type: 'REFUND',
        source: 'ADMIN',
        performedByAdminId: 'usr_admin',
        idempotencyKey: 'deletion-settlement:del_1',
        reference: { type: 'account_deletion', id: 'del_1' },
      }),
    );
    const upd = (h.tx.accountDeletionRequest.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ])[0];
    expect(upd.where).toEqual({ id: 'del_1', settledAt: null });
    expect(upd.data).toMatchObject({ settledById: 'usr_admin', settledAmount: '150.00', settlementTxId: 'wtx_1' });
    expect(upd.data.settledAt).toBeInstanceOf(Date);
    expect(h.audit.recordTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorId: 'usr_admin',
        entityId: 'del_1',
        note: expect.stringContaining('RCPT-9'),
      }),
    );
  });

  it('refuses an amount that does not equal the current balance, moving nothing', async () => {
    const h = build();
    holding(h, { balance: '150.00' });
    await expect(
      h.service.confirmSettlement('del_1', ADMIN_ACTOR, { ...CONFIRM, amount: 100 }, META),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(h.wallet.debit).not.toHaveBeenCalled();
    expect(h.tx.accountDeletionRequest.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a duplicate confirmation', async () => {
    const h = build();
    holding(h, { settledAt: new Date() });
    await expect(h.service.confirmSettlement('del_1', ADMIN_ACTOR, CONFIRM, META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(h.wallet.debit).not.toHaveBeenCalled();
  });

  it('refuses a racing duplicate even past the first read (conditional update decides)', async () => {
    const h = build();
    holding(h);
    h.tx.accountDeletionRequest.updateMany.mockResolvedValueOnce({ count: 0 } as never);
    await expect(h.service.confirmSettlement('del_1', ADMIN_ACTOR, CONFIRM, META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    // The debit already ran, but it is idempotent per request
    // (deletion-settlement:del_1), so the retry that wins cannot move money twice.
  });

  it('refuses a request that is not holding for settlement', async () => {
    const h = build();
    // Default findUnique: a PROCESSING request with no settlement hold.
    await expect(h.service.confirmSettlement('del_1', ADMIN_ACTOR, CONFIRM, META)).rejects.toMatchObject({
      code: 'INVALID_STATE',
    });
    expect(h.wallet.debit).not.toHaveBeenCalled();
  });

  it('a balance drained after the hold is confirmed with amount 0 and no ledger line', async () => {
    const h = build();
    holding(h, { balance: '0.00' });
    const out = await h.service.confirmSettlement('del_1', ADMIN_ACTOR, { ...CONFIRM, amount: 0 }, META);
    expect(out).toEqual({ id: 'del_1', settled: true, amount: 0, transactionId: null });
    // Nothing moved, so nothing may be written to the ledger (§4.4 is about
    // changes; a no-op debit row would be a fabricated transaction).
    expect(h.wallet.debit).not.toHaveBeenCalled();
    expect(h.audit.recordTx).toHaveBeenCalled();
  });

  it('the settlement list carries minimal identity, both amounts, the ledger breakdown, and nothing else', async () => {
    const h = build();
    h.prisma.accountDeletionRequest.findMany.mockResolvedValueOnce([
      {
        id: 'del_1',
        userId: 'usr_s',
        status: AccountDeletionStatus.PENDING,
        requestedAt: new Date(),
        scheduledFor: new Date(),
        settlementRequiredAt: new Date(),
        outstandingAmount: '150.00',
        user: {
          fullName: 'Ahmed Mohamed',
          phone: '01001234567',
          wallet: { id: 'wal_1', balance: '140.00' },
        },
      },
    ] as never);
    // How the balance arose: 120 from recharge cards (real cash in), 50 from
    // an administrative credit, 30 spent in the library.
    h.prisma.walletTransaction.groupBy.mockResolvedValueOnce([
      { walletId: 'wal_1', type: 'CREDIT_RECHARGE', direction: 'CREDIT', _sum: { amount: '120.00' } },
      { walletId: 'wal_1', type: 'ADMIN_ADJUSTMENT', direction: 'CREDIT', _sum: { amount: '50.00' } },
      { walletId: 'wal_1', type: 'PURCHASE', direction: 'DEBIT', _sum: { amount: '30.00' } },
    ] as never);

    const [item] = await h.service.listPendingSettlements();
    expect(Object.keys(item).sort()).toEqual(
      [
        'currentBalance',
        'fullName',
        'id',
        'ledger',
        'outstandingAmount',
        'phone',
        'requestedAt',
        'scheduledFor',
        'settlementRequiredAt',
        'status',
        'userId',
      ].sort(),
    );
    // The live balance is the amount to CLEAR; the ledger breakdown is what
    // tells the administrator how much of it is actually owed (a wallet
    // balance is not automatically a refund liability).
    expect(item).toMatchObject({
      outstandingAmount: 150,
      currentBalance: 140,
      fullName: 'Ahmed Mohamed',
      ledger: {
        credits: { CREDIT_RECHARGE: 120, ADMIN_ADJUSTMENT: 50 },
        debits: { PURCHASE: 30 },
      },
    });
    const where = (h.prisma.accountDeletionRequest.findMany.mock.calls.at(-1) as unknown as [
      { where: Record<string, unknown> },
    ])[0].where;
    expect(where).toEqual({ settlementRequiredAt: { not: null }, settledAt: null });
    // The breakdown is a read: groupBy, never a write.
    expect(Object.keys(h.prisma.walletTransaction)).toEqual(['groupBy']);
  });

  it('administrator recovery can never clear a settlement hold', async () => {
    // retryFailed re-queues a FAILED erasure; it must not be a side door out
    // of the settlement requirement. The update touches exactly the failure
    // fields, and the due query (pinned above) excludes held requests whatever
    // their failure state.
    const h = build();
    await h.service.retryFailed('del_1', ADMIN_ACTOR, 'Cause fixed, ticket SC-1', META);
    const { where, data } = (h.prisma.accountDeletionRequest.updateMany.mock.calls[0] as unknown as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ])[0];
    expect(Object.keys(data).sort()).toEqual(['attempts', 'failedAt', 'lastError']);
    expect(where).not.toHaveProperty('settlementRequiredAt');
    expect(Object.keys(data)).not.toContain('settledAt');
  });

  it('both settlement endpoints are administrator-only, and the body is validated', async () => {
    const roles = (handler: object) => (Reflect.getMetadata(ROLES_KEY, handler) as string[]).slice().sort();
    for (const handler of [
      AccountDeletionAdminController.prototype.settlements,
      AccountDeletionAdminController.prototype.confirmSettlement,
    ]) {
      expect(roles(handler)).toEqual(['ADMIN', 'MASTER']);
      expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).toBeUndefined();
    }
    const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
    // A written reason and an explicit amount are not optional.
    await expect(
      pipe.transform({ method: 'cash', reason: 'Settled in person, SC-11' }, { type: 'body', metatype: ConfirmSettlementDto }),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform({ amount: 150, method: 'cash', reason: 'short' }, { type: 'body', metatype: ConfirmSettlementDto }),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform({ amount: -5, method: 'cash', reason: 'Settled in person, SC-11' }, { type: 'body', metatype: ConfirmSettlementDto }),
    ).rejects.toBeDefined();
    await expect(
      pipe.transform(
        { amount: 150, method: 'cash at the centre', reference: 'RCPT-9', reason: 'Settled in person, SC-11' },
        { type: 'body', metatype: ConfirmSettlementDto },
      ),
    ).resolves.toMatchObject({ amount: 150 });
  });
});
