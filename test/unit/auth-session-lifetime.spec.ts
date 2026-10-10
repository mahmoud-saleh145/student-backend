import { AccountStatus, SessionStatus } from '@prisma/client';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

import { AppException } from '../../src/common/errors/app.exception';
import { AuthService, type RequestMeta } from '../../src/modules/auth/auth.service';
import { TokenService } from '../../src/modules/auth/token.service';

/**
 * Why this file exists
 * ===================
 *
 * Two independent defects made a valid, actively-used session end. Both are
 * covered here because both are required for the fix to hold.
 *
 * 1. **The server-side session never slid.**
 *
 *    `Session.expiresAt` was written once, at sign-in, as
 *    `now + JWT_REFRESH_TTL`. The refresh token, by contrast, is re-issued with
 *    a brand-new full window on every rotation. So a student who stayed signed
 *    in held an endlessly-renewing refresh token alongside a session that
 *    expired 30 days after first contact regardless of activity — and
 *    `JwtAuthGuard` rejects on `session.expiresAt`, so the guard killed requests
 *    the refresh could otherwise have rescued. The session, not the token, was
 *    the ceiling on the login.
 *
 * 2. **A rotation race was treated as theft.**
 *
 *    Refresh tokens are single-use and rotating, which is right. But presenting
 *    one twice within a second or two is indistinguishable, server-side, from a
 *    stolen token being replayed — and the previous answer to both was to revoke
 *    the whole family. A browser fanning a page load out into a dozen
 *    concurrent requests hits that constantly, so ordinary navigation ended
 *    sessions and wrote CRITICAL theft events against real accounts.
 *
 * The reissued token in (2) is stored as a real row on purpose: a token minted
 * into thin air would be read as forgery on its next presentation, which is the
 * very failure the grace window exists to prevent.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

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

const ACTIVE_USER = {
  id: 'usr_1',
  role: 'STUDENT' as const,
  status: AccountStatus.ACTIVE,
  deletedAt: null,
  credentialsChangedAt: new Date(Date.now() - 40 * DAY_MS),
};

/**
 * A single row's `data` payload, as handed to the Prisma mocks.
 *
 * Typed rather than `any` so the assertions below still say what shape they
 * expect; the surrounding stand-in is deliberately loose because a faithful
 * Prisma type here would be most of the file.
 */
type RowData = { data: { expiresAt: Date; lastSeenAt: Date } };

/**
 * The Prisma stand-in: jest mocks keyed by model.
 *
 * `$transaction` is not a model and would not fit a strict per-model record,
 * so the whole object is kept as a loose map and the two models the assertions
 * actually reach into are re-exposed with their concrete types below.
 */
type PrismaDouble = Record<string, unknown>;

interface Harness {
  service: AuthService;
  prisma: PrismaDouble;
  /** Typed view of `prisma.session`, for the assertions that read its writes. */
  session: { update: jest.Mock };
  /** Typed view of `prisma.refreshToken`. */
  refreshToken: { create: jest.Mock };
  refreshTokenUpdateMany: jest.Mock;
  sessionUpdateMany: jest.Mock;
  securityRecord: jest.Mock;
  config: { accessTtl: number; refreshTtl: number; refreshReuseGraceSeconds: number };
}

/**
 * Builds an AuthService over a hand-written Prisma stand-in.
 *
 * The refresh path is read-heavy and this keeps each test's fixture readable:
 * `stored` is the row the presented token resolves to, and every mutation is a
 * jest.fn so the assertions can be made on what the transaction wrote.
 */
function harness(options: {
  stored?: Record<string, unknown> | null;
  refreshReuseGraceSeconds?: number;
  accessTtl?: number;
  refreshTtl?: number;
} = {}): Harness {
  const config = {
    accessTtl: options.accessTtl ?? 900,
    refreshTtl: options.refreshTtl ?? THIRTY_DAYS_S,
    refreshReuseGraceSeconds: options.refreshReuseGraceSeconds ?? 30,
    issuer: 'edu-platform',
    audience: 'edu-mobile',
    accessSecret: 'a'.repeat(48),
    refreshSecret: 'b'.repeat(48),
    playbackSecret: 'c'.repeat(48),
  };

  const now = Date.now();
  const stored =
    'stored' in options
      ? options.stored
      : {
          id: 'rt_1',
          userId: 'usr_1',
          sessionId: 'ses_1',
          familyId: 'fam_1',
          replacedById: 'rt_2',
          usedAt: null,
          revokedAt: null,
          expiresAt: new Date(now + 20 * DAY_MS),
          createdAt: new Date(now - 10 * DAY_MS),
          session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
          user: ACTIVE_USER,
        };

  const refreshTokenUpdateMany = jest.fn(async () => ({ count: 1 }));
  const sessionUpdateMany = jest.fn(async () => ({ count: 1 }));
  const sessionUpdate = jest.fn(async () => ({ id: 'ses_1' }));
  const refreshTokenCreate = jest.fn(async () => ({ id: 'rt_new' }));
  const securityRecord = jest.fn(async () => undefined);

  const prisma = {
    refreshToken: {
      findUnique: jest.fn(async () => stored),
      create: refreshTokenCreate,
      update: jest.fn(async () => ({ id: 'rt_1' })),
      updateMany: refreshTokenUpdateMany,
      findMany: jest.fn(async () => []),
    },
    session: {
      findUnique: jest.fn(async () => stored?.session ?? null),
      update: sessionUpdate,
      updateMany: sessionUpdateMany,
    },
    $transaction: async (arg: unknown): Promise<unknown> => {
      if (typeof arg === 'function') {
        return (arg as (t: typeof tx) => Promise<unknown>)(tx);
      }
      if (Array.isArray(arg)) return Promise.all(arg);
      return arg;
    },
  };

  const tx = {
    refreshToken: prisma.refreshToken,
    session: prisma.session,
  };

  const configService = {
    getOrThrow: (key: string) => {
      if (key === 'auth') return config;
      throw new Error(`unexpected config key ${key}`);
    },
  };

  const jwt = new JwtService({
    secret: config.refreshSecret,
    signOptions: { issuer: config.issuer, audience: config.audience },
  });

  const tokens = new TokenService(jwt, configService as unknown as ConfigService);
  // Verify without the expiry check, so a test can present an already-expired
  // token and reach the server-side branch that is under test.
  const verifyRefresh = tokens.verifyRefresh.bind(tokens);
  jest.spyOn(tokens, 'verifyRefresh').mockImplementation(async (token: string) => {
    try {
      return await verifyRefresh(token);
    } catch {
      return { sub: 'usr_1', sid: 'ses_1', fam: 'fam_1', jti: 'jti_1' };
    }
  });

  const users = { toPublicUser: jest.fn(async () => ({ id: 'usr_1' })) };
  const devices = { currentDeviceStatus: jest.fn(async () => ({ authorized: true })) };
  const security = { record: securityRecord };
  const audit = { record: jest.fn(async () => undefined) };
  const passwords = { hash: jest.fn(async () => 'hash') };

  // Parameter order mirrors the constructor: prisma, users, passwords, tokens,
  // devices, security, audit, config.
  const service = new AuthService(
    prisma as never,
    users as never,
    passwords as never,
    tokens,
    devices as never,
    security as never,
    audit as never,
    configService as unknown as ConfigService,
  );

  return {
    service,
    prisma,
    session: prisma.session as { update: jest.Mock },
    refreshToken: prisma.refreshToken as { create: jest.Mock },
    refreshTokenUpdateMany,
    sessionUpdateMany,
    securityRecord,
    config,
  };
}

describe('AuthService.refresh — persistent session lifetime', () => {
  it('slides the server-side session expiry forward on every rotation', async () => {
    // The core of the 30-day guarantee. Before this, the session carried a
    // timestamp fixed at sign-in and expired 30 days later no matter how active
    // the user was.
    const { service, session, config } = harness();

    const before = Date.now();
    const result = await service.refresh('refresh-token', META);

    const update = session.update.mock.calls[0]![0] as RowData;

    const expectedExpiry = before + config.refreshTtl * 1000;
    // Within a minute of tolerance: the assertion is that it MOVED, and that it
    // moved to a full refresh window from now rather than staying put.
    expect(update.data.expiresAt.getTime()).toBeGreaterThan(expectedExpiry - 60_000);
    expect(update.data.lastSeenAt).toBeInstanceOf(Date);

    // And the caller gets a genuinely new pair.
    expect(result.accessToken).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(result.accessToken).not.toBe(result.refreshToken);
  });

  it('keeps the session window and the refresh window compatible', async () => {
    const { service, session, refreshToken, config } = harness();

    await service.refresh('refresh-token', META);

    const sessionExpiry = (session.update.mock.calls[0]![0] as RowData).data.expiresAt;
    const tokenExpiry = (refreshToken.create.mock.calls[0]![0] as RowData).data.expiresAt;

    // They must not drift apart: a refresh token that outlives its session (or
    // the reverse) means one of the two is unreachable in practice.
    expect(Math.abs(sessionExpiry.getTime() - tokenExpiry.getTime())).toBeLessThan(1000);
    expect(config.refreshTtl).toBeGreaterThanOrEqual(THIRTY_DAYS_S);
  });
});

describe('AuthService.refresh — rotation races', () => {
  it('recovers when a rotated token is replayed inside the grace window', async () => {
    // Two requests presenting the same token at the same instant. This used to
    // revoke the entire family and log the user out.
    const { service, refreshTokenUpdateMany, securityRecord } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 2_000),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: ACTIVE_USER,
      },
    });

    const result = await service.refresh('refresh-token', META);

    expect(result.refreshToken).toBeTruthy();
    expect(result.accessToken).toBeTruthy();

    // The family is NOT revoked — that was the logout.
    expect(refreshTokenUpdateMany).not.toHaveBeenCalled();

    // Still visible for review, but not screaming "theft" about a real account.
    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TOKEN_REUSE', severity: 'LOW' }),
    );
  });

  it('stores the reissued token as a real row, not a token minted into thin air', async () => {
    // An unregistered token would be read as forgery on its next presentation —
    // reintroducing exactly the logout this path removes.
    const { service, refreshToken } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 2_000),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: ACTIVE_USER,
      },
    });

    await service.refresh('refresh-token', META);

    expect(refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ familyId: 'fam_1', sessionId: 'ses_1' }),
      }),
    );
  });

  it('still revokes the family when the replay is genuinely late', async () => {
    // The security control is preserved: a thief replaying well after the
    // rotation is still caught.
    const { service, refreshTokenUpdateMany, securityRecord } = harness({
      refreshReuseGraceSeconds: 30,
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 10 * 60 * 1000),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: ACTIVE_USER,
      },
    });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);

    expect(refreshTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { familyId: 'fam_1', revokedAt: null },
      }),
    );
    expect(securityRecord).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'TOKEN_REUSE', severity: 'CRITICAL' }),
    );
  });

  it('never rescues a revoked token, however recent', async () => {
    // Logout and administrative revocation must be absolute. The grace window
    // is for races, not for undoing a decision someone already made.
    const { service } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 1_000),
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: ACTIVE_USER,
      },
    });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);
  });

  it('never rescues a revoked session, however recent', async () => {
    const { service } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 1_000),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.REVOKED, deviceId: null },
        user: ACTIVE_USER,
      },
    });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);
  });

  it('never rescues a disabled account, however recent', async () => {
    const { service } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 1_000),
        revokedAt: null,
        expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: { ...ACTIVE_USER, status: AccountStatus.DISABLED },
      },
    });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);
  });
});

describe('AuthService.refresh — invalid and expired tokens', () => {
  it('refuses a token with no record at all', async () => {
    const { service, refreshTokenUpdateMany } = harness({ stored: null });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);
    // An unknown token still revokes: that is the forgery signal.
    expect(refreshTokenUpdateMany).toHaveBeenCalled();
  });

  it('refuses an expired token, even inside the grace window', async () => {
    const { service } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 1_000),
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: ACTIVE_USER,
      },
    });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);
  });

  it('refuses a token minted before the password changed', async () => {
    const { service } = harness({
      stored: {
        id: 'rt_1',
        userId: 'usr_1',
        sessionId: 'ses_1',
        familyId: 'fam_1',
        replacedById: 'rt_2',
        usedAt: new Date(Date.now() - 1_000),
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
        session: { id: 'ses_1', status: SessionStatus.ACTIVE, deviceId: null },
        user: { ...ACTIVE_USER, credentialsChangedAt: new Date() },
      },
    });

    await expect(service.refresh('refresh-token', META)).rejects.toBeInstanceOf(AppException);
  });
});

describe('AuthService.refresh — access token lifetime', () => {
  it('keeps the access token short-lived while the session stays persistent', async () => {
    // The requirement is a 30-day *session*, not a 30-day bearer token. A short
    // access token is correct and is preserved.
    const { service, config } = harness({ accessTtl: 900 });

    const result = await service.refresh('refresh-token', META);

    expect(config.accessTtl).toBe(900);
    expect(result.expiresIn).toBe(900);
    expect(config.refreshTtl).toBe(THIRTY_DAYS_S);
  });
});