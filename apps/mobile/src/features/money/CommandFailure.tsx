/**
 * How a failed command is shown on the money, booking and enrollment screens (SPK-UX-008, §4.9,
 * §4.10): `POST /bookings`, `/bookings/{id}/cancel`, `/enrollments/{id}/renew|cancel|transfer`,
 * `/session-bookings`, `/makeup-entitlements/{id}/redeem`, membership and form commands.
 *
 * - Permission restriction (ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED) and protected
 *   NOT_FOUND read as "not available", never as "exists but denied".
 * - Refused before running (`refusedBeforeRunning`: INTEGRATION_UNAVAILABLE `recovery_mode`, payments
 *   paused while the service recovers from a restore, SPK-AT-028): nothing ran, so it is "Not done"
 *   with the API's message (`ui/RefusedBeforeRunning`), never "No answer yet" although it is a 503.
 * - No definite answer (`mayHaveTakenEffect`: no response after sending, IDEMPOTENCY_IN_PROGRESS,
 *   INTERNAL_ERROR or another 5xx, a success status whose body could not be read
 *   (RESPONSE_UNREADABLE), PAYMENT_OUTCOME_UNKNOWN): the change may have been made, so it is "No
 *   answer yet", never "Something went wrong". "Check again" repeats the same intent with
 *   the same idempotency key, so it can never apply twice (§4.9); where the API's next action is
 *   not a retry (PAYMENT_OUTCOME_UNKNOWN: await reconciliation) that action is shown instead.
 * - An earlier attempt committed and its answer was lost (`tookEffectOutcomeLost`,
 *   IDEMPOTENCY_OUTCOME_UNAVAILABLE): "This may already have been done" with "Reload"
 *   (`ui/OutcomeLost`).
 * - Stale version (STALE_REVISION, INVALID_TRANSITION): the record changed; "Reload" shows the
 *   current state and the user's input is kept by the screen.
 * - Anything else: the API's safe message, error code, reference and permitted next action.
 *
 * Pass `read` for the failure of a read (a GET, such as the transfer preview or the re-read before
 * canceling): it changed nothing, so it is shown as a read that did not load, with "Try again".
 *
 * Every answer is announced to screen readers when it appears (`ui/announce`: a live region on
 * Android, an announcement on iOS), "No answer yet" included, with its next action (SPK-UX-009,
 * NA-A01): "Check again", "Reload", or the instruction the API's next action gives ("Do not pay
 * again. The outcome is being confirmed.").
 */
import { recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { Text } from 'react-native';
import {
  mayHaveTakenEffect,
  refusedBeforeRunning,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { LiveRegion, sentences } from '../../ui/announce';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { OutcomeLost } from '../../ui/OutcomeLost';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { RefusedBeforeRunning } from '../../ui/RefusedBeforeRunning';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { makeStyles, spacing, type } from '../../ui/theme';

const STALE_LABEL = 'This changed since you opened it';

export interface CommandFailureProps {
  error: ApiError;
  /** Repeat the same intent (same idempotency key), or read again for a `read`. */
  onRetry?: () => void;
  /** Reload the record after a stale version (a lost outcome reads every API record again). */
  onReload?: () => void;
  /** What the command was, for the wording: "the cancellation". */
  what: string;
  /** The failure is of a read (a GET), which changes nothing. */
  read?: boolean;
}

export function CommandFailure({
  error,
  onRetry,
  onReload,
  what,
  read = false,
}: CommandFailureProps) {
  // R3-SCREEN-STATES-01: "Check again" needs a connection; offline it neither queues nor fails.
  const styles = useStyles();
  const offline = useConnectivity().reachable === false;
  if (error.isNotFound || error.isPermissionRestriction) {
    return (
      <StateView
        variant="unavailable"
        description={
          error.code === 'PARTICIPANT_AUTHORITY_REQUIRED' || error.code === 'ACCESS_DENIED'
            ? `This is not available to your account. A guardian who holds this permission, or the front desk, can help.`
            : undefined
        }
      />
    );
  }
  if (read) {
    // A read changed nothing: offline is "offline", anything else the API's answer to read again.
    return onRetry ? (
      <QueryErrorView error={error} onRetry={onRetry} />
    ) : (
      <StateView variant="error" error={error} />
    );
  }
  if (tookEffectOutcomeLost(error)) {
    return <OutcomeLost error={error} what={what} />;
  }
  if (refusedBeforeRunning(error)) {
    return <RefusedBeforeRunning error={error} onRetry={onRetry} />;
  }
  const recovery = recoveryActionFor(error);
  if (mayHaveTakenEffect(error)) {
    const body = `We did not get a definite answer about ${what}. It may already have been made. Checking again is safe: it cannot apply ${what} twice.`;
    // NA-A01: announced with the next action, the button's label or the instruction shown.
    const nextAction = recovery.retry && onRetry ? 'Check again' : recovery.label;
    return (
      <LiveRegion
        style={styles.box}
        announcement={sentences('No answer yet', body, nextAction)}
        occurrence={error}
        testID="command-no-answer"
      >
        <StatusBadge tone="warning" label="No answer yet" />
        <Text style={styles.body}>{body}</Text>
        <Text style={styles.caption} selectable>
          Error code: {error.code}
          {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
        </Text>
        {recovery.retry && onRetry ? (
          <>
            <Button label={nextAction} onPress={onRetry} disabled={offline} />
            {offline ? <Text style={styles.caption}>Needs a connection.</Text> : null}
          </>
        ) : (
          <Text style={styles.body}>{nextAction}</Text>
        )}
      </LiveRegion>
    );
  }
  if (error.isStale) {
    return (
      <LiveRegion
        style={styles.box}
        announcement={sentences(STALE_LABEL, error.message, onReload ? 'Reload' : null)}
        occurrence={error}
        testID="command-stale"
      >
        <StatusBadge tone="warning" label={STALE_LABEL} />
        <Text style={styles.body}>{error.message}</Text>
        <Text style={styles.caption}>
          Error code: {error.code}
          {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
        </Text>
        {onReload ? <Button label="Reload" onPress={onReload} /> : null}
      </LiveRegion>
    );
  }
  // A retryable failure repeats the same intent; otherwise the permitted next action is shown as
  // the instruction ("Review eligibility", "Contact support").
  return <StateView variant="error" error={error} onRetry={recovery.retry ? onRetry : undefined} />;
}

const useStyles = makeStyles(({ colors }) => ({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
}));
