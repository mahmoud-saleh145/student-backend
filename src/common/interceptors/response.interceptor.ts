import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { map, type Observable } from 'rxjs';

import { RAW_RESPONSE_KEY } from '../decorators/raw-response.decorator';
import type { SuccessEnvelope } from '../types/api-response';

/**
 * Wraps every successful handler result in the success envelope.
 *
 * Handlers return plain data; they never build the envelope themselves. A
 * handler that must control the raw body (file streams, provider webhooks
 * that expect a bare 200) opts out with @RawResponse().
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (raw) return next.handle();

    const request = context.switchToHttp().getRequest<Request>();

    return next.handle().pipe(
      map((data): SuccessEnvelope<unknown> => {
        // A handler that returned a paginated result keeps `{ items, meta }`
        // under `data` (the mobile client reads exactly that) and gets a
        // request id on the envelope.
        //
        // Every other key the handler returned beside `items`/`meta` is kept.
        // This used to rebuild `data` as `{ items, meta }` alone, which silently
        // dropped `lesson`/`summary` from the lecture viewers report (the
        // dashboard then crashed reading `data.lesson`) and `totals` from the
        // recharge, part-purchase and library reports (which rendered as 0).
        if (
          data &&
          typeof data === 'object' &&
          'items' in (data as object) &&
          'meta' in (data as object)
        ) {
          return {
            success: true,
            data: { ...(data as object) },
            meta: { requestId: request.requestId },
          };
        }

        return {
          success: true,
          data: data as unknown,
          meta: request.requestId ? { requestId: request.requestId } : undefined,
        };
      }),
    );
  }
}
