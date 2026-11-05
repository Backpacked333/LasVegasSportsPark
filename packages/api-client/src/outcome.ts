/**
 * What a command's failure says about its effect (§4.9, §4.14, SPK-PAY-007, SPK-UX-008). The staff
 * dashboard's command failure views and command hooks decide with these predicates only, never
 * with a check of their own on `kind` or a single code. The customer app re-exports these
 * unchanged (apps/mobile/src/api/command-outcome.ts).
 *
 * - `mayHaveTakenEffect`: no definite answer to a command (never a failed read, which changed
 *   nothing: `ApiError.method` is `get`), so the request may have reached the API and committed.
 *   No response (`kind: 'network'`: the client cannot tell a request that never left
 *   from a connection lost after sending; `kind: 'timeout'`), the same key still running
 *   (IDEMPOTENCY_IN_PROGRESS), a server failure (INTERNAL_ERROR or any 5xx: a command can fail
 *   after an earlier transaction of it committed), a success status whose body could not be read
 *   (RESPONSE_UNREADABLE: a 2xx means the API, or something in front of it, answered success), or
 *   a payment the API holds as unknown (PAYMENT_OUTCOME_UNKNOWN). Never shown as "nothing changed"
 *   or "something went wrong": "Try again" repeats the same request under the same idempotency
 *   key, which the API answers with the stored outcome or runs once. A refusal before running
 *   (`refusedBeforeRunning`) is excluded although it is a 503.
 * - `refusedBeforeRunning`: INTEGRATION_UNAVAILABLE from a guard that answers before the
 *   idempotency interceptor claims the key, so nothing ran: `details.reason: 'recovery_mode'` (the
 *   kernel RecoveryGuard while the organization recovers from a restore, §5.8, SPK-AT-028) and
 *   `details.reason: 'disabled'` (the optional assistant is off, SPK-AUTO-005). The API's message
 *   says why; the same key may be sent again later.
 * - `outcomeStillOpen`: the form that sent the command keeps exactly the request it sent (locked)
 *   while the hook keeps the key (`keepsIntentAfterFailure`), except after a refusal before
 *   running, where nothing happened and a changed request is a new intent anyway.
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
import { RESPONSE_UNREADABLE_CODE, type ApiError } from './errors';
import { OUTCOME_LOST_CODE, keepsIntentAfterFailure } from './idempotency';

export const SECRET_WITHHELD_CODE = 'IDEMPOTENCY_SECRET_WITHHELD';

/**
 * `details.reason` of an INTEGRATION_UNAVAILABLE answered before the idempotency key is claimed:
 * `recovery_mode` (apps/api kernel recovery.guard.ts) and `disabled` (automation
 * automation-enabled.guard.ts).
 */
export const REFUSED_BEFORE_RUNNING_REASONS: readonly string[] = ['recovery_mode', 'disabled'];

/** The guard refused the command before it ran: nothing changed, the API's message says why. */
export function refusedBeforeRunning(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, details } = error as { code?: unknown; details?: unknown };
  if (code !== 'INTEGRATION_UNAVAILABLE') return false;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return false;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' && REFUSED_BEFORE_RUNNING_REASONS.includes(reason);
}

export function mayHaveTakenEffect(error: ApiError): boolean {
  // A read changes nothing, whatever answer it lost (the client records the method it sent).
  if (error.method === 'get') return false;
  if (refusedBeforeRunning(error)) return false;
  return (
    error.isOffline ||
    error.code === 'IDEMPOTENCY_IN_PROGRESS' ||
    error.code === 'INTERNAL_ERROR' ||
    error.code === 'PAYMENT_OUTCOME_UNKNOWN' ||
    error.code === RESPONSE_UNREADABLE_CODE ||
    (error.status ?? 0) >= 500
  );
}

/**
 * The outcome of the last attempt is not known (or it committed under its key): the form keeps
 * exactly the request that was sent until the person has looked at the current state. False after
 * a refusal before running, which changed nothing.
 */
export function outcomeStillOpen(error: ApiError | null | undefined): boolean {
  return !!error && keepsIntentAfterFailure(error) && !refusedBeforeRunning(error);
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
