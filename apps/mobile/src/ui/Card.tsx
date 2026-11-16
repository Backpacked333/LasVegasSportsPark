/**
 * Cards of the park system: the card surface on the page with a line border (`Card`), the night
 * pitch hero (`Card tone="night"`), and a titled section card (`SectionCard`) whose title is an
 * uppercase eyebrow announced as a header. Rows and state views inside a card are drawn flat
 * (`ListRowLayout`), and a section card inside another card loses its own frame, so cards never
 * nest visually. Corners are continuous where the platform draws them; colours follow the theme.
 */
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ListRowLayout, useRowLayout } from './ListRow';
import { continuousCorners, makeStyles, radius, spacing, type, useTheme } from './theme';

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
  const styles = useStyles();
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
  eyebrow: { ...type.eyebrow },
}));
