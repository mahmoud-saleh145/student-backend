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
        // A handler that returned a paginated result gets its `meta` lifted to
        // the envelope while `items` stays under `data`, so pagination is
        // consistent across every list endpoint.
        if (
          data &&
          typeof data === 'object' &&
          'items' in (data as object) &&
          'meta' in (data as object)
        ) {
          const page = data as unknown as { items: unknown[]; meta: unknown };
          return {
            success: true,
            // The mobile client expects `{ items, meta }` under `data` for
            // paginated endpoints, so the shape is preserved there too.
            data: { items: page.items, meta: page.meta },
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
