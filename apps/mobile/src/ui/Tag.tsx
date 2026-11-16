/**
 * Tag: a short neutral label on a card ("Ages 6 to 8", "Indoor", "Saturdays"), as a small capsule.
 * A Tag describes; it is not a status (status uses `StatusBadge`, with its glyph) and not a control
 * (filters use `Chip`).
 *
 * Tones: `neutral` (the soft surface), `tonal` (the tonal fill) and `onMedia` (over artwork: the
 * `scrimEnd` fill with `onMedia` text, which keeps 4.5:1 on any image pixel, ADR-008). Its words
 * are read as text; inside a card that is one accessible element the card's name includes them.
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from './Icon';
import { makeStyles, radius, spacing, type, useTheme } from './theme';

export type TagTone = 'neutral' | 'tonal' | 'onMedia';

export interface TagProps {
  label: string;
  tone?: TagTone;
  /** Decorative Material Symbols name before the label. */
  icon?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Tag({ label, tone = 'neutral', icon, style, testID }: TagProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const foreground =
    tone === 'onMedia' ? colors.onMedia : tone === 'tonal' ? colors.onTonal : colors.text;
  return (
    <View
      style={[styles.tag, styles[tone], style]}
      accessible
      accessibilityRole="text"
      accessibilityLabel={label}
      testID={testID}
    >
      {icon ? <Icon name={icon} size={14} color={foreground} /> : null}
      <Text style={[styles.label, { color: foreground }]}>{label}</Text>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  tag: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xxs + 1,
    borderRadius: radius.pill,
  },
  neutral: { backgroundColor: colors.surface },
  tonal: { backgroundColor: colors.tonal },
  onMedia: { backgroundColor: colors.scrimEnd },
  label: { ...type.micro, flexShrink: 1 },
}));
