/**
 * How a failed registration command is shown (SPK-UX-008, §4.10): the API's code, safe message,
 * correlation reference and the recovery its `nextAction` permits. The user's input stays on the
 * screen (recoverable failures preserve valid input).
 *
 * - Protected NOT_FOUND, ACCESS_DENIED and PARTICIPANT_AUTHORITY_REQUIRED read as "not available";
 *   nothing says the record exists (§4.10, §4.14).
 * - No connection or no answer: the command may or may not have taken effect, so "Try again"
 *   repeats the same intent with the same idempotency key (§4.9) and nothing happens twice.
 * - ELIGIBILITY_FAILED lists the API's reasons and permitted alternatives (SPK-REG-002).
 */
import { presentationForError, recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import { StateView } from '../../ui/StateView';
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
  const recovery = recoveryActionFor(error);
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
  const mayHaveHappened = error.isOffline;
  return (
    <View testID={testID}>
      <StateView
        variant="error"
        error={error}
        onRetry={recovery.retry ? onRetry : undefined}
        onAction={recovery.retry ? undefined : action}
      />
      {mayHaveHappened ? (
        <Text style={styles.note}>
          This may already have gone through. Trying again sends the same request, so nothing
          happens twice.
        </Text>
      ) : null}
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
  note: { ...type.caption, color: colors.textMuted, paddingHorizontal: spacing.lg },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.xs },
  label: { ...type.body, fontWeight: '600', color: colors.text },
  item: { ...type.body, color: colors.text },
});
