/**
 * A segmented control (ADR-008, **Proposed** visual system v2): two to four short options side by
 * side, one of them selected.
 *
 * Two patterns, by what the segments do (SPK-UX-009):
 * - `pattern: 'tabs'` (the default) switches what the screen shows below ("Upcoming", "Past"): a
 *   `tablist` of `tab`s, the current one `selected`.
 * - `pattern: 'radio'` chooses a value ("Week", "Month"): a `radiogroup` of `radio`s, the chosen one
 *   `checked` (and `selected`).
 *
 * The selected segment is a raised fill with bold text, so the state is not colour alone. A change
 * plays the selection haptic. Every segment is at least 44 pt tall.
 */
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSelectionHaptic } from './ChoiceList';
import {
  elevation,
  fonts,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  type,
  useTheme,
} from './theme';

export interface Segment<V extends string = string> {
  value: V;
  label: string;
  /** A fuller name for screen readers ("Upcoming sessions"). */
  accessibilityLabel?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<V extends string> {
  /** The group's accessible name ("Show"). */
  label: string;
  segments: readonly Segment<V>[];
  value: V;
  onChange: (value: V) => void;
  pattern?: 'tabs' | 'radio';
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SegmentedControl<V extends string>({
  label,
  segments,
  value,
  onChange,
  pattern = 'tabs',
  style,
  testID,
}: SegmentedControlProps<V>) {
  const styles = useStyles();
  const theme = useTheme();
  const haptic = useSelectionHaptic();
  const tabs = pattern === 'tabs';
  return (
    <View
      style={[styles.track, style]}
      accessibilityRole={tabs ? 'tablist' : 'radiogroup'}
      accessibilityLabel={label}
      testID={testID}
    >
      {segments.map((segment) => {
        const selected = segment.value === value;
        const disabled = segment.disabled === true;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole={tabs ? 'tab' : 'radio'}
            accessibilityLabel={segment.accessibilityLabel ?? segment.label}
            accessibilityState={
              tabs ? { selected, disabled } : { checked: selected, selected, disabled }
            }
            disabled={disabled}
            onPress={() => {
              if (selected) return;
              haptic();
              onChange(segment.value);
            }}
            style={({ pressed }) => [
              styles.segment,
              selected ? [elevation(theme, 'raised'), styles.selected] : null,
              pressed && !selected ? styles.pressed : null,
              disabled ? styles.disabled : null,
            ]}
          >
            <Text style={[styles.label, selected ? styles.selectedLabel : null]}>
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  track: {
    flexDirection: 'row',
    padding: spacing.xxs,
    gap: spacing.xxs,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  segment: {
    flex: 1,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  selected: { borderRadius: radius.pill },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.55 },
  label: { ...type.callout, color: colors.textMuted, textAlign: 'center' },
  selectedLabel: { ...fonts.semibold, color: colors.text },
}));
