/**
 * The error-code contract.
 *
 * This enum is copied verbatim from the mobile app's `ApiErrorCode` union
 * (edu-mobile/src/types/api.ts). The app renders a localized, student-facing
 * message keyed by `code` and branches its UI on it; it never displays the
 * server's `message`. Adding a code here without adding it to both locale
 * bundles in the app degrades that error to a generic message.
 *
 * Codes are grouped by domain and each carries a canonical HTTP status, so a
 * handler throws `new AppException(ErrorCode.NOT_ENROLLED)` and the status is
 * never chosen ad hoc at the call site.
 */
export enum ErrorCode {
  // --- transport / generic ---------------------------------------------------
  SERVER_ERROR = 'SERVER_ERROR',
  UNKNOWN = 'UNKNOWN',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  MAINTENANCE = 'MAINTENANCE',
  APP_UPDATE_REQUIRED = 'APP_UPDATE_REQUIRED',

  // --- auth ------------------------------------------------------------------
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  UNAUTHORIZED = 'UNAUTHORIZED',
  SESSION_EXPIRED = 'SESSION_EXPIRED',
  ACCOUNT_DISABLED = 'ACCOUNT_DISABLED',
  ACCOUNT_PENDING = 'ACCOUNT_PENDING',
  PHONE_ALREADY_REGISTERED = 'PHONE_ALREADY_REGISTERED',

  // --- device binding --------------------------------------------------------
  DEVICE_NOT_AUTHORIZED = 'DEVICE_NOT_AUTHORIZED',
  DEVICE_LIMIT_REACHED = 'DEVICE_LIMIT_REACHED',
  DEVICE_CHANGE_PENDING = 'DEVICE_CHANGE_PENDING',
  DEVICE_INTEGRITY_FAILED = 'DEVICE_INTEGRITY_FAILED',

  // --- access ----------------------------------------------------------------
  FORBIDDEN = 'FORBIDDEN',
  NOT_FOUND = 'NOT_FOUND',
  COURSE_NOT_AVAILABLE = 'COURSE_NOT_AVAILABLE',
  COURSE_ARCHIVED = 'COURSE_ARCHIVED',
  ACCESS_EXPIRED = 'ACCESS_EXPIRED',
  NOT_ENROLLED = 'NOT_ENROLLED',
  ENROLLMENT_PENDING = 'ENROLLMENT_PENDING',
  PAYMENT_REQUIRED = 'PAYMENT_REQUIRED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  INVALID_CODE = 'INVALID_CODE',
  CODE_ALREADY_USED = 'CODE_ALREADY_USED',

  // --- wallet / credits ------------------------------------------------------
  // The student app renders these, so each one needs an entry in both locale
  // bundles. Without it the app falls back to a generic message.
  INSUFFICIENT_CREDIT = 'INSUFFICIENT_CREDIT',
  WALLET_LOCKED = 'WALLET_LOCKED',
  AMOUNT_BELOW_MINIMUM = 'AMOUNT_BELOW_MINIMUM',
  CODE_NOT_RECHARGEABLE = 'CODE_NOT_RECHARGEABLE',

  // --- announcements ---------------------------------------------------------
  // Dashboard-only. The student app never receives these, so unlike the wallet
  // block above they need no locale bundle entries.
  AUDIENCE_RULE_INVALID = 'AUDIENCE_RULE_INVALID',
  AUDIENCE_TOO_LARGE = 'AUDIENCE_TOO_LARGE',
  ANNOUNCEMENT_NOT_EDITABLE = 'ANNOUNCEMENT_NOT_EDITABLE',

  // --- playback --------------------------------------------------------------
  PLAYBACK_DENIED = 'PLAYBACK_DENIED',
  PLAYBACK_TICKET_EXPIRED = 'PLAYBACK_TICKET_EXPIRED',
  CONCURRENT_STREAM_LIMIT = 'CONCURRENT_STREAM_LIMIT',
  VIDEO_NOT_READY = 'VIDEO_NOT_READY',
  VIDEO_UNAVAILABLE = 'VIDEO_UNAVAILABLE',
  CAPTURE_DETECTED = 'CAPTURE_DETECTED',

  // --- back-office only ------------------------------------------------------
  // These never reach the student app, so they have no mobile translation.
  // Admin/teacher clients render `message` for them.
  CONFLICT = 'CONFLICT',
  ALREADY_ENROLLED = 'ALREADY_ENROLLED',
  INVALID_STATE = 'INVALID_STATE',
  UPLOAD_FAILED = 'UPLOAD_FAILED',
  PROCESSING_FAILED = 'PROCESSING_FAILED',
  STORAGE_UNAVAILABLE = 'STORAGE_UNAVAILABLE',
  MASTER_ALREADY_EXISTS = 'MASTER_ALREADY_EXISTS',
  CANNOT_MODIFY_MASTER = 'CANNOT_MODIFY_MASTER',
  INSUFFICIENT_ROLE = 'INSUFFICIENT_ROLE',
  NOT_COURSE_TEACHER = 'NOT_COURSE_TEACHER',
}

/** Canonical HTTP status for each code. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  [ErrorCode.SERVER_ERROR]: 500,
  [ErrorCode.UNKNOWN]: 500,
  [ErrorCode.VALIDATION_ERROR]: 422,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.MAINTENANCE]: 503,
  [ErrorCode.APP_UPDATE_REQUIRED]: 426,

  [ErrorCode.INVALID_CREDENTIALS]: 401,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.SESSION_EXPIRED]: 401,
  [ErrorCode.ACCOUNT_DISABLED]: 403,
  [ErrorCode.ACCOUNT_PENDING]: 403,
  [ErrorCode.PHONE_ALREADY_REGISTERED]: 409,

  [ErrorCode.DEVICE_NOT_AUTHORIZED]: 403,
  [ErrorCode.DEVICE_LIMIT_REACHED]: 403,
  [ErrorCode.DEVICE_CHANGE_PENDING]: 403,
  [ErrorCode.DEVICE_INTEGRITY_FAILED]: 403,

  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.COURSE_NOT_AVAILABLE]: 404,
  [ErrorCode.COURSE_ARCHIVED]: 410,
  [ErrorCode.ACCESS_EXPIRED]: 410,
  [ErrorCode.NOT_ENROLLED]: 403,
  [ErrorCode.ENROLLMENT_PENDING]: 409,
  [ErrorCode.PAYMENT_REQUIRED]: 402,
  [ErrorCode.PAYMENT_FAILED]: 402,
  [ErrorCode.INVALID_CODE]: 400,
  [ErrorCode.CODE_ALREADY_USED]: 409,

  [ErrorCode.INSUFFICIENT_CREDIT]: 402,
  [ErrorCode.WALLET_LOCKED]: 403,
  [ErrorCode.AMOUNT_BELOW_MINIMUM]: 422,
  [ErrorCode.CODE_NOT_RECHARGEABLE]: 400,

  [ErrorCode.AUDIENCE_RULE_INVALID]: 422,
  [ErrorCode.AUDIENCE_TOO_LARGE]: 422,
  [ErrorCode.ANNOUNCEMENT_NOT_EDITABLE]: 409,

  [ErrorCode.PLAYBACK_DENIED]: 403,
  [ErrorCode.PLAYBACK_TICKET_EXPIRED]: 401,
  [ErrorCode.CONCURRENT_STREAM_LIMIT]: 429,
  [ErrorCode.VIDEO_NOT_READY]: 409,
  [ErrorCode.VIDEO_UNAVAILABLE]: 404,
  [ErrorCode.CAPTURE_DETECTED]: 403,

  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.ALREADY_ENROLLED]: 409,
  [ErrorCode.INVALID_STATE]: 409,
  [ErrorCode.UPLOAD_FAILED]: 400,
  [ErrorCode.PROCESSING_FAILED]: 500,
  [ErrorCode.STORAGE_UNAVAILABLE]: 503,
  [ErrorCode.MASTER_ALREADY_EXISTS]: 409,
  [ErrorCode.CANNOT_MODIFY_MASTER]: 403,
  [ErrorCode.INSUFFICIENT_ROLE]: 403,
  [ErrorCode.NOT_COURSE_TEACHER]: 403,
};

/** Developer-facing default text. Never rendered to students. */
export const ERROR_MESSAGE: Record<ErrorCode, string> = {
  [ErrorCode.SERVER_ERROR]: 'Internal server error',
  [ErrorCode.UNKNOWN]: 'Unexpected error',
  [ErrorCode.VALIDATION_ERROR]: 'Request validation failed',
  [ErrorCode.RATE_LIMITED]: 'Too many requests',
  [ErrorCode.MAINTENANCE]: 'Service temporarily unavailable',
  [ErrorCode.APP_UPDATE_REQUIRED]: 'Client version is no longer supported',

  [ErrorCode.INVALID_CREDENTIALS]: 'Phone number or password is incorrect',
  [ErrorCode.UNAUTHORIZED]: 'Authentication required',
  [ErrorCode.SESSION_EXPIRED]: 'Session is no longer valid',
  [ErrorCode.ACCOUNT_DISABLED]: 'Account has been disabled',
  [ErrorCode.ACCOUNT_PENDING]: 'Account is awaiting activation',
  [ErrorCode.PHONE_ALREADY_REGISTERED]: 'An account with this phone already exists',

  [ErrorCode.DEVICE_NOT_AUTHORIZED]: 'This device is not authorized for the account',
  [ErrorCode.DEVICE_LIMIT_REACHED]: 'Device limit reached for this account',
  [ErrorCode.DEVICE_CHANGE_PENDING]: 'A device change request is under review',
  [ErrorCode.DEVICE_INTEGRITY_FAILED]: 'Device failed integrity checks',

  [ErrorCode.FORBIDDEN]: 'Not permitted',
  [ErrorCode.NOT_FOUND]: 'Resource not found',
  [ErrorCode.COURSE_NOT_AVAILABLE]: 'Course is not available',
  [ErrorCode.COURSE_ARCHIVED]: 'Course has been archived',
  [ErrorCode.ACCESS_EXPIRED]: 'Access to this content has expired',
  [ErrorCode.NOT_ENROLLED]: 'Not enrolled in this course',
  [ErrorCode.ENROLLMENT_PENDING]: 'Enrollment is still being processed',
  [ErrorCode.PAYMENT_REQUIRED]: 'Payment is required for this course',
  [ErrorCode.PAYMENT_FAILED]: 'Payment could not be completed',
  [ErrorCode.INVALID_CODE]: 'Access code is not valid',
  [ErrorCode.CODE_ALREADY_USED]: 'Access code has already been used',

  [ErrorCode.INSUFFICIENT_CREDIT]: 'Not enough credit in the wallet',
  [ErrorCode.WALLET_LOCKED]: 'Wallet is not available for this account',
  [ErrorCode.AMOUNT_BELOW_MINIMUM]: 'Amount is below the configured minimum',
  [ErrorCode.CODE_NOT_RECHARGEABLE]: 'This code does not add credit to a wallet',

  [ErrorCode.AUDIENCE_RULE_INVALID]: 'Audience rule is not valid',
  [ErrorCode.AUDIENCE_TOO_LARGE]: 'Audience is larger than the permitted limit',
  [ErrorCode.ANNOUNCEMENT_NOT_EDITABLE]: 'Announcement can no longer be edited',

  [ErrorCode.PLAYBACK_DENIED]: 'Playback is not authorized',
  [ErrorCode.PLAYBACK_TICKET_EXPIRED]: 'Playback authorization expired',
  [ErrorCode.CONCURRENT_STREAM_LIMIT]: 'Concurrent stream limit reached',
  [ErrorCode.VIDEO_NOT_READY]: 'Video is still processing',
  [ErrorCode.VIDEO_UNAVAILABLE]: 'Video is unavailable',
  [ErrorCode.CAPTURE_DETECTED]: 'Playback stopped: screen capture detected',

  [ErrorCode.CONFLICT]: 'Conflicting state',
  [ErrorCode.ALREADY_ENROLLED]: 'Student is already enrolled',
  [ErrorCode.INVALID_STATE]: 'Operation not valid in the current state',
  [ErrorCode.UPLOAD_FAILED]: 'Upload failed',
  [ErrorCode.PROCESSING_FAILED]: 'Media processing failed',
  [ErrorCode.STORAGE_UNAVAILABLE]: 'Object storage is unavailable',
  [ErrorCode.MASTER_ALREADY_EXISTS]: 'A master account already exists',
  [ErrorCode.CANNOT_MODIFY_MASTER]: 'The master account cannot be modified this way',
  [ErrorCode.INSUFFICIENT_ROLE]: 'Role does not permit this operation',
  [ErrorCode.NOT_COURSE_TEACHER]: 'Not assigned to this course',
};

/**
 * Codes the student app treats as session-ending. Listed here so the auth
 * layer and the docs cannot drift apart.
 */
export const SESSION_ENDING_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.SESSION_EXPIRED,
  ErrorCode.ACCOUNT_DISABLED,
]);
