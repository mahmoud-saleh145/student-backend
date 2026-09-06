/**
 * Response envelope.
 *
 * ── Contract conflict, resolved ───────────────────────────────────────────
 * The backend specification asks for:
 *     { success: false, error: { code, message } }
 * The already-built mobile app reads error fields from the TOP LEVEL:
 *     { statusCode, code, message, errors, requestId }
 * (see edu-mobile/src/api/errors.ts → toApiError).
 *
 * Rather than break one of them, error bodies carry BOTH shapes: the nested
 * `error` object the spec asks for, and the flat fields the shipped client
 * already parses. They are always populated from the same source values, so
 * they cannot disagree. This costs a few bytes per error response and removes
 * the need for any change in the mobile app.
 *
 * Success bodies are `{ success, data, meta }`. The mobile client unwraps
 * `body.data` when a `data` key is present, so it reads these unchanged.
 * ─────────────────────────────────────────────────────────────────────────
 */

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  success: false;

  /** Spec-shaped nested error. */
  error: {
    code: string;
    message: string;
    fields?: Record<string, string[]>;
    details?: Record<string, unknown>;
  };

  // --- flat mirror consumed by the shipped mobile client --------------------
  statusCode: number;
  code: string;
  message: string;
  errors?: Record<string, string[]>;
  requestId?: string;
  timestamp: string;
  path?: string;
}

export type ApiEnvelope<T> = SuccessEnvelope<T> | ErrorEnvelope;

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrevious: boolean;
}

export interface Paginated<T> {
  items: T[];
  meta: PageMeta;
}

export function paginated<T>(
  items: T[],
  total: number,
  page: number,
  pageSize: number,
): Paginated<T> {
  const totalPages = Math.max(1, Math.ceil(total / Math.max(1, pageSize)));
  return {
    items,
    meta: {
      page,
      pageSize,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrevious: page > 1,
    },
  };
}
