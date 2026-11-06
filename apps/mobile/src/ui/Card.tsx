/**
 * Cards of the park system: white on desert sand with a line border (`Card`), the night pitch hero
 * (`Card tone="night"`), and a titled section card (`SectionCard`) whose title is an uppercase
 * eyebrow announced as a header. Rows and state views inside a card are drawn flat
 * (`ListRowLayout`), and a section card inside another card loses its own frame, so cards never
 * nest visually.
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ListRowLayout, useRowLayout } from './ListRow';
import { colors, radius, spacing, type } from './theme';

export function Card({
  children,
  tone = 'default',
  style,
  testID,
}: {
  children: ReactNode;
  tone?: 'default' | 'night';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const nested = useRowLayout() === 'flat';
  return (
    <View
      style={[
        tone === 'night' ? styles.night : nested ? styles.nested : styles.card,
        styles.inner,
        style,
      ]}
      testID={testID}
    >
      <ListRowLayout layout="flat">{children}</ListRowLayout>
    </View>
  );
}

/** Uppercase section label ("FOR YOU TO KNOW"), announced as a header. */
export function Eyebrow({
  children,
  color = colors.textMuted,
  testID,
}: {
  children: string;
  color?: string;
  testID?: string;
}) {
  return (
    <Text style={[styles.eyebrow, { color }]} accessibilityRole="header" testID={testID}>
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

const styles = StyleSheet.create({
  card: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  nested: { paddingVertical: spacing.sm },
  night: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    backgroundColor: colors.night,
    borderRadius: radius.xl,
  },
  inner: { gap: spacing.sm },
  eyebrow: { ...type.eyebrow },
});
