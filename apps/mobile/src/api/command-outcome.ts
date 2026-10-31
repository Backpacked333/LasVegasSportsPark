/**
 * What a command's failure says about its effect, in one place for every customer screen (§4.9,
 * §4.14, SPK-PAY-007, SPK-UX-008). The shared failure views (account `CommandError`, teams
 * `CommandFailure`, money `CommandFailure`, registration `CommandError`, `ui/SecretWithheld`) and
 * the payment screens (SCR-C-14, SCR-C-15, SCR-C-25, SCR-C-34) decide with these predicates only.
 *
 * - `mayHaveTakenEffect`: no definite answer. The request may have reached the API and committed:
 *   no response (a lost connection while waiting, `kind: 'network'`, or the client's timeout), the
 *   same key still running (IDEMPOTENCY_IN_PROGRESS), a server failure (INTERNAL_ERROR, any 5xx: a
 *   command can fail after an earlier transaction of it committed), or a payment the API holds as
 *   unknown (PAYMENT_OUTCOME_UNKNOWN). Such an answer is never shown as "Not done": "Check again"
 *   repeats the same request under the same idempotency key, which the API answers with the stored
 *   outcome or runs once. `ApiError.outcomeUnknown` covers only the timeout and
 *   PAYMENT_OUTCOME_UNKNOWN, so screens use this instead.
 * - `tookEffectOutcomeLost`: IDEMPOTENCY_OUTCOME_UNAVAILABLE. An earlier attempt under this key
 *   committed changes, but its response was never recorded (the API stopped first, and its lease
 *   lapsed), so the API will not run it again and cannot say what it returned (next action
 *   `reload_current_state`). It is kept apart from `mayHaveTakenEffect` because "Check again" is no
 *   use here: the same key gets the same answer. Screens show "This may already have been done"
 *   with "Reload", which reads the record or list again, never "Something went wrong" or "Not
 *   done", and a create form does not create again beside the record it may have made. The hooks
 *   keep the intent's key after it (`keepsIntentAfterFailure`), so an unchanged resubmission is
 *   answered the same way instead of running under a new key.
 * - `secretWithheldOf`: IDEMPOTENCY_SECRET_WITHHELD. A retry of a create command whose response
 *   carried a one-time secret (an invitation or a calendar feed link) found that the first attempt
 *   succeeded; the secret is returned only in the original response, which never reached this
 *   device. The record exists (`details.resourceId`): it is shown as created, and the way on is to
 *   revoke it and issue a new one (next action `revoke_and_reissue`).
 * - `mustNotCreateAgain`: either of the last two. A create form holds back creating again and shows
 *   `ui/SecretWithheld`, which points to where the record is listed.
 */
import { keepsIntentAfter, type ApiError } from '@sportspark/api-client';

export function mayHaveTakenEffect(error: ApiError): boolean {
  return (
    error.isOffline ||
    error.code === 'IDEMPOTENCY_IN_PROGRESS' ||
    error.code === 'INTERNAL_ERROR' ||
    error.code === 'PAYMENT_OUTCOME_UNKNOWN' ||
    (error.status ?? 0) >= 500
  );
}

export const OUTCOME_LOST_CODE = 'IDEMPOTENCY_OUTCOME_UNAVAILABLE';

export function tookEffectOutcomeLost(error: ApiError): boolean {
  return error.code === OUTCOME_LOST_CODE;
}

/**
 * Whether the next attempt of the same input must keep the intent's idempotency key. As
 * `keepsIntentAfter` (api-client), and also after IDEMPOTENCY_OUTCOME_UNAVAILABLE: the API never
 * stores that answer but gives it again for the same key, whereas a new key would run the command
 * a second time (`ApiError.keepsIntent` ends the intent there).
 */
export function keepsIntentAfterFailure(error: unknown): boolean {
  if (
    error &&
    typeof error === 'object' &&
    (error as { code?: unknown }).code === OUTCOME_LOST_CODE
  )
    return true;
  return keepsIntentAfter(error);
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

/** The create may already have made its record: do not send it again under a new key. */
export function mustNotCreateAgain(error: ApiError | null): boolean {
  return error !== null && (secretWithheldOf(error) !== null || tookEffectOutcomeLost(error));
}
