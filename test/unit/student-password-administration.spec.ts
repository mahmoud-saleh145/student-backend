import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AuditAction, SessionStatus, UserRole } from '@prisma/client';
import * as argon2 from 'argon2';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { AppException } from '../../src/common/errors/app.exception';
import { ERROR_STATUS, ErrorCode } from '../../src/common/errors/error-codes';
import { RolesGuard } from '../../src/common/guards/roles.guard';
import { authConfig } from '../../src/config/configuration';
import { AuthController } from '../../src/modules/auth/auth.controller';
import { AuthService, type RequestMeta } from '../../src/modules/auth/auth.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from '../../src/modules/auth/dto';
import { checkNewPassword } from '../../src/modules/auth/password-policy';
import { PasswordService } from '../../src/modules/auth/password.service';
import { ResetPasswordDto, UsersController } from '../../src/modules/users/users.controller';
import { UsersService } from '../../src/modules/users/users.service';

/**
 * Student passwords are administered, never self-service.
 *
 * The product rule: a MASTER or ADMIN sets a student's password after the
 * student contacts support; a student can neither change nor recover their
 * own. This file pins the rule at every layer that could leak it:
 *
 *   1. the routes — which roles `RolesGuard` lets through to the admin reset
 *      and to the self-change endpoint, so a direct API call gets 403;
 *   2. the services — the self-change refuses a student even if the route
 *      decorator were dropped, and the reset refuses the master;
 *   3. what a reset does — argon2id hash, every session and refresh token
 *      revoked, lockout cleared, an audit row naming the administrator, and
 *      no password in the response or the audit entry;
 *   4. the one password policy every newly assigned password must meet.
 *
 * The full HTTP path (guards, pipe, real database) is covered by
 * test/integration/student-password-administration.e2e-spec.ts.
 */

const MASTER = { id: 'usr_master', role: UserRole.MASTER };
const ADMIN = { id: 'usr_admin', role: UserRole.ADMIN };
const TEACHER = { id: 'usr_teacher', role: UserRole.TEACHER };
const STUDENT = { id: 'usr_student', role: UserRole.STUDENT };

const NEW_PASSWORD = 'Granite7Harbor';

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type Controller = { prototype: Record<string, unknown> };

function rolesOn(controller: Controller, method: string): UserRole[] | undefined {
  return new Reflector().getAllAndOverride<UserRole[]>(ROLES_KEY, [
    controller.prototype[method] as never,
    controller as never,
  ]);
}

/** Runs the real RolesGuard against a route, as an HTTP request would. */
function guardOn(controller: Controller, method: string, user: { id: string; role: UserRole }) {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => controller.prototype[method],
    getClass: () => controller,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  };
  return () => guard.canActivate(context as never);
}

function expectForbidden(run: () => unknown, code = ErrorCode.INSUFFICIENT_ROLE) {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AppException);
    expect((error as AppException).code).toBe(code);
    expect(ERROR_STATUS[(error as AppException).code]).toBe(403);
    return;
  }
  throw new Error('expected the guard to refuse');
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AppException);
  expect((error as AppException).code).toBe(code);
}

/** The real PasswordService, at cheap argon2 settings. */
function passwordService(): PasswordService {
  const auth = { ...authConfig(), argon: { memoryCost: 8192, timeCost: 2, parallelism: 1 } };
  return new PasswordService({ getOrThrow: () => auth } as unknown as ConfigService);
}

function buildUsersService(target: { id: string; role: UserRole } | null) {
  const userUpdate = jest.fn(async (args: unknown) => args);
  const refreshRevoke = jest.fn(async (args: unknown) => args);
  const sessionRevoke = jest.fn(async (args: unknown) => args);

  const prisma = {
    user: {
      findFirst: jest.fn(async () => target),
      update: userUpdate,
    },
    refreshToken: { updateMany: refreshRevoke },
    session: { updateMany: sessionRevoke },
    $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
  };
  const audit = { record: jest.fn(async () => undefined) };

  const service = new UsersService(
    prisma as never,
    passwordService(),
    audit as never,
    {} as never,
    {} as never,
  );

  return { service, prisma, userUpdate, refreshRevoke, sessionRevoke, audit };
}

// ---------------------------------------------------------------------------
// 1. Routes
// ---------------------------------------------------------------------------

describe('PUT /admin/users/:id/password — route authorization', () => {
  const ctrl = UsersController as unknown as Controller;

  it('is declared for MASTER and ADMIN only', () => {
    expect(rolesOn(ctrl, 'resetPassword')).toEqual([UserRole.MASTER, UserRole.ADMIN]);
  });

  it('lets MASTER and ADMIN through', () => {
    expect(guardOn(ctrl, 'resetPassword', MASTER)()).toBe(true);
    expect(guardOn(ctrl, 'resetPassword', ADMIN)()).toBe(true);
  });

  it('answers a TEACHER 403', () => {
    expectForbidden(guardOn(ctrl, 'resetPassword', TEACHER));
  });

  it('answers a STUDENT 403', () => {
    expectForbidden(guardOn(ctrl, 'resetPassword', STUDENT));
  });
});

describe('POST /auth/password — students are refused', () => {
  const ctrl = AuthController as unknown as Controller;

  it('is declared for staff only', () => {
    expect(rolesOn(ctrl, 'changePassword')).toEqual([
      UserRole.MASTER,
      UserRole.ADMIN,
      UserRole.TEACHER,
    ]);
  });

  it('answers a STUDENT 403 at the route', () => {
    expectForbidden(guardOn(ctrl, 'changePassword', STUDENT));
  });

  it('keeps working for staff accounts', () => {
    expect(guardOn(ctrl, 'changePassword', MASTER)()).toBe(true);
    expect(guardOn(ctrl, 'changePassword', ADMIN)()).toBe(true);
    expect(guardOn(ctrl, 'changePassword', TEACHER)()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Services
// ---------------------------------------------------------------------------

describe('AuthService.changePassword', () => {
  function build(role: UserRole) {
    const prisma = {
      user: {
        findUniqueOrThrow: jest.fn(async () => ({ id: 'usr_1', passwordHash: 'stored', role })),
        update: jest.fn(async () => ({})),
      },
      refreshToken: { updateMany: jest.fn(async () => ({ count: 1 })) },
      session: { updateMany: jest.fn(async () => ({ count: 1 })) },
      $transaction: jest.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    };
    const passwords = {
      verify: jest.fn(async () => true),
      hash: jest.fn(async () => 'new-hash'),
    };
    const audit = { record: jest.fn(async () => undefined) };
    const service = new AuthService(
      prisma as never,
      {} as never,
      passwords as never,
      {} as never,
      {} as never,
      {} as never,
      audit as never,
      { getOrThrow: () => authConfig() } as unknown as ConfigService,
    );
    return { service, prisma, passwords };
  }

  it('refuses a student even when the route guard is bypassed, and writes nothing', async () => {
    const { service, prisma, passwords } = build(UserRole.STUDENT);

    await expectCode(
      service.changePassword('usr_1', 'Current1Pass', NEW_PASSWORD, META),
      ErrorCode.INSUFFICIENT_ROLE,
    );

    // Refused before the current password is even looked at.
    expect(passwords.verify).not.toHaveBeenCalled();
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER])(
    'still lets a %s change their own password',
    async (role) => {
      const { service, prisma } = build(role);
      await expect(
        service.changePassword('usr_1', 'Current1Pass', NEW_PASSWORD, META),
      ).resolves.toEqual({ ok: true });
      expect(prisma.user.update).toHaveBeenCalled();
    },
  );
});

describe('UsersService.resetPasswordByAdmin', () => {
  const student = { id: 'usr_student', role: UserRole.STUDENT };

  it.each([MASTER, ADMIN])('a $role resets a student password', async (actor) => {
    const { service } = buildUsersService(student);
    await expect(
      service.resetPasswordByAdmin(student.id, NEW_PASSWORD, actor),
    ).resolves.toEqual({ ok: true });
  });

  it('stores an argon2id hash of the new password, never the password', async () => {
    const { service, userUpdate } = buildUsersService(student);
    await service.resetPasswordByAdmin(student.id, NEW_PASSWORD, ADMIN);

    const { data } = userUpdate.mock.calls[0][0] as { data: Record<string, unknown> };
    const stored = data.passwordHash as string;
    expect(stored.startsWith('$argon2id$')).toBe(true);
    expect(stored).not.toContain(NEW_PASSWORD);
    await expect(argon2.verify(stored, NEW_PASSWORD)).resolves.toBe(true);
  });

  it('revokes every session and refresh token, and stamps the credential change', async () => {
    const { service, userUpdate, refreshRevoke, sessionRevoke } = buildUsersService(student);
    await service.resetPasswordByAdmin(student.id, NEW_PASSWORD, ADMIN);

    const userData = (userUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(userData.credentialsChangedAt).toBeInstanceOf(Date);

    expect(refreshRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: student.id, revokedAt: null } }),
    );
    expect(sessionRevoke).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: student.id, status: SessionStatus.ACTIVE },
        data: expect.objectContaining({ status: SessionStatus.REVOKED }),
      }),
    );
  });

  it('clears a sign-in lockout so the student can use the new password at once', async () => {
    const { service, userUpdate } = buildUsersService(student);
    await service.resetPasswordByAdmin(student.id, NEW_PASSWORD, ADMIN);

    const userData = (userUpdate.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(userData.failedLoginCount).toBe(0);
    expect(userData.lockedUntil).toBeNull();
  });

  it('audits the acting administrator and the note, without the password', async () => {
    const { service, audit } = buildUsersService(student);
    const result = await service.resetPasswordByAdmin(
      student.id,
      NEW_PASSWORD,
      ADMIN,
      'Identity checked by phone',
    );

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ADMIN.id,
        actorRole: ADMIN.role,
        action: AuditAction.PASSWORD_RESET,
        entity: 'user',
        entityId: student.id,
        note: 'Identity checked by phone',
      }),
    );
    expect(JSON.stringify((audit.record.mock.calls as unknown[][])[0])).not.toContain(NEW_PASSWORD);
    expect(JSON.stringify(result)).not.toContain(NEW_PASSWORD);
  });

  it('refuses the master account, whoever asks', async () => {
    for (const actor of [MASTER, ADMIN]) {
      const { service, userUpdate } = buildUsersService({ id: 'usr_m', role: UserRole.MASTER });
      await expectCode(
        service.resetPasswordByAdmin('usr_m', NEW_PASSWORD, actor),
        ErrorCode.CANNOT_MODIFY_MASTER,
      );
      expect(userUpdate).not.toHaveBeenCalled();
    }
  });

  it('refuses a teacher or student actor even if the route guard were bypassed', async () => {
    for (const actor of [TEACHER, STUDENT]) {
      const { service, userUpdate } = buildUsersService(student);
      await expectCode(
        service.resetPasswordByAdmin(student.id, NEW_PASSWORD, actor),
        ErrorCode.INSUFFICIENT_ROLE,
      );
      expect(userUpdate).not.toHaveBeenCalled();
    }
  });

  it('answers 404 for an unknown or deleted account', async () => {
    const { service } = buildUsersService(null);
    await expectCode(
      service.resetPasswordByAdmin('usr_gone', NEW_PASSWORD, ADMIN),
      ErrorCode.NOT_FOUND,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The password policy
// ---------------------------------------------------------------------------

describe('new-password policy', () => {
  it.each([
    ['Latin upper, lower and digit', 'Granite7Harbor'],
    ['Arabic letters and digits', 'كلمةسرية2024'],
    ['Arabic-Indic digits count as digits', 'Ahmedabc١٢'],
    ['symbols are allowed', 'Tr0ub4dor&3'],
    ['exactly 8 characters', 'Kx7mQp2w'],
    ['exactly 128 characters', `Ab1${'xyz'.repeat(41)}de`],
  ])('accepts: %s', (_label, value) => {
    expect(value.length).toBeLessThanOrEqual(128);
    expect(checkNewPassword(value)).toBeNull();
  });

  it.each([
    ['too short', 'Ab1cdef', 'length'],
    ['too long', `Ab1${'x'.repeat(126)}`, 'length'],
    ['no uppercase', 'granite7harbor', 'letters'],
    ['no lowercase', 'GRANITE7HARBOR', 'letters'],
    ['Arabic-Indic digits are not letters', '١١١١١١١1', 'letters'],
    ['Arabic punctuation is not a letter', '؟؟؟؟aa11', 'letters'],
    ['no digit', 'GraniteHarbor', 'digit'],
    ['a well-known password', 'Password1', 'common'],
    ['a well-known password, any case', 'PassWord123', 'common'],
    ['a number with two letters attached', 'Aa123456', 'common'],
    ['a phone number with two letters attached', 'Aa01001234567', 'common'],
    ['fewer than five different characters', 'Aa1Aa1Aa1', 'common'],
  ])('rejects: %s', (_label, value, problem) => {
    expect(checkNewPassword(value)).toBe(problem);
  });

  it('rejects a non-string outright', () => {
    expect(checkNewPassword(undefined)).toBe('length');
    expect(checkNewPassword(12345678)).toBe('length');
  });
});

describe('every place a password is set uses the policy', () => {
  async function errorsFor<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
    const errors = await validate(plainToInstance(cls, plain));
    return errors.map((e) => e.property);
  }

  const registration = {
    fullName: 'Ahmed Mohamed Ali',
    phone: '01001234567',
    universityId: 'u',
    facultyId: 'f',
    departmentId: 'd',
    academicYearId: 'y',
    gender: 'MALE',
  };

  it.each([
    ['administrative reset', ResetPasswordDto, 'newPassword', {}],
    ['staff self-change', ChangePasswordDto, 'newPassword', { currentPassword: 'anything' }],
  ] as const)('%s rejects a weak password and accepts a strong one', async (_label, cls, field, rest) => {
    expect(await errorsFor(cls as never, { ...rest, [field]: 'Aa123456' })).toContain(field);
    expect(await errorsFor(cls as never, { ...rest, [field]: '12345678' })).toContain(field);
    expect(await errorsFor(cls as never, { ...rest, [field]: NEW_PASSWORD })).not.toContain(field);
  });

  // Registration keeps its existing rule until every student client mirrors the
  // shared policy: an installed app that cannot explain the stricter rule would
  // leave the student on the last registration step with no visible error.
  it('registration keeps its existing rule for now', async () => {
    expect(await errorsFor(RegisterDto, { ...registration, password: 'Aa123456' })).not.toContain('password');
    expect(await errorsFor(RegisterDto, { ...registration, password: '12345678' })).toContain('password');
    expect(await errorsFor(RegisterDto, { ...registration, password: NEW_PASSWORD })).not.toContain('password');
  });

  it('names the problem in the field message', async () => {
    const [error] = await validate(plainToInstance(ResetPasswordDto, { newPassword: 'Aa123456' }));
    expect(Object.values(error.constraints ?? {}).join(' ')).toMatch(/too easy to guess/);
  });

  it('never alters the password: surrounding spaces are kept, not trimmed', async () => {
    const dto = plainToInstance(ResetPasswordDto, { newPassword: ` ${NEW_PASSWORD} ` });
    expect(await validate(dto)).toHaveLength(0);
    expect(dto.newPassword).toBe(` ${NEW_PASSWORD} `);
  });

  it('sign-in does not apply it, so an older password keeps working', async () => {
    expect(
      await errorsFor(LoginDto, { phone: '01001234567', password: 'aaaaaaaa' }),
    ).not.toContain('password');
  });
});
