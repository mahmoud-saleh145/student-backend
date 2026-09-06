import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Request, Response } from 'express';

import { AppException } from '../errors/app.exception';
import { ERROR_MESSAGE, ERROR_STATUS, ErrorCode } from '../errors/error-codes';
import type { ErrorEnvelope } from '../types/api-response';

/**
 * Single exit point for every error.
 *
 * Guarantees:
 *  - the response always carries a machine-readable `code` from the contract;
 *  - internal details (stack traces, Prisma messages, SQL) never leave the
 *    process in production;
 *  - both the spec-shaped nested `error` and the flat fields the mobile client
 *    parses are emitted from the same values.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  constructor(private readonly isProduction: boolean) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const resolved = this.resolve(exception);

    const body: ErrorEnvelope = {
      success: false,
      error: {
        code: resolved.code,
        message: resolved.message,
        ...(resolved.fields ? { fields: resolved.fields } : {}),
        ...(resolved.details && !this.isProduction
          ? { details: resolved.details }
          : {}),
      },
      statusCode: resolved.status,
      code: resolved.code,
      message: resolved.message,
      ...(resolved.fields ? { errors: resolved.fields } : {}),
      requestId: request.requestId,
      timestamp: new Date().toISOString(),
      path: request.originalUrl,
    };

    const logContext = {
      requestId: request.requestId,
      method: request.method,
      path: request.originalUrl,
      status: resolved.status,
      code: resolved.code,
      userId: request.user?.id,
    };

    if (resolved.status >= 500) {
      this.logger.error(
        { ...logContext, err: this.describe(exception) },
        resolved.message,
      );
    } else if (resolved.status === 401 || resolved.status === 403) {
      // Auth failures are expected traffic; log at warn without a stack.
      this.logger.warn(logContext, resolved.message);
    } else {
      this.logger.debug(logContext, resolved.message);
    }

    response.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): {
    status: number;
    code: string;
    message: string;
    fields?: Record<string, string[]>;
    details?: Record<string, unknown>;
  } {
    if (exception instanceof AppException) {
      return {
        status: exception.getStatus(),
        code: exception.code,
        message: exception.message,
        fields: exception.fields,
        details: exception.details,
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      return {
        status,
        code: this.codeForStatus(status),
        message: this.messageFromHttpPayload(payload, status),
        fields: this.fieldsFromHttpPayload(payload),
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromPrisma(exception);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: 422,
        code: ErrorCode.VALIDATION_ERROR,
        message: this.isProduction
          ? ERROR_MESSAGE[ErrorCode.VALIDATION_ERROR]
          : exception.message.split('\n').slice(-3).join(' ').trim(),
      };
    }

    if (
      exception instanceof Prisma.PrismaClientInitializationError ||
      exception instanceof Prisma.PrismaClientRustPanicError
    ) {
      return {
        status: 503,
        code: ErrorCode.MAINTENANCE,
        message: ERROR_MESSAGE[ErrorCode.MAINTENANCE],
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: ErrorCode.SERVER_ERROR,
      message: ERROR_MESSAGE[ErrorCode.SERVER_ERROR],
    };
  }

  private fromPrisma(e: Prisma.PrismaClientKnownRequestError) {
    switch (e.code) {
      case 'P2002': {
        // Unique constraint. Surface the offending field so forms can mark it,
        // but never echo the raw constraint name in production.
        const target = (e.meta?.target as string[] | undefined) ?? [];
        const field = target[0] ?? 'value';
        return {
          status: ERROR_STATUS[ErrorCode.CONFLICT],
          code: ErrorCode.CONFLICT,
          message: `A record with this ${field} already exists`,
          fields: { [field]: ['already exists'] },
        };
      }
      case 'P2003':
        return {
          status: 409,
          code: ErrorCode.CONFLICT,
          message: 'Related record constraint violated',
        };
      case 'P2025':
        return {
          status: 404,
          code: ErrorCode.NOT_FOUND,
          message: ERROR_MESSAGE[ErrorCode.NOT_FOUND],
        };
      case 'P2014':
        return {
          status: 409,
          code: ErrorCode.CONFLICT,
          message: 'Operation would violate a required relation',
        };
      default:
        return {
          status: 500,
          code: ErrorCode.SERVER_ERROR,
          message: ERROR_MESSAGE[ErrorCode.SERVER_ERROR],
          details: this.isProduction ? undefined : { prismaCode: e.code },
        };
    }
  }

  private codeForStatus(status: number): string {
    const map: Record<number, ErrorCode> = {
      400: ErrorCode.VALIDATION_ERROR,
      401: ErrorCode.UNAUTHORIZED,
      402: ErrorCode.PAYMENT_REQUIRED,
      403: ErrorCode.FORBIDDEN,
      404: ErrorCode.NOT_FOUND,
      409: ErrorCode.CONFLICT,
      410: ErrorCode.ACCESS_EXPIRED,
      422: ErrorCode.VALIDATION_ERROR,
      426: ErrorCode.APP_UPDATE_REQUIRED,
      429: ErrorCode.RATE_LIMITED,
      503: ErrorCode.MAINTENANCE,
    };
    return map[status] ?? (status >= 500 ? ErrorCode.SERVER_ERROR : ErrorCode.UNKNOWN);
  }

  private messageFromHttpPayload(payload: unknown, status: number): string {
    if (typeof payload === 'string') return payload;
    if (payload && typeof payload === 'object') {
      const p = payload as { message?: unknown; error?: unknown };
      if (typeof p.message === 'string') return p.message;
      if (Array.isArray(p.message)) return p.message.join('; ');
      if (typeof p.error === 'string') return p.error;
    }
    return this.codeForStatus(status);
  }

  /** class-validator emits `message: string[]` of "field must be ..." lines. */
  private fieldsFromHttpPayload(payload: unknown): Record<string, string[]> | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const raw = (payload as { message?: unknown }).message;
    if (!Array.isArray(raw)) return undefined;

    const fields: Record<string, string[]> = {};
    for (const line of raw as string[]) {
      const field = String(line).split(' ')[0] ?? 'unknown';
      (fields[field] ??= []).push(String(line));
    }
    return Object.keys(fields).length ? fields : undefined;
  }

  private describe(exception: unknown) {
    if (exception instanceof Error) {
      return {
        name: exception.name,
        message: exception.message,
        stack: this.isProduction ? undefined : exception.stack,
      };
    }
    return { value: String(exception) };
  }
}
