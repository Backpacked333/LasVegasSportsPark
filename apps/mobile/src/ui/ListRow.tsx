/**
 * Accessible list row (SPK-UX-009): one focusable element whose label reads title, detail and
 * status together, in that order; a button role only when the row does something.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBadge, type StatusBadgeProps } from './StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from './theme';

export interface ListRowProps {
  title: string;
  detail?: string;
  status?: StatusBadgeProps;
  onPress?: () => void;
  accessibilityHint?: string;
  trailing?: ReactNode;
  testID?: string;
}

export function ListRow({
  title,
  detail,
  status,
  onPress,
  accessibilityHint,
  trailing,
  testID,
}: ListRowProps) {
  const label = [title, detail, status?.label].filter(Boolean).join(', ');
  const content = (
    <>
      <View style={styles.text}>
        <Text style={styles.title}>{title}</Text>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {status ? <StatusBadge {...status} /> : null}
      </View>
      {trailing}
    </>
  );
  if (onPress) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={accessibilityHint}
        onPress={onPress}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        testID={testID}
      >
        {content}
      </Pressable>
    );
  }
  return (
    <View style={styles.row} accessible accessibilityLabel={label} testID={testID}>
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.background,
    gap: spacing.md,
  },
  pressed: { backgroundColor: colors.surface },
  text: { flex: 1, gap: spacing.xs },
  title: { ...type.body, fontWeight: '600', color: colors.text },
  detail: { ...type.caption, color: colors.textMuted },
});
