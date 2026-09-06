import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { IS_PUBLIC_KEY } from '../../src/common/decorators/public.decorator';
import { ROLES_KEY } from '../../src/common/decorators/roles.decorator';
import { AppException } from '../../src/common/errors/app.exception';
import { ErrorCode } from '../../src/common/errors/error-codes';
import { RolesGuard } from '../../src/common/guards/roles.guard';

/**
 * Role authorization.
 *
 * The property that matters most here is the negative one: a student holding a
 * perfectly valid token must not reach an administrative route. Spec §94 —
 * hiding the button in the app secures nothing; this guard is what does.
 */

function contextFor(
  user: { id: string; role: UserRole } | null,
  metadata: Record<string, unknown> = {},
): { context: ExecutionContext; reflector: Reflector } {
  const request = { user: user ?? undefined };

  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;

  const reflector = {
    getAllAndOverride: (key: string) => metadata[key],
  } as unknown as Reflector;

  return { context, reflector };
}

const STUDENT = { id: 'u1', role: UserRole.STUDENT };
const TEACHER = { id: 'u2', role: UserRole.TEACHER };
const ADMIN = { id: 'u3', role: UserRole.ADMIN };
const MASTER = { id: 'u4', role: UserRole.MASTER };

describe('RolesGuard', () => {
  it('allows any authenticated user when no @Roles is present', () => {
    const { context, reflector } = contextFor(STUDENT);
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('allows an empty @Roles list through, same as no decorator', () => {
    const { context, reflector } = contextFor(STUDENT, { [ROLES_KEY]: [] });
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  it('short-circuits for @Public routes without inspecting the user', () => {
    const { context, reflector } = contextFor(null, {
      [IS_PUBLIC_KEY]: true,
      [ROLES_KEY]: [UserRole.MASTER],
    });
    expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
  });

  describe('rejects', () => {
    it('an unauthenticated request on a role-restricted route', () => {
      const { context, reflector } = contextFor(null, {
        [ROLES_KEY]: [UserRole.ADMIN],
      });

      expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(AppException);
      try {
        new RolesGuard(reflector).canActivate(context);
      } catch (e) {
        expect((e as AppException).code).toBe(ErrorCode.UNAUTHORIZED);
      }
    });

    it.each([
      ['student', STUDENT],
      ['teacher', TEACHER],
    ])('a %s on an admin-only route', (_label, user) => {
      const { context, reflector } = contextFor(user, {
        [ROLES_KEY]: [UserRole.MASTER, UserRole.ADMIN],
      });

      try {
        new RolesGuard(reflector).canActivate(context);
        throw new Error('guard should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(AppException);
        expect((e as AppException).code).toBe(ErrorCode.INSUFFICIENT_ROLE);
      }
    });

    /**
     * The distinction the spec insists on (§7): admins are not masters. If
     * MASTER were implicitly folded into every role list, this passes; the
     * decorator is deliberately explicit so that it does not.
     */
    it('an admin on a master-only route', () => {
      const { context, reflector } = contextFor(ADMIN, {
        [ROLES_KEY]: [UserRole.MASTER],
      });

      expect(() => new RolesGuard(reflector).canActivate(context)).toThrow(AppException);
    });
  });

  describe('admits', () => {
    it('a master on a master-only route', () => {
      const { context, reflector } = contextFor(MASTER, {
        [ROLES_KEY]: [UserRole.MASTER],
      });
      expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
    });

    it('an admin on a route that lists both master and admin', () => {
      const { context, reflector } = contextFor(ADMIN, {
        [ROLES_KEY]: [UserRole.MASTER, UserRole.ADMIN],
      });
      expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
    });

    it('a teacher on a staff route', () => {
      const { context, reflector } = contextFor(TEACHER, {
        [ROLES_KEY]: [UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER],
      });
      expect(new RolesGuard(reflector).canActivate(context)).toBe(true);
    });
  });

  /**
   * A matrix rather than a list, so adding a role to the enum without
   * revisiting authorization shows up as a failure here.
   */
  describe('full matrix', () => {
    const routes: { name: string; roles: UserRole[]; allowed: UserRole[] }[] = [
      {
        name: 'master-only',
        roles: [UserRole.MASTER],
        allowed: [UserRole.MASTER],
      },
      {
        name: 'admin',
        roles: [UserRole.MASTER, UserRole.ADMIN],
        allowed: [UserRole.MASTER, UserRole.ADMIN],
      },
      {
        name: 'staff',
        roles: [UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER],
        allowed: [UserRole.MASTER, UserRole.ADMIN, UserRole.TEACHER],
      },
      {
        name: 'student-only',
        roles: [UserRole.STUDENT],
        allowed: [UserRole.STUDENT],
      },
    ];

    for (const route of routes) {
      for (const role of Object.values(UserRole)) {
        const shouldPass = route.allowed.includes(role);

        it(`${role} on a ${route.name} route → ${shouldPass ? 'allow' : 'deny'}`, () => {
          const { context, reflector } = contextFor(
            { id: 'x', role },
            { [ROLES_KEY]: route.roles },
          );
          const guard = new RolesGuard(reflector);

          if (shouldPass) {
            expect(guard.canActivate(context)).toBe(true);
          } else {
            expect(() => guard.canActivate(context)).toThrow(AppException);
          }
        });
      }
    }
  });
});
