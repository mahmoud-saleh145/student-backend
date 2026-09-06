// Generated stub of @prisma/client for the offline harness.
// Only the runtime enum objects are real; types are erased at compile time.

exports.UserRole = Object.freeze({ MASTER: 'MASTER', ADMIN: 'ADMIN', TEACHER: 'TEACHER', STUDENT: 'STUDENT' });
exports.AccountStatus = Object.freeze({ ACTIVE: 'ACTIVE', PENDING: 'PENDING', SUSPENDED: 'SUSPENDED', DISABLED: 'DISABLED' });
exports.Gender = Object.freeze({ MALE: 'MALE', FEMALE: 'FEMALE' });
exports.CourseStatus = Object.freeze({ DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED', SUSPENDED: 'SUSPENDED', ARCHIVED: 'ARCHIVED', HIDDEN: 'HIDDEN' });
exports.ContentStatus = Object.freeze({ DRAFT: 'DRAFT', PUBLISHED: 'PUBLISHED', HIDDEN: 'HIDDEN', ARCHIVED: 'ARCHIVED' });
exports.EnrollmentMethod = Object.freeze({ FREE: 'FREE', PAYMENT: 'PAYMENT', CODE: 'CODE', ADMIN_APPROVAL: 'ADMIN_APPROVAL' });
exports.EnrollmentState = Object.freeze({ PENDING_APPROVAL: 'PENDING_APPROVAL', PENDING_PAYMENT: 'PENDING_PAYMENT', ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED', REVOKED: 'REVOKED', ARCHIVED: 'ARCHIVED' });
exports.AccessDurationType = Object.freeze({ LIFETIME: 'LIFETIME', FIXED_DAYS: 'FIXED_DAYS', UNTIL_DATE: 'UNTIL_DATE' });
exports.LessonKind = Object.freeze({ VIDEO: 'VIDEO', DOCUMENT: 'DOCUMENT', QUIZ: 'QUIZ', LIVE: 'LIVE' });
exports.CompletionRuleType = Object.freeze({ WATCH_PERCENT: 'WATCH_PERCENT', WATCH_FULL: 'WATCH_FULL', MANUAL: 'MANUAL' });
exports.VideoStatus = Object.freeze({ UPLOADING: 'UPLOADING', QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', READY: 'READY', FAILED: 'FAILED', ARCHIVED: 'ARCHIVED' });
exports.AttachmentKind = Object.freeze({ PDF: 'PDF', IMAGE: 'IMAGE', DOC: 'DOC', SHEET: 'SHEET', LINK: 'LINK', OTHER: 'OTHER' });
exports.PaymentStatus = Object.freeze({ PENDING: 'PENDING', AUTHORIZED: 'AUTHORIZED', PAID: 'PAID', FAILED: 'FAILED', CANCELLED: 'CANCELLED', REFUNDED: 'REFUNDED', PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED' });
exports.PaymentProvider = Object.freeze({ MANUAL: 'MANUAL', PAYMOB: 'PAYMOB', STRIPE: 'STRIPE', CODE: 'CODE', FREE: 'FREE' });
exports.CodeStatus = Object.freeze({ ACTIVE: 'ACTIVE', EXHAUSTED: 'EXHAUSTED', EXPIRED: 'EXPIRED', REVOKED: 'REVOKED' });
exports.DeviceStatus = Object.freeze({ ACTIVE: 'ACTIVE', PENDING_APPROVAL: 'PENDING_APPROVAL', REVOKED: 'REVOKED', BLOCKED: 'BLOCKED' });
exports.DeviceChangeStatus = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', CANCELLED: 'CANCELLED' });
exports.SessionStatus = Object.freeze({ ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED', REVOKED: 'REVOKED' });
exports.PlaybackTicketStatus = Object.freeze({ ACTIVE: 'ACTIVE', EXPIRED: 'EXPIRED', RELEASED: 'RELEASED', REVOKED: 'REVOKED' });
exports.NotificationKind = Object.freeze({ NEW_COURSE: 'NEW_COURSE', NEW_SECTION: 'NEW_SECTION', NEW_LESSON: 'NEW_LESSON', NEW_VIDEO: 'NEW_VIDEO', ANNOUNCEMENT: 'ANNOUNCEMENT', PAYMENT: 'PAYMENT', ENROLLMENT: 'ENROLLMENT', COURSE_UPDATE: 'COURSE_UPDATE', ADMIN: 'ADMIN', SECURITY: 'SECURITY' });
exports.SecurityEventType = Object.freeze({ LOGIN_FAILED: 'LOGIN_FAILED', LOGIN_SUCCESS: 'LOGIN_SUCCESS', DEVICE_MISMATCH: 'DEVICE_MISMATCH', DEVICE_REGISTERED: 'DEVICE_REGISTERED', DEVICE_REVOKED: 'DEVICE_REVOKED', INTEGRITY_FAILED: 'INTEGRITY_FAILED', SCREENSHOT: 'SCREENSHOT', RECORDING_STARTED: 'RECORDING_STARTED', RECORDING_STOPPED: 'RECORDING_STOPPED', EXTERNAL_DISPLAY: 'EXTERNAL_DISPLAY', TICKET_DENIED: 'TICKET_DENIED', TICKET_ABUSE: 'TICKET_ABUSE', CONCURRENT_STREAM_BLOCKED: 'CONCURRENT_STREAM_BLOCKED', TOKEN_REUSE: 'TOKEN_REUSE', UNAUTHORIZED_ACCESS: 'UNAUTHORIZED_ACCESS' });
exports.SecuritySeverity = Object.freeze({ INFO: 'INFO', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' });
exports.AuditAction = Object.freeze({ CREATE: 'CREATE', UPDATE: 'UPDATE', DELETE: 'DELETE', ARCHIVE: 'ARCHIVE', RESTORE: 'RESTORE', PUBLISH: 'PUBLISH', UNPUBLISH: 'UNPUBLISH', LOGIN: 'LOGIN', LOGOUT: 'LOGOUT', PASSWORD_RESET: 'PASSWORD_RESET', PRICE_CHANGE: 'PRICE_CHANGE', ROLE_CHANGE: 'ROLE_CHANGE', ACCESS_GRANT: 'ACCESS_GRANT', ACCESS_REVOKE: 'ACCESS_REVOKE', DEVICE_APPROVE: 'DEVICE_APPROVE', DEVICE_REVOKE: 'DEVICE_REVOKE', CODE_ISSUE: 'CODE_ISSUE', CODE_REVOKE: 'CODE_REVOKE', CODE_REDEEM: 'CODE_REDEEM', PAYMENT_CONFIRM: 'PAYMENT_CONFIRM', PAYMENT_REFUND: 'PAYMENT_REFUND', ENROLLMENT_CREATE: 'ENROLLMENT_CREATE', ENROLLMENT_UPDATE: 'ENROLLMENT_UPDATE', SETTINGS_CHANGE: 'SETTINGS_CHANGE' });
exports.WatchEventType = Object.freeze({ STARTED: 'STARTED', PROGRESS: 'PROGRESS', PAUSED: 'PAUSED', COMPLETED: 'COMPLETED', SEEKED: 'SEEKED', ENDED: 'ENDED' });

class Decimal {
  constructor(v){ this._v = Number(v); }
  toFixed(n){ return this._v.toFixed(n); }
  toString(){ return String(this._v); }
  valueOf(){ return this._v; }
}
exports.Prisma = {
  Decimal,
  TransactionIsolationLevel: Object.freeze({
    ReadUncommitted: 'ReadUncommitted',
    ReadCommitted: 'ReadCommitted',
    RepeatableRead: 'RepeatableRead',
    Serializable: 'Serializable',
  }),
  sql: (strings, ...vals) => ({ strings, vals }),
  empty: { strings: [''], vals: [] },
  join: (arr) => ({ arr }),
};
exports.PrismaClient = class PrismaClient {};
