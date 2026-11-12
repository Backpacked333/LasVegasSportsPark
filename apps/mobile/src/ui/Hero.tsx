/**
 * Page hero of the park system: a night (or pitch, for a team) band at the top of a
 * detail page with a floodlight eyebrow, the page's name as a condensed uppercase title and its
 * status underneath. The eyebrow and the title are headers for screen readers (SPK-UX-009); the
 * status keeps its glyph and words on the dark band (StatusBadge pills are tinted, not outlined).
 */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';
import { continuousCorners, makeStyles, radius, spacing, type } from './theme';

export function Hero({
  eyebrow,
  title,
  tone = 'night',
  children,
  testID,
}: {
  /** Short context above the title, e.g. the activity kind or the team's division. */
  eyebrow?: string | null;
  title: string;
  tone?: 'night' | 'pitch';
  children?: ReactNode;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <View style={[styles.hero, tone === 'pitch' && styles.pitch]} testID={testID}>
      {eyebrow ? (
        <Text style={styles.eyebrow} accessibilityRole="header">
          {eyebrow}
        </Text>
      ) : null}
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

/** Body text on a hero band. */
export function HeroText({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <Text style={styles.text}>{children}</Text>;
}

const useStyles = makeStyles(({ colors, dark }) => ({
  hero: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    padding: spacing.lg,
    paddingTop: 18,
    gap: spacing.sm,
    borderRadius: radius.xl,
    ...continuousCorners,
    backgroundColor: colors.night,
    // A hairline keeps the band's edge on a page that is itself dark (Legends mode).
    borderWidth: 1,
    borderColor: dark ? colors.nightLine : colors.night,
  },
  pitch: { backgroundColor: colors.pitch, borderColor: dark ? colors.nightLine : colors.pitch },
  eyebrow: { ...type.eyebrow, color: colors.floodlight },
  title: { ...type.display, color: colors.onNight },
  // Light enough on both the night and the pitch band (AA for body text).
  text: { ...type.body, color: colors.onNightBody },
}));
