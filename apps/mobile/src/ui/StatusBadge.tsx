/**
 * StatusBadge: text plus a glyph, never colour alone (SPK-UX-009, SPK-UX-004 "Payment
 * processing", "awaiting placement" and "confirmed" must not look interchangeable). The label is
 * the full status phrase from docs/package-a/journeys.md section 3 and is what screen readers read.
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, spacing, type } from './theme';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral' | 'pending';

/** One distinct shape per tone, so tones differ in greyscale and for colour-blind users. */
export const STATUS_GLYPHS: Record<StatusTone, string> = {
  success: '✓',
  warning: '▲',
  danger: '✕',
  info: 'ℹ',
  neutral: '●',
  pending: '◷',
};

export interface StatusBadgeProps {
  tone: StatusTone;
  /** The full status phrase, e.g. "Payment processing" or "Confirmed, awaiting placement". */
  label: string;
  testID?: string;
}

export function StatusBadge({ tone, label, testID }: StatusBadgeProps) {
  return (
    <View
      style={[styles.badge, { borderColor: colors[tone] }]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      testID={testID}
    >
      <Text
        style={[styles.glyph, { color: colors[tone] }]}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {STATUS_GLYPHS[tone]}
      </Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderWidth: 1.5,
    borderRadius: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    gap: spacing.xs,
  },
  glyph: { ...type.caption, fontWeight: '700' },
  label: { ...type.caption, color: colors.text, flexShrink: 1 },
});
