import { HttpStatus, type ArgumentsHost } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccountStatus } from '@prisma/client';

import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';
import { authConfig } from '../../src/config/configuration';
import { AuthService, type RequestMeta } from '../../src/modules/auth/auth.service';

/**
 * Account lockout on sign-in.
 *
 * Twenty wrong passwords lock an account for ten minutes. The defect this file
 * pins down: only a *successful* sign-in reset the failure counter, so once
 * the lock ran out the counter was still sitting at the threshold and the very
 * next typo re-locked the account for another full lockout period. A staff
 * member who mistyped once after waiting out a lock was locked again — in
 * production, 2026-10-13, every subsequent attempt answered 429.
 *
 * Apart from the policy test, the cases read the threshold and duration from
 * the real config, so they keep testing the behaviour if the policy moves.
 *
 * The persistence layer is an in-memory row so the counter and lock carry
 * across attempts exactly as they would across requests.
 */

const MINUTE_MS = 60_000;
const START = new Date('2026-10-13T20:00:00.000Z').getTime();

const CORRECT = 'correct-password';
const WRONG = 'wrong-password';

const META: RequestMeta = {
  ip: '10.0.0.1',
  userAgent: 'jest',
  requestId: 'req_1',
  device: {
    deviceKey: null,
    platform: 'web',
    model: null,
    name: null,
    osVersion: null,
    appVersion: null,
    appBuild: null,
    integritySuspect: false,
  },
};

const cfg = authConfig();
const LIMIT = cfg.maxFailedLogins;
const LOCK_MS = cfg.lockoutMinutes * MINUTE_MS;

type UserRow = {
  id: string;
  phone: string;
  passwordHash: string;
  role: 'ADMIN';
  status: AccountStatus;
  deletedAt: Date | null;
  failedLoginCount: number;
  lockedUntil: Date | null;
  lastLoginAt: Date | null;
};

function build() {
  const row: UserRow = {
    id: 'usr_1',
    phone: '01000000002',
    passwordHash: 'hash',
    role: 'ADMIN',
    status: AccountStatus.ACTIVE,
    deletedAt: null,
    failedLoginCount: 0,
    lockedUntil: null,
    lastLoginAt: null,
  };

  const prisma = {
    user: {
      findUnique: jest.fn(async () => ({ ...row })),
      update: jest.fn(async ({ data }: { data: Partial<UserRow> }) => {
        Object.assign(row, data);
        return { ...row };
      }),
    },
    // Sign-in also checks for a pending account deletion (owner decision D5).
    accountDeletionRequest: { findFirst: jest.fn(async () => null) },
  };

  const passwords = {
    verify: jest.fn(async (_hash: string, password: string) => password === CORRECT),
    burnTiming: jest.fn(async () => undefined),
    needsRehash: jest.fn(() => false),
    hash: jest.fn(async () => 'hash'),
  };

  const security = { record: jest.fn(async () => undefined) };
  const configService = { getOrThrow: jest.fn(() => cfg) };

  // Parameter order mirrors the constructor: prisma, users, passwords, tokens,
  // devices, security, audit, config.
  const service = new AuthService(
    prisma as never,
    {} as never,
    passwords as never,
    {} as never,
    {} as never,
    security as never,
    {} as never,
    configService as unknown as ConfigService,
  );

  // Session issuance is covered elsewhere; here it only marks "signed in".
  jest
    .spyOn(service as unknown as { establishSession: () => Promise<unknown> }, 'establishSession')
    .mockImplementation(async () => ({ signedIn: true }));

  const attempt = (password: string) =>
    service.login({ phone: row.phone, password } as never, META);

  return { service, row, passwords, attempt };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  await expect(promise).rejects.toBeInstanceOf(AppException);
  await promise.catch((error: AppException) => expect(error.code).toBe(code));
}

async function failTimes(attempt: (password: string) => Promise<unknown>, times: number) {
  for (let i = 0; i < times; i += 1) {
    await expectCode(attempt(WRONG), ErrorCode.INVALID_CREDENTIALS);
  }
}

beforeEach(() => {
  jest.useFakeTimers({ now: START });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('login lockout', () => {
  it('uses the configured policy: 20 failures, 10 minutes', () => {
    expect(cfg.maxFailedLogins).toBe(20);
    expect(cfg.lockoutMinutes).toBe(10);
  });

  it('the 20th consecutive failure locks the account for 10 minutes', async () => {
    const { row, attempt } = build();

    await failTimes(attempt, 19);
    expect(row.failedLoginCount).toBe(19);
    expect(row.lockedUntil).toBeNull();

    await failTimes(attempt, 1);
    expect(row.failedLoginCount).toBe(20);
    expect(row.lockedUntil?.getTime()).toBe(START + 10 * MINUTE_MS);
  });

  it('blocks every attempt during an active lock — the correct password included', async () => {
    const { row, passwords, attempt } = build();
    await failTimes(attempt, LIMIT);
    const lockedUntil = row.lockedUntil;
    passwords.verify.mockClear();

    // Right after the lock, and one millisecond before it ends.
    for (const at of [START + 1, START + LOCK_MS - 1]) {
      jest.setSystemTime(at);
      await expectCode(attempt(WRONG), ErrorCode.RATE_LIMITED);
      await expectCode(attempt(CORRECT), ErrorCode.RATE_LIMITED);
    }

    // Rejected before the password is checked, and without moving the lock.
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(row.lockedUntil).toEqual(lockedUntil);
    expect(row.failedLoginCount).toBe(LIMIT);
  });

  it('reports the remaining lock time', async () => {
    const { attempt } = build();
    await failTimes(attempt, LIMIT);

    jest.setSystemTime(START + 4 * MINUTE_MS);

    const error = await attempt(CORRECT).then(
      () => null,
      (thrown: AppException) => thrown,
    );
    expect(error?.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error?.details).toEqual({ retryAfterSeconds: LOCK_MS / 1000 - 4 * 60 });
  });

  it('does not re-lock on the first failure after the lock expires', async () => {
    const { row, attempt } = build();
    await failTimes(attempt, LIMIT);

    jest.setSystemTime(START + LOCK_MS + 1);

    await expectCode(attempt(WRONG), ErrorCode.INVALID_CREDENTIALS);
    expect(row.failedLoginCount).toBe(1);
    expect(row.lockedUntil).toBeNull();

    // And the account is usable again straight away.
    await expect(attempt(CORRECT)).resolves.toEqual({ signedIn: true });
  });

  it('locks again after a full new run of failures following an expired lock', async () => {
    const { row, attempt } = build();
    await failTimes(attempt, LIMIT);

    const relockAt = START + LOCK_MS + 1;
    jest.setSystemTime(relockAt);

    await failTimes(attempt, LIMIT - 1);
    expect(row.lockedUntil).toBeNull();

    await failTimes(attempt, 1);
    expect(row.failedLoginCount).toBe(LIMIT);
    expect(row.lockedUntil?.getTime()).toBe(relockAt + LOCK_MS);
    await expectCode(attempt(CORRECT), ErrorCode.RATE_LIMITED);
  });

  it('a successful sign-in resets the counter and clears the lock', async () => {
    const { row, attempt } = build();
    await failTimes(attempt, LIMIT - 1);

    await expect(attempt(CORRECT)).resolves.toEqual({ signedIn: true });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
    expect(row.lastLoginAt).not.toBeNull();

    // A fresh window: one short of the threshold still does not lock.
    await failTimes(attempt, LIMIT - 1);
    expect(row.lockedUntil).toBeNull();
  });

  it('a successful sign-in after an expired lock clears it', async () => {
    const { row, attempt } = build();
    await failTimes(attempt, LIMIT);

    jest.setSystemTime(START + LOCK_MS + MINUTE_MS);

    await expect(attempt(CORRECT)).resolves.toEqual({ signedIn: true });
    expect(row.failedLoginCount).toBe(0);
    expect(row.lockedUntil).toBeNull();
  });
});

describe('lockout response', () => {
  function respond(exception: unknown, isProduction: boolean) {
    const response = {
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    };
    const request = { method: 'POST', originalUrl: '/api/v1/auth/login', requestId: 'req_1' };
    const host = {
      switchToHttp: () => ({ getResponse: () => response, getRequest: () => request }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter(isProduction).catch(exception, host);
    return response;
  }

  const lockout = () =>
    new AppException(ErrorCode.RATE_LIMITED, {
      message: 'Too many failed attempts; try again later',
      details: { retryAfterSeconds: 599.2 },
    });

  it('sends the remaining time as Retry-After, even in production', () => {
    const response = respond(lockout(), true);

    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '600');

    // `details` itself stays withheld in production.
    const body = response.json.mock.calls[0][0];
    expect(body.error.details).toBeUndefined();
  });

  it('sends no Retry-After for a 429 without a wait', () => {
    const response = respond(
      new AppException(ErrorCode.RATE_LIMITED, { message: 'Too many playback requests.' }),
      true,
    );
    expect(response.setHeader).not.toHaveBeenCalled();
  });

  it('never sends Retry-After on a non-429', () => {
    const response = respond(
      new AppException(ErrorCode.INVALID_CREDENTIALS, { details: { retryAfterSeconds: 60 } }),
      true,
    );
    expect(response.setHeader).not.toHaveBeenCalled();
  });
});
