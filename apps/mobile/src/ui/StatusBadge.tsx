/**
 * StatusBadge: a tinted pill with text plus a glyph, never colour alone (SPK-UX-009, SPK-UX-004 "Payment
 * processing", "awaiting placement" and "confirmed" must not look interchangeable). The label is
 * the full status phrase from docs/package-a/journeys.md section 3 and is what screen readers read.
 */
import { StyleSheet, Text, View } from 'react-native';
import { colors, fonts, radius, toneBackgrounds, type } from './theme';

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
      style={[styles.badge, { backgroundColor: toneBackgrounds[tone] }]}
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
      <Text style={[styles.label, { color: colors[tone] }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    gap: 5,
  },
  glyph: { ...type.caption, ...fonts.extrabold, fontSize: 13, lineHeight: 18 },
  label: { ...type.caption, ...fonts.bold, fontSize: 13, lineHeight: 18, flexShrink: 1 },
});
