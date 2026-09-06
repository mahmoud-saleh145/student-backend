import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AuthenticatedUser } from '../types/request-context';

/**
 * Injects the authenticated principal.
 *
 * Throws rather than returning undefined when used on a route that turned out
 * to be public — a handler that asks for the user must have one.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const user = request.user;

    if (!user) {
      throw new AppException(ErrorCode.UNAUTHORIZED, {
        message: '@CurrentUser used on a route without an authenticated principal',
      });
    }

    return field ? user[field] : user;
  },
);

/** Injects the parsed device headers, present on every request. */
export const DeviceInfo = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().deviceContext ?? null;
});

/** Injects the resolved request locale ('en' | 'ar'). */
export const Locale = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<Request>().locale ?? 'en';
});

/** Injects the client IP, honouring the proxy configuration. */
export const ClientIp = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.ip ?? req.socket?.remoteAddress ?? null;
});
