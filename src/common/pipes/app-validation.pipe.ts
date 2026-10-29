import { ValidationPipe } from '@nestjs/common';

import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';

/**
 * The global validation pipe, shared by main.ts and the integration-test
 * harness so the two cannot drift: the harness once built its own plain pipe,
 * which answered 400 where production answers 422 VALIDATION_ERROR.
 */
export function createAppValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    // Strip unknown properties instead of trusting them — this is what stops
    // a client from setting `role: "MASTER"` on a registration payload.
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    stopAtFirstError: false,
    // `value: false` keeps a rejected value — a password, say — out of the
    // error response.
    validationError: { target: false, value: false },
    exceptionFactory: (errors) => {
      const fields: Record<string, string[]> = {};
      const walk = (list: typeof errors, prefix = '') => {
        for (const error of list) {
          const path = prefix ? `${prefix}.${error.property}` : error.property;
          const messages = Object.values(error.constraints ?? {});
          if (messages.length) fields[path] = messages;
          if (error.children?.length) walk(error.children, path);
        }
      };
      walk(errors);

      return new AppException(ErrorCode.VALIDATION_ERROR, {
        message: 'Request validation failed',
        fields,
      });
    },
  });
}
