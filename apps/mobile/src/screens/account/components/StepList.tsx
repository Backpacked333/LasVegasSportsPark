/**
 * Numbered progress steps (SCR-C-01): each step is read as "Step 2 of 4, Participant record,
 * Linked"; the status is a StatusBadge (glyph and words), never colour alone (SPK-UX-009).
 */
import { StyleSheet, Text, View } from 'react-native';
import { StatusBadge, type StatusBadgeProps } from '../../../ui/StatusBadge';
import { colors, spacing, type } from '../../../ui/theme';

export interface Step {
  title: string;
  status: StatusBadgeProps;
}

export function StepList({ steps, label }: { steps: readonly Step[]; label: string }) {
  return (
    <View style={styles.list} accessibilityRole="list" accessibilityLabel={label}>
      {steps.map((step, index) => (
        <View
          key={step.title}
          style={styles.row}
          accessible
          accessibilityLabel={`Step ${index + 1} of ${steps.length}, ${step.title}, ${step.status.label}`}
        >
          <Text style={styles.number}>{index + 1}</Text>
          <View style={styles.text}>
            <Text style={styles.title}>{step.title}</Text>
            <StatusBadge {...step.status} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  number: { ...type.heading, color: colors.textMuted, width: 24, textAlign: 'center' },
  text: { flex: 1, gap: spacing.xs },
  title: { ...type.body, fontWeight: '600', color: colors.text },
});
