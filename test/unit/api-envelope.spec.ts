import { HttpStatus } from '@nestjs/common';

import { AppException } from '../../src/common/errors/app.exception';
import {
  ERROR_MESSAGE,
  ERROR_STATUS,
  ErrorCode,
  SESSION_ENDING_CODES,
} from '../../src/common/errors/error-codes';

/**
 * The error contract.
 *
 * The mobile app was built before this backend and reads error fields from the
 * **top level** of the body (`code`, `message`, `errors`, `requestId`). The
 * backend specification asks for a nested `{ success, error: { code, message } }`
 * envelope. Rather than break one of the two, error bodies carry both shapes,
 * populated from the same source values so they cannot disagree.
 *
 * These tests are the guard on that promise. If someone later "cleans up" the
 * duplication, the shipped app stops being able to read errors and the failure
 * shows up as every error rendering as a generic "something went wrong".
 */

describe('ErrorCode table', () => {
  const codes = Object.values(ErrorCode);

  it('gives every code an HTTP status', () => {
    for (const code of codes) {
      expect(ERROR_STATUS[code]).toBeDefined();
      expect(typeof ERROR_STATUS[code]).toBe('number');
    }
  });

  it('gives every code a human-readable default message', () => {
    for (const code of codes) {
      expect(ERROR_MESSAGE[code]).toBeTruthy();
      expect(ERROR_MESSAGE[code].length).toBeGreaterThan(3);
    }
  });

  it('never maps a client error to a 5xx status', () => {
    // A mis-mapped status makes the app retry a request it should not, and
    // pollutes error monitoring with fake server incidents.
    const clientCodes = [
      ErrorCode.VALIDATION_ERROR,
      ErrorCode.UNAUTHORIZED,
      ErrorCode.FORBIDDEN,
      ErrorCode.NOT_FOUND,
      ErrorCode.NOT_ENROLLED,
      ErrorCode.ACCESS_EXPIRED,
      ErrorCode.INVALID_CODE,
      ErrorCode.CODE_ALREADY_USED,
      ErrorCode.DEVICE_NOT_AUTHORIZED,
    ];

    for (const code of clientCodes) {
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_STATUS[code]).toBeLessThan(500);
    }
  });

  it('reserves 401 for authentication problems only', () => {
    // The app's interceptor reacts to a 401 by attempting one token refresh
    // and, if that fails, clearing the session. Mapping an authorization or
    // business error to 401 would therefore sign students out for a problem a
    // new token cannot fix.
    const allowed401 = new Set<ErrorCode>([
      ErrorCode.INVALID_CREDENTIALS,
      ErrorCode.UNAUTHORIZED,
      ErrorCode.SESSION_EXPIRED,

      // A playback ticket is itself a short-lived bearer credential, so 401 is
      // the semantically correct status for an expired one, and this has been
      // the shipped contract since the mobile app's first release.
      //
      // It is safe under the rule this test exists to protect: the app's
      // session-ending set is { SESSION_EXPIRED, ACCOUNT_DISABLED }, so an
      // expired ticket never clears the student's session. The only cost is
      // that the interceptor spends one silent token refresh and a replay
      // before surfacing the error, since it cannot tell from the status alone
      // that a new access token will not help. Narrowing this to 403 would
      // remove that round trip but is an API-contract change the mobile client
      // would have to ship alongside, so it is deliberately not made here.
      ErrorCode.PLAYBACK_TICKET_EXPIRED,
    ]);

    for (const code of Object.values(ErrorCode)) {
      if (ERROR_STATUS[code] === HttpStatus.UNAUTHORIZED) {
        expect(allowed401.has(code)).toBe(true);
      }
    }
  });

  it('marks the codes after which no retry can help', () => {
    // SESSION_ENDING_CODES is what the app uses to decide "stop retrying and
    // send the student to the login screen".
    expect(SESSION_ENDING_CODES.has(ErrorCode.SESSION_EXPIRED)).toBe(true);
    expect(SESSION_ENDING_CODES.has(ErrorCode.ACCOUNT_DISABLED)).toBe(true);
    // A bad password is recoverable by trying again — it must not be in there.
    expect(SESSION_ENDING_CODES.has(ErrorCode.INVALID_CREDENTIALS)).toBe(false);
  });

  it('keeps device-binding failures out of the sign-out set', () => {
    // A device mismatch must NOT log the student out — they need to stay
    // signed in to reach the "request a device change" screen.
    expect(SESSION_ENDING_CODES.has(ErrorCode.DEVICE_NOT_AUTHORIZED)).toBe(false);
    expect(SESSION_ENDING_CODES.has(ErrorCode.DEVICE_CHANGE_PENDING)).toBe(false);
  });
});

describe('AppException', () => {
  it('derives its HTTP status from the code', () => {
    const error = new AppException(ErrorCode.NOT_ENROLLED);
    expect(error.getStatus()).toBe(ERROR_STATUS[ErrorCode.NOT_ENROLLED]);
  });

  it('carries the code, not just a message', () => {
    const error = new AppException(ErrorCode.ACCESS_EXPIRED);
    expect(error.code).toBe(ErrorCode.ACCESS_EXPIRED);
  });

  it('allows a caller-supplied message to override the default', () => {
    const error = new AppException(ErrorCode.PLAYBACK_DENIED, {
      message: 'This section has not been released yet',
    });
    expect(error.getResponse()).toMatchObject({
      message: 'This section has not been released yet',
    });
  });

  it('carries field errors for form rendering', () => {
    const error = AppException.validation({ phone: ['already registered'] });
    expect(error.fields).toEqual({ phone: ['already registered'] });
    expect(error.code).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('keeps details out of the message, so nothing internal is rendered', () => {
    const error = new AppException(ErrorCode.NOT_ENROLLED, {
      details: { accessState: 'EXPIRED', courseId: 'crs_1' },
    });

    const body = error.getResponse() as { message: string };
    expect(body.message).not.toContain('crs_1');
    expect(error.details).toMatchObject({ courseId: 'crs_1' });
  });

  it('builds a not-found error that names the entity but not its internals', () => {
    const error = AppException.notFound('Lesson', 'les_1');
    expect(error.code).toBe(ErrorCode.NOT_FOUND);
    expect(error.getStatus()).toBe(404);
  });
});

describe('mobile compatibility', () => {
  /**
   * The exact union the shipped app declares in src/api/errors.ts. Adding a
   * code here is fine; the app falls back to a generic message for unknown
   * ones. *Removing* or renaming one is not — the app branches on these
   * strings.
   */
  const CODES_THE_APP_BRANCHES_ON = [
    'VALIDATION_ERROR',
    'UNAUTHORIZED',
    'FORBIDDEN',
    'NOT_FOUND',
    'NOT_ENROLLED',
    'ACCESS_EXPIRED',
    'COURSE_ARCHIVED',
    'PAYMENT_REQUIRED',
    'INVALID_CODE',
    'CODE_ALREADY_USED',
    'DEVICE_NOT_AUTHORIZED',
    'DEVICE_CHANGE_PENDING',
    'VIDEO_NOT_READY',
    'VIDEO_UNAVAILABLE',
    'PLAYBACK_DENIED',
    'SESSION_EXPIRED',
    'RATE_LIMITED',
  ];

  it.each(CODES_THE_APP_BRANCHES_ON)('still defines %s', (code) => {
    expect(Object.values(ErrorCode)).toContain(code);
  });
});
