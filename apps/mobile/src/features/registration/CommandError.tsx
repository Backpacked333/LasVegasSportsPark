/**
 * How a failed registration command is shown (SPK-UX-008, §4.10): the API's code, safe message,
 * correlation reference and the recovery its `nextAction` permits. The user's input stays on the
 * screen (recoverable failures preserve valid input).
 *
 * - Protected NOT_FOUND, ACCESS_DENIED and PARTICIPANT_AUTHORITY_REQUIRED read as "not available";
 *   nothing says the record exists (§4.10, §4.14).
 * - No definite answer (`mayHaveTakenEffect`: no connection or no answer after sending,
 *   IDEMPOTENCY_IN_PROGRESS, INTERNAL_ERROR or another 5xx): the command may or may not have taken
 *   effect, so it reads "No answer yet: this may already have been recorded" (warning, never
 *   "Something went wrong") and "Check again" repeats the same intent with the same idempotency
 *   key (§4.9), so nothing happens twice. PAYMENT_OUTCOME_UNKNOWN reads "Payment outcome being
 *   confirmed. Do not pay again." with the API's next action (await reconciliation); the payment
 *   screens also show it themselves (SPK-PAY-007).
 * - IDEMPOTENCY_OUTCOME_UNAVAILABLE (`tookEffectOutcomeLost`: an earlier attempt committed, its
 *   answer lost): "This may already have been done" with "Reload" (`ui/OutcomeLost`: every API
 *   record on screen is read again).
 * - ELIGIBILITY_FAILED lists the API's reasons and permitted alternatives (SPK-REG-002).
 */
import { presentationForError, recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import { mayHaveTakenEffect, tookEffectOutcomeLost } from '../../api/command-outcome';
import { Button } from '../../ui/Button';
import { OutcomeLost } from '../../ui/OutcomeLost';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

export interface CommandErrorProps {
  error: ApiError | null;
  /** Repeat the same intent with the same key (retryable codes, no connection, timeout). */
  onRetry?: () => void;
  /** STALE_REVISION, INVALID_TRANSITION: read the current record again. */
  onReload?: () => void;
  /** QUOTE_EXPIRED: get a new price. */
  onRequote?: () => void;
  /** MISSING_ACKNOWLEDGMENT: open the required forms. */
  onCompleteForms?: () => void;
  /** CAPACITY_UNAVAILABLE: show the waitlist or other alternatives. */
  onAlternatives?: () => void;
  testID?: string;
}

const PERMISSION_TEXT: Record<string, string> = {
  PARTICIPANT_AUTHORITY_REQUIRED:
    'Your account does not have the permission this needs for this participant. The person who manages their account can give you access.',
  ACCESS_DENIED: 'This is not available to your account.',
};

interface ReasonDetails {
  reasons?: { message?: unknown }[];
  alternatives?: { message?: unknown }[];
}

function messagesOf(list: { message?: unknown }[] | undefined): string[] {
  return (list ?? [])
    .map((r) => r.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
}

export function CommandError({
  error,
  onRetry,
  onReload,
  onRequote,
  onCompleteForms,
  onAlternatives,
  testID = 'command-error',
}: CommandErrorProps) {
  if (!error) return null;
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    return (
      <View testID={testID}>
        <StateView variant="unavailable" description={PERMISSION_TEXT[error.code] ?? undefined} />
      </View>
    );
  }
  if (tookEffectOutcomeLost(error)) {
    return (
      <View testID={testID}>
        <OutcomeLost error={error} />
      </View>
    );
  }
  const recovery = recoveryActionFor(error);
  if (mayHaveTakenEffect(error)) {
    const payment = error.code === 'PAYMENT_OUTCOME_UNKNOWN';
    return (
      <View testID={testID}>
        <View style={styles.box} accessibilityLiveRegion="polite" testID="command-no-answer">
          <StatusBadge
            tone="warning"
            label={
              payment
                ? 'Payment outcome being confirmed. Do not pay again.'
                : 'No answer yet: this may already have been recorded'
            }
          />
          <Text style={styles.body}>
            {payment
              ? error.message
              : 'There was no definite answer, so this may already have gone through. Checking again is safe: it sends the same request, so nothing happens twice.'}
          </Text>
          <Text style={styles.caption} selectable>
            {`Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
          </Text>
          {recovery.retry && onRetry ? (
            <Button label="Check again" onPress={onRetry} />
          ) : (
            <Text style={styles.body}>{recovery.label}</Text>
          )}
        </View>
      </View>
    );
  }
  const action = (() => {
    switch (error.nextAction) {
      case 'reload_and_retry':
      case 'reload_current_state':
        return onReload;
      case 'request_new_quote':
        return onRequote;
      case 'complete_acknowledgment':
        return onCompleteForms;
      case 'join_waitlist_or_choose_alternative':
      case 'review_eligibility_reasons':
        return onAlternatives;
      default:
        return undefined;
    }
  })();
  const details = (error.details ?? {}) as ReasonDetails;
  const reasons = error.code === 'ELIGIBILITY_FAILED' ? messagesOf(details.reasons) : [];
  const alternatives = error.code === 'ELIGIBILITY_FAILED' ? messagesOf(details.alternatives) : [];
  return (
    <View testID={testID}>
      <StateView
        variant="error"
        error={error}
        onRetry={recovery.retry ? onRetry : undefined}
        onAction={recovery.retry ? undefined : action}
      />
      {reasons.length > 0 ? (
        <View style={styles.list} accessibilityRole="list">
          {reasons.map((reason) => (
            <Text key={reason} style={styles.item}>{`✕ ${reason}`}</Text>
          ))}
        </View>
      ) : null}
      {alternatives.length > 0 ? (
        <View style={styles.list} accessibilityRole="list">
          <Text style={styles.label}>What you can do instead</Text>
          {alternatives.map((alternative) => (
            <Text key={alternative} style={styles.item}>{`→ ${alternative}`}</Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.xs },
  label: { ...type.body, fontWeight: '600', color: colors.text },
  item: { ...type.body, color: colors.text },
});
