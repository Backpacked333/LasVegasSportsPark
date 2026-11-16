/**
 * CountBadge: a small capsule with a count (unread notices, items waiting), in the `countBadge`
 * colours of the theme (ADR-008). Nothing is drawn for 0; above `max` it reads "99+".
 *
 * The count is never carried by the badge alone (SPK-UX-009): the control it sits on folds the
 * count into its own accessible name ("Notification inbox, 3 unread"), so by default the badge is
 * hidden from screen readers and read once, through its parent. A badge that stands on its own
 * passes `accessibilityLabel` and is then read as text.
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { makeStyles, radius, spacing, tabular, type } from './theme';

export interface CountBadgeProps {
  count: number;
  /** Counts above this read "{max}+". */
  max?: number;
  /** Words for a badge read on its own ("3 unread"); without it the badge is hidden. */
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** What the badge shows for a count: nothing for 0 or less, "99+" above the maximum. */
export function countBadgeText(count: number, max = 99): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count > max ? `${max}+` : String(Math.floor(count));
}

export function CountBadge({
  count,
  max = 99,
  accessibilityLabel,
  style,
  testID,
}: CountBadgeProps) {
  const styles = useStyles();
  const text = countBadgeText(count, max);
  if (text === null) return null;
  const standalone = accessibilityLabel !== undefined;
  return (
    <View
      style={[styles.badge, style]}
      accessible={standalone}
      accessibilityRole={standalone ? 'text' : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={!standalone}
      importantForAccessibility={standalone ? 'yes' : 'no-hide-descendants'}
      testID={testID}
    >
      <Text style={styles.text} maxFontSizeMultiplier={1.4}>
        {text}
      </Text>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  badge: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: spacing.xs + 2,
    borderRadius: radius.pill,
    backgroundColor: colors.countBadge,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'flex-start',
  },
  text: { ...tabular(type.micro), color: colors.onCountBadge },
}));
