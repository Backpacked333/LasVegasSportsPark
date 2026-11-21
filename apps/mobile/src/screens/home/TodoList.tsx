/**
 * Home "To do" rows (redesign handoff 1b, 3a; INTERACTIONS 1b rows 6 to 8): one card of rows,
 * each with a tinted icon tile, the thing, who it is for with a glyph and a word, and the action
 * that does it in place ("Pay $120", "Sign", "Answer"). A row that was just done shows "✓ Paid" /
 * "✓ Signed" / "✓ Joined" on a green tint for 3 s, then leaves the list (`DONE_FLASH_MS`); the
 * header count drops with it. Offline, every action is disabled and the rows say why (3f).
 *
 * Registrations that need something and the inbox's other action notices follow in the same card
 * (the existing rows, SPK-UX-003 order), so nothing the family must do is only in the inbox.
 */
import type { ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import type { TodoItem } from '../../features/home/todo';
import { formatDay } from '../../features/today/time';
import { Icon } from '../../ui/Icon';
import type { StatusTone } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { fonts, layout, makeStyles, radius, spacing, useTheme } from '../../ui/theme';

/** How long a done row stays with its ✓ (handoff 3a). */
export const DONE_FLASH_MS = 3_000;

export interface DoneRow {
  item: TodoItem;
  /** "✓ Paid". */
  label: string;
  /** "Maya · $120 paid · receipt in Payments". */
  line: string;
}

const TILES: Readonly<Record<TodoItem['kind'], { icon: string; tone: StatusTone }>> = {
  pay: { icon: 'payments', tone: 'warning' },
  sign: { icon: 'signature', tone: 'warning' },
  join: { icon: 'group_add', tone: 'info' },
};

const ACTION_HINTS: Readonly<Record<TodoItem['kind'], string>> = {
  pay: 'Opens the payment sheet',
  sign: 'Opens the form to sign',
  join: 'Opens the invitation',
};

export function todoLine(
  item: TodoItem,
  who: string,
  zone: string,
  context: string | null,
): string {
  switch (item.kind) {
    case 'pay':
      return `${who} · ▲ due ${formatDay(item.obligation.dueAt, zone)}`;
    case 'sign':
      return `${who} · ▲ ${context ? `before ${context}` : 'needed to check in'}`;
    default:
      return `${who} · ℹ invited to the team`;
  }
}

export function actionLabel(item: TodoItem): string {
  switch (item.kind) {
    case 'pay':
      return `Pay ${item.amount}`;
    case 'sign':
      return 'Sign';
    default:
      return 'Answer';
  }
}

export function TodoRow({
  item,
  line,
  onAct,
  disabled,
  first,
  done,
}: {
  item: TodoItem;
  line: string;
  onAct: () => void;
  disabled: boolean;
  first: boolean;
  done?: DoneRow | null;
}) {
  const styles = useStyles();
  const { colors, toneBackgrounds } = useTheme();
  const tile = done ? { icon: 'check', tone: 'success' as const } : TILES[item.kind];
  const label = actionLabel(item);
  return (
    <View
      style={[styles.row, first ? null : styles.divider, done ? styles.doneRow : null]}
      testID={`todo-${item.id}`}
    >
      <View
        style={[
          styles.tile,
          { backgroundColor: done ? colors.primary : toneBackgrounds[tile.tone] },
        ]}
      >
        <Icon name={tile.icon} size={20} color={done ? colors.primaryText : colors[tile.tone]} />
      </View>
      <View
        style={styles.words}
        accessible
        accessibilityLabel={`${item.title}. ${done ? done.line : line}`}
      >
        <Text variant="callout" style={styles.title}>
          {item.title}
        </Text>
        <Text variant="footnote" tone={done ? 'accent' : 'muted'}>
          {done ? done.line : line}
        </Text>
      </View>
      {done ? (
        <Text
          variant="callout"
          tone="accent"
          style={styles.doneLabel}
          testID={`todo-done-${item.id}`}
        >
          {done.label}
        </Text>
      ) : (
        <Pressable
          onPress={onAct}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${label}, ${item.title}`}
          accessibilityHint={ACTION_HINTS[item.kind]}
          accessibilityState={{ disabled }}
          style={({ pressed }) => [
            styles.action,
            item.kind === 'pay' ? styles.primary : styles.tonal,
            pressed ? styles.pressed : null,
            disabled ? styles.disabled : null,
          ]}
          testID={`todo-act-${item.id}`}
        >
          <Text
            style={[
              styles.actionText,
              item.kind === 'pay' ? styles.primaryText : styles.tonalText,
              disabled ? styles.disabledText : null,
            ]}
          >
            {label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

export function TodoCard({ children, testID }: { children: ReactNode; testID?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.card} accessibilityRole="list" testID={testID}>
      {children}
    </View>
  );
}

const useStyles = makeStyles(({ colors, toneBackgrounds }) => ({
  card: {
    marginHorizontal: layout.gutter,
    paddingHorizontal: 14,
    paddingVertical: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md },
  divider: { borderTopWidth: 1, borderTopColor: colors.divider },
  doneRow: {
    backgroundColor: toneBackgrounds.success,
    marginHorizontal: -14,
    paddingHorizontal: 14,
  },
  tile: {
    width: 38,
    height: 38,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  words: { flex: 1, gap: 1 },
  title: { ...fonts.bold },
  action: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.primary },
  tonal: { backgroundColor: colors.tonal },
  pressed: { opacity: 0.8 },
  disabled: { backgroundColor: colors.surface },
  actionText: { ...fonts.semibold, fontSize: 14, lineHeight: 18 },
  primaryText: { color: colors.primaryText, fontVariant: ['tabular-nums'] },
  tonalText: { color: colors.onTonal },
  disabledText: { color: colors.textMuted },
  doneLabel: { ...fonts.semibold },
}));
