/**
 * What a command's failure says about its effect, in one place for every customer screen (§4.9,
 * §4.14, SPK-PAY-007, SPK-UX-008).
 *
 * - `mayHaveTakenEffect`: no definite answer. The request may have reached the API and committed:
 *   no response (a lost connection while waiting, `kind: 'network'`, or the client's timeout), the
 *   same key still running (IDEMPOTENCY_IN_PROGRESS), a server failure (INTERNAL_ERROR, any 5xx: a
 *   command can fail after an earlier transaction of it committed), or a payment the API holds as
 *   unknown (PAYMENT_OUTCOME_UNKNOWN). Such an answer is never shown as "Not done": "Check again"
 *   repeats the same request under the same idempotency key, which the API answers with the stored
 *   outcome or runs once. `ApiError.outcomeUnknown` covers only the timeout and
 *   PAYMENT_OUTCOME_UNKNOWN, so screens use this instead.
 * - `secretWithheldOf`: IDEMPOTENCY_SECRET_WITHHELD. A retry of a create command whose response
 *   carried a one-time secret (an invitation or a calendar feed link) found that the first attempt
 *   succeeded; the secret is returned only in the original response, which never reached this
 *   device. The record exists (`details.resourceId`): it is shown as created, and the way on is to
 *   revoke it and issue a new one (next action `revoke_and_reissue`).
 */
import type { ApiError } from '@sportspark/api-client';

export function mayHaveTakenEffect(error: ApiError): boolean {
  return (
    error.isOffline ||
    error.code === 'IDEMPOTENCY_IN_PROGRESS' ||
    error.code === 'INTERNAL_ERROR' ||
    error.code === 'PAYMENT_OUTCOME_UNKNOWN' ||
    (error.status ?? 0) >= 500
  );
}

export const SECRET_WITHHELD_CODE = 'IDEMPOTENCY_SECRET_WITHHELD';

/**
 * The record an IDEMPOTENCY_SECRET_WITHHELD answer names, or null when the error is another one.
 * `resourceId` is null when the API could not name it (the stored response had no id).
 */
export function secretWithheldOf(error: ApiError): { resourceId: string | null } | null {
  if (error.code !== SECRET_WITHHELD_CODE) return null;
  const details = error.details as { resourceId?: unknown } | null | undefined;
  const resourceId =
    details && typeof details === 'object' && typeof details.resourceId === 'string'
      ? details.resourceId
      : null;
  return { resourceId };
}
