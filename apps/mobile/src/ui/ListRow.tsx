/**
 * Accessible list row (SPK-UX-009): one focusable element whose label reads title, detail and
 * status together, in that order; a button role only when the row does something.
 *
 * Look: on a screen, each row is its own white card with a line border (`RowLayout` "card", the
 * default); inside a card that already frames its content (the feature `Section` cards), rows are
 * flat with a divider between them (`RowLayout` "flat", set by `ListRowLayout`), and none above
 * the first row of a group (the row at the top of its parent, found from its layout). An optional
 * decorative `icon` tile and `accent` stripe (an activity kind's colour) sit on the left; the words
 * always say what they mean. A row that opens something shows a chevron and answers a touch at
 * once: the soft surface fill while pressed (and the platform ripple on Android), no animation.
 * Colours follow the theme.
 *
 * v2 (ADR-008) adds, all optional and all read in the row's one label: a decorative initials
 * `avatar` (the name is the title), a `subtitle` (`detail` stays as its alias), a trailing `value`
 * in tabular figures ("$40.00", "6:30 pm"), a `badge` count with its words ("3 new"), and
 * `chevron` to show or hide the chevron explicitly. The label reads title, subtitle, value,
 * status, badges, count.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';
import { Avatar, type AvatarPerson } from './Avatar';
import { CountBadge } from './CountBadge';
import { Icon } from './Icon';
import { StatusBadge, type StatusBadgeProps } from './StatusBadge';
import {
  continuousCorners,
  fonts,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from './theme';

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
  /** The line under the title. */
  subtitle?: string;
  /** Alias of `subtitle` (kept for existing rows); `subtitle` wins when both are given. */
  detail?: string;
  /**
   * What screen readers hear in place of the line under the title, when the screen shows part of
   * it elsewhere in the row (a calendar row's start time drawn large on the left). Default: the line.
   */
  spokenDetail?: string;
  /** A short value on the right ("$40.00", "6:30 pm"), in tabular figures. */
  value?: string;
  /** A count on the right (unread, waiting); nothing for 0. */
  badge?: number;
  /** The count's words in the label; "{badge} new" by default. */
  badgeLabel?: string;
  /** A decorative initials avatar before the text (the title names the person). */
  avatar?: AvatarPerson;
  /** Show or hide the chevron; by default shown on a row that opens something without `trailing`. */
  chevron?: boolean;
  status?: StatusBadgeProps;
  /** Further labelled pills after the status (e.g. a promotion), read after it. */
  badges?: readonly StatusBadgeProps[];
  onPress?: () => void;
  accessibilityHint?: string;
  trailing?: ReactNode;
  /** Decorative Material Symbols name shown in a tinted tile. */
  icon?: string;
  /** Tile colours: `[background, foreground]`; the soft surface with the text colour by default. */
  iconTone?: readonly [string, string];
  /** A stripe on the left edge, e.g. the activity kind's colour. */
  accent?: string;
  /** Content before the text, e.g. a schedule row's start time (part of the row's label). */
  leading?: ReactNode;
  testID?: string;
}

export function ListRow({
  title,
  subtitle,
  detail: detailAlias,
  spokenDetail,
  value,
  badge,
  badgeLabel,
  avatar,
  chevron,
  status,
  badges = [],
  onPress,
  accessibilityHint,
  trailing,
  icon,
  iconTone,
  accent,
  leading,
  testID,
}: ListRowProps) {
  const { colors } = useTheme();
  const styles = useStyles();
  const layout = useContext(RowLayoutContext);
  const [firstInGroup, setFirstInGroup] = useState(false);
  const [tileColor, tileIconColor] = iconTone ?? [colors.surface, colors.text];
  const detail = subtitle ?? detailAlias;
  const count = badge !== undefined && badge > 0 ? badge : null;
  const label = [
    title,
    spokenDetail ?? detail,
    value,
    status?.label,
    ...badges.map((b) => b.label),
    count !== null ? (badgeLabel ?? `${count} new`) : null,
  ]
    .filter(Boolean)
    .join(', ');
  const showChevron = chevron ?? Boolean(onPress && !trailing);
  const content = (
    <>
      {accent ? <View style={[styles.accent, { backgroundColor: accent }]} /> : null}
      {leading}
      {avatar ? <Avatar name={avatar.name} id={avatar.id} decorative /> : null}
      {icon ? (
        <View style={[styles.tile, { backgroundColor: tileColor }]}>
          <Icon name={icon} size={20} color={tileIconColor} />
        </View>
      ) : null}
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {status ? <StatusBadge {...status} /> : null}
        {badges.map((badge) => (
          <StatusBadge key={badge.label} {...badge} />
        ))}
      </View>
      {value ? <Text style={styles.value}>{value}</Text> : null}
      {count !== null ? <CountBadge count={count} style={styles.count} /> : null}
      {trailing}
      {showChevron ? <Icon name="chevron_right" size={22} color={colors.primary} /> : null}
    </>
  );
  const frame = layout === 'card' ? styles.card : styles.flat;
  // A flat row draws the divider above it, except the first row of its group: the card's own
  // edge is already there, so no line is drawn above the first row (ADR-008).
  const noDivider = layout === 'flat' && firstInGroup ? styles.firstFlat : null;
  const onLayout =
    layout === 'flat'
      ? (event: LayoutChangeEvent) => setFirstInGroup(event.nativeEvent.layout.y < 1)
      : undefined;
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        android_ripple={{ color: colors.surface }}
        style={({ pressed }) => [styles.row, frame, noDivider, pressed && styles.pressed]}
        onLayout={onLayout}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View
      style={[styles.row, frame, noDivider]}
      onLayout={onLayout}
      accessible
      accessibilityLabel={label}
      testID={testID}
    >
      {content}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
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
    // A card row is a full touch target even with a one-line title.
    minHeight: 56,
    borderRadius: radius.lg,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.border,
  },
  flat: {
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.divider,
  },
  firstFlat: { borderTopWidth: 0 },
  pressed: { backgroundColor: colors.surface },
  accent: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    ...continuousCorners,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: spacing.xs },
  title: { ...type.body, ...fonts.bold, color: colors.text },
  detail: { ...type.caption, color: colors.textMuted },
  value: { ...tabular(type.callout), color: colors.textMuted, flexShrink: 0, maxWidth: '40%' },
  count: { alignSelf: 'center' },
}));
