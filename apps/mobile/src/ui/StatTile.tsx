/**
 * StatTile: one figure with its label ("Games played", "8"), on a card surface (ADR-008). The
 * value uses tabular figures so digits line up across tiles and do not shift as they change. An
 * optional sublabel explains it ("2 this week") and an optional tone colours the value; the words
 * always say what the tone means, never the colour alone (SPK-UX-009).
 *
 * The tile is one element for screen readers, read "Label, value, sublabel". It is not a control.
 *
 * `plain`: the same words without a card of its own, sized to its words, for a figure that sits
 * inside another card next to other content (a team card's standing beside its members).
 */
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import {
  continuousCorners,
  elevation,
  fonts,
  makeStyles,
  radius,
  spacing,
  tabular,
  type,
  useTheme,
} from './theme';

export type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

export interface StatTileProps {
  label: string;
  value: string;
  sublabel?: string;
  tone?: StatTone;
  /** No card of its own (inside another card). */
  plain?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function StatTile({
  label,
  value,
  sublabel,
  tone = 'default',
  plain = false,
  style,
  testID,
}: StatTileProps) {
  const theme = useTheme();
  const styles = useStyles();
  const valueColor = tone === 'default' ? theme.colors.text : theme.colors[tone];
  return (
    <View
      style={plain ? [styles.plain, style] : [elevation(theme, 'card'), styles.tile, style]}
      accessible
      accessibilityLabel={[label, value, sublabel].filter(Boolean).join(', ')}
      testID={testID}
    >
      <Text style={styles.label}>{label}</Text>
      <Text style={[styles.value, { color: valueColor }]}>{value}</Text>
      {sublabel ? <Text style={styles.sublabel}>{sublabel}</Text> : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  tile: {
    flex: 1,
    minWidth: 120,
    padding: spacing.lg,
    gap: spacing.xxs,
    borderRadius: radius.lg,
    ...continuousCorners,
  },
  plain: { gap: spacing.xxs },
  label: { ...type.footnote, ...fonts.semibold, color: colors.textMuted },
  value: { ...tabular(type.title1) },
  sublabel: { ...type.footnote, color: colors.textMuted },
}));
