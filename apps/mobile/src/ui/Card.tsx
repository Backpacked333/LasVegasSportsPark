/**
 * Cards of the park system: the card surface on the page with a line border (`Card`), the night
 * pitch hero (`Card tone="night"`), and a titled section card (`SectionCard`) whose title is an
 * uppercase eyebrow announced as a header. Rows and state views inside a card are drawn flat
 * (`ListRowLayout`), and a section card inside another card loses its own frame, so cards never
 * nest visually. Corners are continuous where the platform draws them; colours follow the theme.
 *
 * v2 (ADR-008):
 * - `elevation` draws the card on one of the elevation levels (`card`, `raised`, `sheet`, `bar`)
 *   instead of the line border: a shadow on classic, a lighter surface with a hairline in Legends
 *   mode. Without it a card looks exactly as before.
 * - `onPress` makes the whole card one button (SPK-UX-009): one focusable element, named by
 *   `accessibilityLabel` or else by the words inside it, with a disabled state. A pressed card
 *   shrinks slightly (`motionTokens.pressScale`, through `PressableScale`) only when motion is not
 *   reduced, and always shows the soft pressed fill, so the feedback never depends on motion.
 */
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ListRowLayout, useRowLayout } from './ListRow';
import { useMotion } from './motion';
import { PressableScale } from './PressableScale';
import {
  continuousCorners,
  elevation as elevationStyle,
  makeStyles,
  MIN_TOUCH_SIZE,
  motionTokens,
  radius,
  spacing,
  type,
  useTheme,
  type ElevationLevel,
} from './theme';

export interface CardProps {
  children: ReactNode;
  tone?: 'default' | 'night';
  /** Draw the default card on an elevation level instead of its line border. */
  elevation?: ElevationLevel;
  /** The whole card is one button. */
  onPress?: () => void;
  /** Name of a pressable card; the words inside it by default. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Card({
  children,
  tone = 'default',
  elevation,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  testID,
}: CardProps) {
  const theme = useTheme();
  const styles = useStyles();
  const motion = useMotion();
  const nested = useRowLayout() === 'flat';
  const frame: StyleProp<ViewStyle> =
    tone === 'night'
      ? styles.night
      : nested
        ? styles.nested
        : elevation
          ? [styles.elevated, elevationStyle(theme, elevation)]
          : styles.card;
  const content = <ListRowLayout layout="flat">{children}</ListRowLayout>;
  if (onPress) {
    // PressableScale springs the card to the press scale while motion is on; the pressed style
    // names the same scale (what the card settles at), and the animated style drawn after it wins.
    return (
      <PressableScale
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={onPress}
        android_ripple={tone === 'night' ? undefined : { color: theme.colors.surface }}
        style={({ pressed }) => [
          frame,
          styles.inner,
          styles.pressable,
          pressed && tone !== 'night' && styles.pressed,
          pressed && !motion.reduced && styles.scaled,
          disabled && styles.disabled,
          style,
        ]}
        testID={testID}
      >
        {content}
      </PressableScale>
    );
  }
  return (
    <View style={[frame, styles.inner, style]} testID={testID}>
      {content}
    </View>
  );
}

/** Uppercase section label ("FOR YOU TO KNOW"), announced as a header; muted unless `color` is set. */
export function Eyebrow({
  children,
  color,
  testID,
}: {
  children: string;
  color?: string;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  return (
    <Text
      style={[styles.eyebrow, { color: color ?? colors.textMuted }]}
      accessibilityRole="header"
      testID={testID}
    >
      {children}
    </Text>
  );
}

export function SectionCard({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <Card testID={testID}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </Card>
  );
}

const useStyles = makeStyles(({ colors, dark }) => ({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.border,
  },
  elevated: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    borderRadius: radius.lg,
    ...continuousCorners,
  },
  nested: { paddingVertical: spacing.sm },
  night: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.night,
    borderRadius: radius.xl,
    ...continuousCorners,
    // A hairline keeps the band's edge on a page that is itself dark (Legends mode).
    borderWidth: 1,
    borderColor: dark ? colors.nightLine : colors.night,
  },
  inner: { gap: spacing.sm },
  pressable: { minHeight: MIN_TOUCH_SIZE, overflow: 'hidden' },
  pressed: { backgroundColor: colors.surface },
  scaled: { transform: [{ scale: motionTokens.pressScale }] },
  disabled: { opacity: 0.5 },
  eyebrow: { ...type.eyebrow },
}));
