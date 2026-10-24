/**
 * How a failed command is shown on SCR-C-33 to SCR-C-35 (SPK-UX-008, §4.10):
 *
 * - Permission restriction (ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED) and protected
 *   NOT_FOUND read as "not available", never as "exists but denied".
 * - Stale version (STALE_REVISION, INVALID_TRANSITION): the record changed; "Reload" shows the
 *   current state and the user's input is kept by the screen.
 * - No answer (timeout, lost connection): the change may have been made. "Check again" repeats
 *   the same intent with the same idempotency key, so it can never apply twice (§4.9).
 * - Anything else: the API's safe message, error code, reference and permitted next action.
 *
 * Payment uncertainty (PAYMENT_OUTCOME_UNKNOWN) is shown by the payment screen itself, never here
 * as a plain failure (SPK-PAY-007).
 */
import { recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

export interface CommandFailureProps {
  error: ApiError;
  /** Repeat the same intent (same idempotency key). */
  onRetry?: () => void;
  /** Reload the record after a stale version. */
  onReload?: () => void;
  /** What the command was, for the wording: "the cancellation". */
  what: string;
}

export function CommandFailure({ error, onRetry, onReload, what }: CommandFailureProps) {
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
  if (error.isOffline) {
    return (
      <View style={styles.box} accessibilityLiveRegion="polite" testID="command-no-answer">
        <StatusBadge tone="warning" label="No answer yet" />
        <Text style={styles.body}>
          We did not get an answer about {what}. It may already have been made. Checking again is
          safe: it cannot apply {what} twice.
        </Text>
        <Text style={styles.caption}>Error code: {error.code}</Text>
        {onRetry ? <Button label="Check again" onPress={onRetry} /> : null}
      </View>
    );
  }
  if (error.isStale) {
    return (
      <View style={styles.box} accessibilityLiveRegion="polite" testID="command-stale">
        <StatusBadge tone="warning" label="This changed since you opened it" />
        <Text style={styles.body}>{error.message}</Text>
        <Text style={styles.caption}>
          Error code: {error.code}
          {error.correlationId ? `. Reference: ${error.correlationId}` : ''}
        </Text>
        {onReload ? <Button label="Reload" onPress={onReload} /> : null}
      </View>
    );
  }
  // A retryable failure repeats the same intent; otherwise the permitted next action is shown as
  // the instruction ("Review eligibility", "Contact support").
  const recovery = recoveryActionFor(error);
  return <StateView variant="error" error={error} onRetry={recovery.retry ? onRetry : undefined} />;
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
