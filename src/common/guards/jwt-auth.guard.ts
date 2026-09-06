import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AccountStatus, SessionStatus } from '@prisma/client';
import type { Request } from 'express';

import type { AuthConfig } from '../../config/configuration';
import { PrismaService } from '../../database/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import type { AuthenticatedUser } from '../types/request-context';

export interface AccessTokenPayload {
  sub: string;
  sid: string;
  role: string;
  /** Issued-at, compared against User.credentialsChangedAt. */
  iat: number;
  exp: number;
}

/**
 * Authentication gate.
 *
 * Verifying the signature is not enough. A token stays cryptographically valid
 * until it expires, so every request also checks that:
 *
 *   • the session still exists and is ACTIVE (covers logout and admin revoke)
 *   • the account is still ACTIVE (covers suspension mid-session)
 *   • the token predates no credential change (covers password reset)
 *
 * That is one indexed lookup per request, which is the right trade for being
 * able to kill a session immediately.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  private readonly auth: AuthConfig;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.auth = config.getOrThrow<AuthConfig>('auth');
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (isPublic) {
      // Still attach the principal when a token happens to be present, so
      // public endpoints (course browsing) can personalise their response.
      if (token) {
        await this.attach(request, token).catch(() => undefined);
      }
      return true;
    }

    if (!token) {
      throw new AppException(ErrorCode.UNAUTHORIZED, {
        message: 'Missing bearer token',
      });
    }

    await this.attach(request, token);
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.header('authorization');
    if (!header) return null;
    const [scheme, value] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && value ? value : null;
  }

  private async attach(request: Request, token: string): Promise<void> {
    let payload: AccessTokenPayload;

    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.auth.accessSecret,
        issuer: this.auth.issuer,
        audience: this.auth.audience,
      });
    } catch (e) {
      const expired = (e as Error).name === 'TokenExpiredError';
      throw new AppException(
        expired ? ErrorCode.SESSION_EXPIRED : ErrorCode.UNAUTHORIZED,
        { message: expired ? 'Access token expired' : 'Invalid access token' },
      );
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.sid },
      select: {
        id: true,
        status: true,
        expiresAt: true,
        deviceId: true,
        user: {
          select: {
            id: true,
            role: true,
            phone: true,
            fullName: true,
            status: true,
            deletedAt: true,
            credentialsChangedAt: true,
          },
        },
      },
    });

    if (!session || session.status !== SessionStatus.ACTIVE) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, {
        message: 'Session revoked or unknown',
      });
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, { message: 'Session expired' });
    }

    const user = session.user;

    if (user.deletedAt) {
      throw new AppException(ErrorCode.ACCOUNT_DISABLED, { message: 'Account removed' });
    }

    if (user.status === AccountStatus.DISABLED || user.status === AccountStatus.SUSPENDED) {
      throw new AppException(ErrorCode.ACCOUNT_DISABLED, {
        message: `Account is ${user.status.toLowerCase()}`,
      });
    }

    // A password change invalidates every token minted before it, without
    // needing to enumerate and delete them.
    if (payload.iat * 1000 < user.credentialsChangedAt.getTime() - 1000) {
      throw new AppException(ErrorCode.SESSION_EXPIRED, {
        message: 'Credentials changed after this token was issued',
      });
    }

    const principal: AuthenticatedUser = {
      id: user.id,
      role: user.role,
      phone: user.phone,
      fullName: user.fullName,
      status: user.status,
      sessionId: session.id,
      deviceId: session.deviceId,
      deviceKey: request.deviceContext?.deviceKey ?? null,
    };

    request.user = principal;

    // Fire-and-forget freshness update; never block the request on it.
    void this.prisma.session
      .update({ where: { id: session.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
  }
}
