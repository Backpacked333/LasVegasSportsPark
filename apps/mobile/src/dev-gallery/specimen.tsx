/**
 * Layout helpers of the design system gallery (development only, ADR-008): a titled group of
 * specimens on the page, captions naming the state a specimen shows, rows and stacks, and a night
 * band for the specimens made for artwork and night surfaces.
 */
import type { ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { activityArtwork } from '../artwork/manifest';
import { Artwork } from '../ui/Artwork';
import { MediaScrim } from '../ui/MediaCard';
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

/**
 * Words and controls over artwork, as screens draw them: a picture with the scrim (`MediaScrim`)
 * at its foot. On a plain page colour the scrim would show nothing in Legends mode (black on
 * black), so the specimen is always over a picture.
 */
export function ScrimBand({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.media}>
      <Artwork
        source={activityArtwork['soccer-league'].wide}
        aspectRatio={16 / 9}
        rounded={false}
      />
      <MediaScrim bandStyle={styles.scrimWords}>{children}</MediaScrim>
    </View>
  );
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
  media: { borderRadius: radius.image, overflow: 'hidden' },
  scrimWords: { gap: spacing.sm },
  night: { backgroundColor: colors.night },
}));
