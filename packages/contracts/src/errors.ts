/**
 * Stable error contract (specification §4.10).
 * Every error carries a stable code, a safe message, a correlation reference, and the permitted next action.
 * Protected-record errors must not reveal that another household's record exists.
 */
export const ErrorCodes = {
  AUTHENTICATION_REQUIRED: { httpStatus: 401, nextAction: 'authenticate' },
  ACCESS_DENIED: { httpStatus: 403, nextAction: 'contact_support_or_request_access' },
  PARTICIPANT_AUTHORITY_REQUIRED: { httpStatus: 403, nextAction: 'request_participant_authority' },
  NOT_FOUND: { httpStatus: 404, nextAction: 'verify_reference' },
  VALIDATION_FAILED: { httpStatus: 400, nextAction: 'correct_input' },
  ELIGIBILITY_FAILED: { httpStatus: 422, nextAction: 'review_eligibility_reasons' },
  MISSING_ACKNOWLEDGMENT: { httpStatus: 422, nextAction: 'complete_acknowledgment' },
  CAPACITY_UNAVAILABLE: { httpStatus: 409, nextAction: 'join_waitlist_or_choose_alternative' },
  DUPLICATE_ENTITLEMENT: { httpStatus: 409, nextAction: 'review_existing_participation' },
  RESOURCE_CONFLICT: { httpStatus: 409, nextAction: 'resolve_conflict' },
  STALE_REVISION: { httpStatus: 409, nextAction: 'reload_and_retry' },
  INVALID_TRANSITION: { httpStatus: 409, nextAction: 'reload_current_state' },
  QUOTE_EXPIRED: { httpStatus: 409, nextAction: 'request_new_quote' },
  IDEMPOTENCY_CONFLICT: { httpStatus: 409, nextAction: 'use_new_idempotency_key' },
  IDEMPOTENCY_IN_PROGRESS: { httpStatus: 409, nextAction: 'retry_later_with_same_key' },
  IDEMPOTENCY_OUTCOME_UNAVAILABLE: { httpStatus: 409, nextAction: 'reload_current_state' },
  IDEMPOTENCY_SECRET_WITHHELD: { httpStatus: 409, nextAction: 'revoke_and_reissue' },
  PAYMENT_OUTCOME_UNKNOWN: { httpStatus: 409, nextAction: 'await_reconciliation' },
  REFUND_PENDING: { httpStatus: 409, nextAction: 'await_refund_resolution' },
  INTEGRATION_UNAVAILABLE: { httpStatus: 503, nextAction: 'retry_later' },
  RATE_LIMITED: { httpStatus: 429, nextAction: 'retry_later' },
  /**
   * SPK-AT-027, §4.13: the calling app build is below the minimum supported version for its
   * platform (`details.minimumVersion`). Added as proposed by DEC-092; the minimum versions
   * themselves are DEC-061 (pending).
   */
  CLIENT_UPDATE_REQUIRED: { httpStatus: 426, nextAction: 'update_app' },
  INTERNAL_ERROR: { httpStatus: 500, nextAction: 'retry_or_contact_support' },
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

/**
 * Next actions an error may name instead of its code's default (§4.10 "the permitted next
 * action"). `see_code` is what the filter answers for a framework HTTP exception; the others are
 * named by a module for a more precise recovery than the code's default.
 */
export const ADDITIONAL_NEXT_ACTIONS = [
  'see_code',
  /** §5.6: the legacy system is authoritative for this record category (migration, K-11). */
  'write_in_authoritative_system',
  /** Support: a case action's outcome must be recorded first. */
  'settle_case_action',
  /** Support: an authorized action must be linked to the case first. */
  'link_authorized_action',
] as const;

/** Every next action the API can send: each code's default plus `ADDITIONAL_NEXT_ACTIONS`. */
export const NEXT_ACTIONS = [
  ...new Set<string>([
    ...Object.values(ErrorCodes).map((c) => c.nextAction),
    ...ADDITIONAL_NEXT_ACTIONS,
  ]),
] as unknown as readonly ErrorNextAction[];
export type ErrorNextAction =
  (typeof ErrorCodes)[ErrorCode]['nextAction'] | (typeof ADDITIONAL_NEXT_ACTIONS)[number];

export interface ErrorResponseBody {
  code: ErrorCode;
  message: string;
  correlationId: string;
  nextAction: ErrorNextAction;
  details?: unknown;
}

export interface DomainErrorOptions {
  details?: unknown;
  /** Defaults to the code's next action; any other value must be listed in NEXT_ACTIONS. */
  nextAction?: ErrorNextAction;
  cause?: unknown;
}

export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly nextAction: ErrorNextAction;
  readonly details: unknown;

  constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.httpStatus = ErrorCodes[code].httpStatus;
    this.nextAction = options.nextAction ?? ErrorCodes[code].nextAction;
    this.details = options.details;
  }

  toResponseBody(correlationId: string): ErrorResponseBody {
    const body: ErrorResponseBody = {
      code: this.code,
      message: this.message,
      correlationId,
      nextAction: this.nextAction,
    };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }

  static is(value: unknown): value is DomainError {
    return value instanceof DomainError;
  }
}

/** Convenience constructors so modules raise consistent errors. */
export const errors = {
  authenticationRequired: (message = 'Authentication is required.') =>
    new DomainError('AUTHENTICATION_REQUIRED', message),
  accessDenied: (message = 'You are not permitted to perform this action.', details?: unknown) =>
    new DomainError('ACCESS_DENIED', message, { details }),
  participantAuthorityRequired: (message = 'Authority over this participant is required.') =>
    new DomainError('PARTICIPANT_AUTHORITY_REQUIRED', message),
  /**
   * Use for protected records when the caller may not learn whether the record exists
   * (specification §4.10: errors must not reveal another household's protected record existence).
   */
  protectedNotFound: (recordType = 'record') =>
    new DomainError('NOT_FOUND', `The requested ${recordType} was not found.`),
  notFound: (recordType: string, id?: string) =>
    new DomainError(
      'NOT_FOUND',
      id ? `${recordType} ${id} was not found.` : `${recordType} was not found.`,
    ),
  validation: (message: string, details?: unknown) =>
    new DomainError('VALIDATION_FAILED', message, { details }),
  eligibility: (message: string, details?: unknown) =>
    new DomainError('ELIGIBILITY_FAILED', message, { details }),
  missingAcknowledgment: (message: string, details?: unknown) =>
    new DomainError('MISSING_ACKNOWLEDGMENT', message, { details }),
  capacityUnavailable: (message = 'No capacity is available.', details?: unknown) =>
    new DomainError('CAPACITY_UNAVAILABLE', message, { details }),
  duplicateEntitlement: (message: string, details?: unknown) =>
    new DomainError('DUPLICATE_ENTITLEMENT', message, { details }),
  resourceConflict: (message: string, details?: unknown) =>
    new DomainError('RESOURCE_CONFLICT', message, { details }),
  staleRevision: (expected: number, actual: number) =>
    new DomainError('STALE_REVISION', 'The record changed since it was loaded.', {
      details: { expectedRevision: expected, currentRevision: actual },
    }),
  invalidTransition: (machine: string, from: string, event: string) =>
    new DomainError('INVALID_TRANSITION', `${machine} cannot ${event} from ${from}.`, {
      details: { machine, from, event },
    }),
  quoteExpired: () => new DomainError('QUOTE_EXPIRED', 'The quote has expired.'),
  idempotencyConflict: () =>
    new DomainError(
      'IDEMPOTENCY_CONFLICT',
      'This idempotency key was used with a different request.',
    ),
  idempotencyInProgress: () =>
    new DomainError(
      'IDEMPOTENCY_IN_PROGRESS',
      'A request with this idempotency key is still in progress.',
    ),
  /**
   * The request that holds this key committed changes but its response was never recorded (the
   * process stopped first). Re-running it could repeat its effect, so the client reloads state (§4.9).
   */
  idempotencyOutcomeUnavailable: (details?: unknown) =>
    new DomainError(
      'IDEMPOTENCY_OUTCOME_UNAVAILABLE',
      'The request with this idempotency key changed data but its response was not recorded; reload the current state instead of retrying it.',
      { details },
    ),
  /**
   * A replay of a command whose response carried a one-time secret (§4.9). The record exists (named
   * in `details.resourceId`) but its secret is returned only once and is never stored with the
   * idempotency key (§4.14); revoke it and issue a new one to obtain a new secret.
   */
  idempotencySecretWithheld: (details: { resourceId: string | null }) =>
    new DomainError(
      'IDEMPOTENCY_SECRET_WITHHELD',
      'This request already succeeded. Its one-time secret is returned only in the original response; revoke the record and issue a new one to obtain a new secret.',
      { details },
    ),
  paymentOutcomeUnknown: (details?: unknown) =>
    new DomainError('PAYMENT_OUTCOME_UNKNOWN', 'The payment outcome is not yet known.', {
      details,
    }),
  refundPending: (details?: unknown) =>
    new DomainError('REFUND_PENDING', 'A refund is pending on these funds.', { details }),
  integrationUnavailable: (integration: string, cause?: unknown) =>
    new DomainError('INTEGRATION_UNAVAILABLE', `${integration} is currently unavailable.`, {
      cause,
    }),
  internal: (message = 'An unexpected error occurred.', cause?: unknown) =>
    new DomainError('INTERNAL_ERROR', message, { cause }),
};
