/**
 * RefusedBeforeRunning: a command the service refused before running it (`refusedBeforeRunning`:
 * INTEGRATION_UNAVAILABLE with `details.reason` `recovery_mode` or `disabled`, from a kernel guard
 * that answers before the idempotency key is claimed). Shown by every shared failure view (account
 * `CommandError`, teams and money `CommandFailure`, registration `CommandError`) and so by the
 * payment screens (SCR-C-14, SCR-C-25, SCR-C-34) that show their failures through them (§4.9,
 * §4.10 permitted next action, SPK-UX-008, SPK-AT-028, R4-CLIENTS-A11Y-COPY-01).
 *
 * Nothing ran, so it is neither "No answer yet" nor "Payment outcome being confirmed. Do not pay
 * again.": it reads "Not done" with the API's safe message ("Payments are paused while the service
 * recovers from a restore. Try again later.") and says that nothing was changed. "Try again" sends
 * the same request again (the key was never claimed, so it simply runs once the service accepts
 * it); offline it is disabled and says it needs a connection.
 *
 * It is announced to screen readers when it appears (`ui/announce`: a live region on Android, an
 * announcement on iOS), with its next action (SPK-UX-009, NA-A01).
 */
import { recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { StyleSheet, Text } from 'react-native';
import { useConnectivity } from '../providers/AppProviders';
import { LiveRegion, sentences } from './announce';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';
import { colors, spacing, type } from './theme';

export const REFUSED_BEFORE_RUNNING_LABEL = 'Not done';
export const NOTHING_CHANGED_TEXT =
  'Nothing was changed: the service did not run this request, so nothing was paid or recorded.';

export function RefusedBeforeRunning({
  error,
  onRetry,
  testID = 'command-refused-before-running',
}: {
  error: ApiError;
  /** Send the same request again later. */
  onRetry?: () => void;
  testID?: string;
}) {
  const offline = useConnectivity().reachable === false;
  const recovery = recoveryActionFor(error);
  const retry = recovery.retry && onRetry ? onRetry : undefined;
  // NA-A01: the announcement ends with the next action, the button's label or the instruction.
  const nextAction = retry ? recovery.label : recovery.retry ? 'Try again later' : recovery.label;
  return (
    <LiveRegion
      style={styles.box}
      announcement={sentences(
        REFUSED_BEFORE_RUNNING_LABEL,
        error.message,
        NOTHING_CHANGED_TEXT,
        nextAction,
      )}
      occurrence={error}
      testID={testID}
    >
      <StatusBadge tone="danger" label={REFUSED_BEFORE_RUNNING_LABEL} />
      <Text style={styles.body}>{error.message}</Text>
      <Text style={styles.body}>{NOTHING_CHANGED_TEXT}</Text>
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
            accessibilityHint="Sends the request again; the first one was not run"
          />
          {offline ? <Text style={styles.caption}>Needs a connection.</Text> : null}
        </>
      ) : (
        <Text style={styles.body}>{nextAction}</Text>
      )}
    </LiveRegion>
  );
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
