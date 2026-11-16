/**
 * An icon-only button (ADR-008 visual system v2, SPK-UX-009): a 44 pt round target whose icon is
 * decorative, so the required `label` is what VoiceOver and TalkBack read ("Notification inbox").
 *
 * An optional `count` (unread notices, items waiting) is folded into that name, "Notification
 * inbox, 3 unread", and drawn as a small badge in the count-badge tokens. The badge itself is
 * hidden from screen readers (the name already says it) and shows "99+" above 99; the name keeps
 * the exact number. No count, or 0, draws no badge and leaves the name as the label.
 *
 * `countCapped`: the count is where the API stopped counting (the inbox's `capped`), so the real
 * number is higher. The name then says "more than": "Notification inbox, more than 99 unread", and
 * the badge "99+".
 *
 * Variants: `plain` (no fill, for headers and rows), `tonal` (a soft accent tint) and `onMedia`
 * (over artwork, on the scrim token). Press feedback and haptics as `Button`: the pressed fill at
 * once, the press scale only with motion on, a light impact when the press lands.
 */
import { StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { PressableScale, type PressHaptic } from './PressableScale';
import {
  MIN_TOUCH_SIZE,
  makeStyles,
  radius,
  spacing,
  tabularFigures,
  type,
  useTheme,
} from './theme';

export type IconButtonVariant = 'plain' | 'tonal' | 'onMedia';

export interface IconButtonProps {
  /** Material Symbols name of the decorative icon. */
  icon: string;
  /** What the button does or opens, read by screen readers ("Notification inbox"). */
  label: string;
  onPress: () => void;
  variant?: IconButtonVariant;
  /** A number to badge: folded into the accessible name. */
  count?: number;
  /** The words after the count in the name (default "unread"): "Cart, 2 items". */
  countLabel?: string;
  /** The count is a cap: there are more than `count` ("more than 99 unread", badge "99+"). */
  countCapped?: boolean;
  disabled?: boolean;
  accessibilityHint?: string;
  /** The haptic a press plays (default a light impact). */
  haptic?: PressHaptic;
  testID?: string;
}

/** The badge text: the count, or "99+" above 99; "{count}+" for a capped count. */
export function badgeText(count: number, capped = false): string {
  if (capped) return `${count}+`;
  return count > 99 ? '99+' : String(count);
}

/**
 * The accessible name: the label, then the count and its words when there is a count ("more than
 * {count}" for a capped one).
 */
export function iconButtonName(
  label: string,
  count?: number,
  countLabel = 'unread',
  capped = false,
): string {
  if (!count || count <= 0) return label;
  return `${label}, ${capped ? `more than ${count}` : count} ${countLabel}`;
}

const useStyles = makeStyles(({ colors }) => ({
  plain: { backgroundColor: 'transparent' },
  plainPressed: { backgroundColor: colors.surface },
  tonal: { backgroundColor: colors.tonal },
  tonalPressed: { opacity: 0.86 },
  onMedia: { backgroundColor: colors.scrimEnd },
  onMediaPressed: { opacity: 0.86 },
  badge: { backgroundColor: colors.countBadge },
  badgeText: { color: colors.onCountBadge },
}));

export function IconButton({
  icon,
  label,
  onPress,
  variant = 'plain',
  count,
  countLabel,
  countCapped = false,
  disabled = false,
  accessibilityHint,
  haptic = 'light',
  testID,
}: IconButtonProps) {
  const { colors } = useTheme();
  const themed = useStyles();
  const iconColor =
    variant === 'tonal' ? colors.onTonal : variant === 'onMedia' ? colors.onMedia : colors.text;
  const pressedStyle: ViewStyle = themed[`${variant}Pressed`];
  const badged = count !== undefined && count > 0;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={iconButtonName(label, count, countLabel, countCapped)}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      haptic={haptic}
      testID={testID}
      style={({ pressed }) => [
        styles.base,
        themed[variant],
        disabled && styles.inactive,
        pressed && pressedStyle,
      ]}
    >
      <Icon name={icon} size={24} color={iconColor} />
      {badged ? (
        <View
          style={[styles.badge, themed.badge]}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          testID={testID ? `${testID}-badge` : undefined}
        >
          <Text style={[styles.badgeText, themed.badgeText]} maxFontSizeMultiplier={1.3}>
            {badgeText(count, countCapped)}
          </Text>
        </View>
      ) : null}
    </PressableScale>
  );
}

const BADGE_SIZE = 18;

const styles = StyleSheet.create({
  base: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inactive: { opacity: 0.5 },
  badge: {
    position: 'absolute',
    top: spacing.xxs,
    right: spacing.xxs,
    minWidth: BADGE_SIZE,
    minHeight: BADGE_SIZE,
    paddingHorizontal: spacing.xs,
    borderRadius: BADGE_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { ...type.micro, fontSize: 11, lineHeight: 14, ...tabularFigures },
});
