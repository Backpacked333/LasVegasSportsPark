/**
 * OutcomeLost: the IDEMPOTENCY_OUTCOME_UNAVAILABLE answer (§4.9, SPK-UX-008), shown by every shared
 * failure view (account `CommandError`, teams and money `CommandFailure`, registration
 * `CommandError`).
 *
 * The answer comes when the same request is sent again under the same key ("Check again" after a
 * lost answer) and an earlier attempt committed changes but its response was never recorded: the
 * API will not run it again and cannot say what it returned (next action `reload_current_state`).
 * So it is neither "Something went wrong" nor "Not done": it reads "This may already have been
 * done", and "Reload" reads every API record and list on screen again, which shows what the command
 * changed. It never calls a screen's stale-version reload, which may end the intent: nothing is
 * sent again from here, and the key is kept (`keepsIntentAfterFailure`), so an unchanged
 * resubmission gets this answer again instead of running under a new key.
 */
import type { ApiError } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';
import { colors, spacing, type } from './theme';

export const OUTCOME_LOST_LABEL = 'This may already have been done';

export function OutcomeLost({
  error,
  what,
  testID = 'command-outcome-lost',
}: {
  error: ApiError;
  /** What the command was, for the wording: "the cancellation". Default: "this". */
  what?: string;
  testID?: string;
}) {
  const queryClient = useQueryClient();
  // Every API read on screen (the record, the list, a payment's state) is read again.
  const reload = () => void queryClient.invalidateQueries({ queryKey: ['api'] });
  return (
    <View style={styles.box} accessibilityLiveRegion="polite" testID={testID}>
      <StatusBadge tone="warning" label={OUTCOME_LOST_LABEL} />
      <Text style={styles.body}>
        {`Your earlier request reached the service and changed something, but its answer was lost, so ${what ?? 'this'} may already have been done. Reload to see where it stands; it is not sent again.`}
      </Text>
      <Text style={styles.caption} selectable>
        {`Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
      </Text>
      <Button
        label="Reload"
        variant="secondary"
        onPress={reload}
        accessibilityHint="Reads what is shown here again"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
