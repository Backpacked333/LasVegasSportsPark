/**
 * InfoCard: a tinted notice inside a screen (ADR-008): something the customer should know, and
 * what they can do about it. Tones `info`, `warning`, `success` and `danger` use the theme's tone
 * tints with the tone colour for the icon; the words are in the text colour, so they read at full
 * contrast on every tint.
 *
 * Colour never carries the tone alone (SPK-UX-009): each tone has its own icon, and the title and
 * message say what is meant. The icon, title and message are one element for screen readers,
 * read "Title. Message."; the optional action is its own button after it, and `children` (for
 * example `SupportDetails`) follow the action.
 */
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { sentences } from './announce';
import { Button } from './Button';
import { Icon } from './Icon';
import { continuousCorners, fonts, makeStyles, radius, spacing, type, useTheme } from './theme';

export type InfoCardTone = 'info' | 'warning' | 'success' | 'danger';

/** One distinct icon per tone, so tones differ without colour. */
export const INFO_CARD_ICONS: Readonly<Record<InfoCardTone, string>> = {
  info: 'info',
  warning: 'warning',
  success: 'check_circle',
  danger: 'error',
};

export interface InfoCardAction {
  label: string;
  onPress: () => void;
  accessibilityHint?: string;
}

export interface InfoCardProps {
  tone?: InfoCardTone;
  title?: string;
  message: string;
  /** Another Material Symbols name instead of the tone's own. */
  icon?: string;
  action?: InfoCardAction;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function InfoCard({
  tone = 'info',
  title,
  message,
  icon,
  action,
  children,
  style,
  testID,
}: InfoCardProps) {
  const styles = useStyles();
  const { colors, toneBackgrounds } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: toneBackgrounds[tone] }, style]} testID={testID}>
      <View style={styles.head} accessible accessibilityLabel={sentences(title, message)}>
        <Icon name={icon ?? INFO_CARD_ICONS[tone]} size={22} color={colors[tone]} />
        <View style={styles.words}>
          {title ? <Text style={styles.title}>{title}</Text> : null}
          <Text style={styles.message}>{message}</Text>
        </View>
      </View>
      {action ? (
        <Button
          label={action.label}
          onPress={action.onPress}
          accessibilityHint={action.accessibilityHint}
          variant="secondary"
        />
      ) : null}
      {children}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: {
    padding: spacing.lg,
    gap: spacing.md,
    borderRadius: radius.lg,
    ...continuousCorners,
    alignItems: 'stretch',
  },
  head: { flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start' },
  words: { flex: 1, gap: spacing.xs },
  title: { ...type.body, ...fonts.semibold, color: colors.text },
  message: { ...type.callout, color: colors.text },
}));
