/**
 * Typed form of the §4.10 error contract: every API error carries a stable `code`, a safe
 * `message`, a `correlationId` and the permitted `nextAction`, optionally `details`.
 *
 * The codes mirror `ErrorCodes` in packages/contracts/src/errors.ts; `error-codes.spec.ts` fails
 * when the two lists drift. Client-side failures (no connection, timeout, a body that is not the
 * error contract) get their own codes so screens can show the SPK-UX-008 offline state.
 */

/** Codes the API returns today (`ErrorCodes` in packages/contracts). */
export const API_ERROR_CODES = [
  'AUTHENTICATION_REQUIRED',
  'ACCESS_DENIED',
  'PARTICIPANT_AUTHORITY_REQUIRED',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'ELIGIBILITY_FAILED',
  'MISSING_ACKNOWLEDGMENT',
  'CAPACITY_UNAVAILABLE',
  'DUPLICATE_ENTITLEMENT',
  'RESOURCE_CONFLICT',
  'STALE_REVISION',
  'INVALID_TRANSITION',
  'QUOTE_EXPIRED',
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
  'IDEMPOTENCY_SECRET_WITHHELD',
  'PAYMENT_OUTCOME_UNKNOWN',
  'REFUND_PENDING',
  'INTEGRATION_UNAVAILABLE',
  'RATE_LIMITED',
  'CLIENT_UPDATE_REQUIRED',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * `CLIENT_UPDATE_REQUIRED` (HTTP 426, next action `update_app`, `details.minimumVersion`): the API
 * kernel's client-compatibility guard answers it for a build below the minimum supported app
 * version of its platform, read from the `X-Sportspark-Client` header (§4.13, SPK-AT-027, DEC-092
 * proposed). The client also treats any HTTP 426 as update-required. The minimum versions are
 * configuration pending DEC-061 (none enforced by default).
 */
export const UPDATE_REQUIRED_CODE = 'CLIENT_UPDATE_REQUIRED';
export const UPDATE_REQUIRED_STATUS = 426;

/** Failures detected by the client, never sent by the API. */
export const CLIENT_ERROR_CODES = [
  'NETWORK_UNAVAILABLE',
  'TIMEOUT',
  'UNEXPECTED_RESPONSE',
] as const;
export type ClientErrorCode = (typeof CLIENT_ERROR_CODES)[number];

export type ErrorCode = ApiErrorCode | typeof UPDATE_REQUIRED_CODE | ClientErrorCode;

export type ApiErrorKind =
  /** The API answered with the error contract. */
  | 'api'
  /** The request did not reach the API or the response did not come back. */
  | 'network'
  /** No response within the timeout: for a command the outcome is unknown, retry with the same key. */
  | 'timeout'
  /** The API (or a proxy in front of it) answered with something that is not the error contract. */
  | 'unexpected_response'
  /** This build is below the minimum supported app version (proposed, DEC-061/DEC-092). */
  | 'update_required';

export interface ApiErrorInit {
  kind: ApiErrorKind;
  status: number | null;
  code: ErrorCode | (string & {});
  message: string;
  nextAction: string;
  correlationId: string | null;
  details?: unknown;
  cause?: unknown;
}

/**
 * Codes for which retrying the same intent with the same idempotency key is the permitted next
 * action. Everything else needs the user to change something, wait for reconciliation, or reload.
 */
const RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_IN_PROGRESS',
  'INTEGRATION_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'NETWORK_UNAVAILABLE',
  'TIMEOUT',
]);

export class ApiError extends Error {
  override readonly name: string = 'ApiError';
  readonly kind: ApiErrorKind;
  /** HTTP status, or null when no response arrived. */
  readonly status: number | null;
  readonly code: ErrorCode | (string & {});
  readonly nextAction: string;
  readonly correlationId: string | null;
  readonly details: unknown;

  constructor(init: ApiErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.nextAction = init.nextAction;
    this.correlationId = init.correlationId;
    this.details = init.details;
  }

  /**
   * True when the same intent may be retried with the same idempotency key (§4.9). A payment
   * whose outcome is unknown is never retryable: the next action is to await reconciliation.
   */
  get retryable(): boolean {
    return RETRYABLE_CODES.has(this.code);
  }

  /** The command may have taken effect; never present this as a plain failure (SPK-PAY-007). */
  get outcomeUnknown(): boolean {
    return this.kind === 'timeout' || this.code === 'PAYMENT_OUTCOME_UNKNOWN';
  }

  /**
   * A protected record the caller may not see is answered NOT_FOUND (§4.10, §4.14). Screens show
   * it as unavailable and never imply that the record exists.
   */
  get isNotFound(): boolean {
    return this.code === 'NOT_FOUND';
  }

  /**
   * The principal may not perform the action: render as "not available", never retry. A command
   * refused because the organization turned its capability off is not a restriction of the
   * principal (`isCapabilityDisabled`) and is shown as "turned off" instead.
   */
  get isPermissionRestriction(): boolean {
    if (this.isCapabilityDisabled) return false;
    return this.code === 'ACCESS_DENIED' || this.code === 'PARTICIPANT_AUTHORITY_REQUIRED';
  }
  /**
   * ACCESS_DENIED with `details.code: 'CAPABILITY_DISABLED'`: a gated command of a capability the
   * organization has turned off (K-12, DEC-016). Never retryable; the turned-off state names the
   * decision that may turn it on.
   */
  get isCapabilityDisabled(): boolean {
    if (this.code !== 'ACCESS_DENIED') return false;
    const details = this.details as { code?: unknown } | null | undefined;
    return (
      typeof details === 'object' && details !== null && details.code === 'CAPABILITY_DISABLED'
    );
  }

  /**
   * What is on screen no longer matches the record: reload before deciding again. Includes
   * IDEMPOTENCY_OUTCOME_UNAVAILABLE, the API's answer when an earlier attempt with this key changed
   * data but its response was never recorded (next action `reload_current_state`, §4.9).
   */
  get isStale(): boolean {
    return (
      this.code === 'STALE_REVISION' ||
      this.code === 'INVALID_TRANSITION' ||
      this.code === 'IDEMPOTENCY_OUTCOME_UNAVAILABLE'
    );
  }

  /**
   * Whether the next attempt of the same user intent must keep this intent's idempotency key.
   *
   * The API stores every domain (4xx) answer under the key and replays it for the same key and
   * payload (apps/api/src/kernel/http/idempotency.interceptor.ts). After such a definitive answer a
   * retry with the same key can only get the same refusal again, so the intent ends and the next
   * attempt gets a new key. The key is kept only while the outcome is not known: no response
   * (network, timeout), a retryable code (IDEMPOTENCY_IN_PROGRESS, INTEGRATION_UNAVAILABLE,
   * RATE_LIMITED, INTERNAL_ERROR, a 5xx without the contract), or PAYMENT_OUTCOME_UNKNOWN, where a
   * new key could start a second payment (SPK-PAY-007).
   */
  get keepsIntent(): boolean {
    return this.isOffline || this.retryable || this.code === 'PAYMENT_OUTCOME_UNKNOWN';
  }

  get isAuthenticationRequired(): boolean {
    return this.code === 'AUTHENTICATION_REQUIRED';
  }

  get isOffline(): boolean {
    return this.kind === 'network' || this.kind === 'timeout';
  }

  static is(value: unknown): value is ApiError {
    return value instanceof ApiError;
  }
}

/** The build is below the minimum supported version; the app must show "Update required". */
export class UpdateRequiredError extends ApiError {
  override readonly name: string = 'UpdateRequiredError';
  /** `details.minimumVersion` when the API states it (proposed, DEC-092). */
  readonly minimumVersion: string | null;

  constructor(init: Omit<ApiErrorInit, 'kind'>) {
    super({ ...init, kind: 'update_required' });
    const details = init.details as { minimumVersion?: unknown } | undefined;
    this.minimumVersion =
      details && typeof details.minimumVersion === 'string' ? details.minimumVersion : null;
  }

  static override is(value: unknown): value is UpdateRequiredError {
    return value instanceof UpdateRequiredError;
  }
}

interface ErrorBody {
  code: string;
  message: string;
  correlationId?: string;
  nextAction?: string;
  details?: unknown;
}

function isErrorBody(value: unknown): value is ErrorBody {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

/** Builds the typed error from an HTTP error response body (already parsed, or null). */
export function errorFromResponse(
  status: number,
  body: unknown,
  headerCorrelationId: string | null,
): ApiError {
  if (!isErrorBody(body)) {
    if (status === UPDATE_REQUIRED_STATUS) {
      return new UpdateRequiredError({
        status,
        code: UPDATE_REQUIRED_CODE,
        message: 'This version of the app is no longer supported.',
        nextAction: 'update_app',
        correlationId: headerCorrelationId,
      });
    }
    return new ApiError({
      kind: 'unexpected_response',
      status,
      // A 5xx without the contract (proxy, gateway) is treated like INTERNAL_ERROR: retryable.
      code: status >= 500 ? 'INTERNAL_ERROR' : 'UNEXPECTED_RESPONSE',
      message: 'The service returned an unexpected response.',
      nextAction: status >= 500 ? 'retry_or_contact_support' : 'contact_support',
      correlationId: headerCorrelationId,
    });
  }
  const init = {
    status,
    code: body.code,
    message: body.message,
    nextAction: body.nextAction ?? 'contact_support',
    correlationId: body.correlationId ?? headerCorrelationId,
    details: body.details,
  };
  if (body.code === UPDATE_REQUIRED_CODE || status === UPDATE_REQUIRED_STATUS) {
    return new UpdateRequiredError(init);
  }
  return new ApiError({ ...init, kind: 'api' });
}

export function networkError(cause: unknown): ApiError {
  return new ApiError({
    kind: 'network',
    status: null,
    code: 'NETWORK_UNAVAILABLE',
    message: 'The service could not be reached.',
    nextAction: 'retry_when_online',
    correlationId: null,
    cause,
  });
}

export function timeoutError(timeoutMs: number): ApiError {
  return new ApiError({
    kind: 'timeout',
    status: null,
    code: 'TIMEOUT',
    message: `No response within ${Math.round(timeoutMs / 1000)} seconds.`,
    nextAction: 'retry_with_same_key',
    correlationId: null,
  });
}
