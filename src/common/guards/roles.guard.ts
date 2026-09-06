import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import type { Request } from 'express';

import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * Coarse role gate. Fine-grained checks — "is this teacher assigned to this
 * course" — live in the domain services, because they need to load the
 * resource anyway and a guard would duplicate that query.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles() means "any authenticated user"; JwtAuthGuard already ran.
    if (!required || required.length === 0) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      throw new AppException(ErrorCode.UNAUTHORIZED);
    }

    if (!required.includes(user.role)) {
      throw new AppException(ErrorCode.INSUFFICIENT_ROLE, {
        message: `Requires one of: ${required.join(', ')}`,
        details: { required, actual: user.role },
      });
    }

    return true;
  }
}
