import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { tap, type Observable } from 'rxjs';

import { AUDIT_KEY, type AuditMetadata } from '../../common/decorators/audit.decorator';

import { AuditService } from './audit.service';

/**
 * Writes an audit row after a decorated handler succeeds.
 *
 * "After it succeeds" is the point: recording intent rather than outcome
 * produces a log full of operations that never happened. Handlers that need a
 * before/after diff call AuditService directly instead — the interceptor only
 * sees the response.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) { }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = this.reflector.getAllAndOverride<AuditMetadata>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!metadata) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      tap((result) => {
        const idParamValue = metadata.idParam
          ? request.params?.[metadata.idParam]
          : undefined;
        const entityId =
          (typeof idParamValue === 'string' ? idParamValue : undefined) ??
          (result && typeof result === 'object' && 'id' in result
            ? String((result as { id: unknown }).id)
            : undefined);

        void this.audit.record({
          actorId: request.user?.id ?? null,
          actorRole: request.user?.role ?? null,
          action: metadata.action,
          entity: metadata.entity,
          entityId: entityId ?? null,
          after: result,
          ipAddress: request.ip ?? null,
          userAgent: request.header('user-agent') ?? null,
          requestId: request.requestId ?? null,
        });
      }),
    );
  }
}
