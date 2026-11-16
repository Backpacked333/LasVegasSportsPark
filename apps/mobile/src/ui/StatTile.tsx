/**
 * StatTile: one figure with its label ("Games played", "8"), on a card surface (ADR-008). The
 * value uses tabular figures so digits line up across tiles and do not shift as they change. An
 * optional sublabel explains it ("2 this week") and an optional tone colours the value; the words
 * always say what the tone means, never the colour alone (SPK-UX-009).
 *
 * The tile is one element for screen readers, read "Label, value, sublabel". It is not a control.
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
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function StatTile({
  label,
  value,
  sublabel,
  tone = 'default',
  style,
  testID,
}: StatTileProps) {
  const theme = useTheme();
  const styles = useStyles();
  const valueColor = tone === 'default' ? theme.colors.text : theme.colors[tone];
  return (
    <View
      style={[elevation(theme, 'card'), styles.tile, style]}
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
  label: { ...type.footnote, ...fonts.semibold, color: colors.textMuted },
  value: { ...tabular(type.title1) },
  sublabel: { ...type.footnote, color: colors.textMuted },
}));
