/**
 * Page hero of the park system: a night pitch (or pitch green, for a team) band at the top of a
 * detail page with a floodlight eyebrow, the page's name as a condensed uppercase title and its
 * status underneath. The eyebrow and the title are headers for screen readers (SPK-UX-009); the
 * status keeps its glyph and words on the dark band (StatusBadge pills are tinted, not outlined).
 */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing, toneBackgrounds, type } from './theme';

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
  return <Text style={styles.text}>{children}</Text>;
}

const styles = StyleSheet.create({
  hero: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
    padding: spacing.lg,
    paddingTop: 18,
    gap: spacing.sm,
    borderRadius: radius.xl,
    backgroundColor: colors.night,
  },
  pitch: { backgroundColor: colors.primary },
  eyebrow: { ...type.eyebrow, color: colors.floodlight },
  title: { ...type.display, color: colors.primaryText },
  // Light enough on both night and pitch green (AA for body text).
  text: { ...type.body, color: toneBackgrounds.success },
});
