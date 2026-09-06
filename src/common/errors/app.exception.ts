import { HttpException } from '@nestjs/common';

import { ERROR_MESSAGE, ERROR_STATUS, ErrorCode } from './error-codes';

export interface AppExceptionOptions {
  /** Overrides the canonical developer message. */
  message?: string;
  /** Field-scoped errors, applied directly onto client form fields. */
  fields?: Record<string, string[]>;
  /** Extra machine-readable context (never rendered to students). */
  details?: Record<string, unknown>;
  /** Overrides the canonical HTTP status. Use sparingly. */
  status?: number;
  /** Underlying error, logged but never serialised to the client. */
  cause?: unknown;
}

/**
 * The only exception type the application layer should throw.
 *
 * Carrying the ErrorCode rather than an HTTP status is what keeps the API
 * contract stable: the client branches on `code`, and the status is a
 * transport detail derived from it.
 */
export class AppException extends HttpException {
  readonly code: ErrorCode;
  readonly fields?: Record<string, string[]>;
  readonly details?: Record<string, unknown>;
  override readonly cause: unknown;

  constructor(code: ErrorCode, options: AppExceptionOptions = {}) {
    const status = options.status ?? ERROR_STATUS[code] ?? 500;
    const message = options.message ?? ERROR_MESSAGE[code] ?? 'Error';

    super({ code, message }, status);

    this.code = code;
    this.fields = options.fields;
    this.details = options.details;
    this.cause = options.cause;
  }

  static notFound(entity: string, id?: string) {
    return new AppException(ErrorCode.NOT_FOUND, {
      message: id ? `${entity} ${id} not found` : `${entity} not found`,
      details: { entity, id },
    });
  }

  static forbidden(reason: string, details?: Record<string, unknown>) {
    return new AppException(ErrorCode.FORBIDDEN, { message: reason, details });
  }

  static validation(fields: Record<string, string[]>, message?: string) {
    return new AppException(ErrorCode.VALIDATION_ERROR, {
      message: message ?? 'Request validation failed',
      fields,
    });
  }

  static conflict(message: string, details?: Record<string, unknown>) {
    return new AppException(ErrorCode.CONFLICT, { message, details });
  }
}
