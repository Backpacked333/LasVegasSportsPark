/**
 * RefusedBeforeRunning: a command the service refused before running it (`refusedBeforeRunning`:
 * INTEGRATION_UNAVAILABLE with `details.reason` `recovery_mode` or `disabled`, from a kernel guard
 * that answers before the idempotency key is claimed). Shown by every shared failure view (account
 * `CommandError`, teams and money `CommandFailure`, registration `CommandError`) and by the payment
 * screens (SCR-C-14, SCR-C-15, SCR-C-25, SCR-C-34) (§4.9, §4.10 permitted next action, SPK-UX-008,
 * SPK-AT-028, R4-CLIENTS-A11Y-COPY-01).
 *
 * - A first attempt: nothing ran, so it is neither "No answer yet" nor "Payment outcome being
 *   confirmed. Do not pay again.": it reads "Not done" with the API's safe message ("Payments are
 *   paused while the service recovers from a restore. Try again later.") and says that nothing was
 *   changed. "Try again" sends the same request again (the key was never claimed, so it simply
 *   runs once the service accepts it).
 * - A re-check (`priorUnknown`, by default `refusedAfterNoAnswer`: an earlier attempt under the same
 *   key got no answer, and this check of it was refused): only the check did not run. The guard
 *   answers before the stored outcome is read, so the earlier attempt may still have committed or
 *   charged a card (SPK-PAY-007). It reads "Check not run" with the API's message and that the
 *   earlier attempt (`payment`: the earlier payment) may still have gone through, never "Nothing
 *   was changed"; "Check again" asks again with the same request. The screen keeps its own
 *   "Payment outcome being confirmed. Do not pay again." state and paying blocked beside it.
 *
 * Offline the button is disabled and says it needs a connection. It is announced to screen readers
 * when it appears (`ui/announce`: a live region on Android, an announcement on iOS), with its next
 * action (SPK-UX-009, NA-A01).
 */
import { recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { Text } from 'react-native';
import { refusedAfterNoAnswer } from '../api/command-outcome';
import { useConnectivity } from '../providers/AppProviders';
import { LiveRegion, sentences } from './announce';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';
import { makeStyles, spacing, type } from './theme';

export const REFUSED_BEFORE_RUNNING_LABEL = 'Not done';
export const NOTHING_CHANGED_TEXT =
  'Nothing was changed: the service did not run this request, so nothing was paid or recorded.';
/** A re-check of an attempt that got no answer was refused before running. */
export const CHECK_NOT_RUN_LABEL = 'Check not run';
export const EARLIER_ATTEMPT_OPEN_TEXT =
  'This check could not run now, so the earlier attempt may still have gone through. Check again later before doing it again.';
export const EARLIER_PAYMENT_OPEN_TEXT =
  'This check could not run now; the earlier payment may still have gone through. Do not pay again.';

export function RefusedBeforeRunning({
  error,
  onRetry,
  priorUnknown = refusedAfterNoAnswer(error),
  payment = false,
  testID = 'command-refused-before-running',
}: {
  error: ApiError;
  /** Send the same request again later. */
  onRetry?: () => void;
  /** The refused request re-checked an earlier attempt whose outcome is still unknown. */
  priorUnknown?: boolean;
  /** The earlier attempt was a payment: "Do not pay again". */
  payment?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  const offline = useConnectivity().reachable === false;
  const recovery = recoveryActionFor(error);
  const retry = recovery.retry && onRetry ? onRetry : undefined;
  const label = priorUnknown ? CHECK_NOT_RUN_LABEL : REFUSED_BEFORE_RUNNING_LABEL;
  const explanation = priorUnknown
    ? payment
      ? EARLIER_PAYMENT_OPEN_TEXT
      : EARLIER_ATTEMPT_OPEN_TEXT
    : NOTHING_CHANGED_TEXT;
  // NA-A01: the announcement ends with the next action, the button's label or the instruction.
  const nextAction = priorUnknown
    ? retry
      ? 'Check again'
      : 'Check again later'
    : retry
      ? recovery.label
      : recovery.retry
        ? 'Try again later'
        : recovery.label;
  const hint = priorUnknown
    ? payment
      ? 'Asks about the same payment again; it cannot charge twice'
      : 'Sends the same request again; it is never applied twice'
    : 'Sends the request again; the first one was not run';
  return (
    <LiveRegion
      style={styles.box}
      announcement={sentences(label, error.message, explanation, nextAction)}
      occurrence={error}
      testID={testID}
    >
      <StatusBadge tone={priorUnknown ? 'warning' : 'danger'} label={label} />
      <Text style={styles.body}>{error.message}</Text>
      <Text style={styles.body}>{explanation}</Text>
      <Text style={styles.caption} selectable>
        {`Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
      </Text>
      {retry ? (
        <>
          <Button
            label={nextAction}
            variant="secondary"
            onPress={retry}
            disabled={offline}
            accessibilityHint={hint}
          />
          {offline ? <Text style={styles.caption}>Needs a connection.</Text> : null}
        </>
      ) : (
        <Text style={styles.body}>{nextAction}</Text>
      )}
    </LiveRegion>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
}));
