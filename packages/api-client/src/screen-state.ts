/**
 * How an API failure is presented, shared by the customer app and the staff dashboard so both use
 * the same words for the same condition (SPK-UX-008 states, SPK-UX-010 consistent terminology,
 * §4.10 next actions). Screens choose the component; this decides which state and which recovery.
 */
import { ApiError } from './errors';

export type ErrorPresentation =
  /** Protected NOT_FOUND, ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED: "not available". */
  | 'unavailable'
  /** No connection or no response: show what is cached with its age. */
  | 'offline'
  /** This build is below the minimum supported version (SCR-C-39). */
  | 'update_required'
  /** The session expired or was revoked: sign in again. */
  | 'session_expired'
  /** Any other failure: code, safe message, correlation reference, recovery action. */
  | 'error';

export function presentationForError(error: unknown): ErrorPresentation {
  if (!(error instanceof ApiError)) return 'error';
  if (error.kind === 'update_required') return 'update_required';
  if (error.isAuthenticationRequired) return 'session_expired';
  if (error.isNotFound || error.isPermissionRestriction) return 'unavailable';
  if (error.isOffline) return 'offline';
  return 'error';
}

export interface RecoveryAction {
  /** The API's `nextAction` (or the client's, for client-side failures). */
  nextAction: string;
  /** Button or instruction text. */
  label: string;
  /** Whether repeating the same request (same intent, same key) is the action. */
  retry: boolean;
}

/** Wording for every `nextAction` the API sends (packages/contracts ErrorCodes) and the client's own. */
export const RECOVERY_ACTION_LABELS: Readonly<Record<string, { label: string; retry: boolean }>> = {
  authenticate: { label: 'Sign in again', retry: false },
  contact_support_or_request_access: { label: 'Contact support', retry: false },
  request_participant_authority: { label: 'Request access', retry: false },
  verify_reference: { label: 'Check the link', retry: false },
  correct_input: { label: 'Review your entries', retry: false },
  review_eligibility_reasons: { label: 'Review eligibility', retry: false },
  complete_acknowledgment: { label: 'Complete required forms', retry: false },
  join_waitlist_or_choose_alternative: { label: 'See alternatives', retry: false },
  review_existing_participation: { label: 'Review existing registration', retry: false },
  resolve_conflict: { label: 'Resolve the conflict', retry: false },
  reload_and_retry: { label: 'Reload', retry: false },
  reload_current_state: { label: 'Reload', retry: false },
  request_new_quote: { label: 'Get a new price', retry: false },
  use_new_idempotency_key: { label: 'Start again', retry: false },
  retry_later_with_same_key: { label: 'Try again', retry: true },
  await_reconciliation: {
    label: 'Do not pay again. The outcome is being confirmed.',
    retry: false,
  },
  await_refund_resolution: { label: 'A refund is pending', retry: false },
  retry_later: { label: 'Try again', retry: true },
  retry_or_contact_support: { label: 'Try again', retry: true },
  retry_when_online: { label: 'Try again', retry: true },
  retry_with_same_key: { label: 'Try again', retry: true },
  update_app: { label: 'Update the app', retry: false },
  contact_support: { label: 'Contact support', retry: false },
};

export function recoveryActionFor(error: unknown): RecoveryAction {
  if (!(error instanceof ApiError)) {
    return { nextAction: 'retry_or_contact_support', label: 'Try again', retry: true };
  }
  const known = RECOVERY_ACTION_LABELS[error.nextAction];
  if (known) return { nextAction: error.nextAction, ...known };
  return {
    nextAction: error.nextAction,
    label: error.retryable ? 'Try again' : 'Contact support',
    retry: error.retryable,
  };
}
