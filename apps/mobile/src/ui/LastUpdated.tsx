/**
 * "Updated 4 minutes ago" for every list and record (SPK-UX-008 stale version, §4.15 cached-data age).
 */
import { formatAge } from '@sportspark/api-client';
import { StyleSheet, Text } from 'react-native';
import { colors, spacing, type } from './theme';

export function LastUpdated({ at, now }: { at: Date | null; now: Date }) {
  if (!at) return null;
  const phrase = `Updated ${formatAge(at, now)}`;
  return (
    <Text style={styles.text} accessibilityLabel={phrase} testID="last-updated">
      {phrase}
    </Text>
  );
}

const styles = StyleSheet.create({
  text: {
    ...type.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
});
