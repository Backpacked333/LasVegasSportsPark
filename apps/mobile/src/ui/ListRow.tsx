/**
 * Accessible list row (SPK-UX-009): one focusable element whose label reads title, detail and
 * status together, in that order; a button role only when the row does something.
 *
 * Look: on a screen, each row is its own white card with a line border (`RowLayout` "card", the
 * default); inside a card that already frames its content (the feature `Section` cards), rows are
 * flat with a divider between them (`RowLayout` "flat", set by `ListRowLayout`). An optional
 * decorative `icon` tile and `accent` stripe (an activity kind's colour) sit on the left; the words
 * always say what they mean. A row that opens something shows a chevron.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from './Icon';
import { StatusBadge, type StatusBadgeProps } from './StatusBadge';
import { colors, fonts, MIN_TOUCH_SIZE, radius, spacing, type } from './theme';

export type RowLayout = 'card' | 'flat';

const RowLayoutContext = createContext<RowLayout>('card');

/** How rows (and state cards, `StateView`) are drawn here: flat inside a card frame. */
export function useRowLayout(): RowLayout {
  return useContext(RowLayoutContext);
}

/** Sets how the rows below are drawn: inside a card frame they are flat. */
export function ListRowLayout({ layout, children }: { layout: RowLayout; children: ReactNode }) {
  return <RowLayoutContext.Provider value={layout}>{children}</RowLayoutContext.Provider>;
}

export interface ListRowProps {
  title: string;
  detail?: string;
  status?: StatusBadgeProps;
  onPress?: () => void;
  accessibilityHint?: string;
  trailing?: ReactNode;
  /** Decorative Material Symbols name shown in a tinted tile. */
  icon?: string;
  /** Tile colours: `[background, foreground]`. */
  iconTone?: readonly [string, string];
  /** A stripe on the left edge, e.g. the activity kind's colour. */
  accent?: string;
  testID?: string;
}

export function ListRow({
  title,
  detail,
  status,
  onPress,
  accessibilityHint,
  trailing,
  icon,
  iconTone = [colors.surface, colors.text],
  accent,
  testID,
}: ListRowProps) {
  const layout = useContext(RowLayoutContext);
  const label = [title, detail, status?.label].filter(Boolean).join(', ');
  const content = (
    <>
      {accent ? <View style={[styles.accent, { backgroundColor: accent }]} /> : null}
      {icon ? (
        <View style={[styles.tile, { backgroundColor: iconTone[0] }]}>
          <Icon name={icon} size={20} color={iconTone[1]} />
        </View>
      ) : null}
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {status ? <StatusBadge {...status} /> : null}
      </View>
      {trailing}
      {onPress && !trailing ? <Icon name="chevron_right" size={22} color={colors.primary} /> : null}
    </>
  );
  const frame = layout === 'card' ? styles.card : styles.flat;
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        style={({ pressed }) => [styles.row, frame, pressed && styles.pressed]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={[styles.row, frame]} accessible accessibilityLabel={label} testID={testID}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.background,
    overflow: 'hidden',
  },
  card: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  flat: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  pressed: { backgroundColor: colors.surface },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: spacing.xs },
  title: { ...type.body, ...fonts.bold, color: colors.text },
  detail: { ...type.caption, color: colors.textMuted },
});
