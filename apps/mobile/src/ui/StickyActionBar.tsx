/**
 * StickyActionBar: the bar pinned to the bottom of a flow screen (cart, checkout, a booking), with
 * an optional summary on the left ("Total", "$240.00") and the one primary action on the right
 * (ADR-008). It sits on the `bar` elevation (a shadow cast upwards on classic, a lighter surface
 * with a hairline in Legends mode). Put it in `Screen`'s `footer`, which keeps it above a floating
 * tab bar.
 *
 * The summary is one element for screen readers ("Total, $240.00"), with tabular figures; the
 * action is a block button whose busy and disabled states are exposed (SPK-UX-009). `children`
 * replace the summary when a screen needs more than a label and a value.
 */
import type { ReactNode } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Button } from './Button';
import { elevation, fonts, layout, makeStyles, spacing, tabular, type, useTheme } from './theme';

export interface StickyAction {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  busy?: boolean;
  accessibilityHint?: string;
  icon?: string;
}

export interface StickyActionBarProps {
  /** The summary's label ("Total") and value ("$240.00"). */
  summaryLabel?: string;
  summaryValue?: string;
  /** A note under the summary ("Includes fees"). */
  summaryNote?: string;
  action: StickyAction;
  /** Custom summary content instead of label and value. */
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function StickyActionBar({
  summaryLabel,
  summaryValue,
  summaryNote,
  action,
  children,
  style,
  testID,
}: StickyActionBarProps) {
  const theme = useTheme();
  const styles = useStyles();
  const hasSummary = Boolean(children || summaryLabel || summaryValue);
  return (
    <View style={[elevation(theme, 'bar'), styles.bar, style]} testID={testID}>
      {children ? (
        <View style={styles.summary}>{children}</View>
      ) : hasSummary ? (
        <View
          style={styles.summary}
          accessible
          accessibilityLabel={[summaryLabel, summaryValue, summaryNote].filter(Boolean).join(', ')}
        >
          {summaryLabel ? <Text style={styles.label}>{summaryLabel}</Text> : null}
          {summaryValue ? <Text style={styles.value}>{summaryValue}</Text> : null}
          {summaryNote ? <Text style={styles.label}>{summaryNote}</Text> : null}
        </View>
      ) : null}
      {/* TODO(1b): Button v2 size "lg" (buttonHeight.sticky) once it lands. */}
      <View style={hasSummary ? styles.actionBeside : styles.actionAlone}>
        <Button
          label={action.label}
          onPress={action.onPress}
          disabled={action.disabled}
          busy={action.busy}
          accessibilityHint={action.accessibilityHint}
          icon={action.icon}
          block
        />
      </View>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.md,
  },
  summary: { flexGrow: 1, flexShrink: 1, minWidth: 96, gap: spacing.xxs },
  label: { ...type.footnote, color: colors.textMuted },
  value: { ...tabular(type.title3), ...fonts.bold, color: colors.text },
  actionBeside: { flexGrow: 1, minWidth: 160 },
  actionAlone: { flexGrow: 1 },
}));
