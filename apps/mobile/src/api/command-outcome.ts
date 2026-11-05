/**
 * What a command's failure says about its effect, in one place for every customer screen (§4.9,
 * §4.10, §4.14, SPK-PAY-007, SPK-UX-008, SPK-AT-028). The shared failure views (account
 * `CommandError`, teams `CommandFailure`, money `CommandFailure`, registration `CommandError`,
 * `ui/SecretWithheld`) and the payment screens (SCR-C-14, SCR-C-15, SCR-C-25, SCR-C-34) decide
 * with these predicates only.
 *
 * They are the shared predicates of `@sportspark/api-client` (`outcome.ts`, `idempotency.ts`), the
 * same ones the staff dashboard decides with, re-exported here so the customer app has no copy of
 * its own that could drift from them (R4-CLIENTS-A11Y-COPY-01):
 *
 * - `mayHaveTakenEffect`: no definite answer to a command, so the request may have reached the API
 *   and committed: no response (a lost connection while waiting, `kind: 'network'`, or the
 *   client's timeout), the same key still running (IDEMPOTENCY_IN_PROGRESS), a server failure
 *   (INTERNAL_ERROR, any 5xx: a command can fail after an earlier transaction of it committed), a
 *   success status whose body could not be read (RESPONSE_UNREADABLE: a 2xx means the API
 *   answered success), or a payment the API holds as unknown (PAYMENT_OUTCOME_UNKNOWN). Such an
 *   answer is never shown as "Not done": "Check again" repeats the same request under the same
 *   idempotency key, which the API answers with the stored outcome or runs once. A failed read
 *   (`ApiError.method` is `get`) changed nothing and is never one, and neither is a refusal before
 *   running, although it is a 503. `ApiError.outcomeUnknown` covers only the timeout and
 *   PAYMENT_OUTCOME_UNKNOWN, so screens use this instead.
 * - `refusedBeforeRunning`: INTEGRATION_UNAVAILABLE from a guard that answers before the
 *   idempotency key is claimed, so nothing ran: `details.reason: 'recovery_mode'` (payments are
 *   paused while the organization recovers from a restore, §5.8, SPK-AT-028) or `'disabled'`.
 *   Screens show it as "Not done" with the API's message ("Payments are paused ... Try again
 *   later."), never as "No answer yet" or "Do not pay again" (`ui/RefusedBeforeRunning`).
 * - `outcomeStillOpen`: the key is kept and the outcome is open (not after a refusal before
 *   running, where nothing happened).
 * - `tookEffectOutcomeLost`: IDEMPOTENCY_OUTCOME_UNAVAILABLE. An earlier attempt under this key
 *   committed changes, but its response was never recorded (the API stopped first, and its lease
 *   lapsed), so the API will not run it again and cannot say what it returned (next action
 *   `reload_current_state`). It is kept apart from `mayHaveTakenEffect` because "Check again" is no
 *   use here: the same key gets the same answer. Screens show "This may already have been done"
 *   with "Reload", which reads the record or list again, never "Something went wrong" or "Not
 *   done", and a create form does not create again beside the record it may have made. The hooks
 *   keep the intent's key after it (`keepsIntentAfterFailure`), so an unchanged resubmission is
 *   answered the same way instead of running under a new key.
 * - `keepsIntentAfterFailure`: whether the next attempt of the same input keeps the intent's key:
 *   while the outcome is not known (`ApiError.keepsIntent`) and after IDEMPOTENCY_OUTCOME_
 *   UNAVAILABLE, where a new key would run the command a second time.
 * - `secretWithheldOf`: IDEMPOTENCY_SECRET_WITHHELD. A retry of a create command whose response
 *   carried a one-time secret (an invitation or a calendar feed link) found that the first attempt
 *   succeeded; the secret is returned only in the original response, which never reached this
 *   device. The record exists (`details.resourceId`): it is shown as created, and the way on is to
 *   revoke it and issue a new one (next action `revoke_and_reissue`).
 * - `mustNotCreateAgain`: either of the last two. A create form holds back creating again and shows
 *   `ui/SecretWithheld`, which points to where the record is listed.
 */
export {
  OUTCOME_LOST_CODE,
  RESPONSE_UNREADABLE_CODE,
  SECRET_WITHHELD_CODE,
  keepsIntentAfterFailure,
  mayHaveTakenEffect,
  mustNotCreateAgain,
  outcomeStillOpen,
  refusedBeforeRunning,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '@sportspark/api-client';
