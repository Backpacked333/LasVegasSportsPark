/**
 * Section: a titled group on a screen (ADR-008): the title (a header for screen readers,
 * SPK-UX-009), an optional action on the right ("See all"), and its content in one of three looks:
 *
 * - `card` (default): the content inside one card, rows drawn flat with dividers (`Card`).
 * - `plain`: the content straight on the page, inside the screen gutter.
 * - `carousel`: the content edge to edge (a `Carousel`, which keeps the gutter itself).
 *
 * The action is a text button at least 44 pt tall. Its name says which section it belongs to
 * ("See all, Upcoming"), so a screen with several sections never has two buttons of the same name.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Card } from './Card';
import {
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  spacing,
  type,
  type ElevationLevel,
} from './theme';

export type SectionVariant = 'card' | 'plain' | 'carousel';

export interface SectionAction {
  label: string;
  onPress: () => void;
  /** The button's name; "{label}, {title}" by default. */
  accessibilityLabel?: string;
  accessibilityHint?: string;
}

export interface SectionProps {
  title: string;
  /** A line under the title. */
  subtitle?: string;
  action?: SectionAction;
  variant?: SectionVariant;
  /** The card's elevation in the `card` variant. */
  elevation?: ElevationLevel;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Section({
  title,
  subtitle,
  action,
  variant = 'card',
  elevation,
  children,
  style,
  testID,
}: SectionProps) {
  const styles = useStyles();
  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.head}>
        <View style={styles.words}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
        </View>
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.accessibilityLabel ?? `${action.label}, ${title}`}
            accessibilityHint={action.accessibilityHint}
            onPress={action.onPress}
            hitSlop={{ left: spacing.sm, right: spacing.sm }}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
          >
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        ) : null}
      </View>
      {variant === 'card' ? (
        <Card elevation={elevation} style={styles.card}>
          {children}
        </Card>
      ) : variant === 'plain' ? (
        <View style={styles.plain}>{children}</View>
      ) : (
        <View>{children}</View>
      )}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: { marginTop: layout.sectionGap - spacing.sm, gap: spacing.sm },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
  },
  words: { flex: 1, gap: spacing.xxs },
  title: { ...type.title3, color: colors.text },
  subtitle: { ...type.footnote, color: colors.textMuted },
  action: { minHeight: MIN_TOUCH_SIZE, justifyContent: 'center' },
  pressed: { opacity: 0.6 },
  actionLabel: { ...type.callout, ...fonts.semibold, color: colors.primary },
  card: { marginHorizontal: layout.gutter, marginVertical: 0 },
  plain: { paddingHorizontal: layout.gutter, gap: layout.cardGap },
}));
