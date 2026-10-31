/**
 * What a command's failure says about its effect, in one place for both apps (§4.9, §4.14,
 * SPK-PAY-007, SPK-UX-008). Command failure views decide with these predicates only, never with a
 * check of their own on `kind` or a single code:
 *
 * - `mayHaveTakenEffect`: no definite answer to a command (never a failed read, which changed
 *   nothing: `ApiError.method` is `get`), so the request may have reached the API and committed.
 *   No response (`kind: 'network'`: the client cannot tell a request that never left
 *   from a connection lost after sending; `kind: 'timeout'`), the same key still running
 *   (IDEMPOTENCY_IN_PROGRESS), a server failure (INTERNAL_ERROR or any 5xx: a command can fail
 *   after an earlier transaction of it committed), or a payment the API holds as unknown
 *   (PAYMENT_OUTCOME_UNKNOWN). Never shown as "nothing changed" or "something went wrong": "Try
 *   again" repeats the same request under the same idempotency key, which the API answers with the
 *   stored outcome or runs once.
 * - `tookEffectOutcomeLost`: IDEMPOTENCY_OUTCOME_UNAVAILABLE. An earlier attempt under this key
 *   committed, but its response was never recorded, so the API will not run it again and cannot say
 *   what it returned (next action `reload_current_state`). "Try again" is no use (the same key gets
 *   the same answer); the screen says "This may already have been done" and re-reads the record.
 *   The command hooks keep the key (`keepsIntentAfterFailure`), so an unchanged resubmission is
 *   answered the same way instead of running under a new key.
 * - `secretWithheldOf`: IDEMPOTENCY_SECRET_WITHHELD. A retry of a create command whose response
 *   carried a one-time secret (an invitation code, a claim code, an export's download token, a
 *   calendar feed link) found that the first attempt succeeded; the secret is returned only in the
 *   original response, which never arrived. The record exists (`details.resourceId`): it is shown
 *   as created, and the way on is to revoke it and issue a new one (next action
 *   `revoke_and_reissue`).
 * - `mustNotCreateAgain`: either of the last two. A create form does not create again beside the
 *   record it may already have made until the person has looked at the current state.
 */
import type { ApiError } from './errors';
import { OUTCOME_LOST_CODE } from './idempotency';

export const SECRET_WITHHELD_CODE = 'IDEMPOTENCY_SECRET_WITHHELD';

export function mayHaveTakenEffect(error: ApiError): boolean {
  // A read changes nothing, whatever answer it lost (the client records the method it sent).
  if (error.method === 'get') return false;
  return (
    error.isOffline ||
    error.code === 'IDEMPOTENCY_IN_PROGRESS' ||
    error.code === 'INTERNAL_ERROR' ||
    error.code === 'PAYMENT_OUTCOME_UNKNOWN' ||
    (error.status ?? 0) >= 500
  );
}

export function tookEffectOutcomeLost(error: ApiError): boolean {
  return error.code === OUTCOME_LOST_CODE;
}

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

/** The create may already have made its record: do not send it again under a new key. */
export function mustNotCreateAgain(error: ApiError | null | undefined): boolean {
  return !!error && (secretWithheldOf(error) !== null || tookEffectOutcomeLost(error));
}
