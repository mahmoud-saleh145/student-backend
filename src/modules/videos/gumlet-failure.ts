/**
 * What a Gumlet failure MEANS, and what has to change before trying again.
 *
 * WHY THIS EXISTS
 *
 * A provider error string is not a verdict. The same video can fail because the
 * account ran out of storage minutes (an operator must upgrade the plan), because
 * the provider could not fetch the input URL (a fresh ingest fixes it), because
 * the network blipped (a retry is fine), or because the API key was revoked (an
 * operator must fix the credential). Before this module, all four arrived as one
 * flat `gumletError` string and every one of them was treated the same way:
 * re-read the same asset, get the same answer, forever.
 *
 * The distinction matters operationally, because only some of these are fixed by
 * pressing "Retry" again:
 *
 *   QUOTA_EXCEEDED       - the account's allowance is spent. A new asset is
 *                          rejected exactly like the old one. Retry is pointless
 *                          until the plan changes.
 *   ACCOUNT_OR_CREDENTIALS - the API key was revoked, the workspace is wrong, the
 *                          account is unpaid. Same shape: nothing about the
 *                          video can fix it.
 *   SOURCE_UNREACHABLE   - the provider could not read the input. The video is
 *                          fine; a FRESH ingest with a fresh URL can succeed.
 *   TRANSIENT            - a blip. The same request may succeed on its own.
 *
 * `requiresReingest` is the field the recovery path acts on: it is the only
 * failure class where minting a new asset is the correct repair, and it is
 * exactly the class that `adopt()` - which is idempotent by design - cannot
 * recover on its own.
 *
 * WHY IT IS A PURE MODULE
 *
 * It has no dependency on Nest, on Prisma or on the HTTP client, so the rules
 * can be exercised directly. A classification that decides whether a video is
 * recoverable is exactly the kind of logic that must not be tested only through
 * a service that needs three collaborators and a provider stub.
 */

/** The classes of provider failure this platform distinguishes. */
export type GumletFailureKind =
  /** The account's allowance (storage minutes, bandwidth) is spent. */
  | 'QUOTA_EXCEEDED'
  /** The key, the workspace or the account itself is not usable. */
  | 'ACCOUNT_OR_CREDENTIALS'
  /** The provider could not read the input it was given. */
  | 'SOURCE_UNREACHABLE'
  /** A blip: the same request may well succeed unchanged. */
  | 'TRANSIENT'
  /** The provider said something this module does not recognise. */
  | 'UNKNOWN';

export interface GumletFailure {
  kind: GumletFailureKind;
  /**
   * May the platform retry THE SAME asset without an operator changing
   * anything? Only a transient failure may.
   */
  retryable: boolean;
  /**
   * Must an operator change something first (a plan, a credential, an
   * allowance) before another attempt can possibly succeed?
   */
  requiresOperatorAction: boolean;
  /**
   * Does the video need a NEW asset to be recoverable? True only for a failed
   * input: the old asset is dead and only a fresh ingest can replace it.
   */
  requiresReingest: boolean;
  /** Sanitized, actionable text for an administrator. */
  adminMessage: string;
}

/** Longest provider text kept. Long enough to be useful, short enough to store. */
const MAX_MESSAGE_LENGTH = 400;

/**
 * Strip anything that must not reach a log, an audit row or an API response.
 *
 * Provider messages are echoed from a third party, so they can contain a
 * presigned URL, a token or an account identifier. None of those belong in a
 * row a dashboard renders, and a presigned URL in a log is a credential in a
 * log.
 */
export function sanitizeProviderText(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value)
    // A URL of any shape: a signed R2 URL carries the object's signature.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    // A query-string parameter that carries a credential.
    .replace(/([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|token|signature|api[_-]?key)=)[^&\s]+/gi, '$1[redacted]')
    // A bare secret-shaped token (base64/hex, long enough not to be a word).
    .replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, '[secret]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

/** Lower-cased haystack both the code and the message are matched against. */
function haystack(code: string | null | undefined, message: string | null | undefined): string {
  return `${code ?? ''} ${message ?? ''}`.toLowerCase();
}

/**
 * Classify a provider failure.
 *
 * The order of the rules is deliberate. A quota message also talks about the
 * account and about upgrading, so it has to be tested before the account rule
 * or every quota failure would be reported as a credential problem - and the
 * two need different operator actions.
 */
export function classifyGumletFailure(input: {
  code?: string | null;
  message?: string | null;
  status?: number | null;
}): GumletFailure {
  const code = input.code ?? null;
  const message = input.message ?? null;
  const hay = haystack(code, message);

  // A rate limit is a rate to wait out, and the platform's own backoff handles
  // it. Checked first because 429 is unambiguous.
  if (input.status === 429 || hay.includes('rate limit') || hay.includes('too many requests')) {
    return {
      kind: 'TRANSIENT',
      retryable: true,
      requiresOperatorAction: false,
      requiresReingest: false,
      adminMessage: 'Gumlet rate-limited this request. It is being retried with a backoff.',
    };
  }

  // An allowance that is spent, or a plan that is not what the platform expects.
  if (
    hay.includes('quota') ||
    hay.includes('storage minutes') ||
    hay.includes('exceeds the') ||
    hay.includes('upgrade your account') ||
    hay.includes('insufficient funds') ||
    hay.includes('payment') ||
    hay.includes('unpaid') ||
    hay.includes('subscription')
  ) {
    return {
      kind: 'QUOTA_EXCEEDED',
      retryable: false,
      requiresOperatorAction: true,
      // A fresh asset is rejected exactly like the old one, so re-ingesting
      // cannot help until the allowance changes.
      requiresReingest: false,
      adminMessage:
        'Gumlet rejected this video because the account allowance is exhausted ' +
        '(storage minutes / plan limit). The plan must be increased before this video can be processed; ' +
        'retrying will not help on its own.',
    };
  }

  // The credential, the workspace or the account is not usable.
  if (
    hay.includes('unauthorized') ||
    hay.includes('forbidden') ||
    hay.includes('invalid api key') ||
    hay.includes('invalid_api_key') ||
    hay.includes('api key') ||
    hay.includes('credential') ||
    hay.includes('permission') ||
    hay.includes('workspace') ||
    hay.includes('account is') ||
    hay.includes('not found on this account')
  ) {
    return {
      kind: 'ACCOUNT_OR_CREDENTIALS',
      retryable: false,
      requiresOperatorAction: true,
      requiresReingest: false,
      adminMessage:
        'Gumlet rejected this request because of the account, the workspace or the API credentials. ' +
        'Those must be corrected before this video can be processed.',
    };
  }

  // The provider could not read the input it was handed. The video itself may
  // be perfectly good; a fresh ingest with a fresh URL can still succeed.
  if (
    hay.includes('err_asset_not_found') ||
    hay.includes('trouble downloading') ||
    hay.includes('could not download') ||
    hay.includes('failed to download') ||
    hay.includes('input video') ||
    hay.includes('input file') ||
    hay.includes('source url')
  ) {
    return {
      kind: 'SOURCE_UNREACHABLE',
      retryable: false,
      requiresOperatorAction: false,
      requiresReingest: true,
      adminMessage:
        'Gumlet could not read the uploaded file when it tried to ingest it. ' +
        'The video must be ingested again from a fresh upload URL.',
    };
  }

  // A blip.
  if (
    hay.includes('timeout') ||
    hay.includes('timed out') ||
    hay.includes('temporarily') ||
    hay.includes('econnreset') ||
    hay.includes('etimedout') ||
    hay.includes('socket hang up') ||
    hay.includes('network') ||
    hay.includes('service unavailable') ||
    hay.includes('internal server error')
  ) {
    return {
      kind: 'TRANSIENT',
      retryable: true,
      requiresOperatorAction: false,
      requiresReingest: false,
      adminMessage: 'Gumlet reported a temporary problem. The request is being retried with a backoff.',
    };
  }

  // A 5xx with no recognisable wording is still transient; anything else with
  // no recognisable wording is unknown, and is treated conservatively: not
  // retryable, and not a reason to mint a new asset.
  if (typeof input.status === 'number' && input.status >= 500) {
    return {
      kind: 'TRANSIENT',
      retryable: true,
      requiresOperatorAction: false,
      requiresReingest: false,
      adminMessage: `Gumlet returned HTTP ${input.status}. The request is being retried with a backoff.`,
    };
  }

  return {
    kind: 'UNKNOWN',
    retryable: false,
    requiresOperatorAction: false,
    requiresReingest: false,
    adminMessage: message
      ? `Gumlet reported a problem: ${sanitizeProviderText(message)}`
      : 'Gumlet reported a problem that has not been classified.',
  };
}
