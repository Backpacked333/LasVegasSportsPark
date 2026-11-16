/**
 * Eligibility or readiness reasons with who resolves them (SPK-READY-003, SPK-CAP-004), in the
 * visual system v2 (ADR-008, **Proposed**). Each reason shows its status with a glyph and words
 * (`StatusBadge`, never colour alone; SPK-UX-009), the API's message, and "{who}: {what to do}".
 * A rule that needs league approval (`approval_required`) is shown as a pending approval, never as
 * a denial (SCR-C-26). The list is announced as a list.
 *
 * Moved here from `features/teams/ui.tsx`; the teams kit re-exports it. The role and severity
 * words are the team screens' (`features/teams/format`, `features/teams/status`), the only words
 * the app has for them.
 */
import { View } from 'react-native';
import type { EligibilityReason } from '../api/error-details';
import { roleWords } from '../features/teams/format';
import { severityStatus } from '../features/teams/status';
import { StatusBadge, type StatusBadgeProps } from './StatusBadge';
import { Text } from './Text';
import { makeStyles, spacing } from './theme';

export type { EligibilityReason };

/** The badge of one reason: "League approval required" for an approval rule, else its severity. */
export function reasonStatus(
  reason: Pick<EligibilityReason, 'code' | 'severity'>,
): StatusBadgeProps {
  return reason.code === 'approval_required'
    ? { tone: 'pending', label: 'League approval required' }
    : severityStatus(reason.severity);
}

export interface ReasonListProps {
  reasons: readonly EligibilityReason[];
  testID?: string;
}

export function ReasonList({ reasons, testID }: ReasonListProps) {
  const styles = useStyles();
  return (
    <View accessibilityRole="list" style={styles.list} testID={testID}>
      {reasons.map((reason, index) => (
        <View key={`${reason.code}-${index}`} style={styles.reason}>
          <StatusBadge {...reasonStatus(reason)} />
          <Text variant="body">{reason.message}</Text>
          <Text variant="caption" tone="muted">
            {`${roleWords(reason.responsibleRole)}: ${reason.requiredAction}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  list: { gap: spacing.sm },
  reason: { gap: spacing.xs, paddingVertical: spacing.xs },
}));
