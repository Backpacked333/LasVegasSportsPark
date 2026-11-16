/**
 * Disclosure: a fold that shows more when the person asks (ADR-008). Its heading is one button
 * with the fold's title as its name and the fold's state as `expanded` (SPK-UX-009), at least
 * 44 pt tall; the chevron points down when closed and up when open. The content is not rendered
 * while closed, so screen readers never reach it by accident.
 *
 * Opening and closing animate the layout over the `base` duration only when motion is not reduced
 * (`useMotion()`); otherwise the content appears and goes at once.
 *
 * Uncontrolled by default (`defaultExpanded`); pass `expanded` and `onToggle` to control it.
 * `size="sm"` is the quiet variant used by `SupportDetails`.
 */
import { useState, type ReactNode } from 'react';
import {
  LayoutAnimation,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Icon } from './Icon';
import { useMotion } from './motion';
import { fonts, makeStyles, MIN_TOUCH_SIZE, spacing, type, useTheme } from './theme';

export interface DisclosureProps {
  title: string;
  children: ReactNode;
  defaultExpanded?: boolean;
  /** Controlled state; with it, `onToggle` decides. */
  expanded?: boolean;
  onToggle?: (expanded: boolean) => void;
  size?: 'sm' | 'md';
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Disclosure({
  title,
  children,
  defaultExpanded = false,
  expanded: controlled,
  onToggle,
  size = 'md',
  accessibilityHint,
  style,
  testID,
}: DisclosureProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const motion = useMotion();
  const [own, setOwn] = useState(defaultExpanded);
  const expanded = controlled ?? own;
  const toggle = () => {
    const next = !expanded;
    if (!motion.reduced) {
      LayoutAnimation.configureNext(
        LayoutAnimation.create(motion.duration('base'), 'easeInEaseOut', 'opacity'),
      );
    }
    if (controlled === undefined) setOwn(next);
    onToggle?.(next);
  };
  const small = size === 'sm';
  return (
    <View style={style} testID={testID}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityHint={accessibilityHint}
        accessibilityState={{ expanded }}
        onPress={toggle}
        hitSlop={small ? { left: spacing.sm, right: spacing.sm } : undefined}
        style={({ pressed }) => [styles.heading, pressed && styles.pressed]}
      >
        <Text style={small ? styles.titleSmall : styles.title}>{title}</Text>
        <Icon
          name={expanded ? 'expand_less' : 'expand_more'}
          size={small ? 18 : 22}
          color={small ? colors.textMuted : colors.text}
        />
      </Pressable>
      {expanded ? <View style={styles.content}>{children}</View> : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  heading: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
  },
  pressed: { opacity: 0.6 },
  title: { ...type.body, ...fonts.semibold, color: colors.text, flexShrink: 1 },
  titleSmall: { ...type.footnote, ...fonts.semibold, color: colors.textMuted, flexShrink: 1 },
  content: { gap: spacing.xs, paddingBottom: spacing.xs },
}));
