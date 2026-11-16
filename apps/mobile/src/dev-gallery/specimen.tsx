/**
 * Layout helpers of the design system gallery (development only, ADR-008): a titled group of
 * specimens on the page, captions naming the state a specimen shows, rows and stacks, and a night
 * band for the specimens made for artwork and night surfaces.
 */
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { Section, type SectionAction, type SectionVariant } from '../ui/Section';
import { Text } from '../ui/Text';
import { makeStyles, radius, spacing } from '../ui/theme';

/** One component's specimens: a gallery section, plain on the page unless a variant is given. */
export function Specimens({
  title,
  subtitle,
  variant = 'plain',
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  variant?: SectionVariant;
  action?: SectionAction;
  children: ReactNode;
}) {
  return (
    <Section title={title} subtitle={subtitle} variant={variant} action={action}>
      {children}
    </Section>
  );
}

/** A small caption above a specimen ("Busy", "Disabled"). */
export function Caption({ children }: { children: string }) {
  return (
    <Text variant="footnote" tone="muted">
      {children}
    </Text>
  );
}

/** Specimens side by side, wrapping. */
export function Row({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  return <View style={[styles.row, style]}>{children}</View>;
}

/** Specimens one under the other. */
export function Column({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const styles = useStyles();
  return <View style={[styles.column, style]}>{children}</View>;
}

/** The scrim colour band that words and controls over artwork sit on. */
export function ScrimBand({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={[styles.band, styles.scrim]}>{children}</View>;
}

/** The night surface (hero cards, the pass). */
export function NightBand({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={[styles.band, styles.night]}>{children}</View>;
}

/** A card in a plain section already sits inside the gutter: no margin of its own. */
export const inGutter: ViewStyle = { marginHorizontal: 0 };

const useStyles = makeStyles(({ colors }) => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.sm },
  column: { gap: spacing.md },
  band: { gap: spacing.sm, padding: spacing.lg, borderRadius: radius.image },
  scrim: { backgroundColor: colors.scrimEnd },
  night: { backgroundColor: colors.night },
}));
