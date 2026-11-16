/**
 * "Updated 4 minutes ago" for every list and record (SPK-UX-008 stale version, §4.15 cached-data age).
 */
import { formatAge } from '@sportspark/api-client';
import { Text } from 'react-native';
import { makeStyles, spacing, type } from './theme';

export function LastUpdated({ at, now }: { at: Date | null; now: Date }) {
  const styles = useStyles();
  if (!at) return null;
  const phrase = `Updated ${formatAge(at, now)}`;
  return (
    <Text style={styles.text} accessibilityLabel={phrase} testID="last-updated">
      {phrase}
    </Text>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  text: {
    ...type.caption,
    color: colors.textMuted,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
}));
