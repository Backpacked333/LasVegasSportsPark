/**
 * AppHeader: the top of a tab or a page (ADR-008): an optional eyebrow ("Saturday 24 October"),
 * the large title in the `largeTitle` style, announced as a header (SPK-UX-009), an optional
 * subtitle, and an `actions` slot on the right for a few icon buttons (the pass, the inbox).
 *
 * `Screen` draws one when it gets a `title`; a screen that needs the header elsewhere renders it
 * itself. The title wraps instead of truncating at large text sizes, and the actions wrap below it
 * when they no longer fit beside it.
 */
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { fonts, layout, makeStyles, MIN_TOUCH_SIZE, spacing, type } from './theme';

export interface AppHeaderProps {
  title: string;
  eyebrow?: string;
  subtitle?: string;
  /** A few controls (icon buttons), on the right of the title. */
  actions?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function AppHeader({ title, eyebrow, subtitle, actions, style, testID }: AppHeaderProps) {
  const styles = useStyles();
  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.words}>
        {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {actions ? (
        <View style={styles.actions} testID={testID ? `${testID}-actions` : undefined}>
          {actions}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  root: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
  },
  words: { flexGrow: 1, flexShrink: 1, minWidth: 160, gap: spacing.xxs },
  eyebrow: { ...type.footnote, ...fonts.semibold, color: colors.textMuted },
  title: { ...type.largeTitle, color: colors.text },
  subtitle: { ...type.callout, color: colors.textMuted },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: MIN_TOUCH_SIZE,
  },
}));
