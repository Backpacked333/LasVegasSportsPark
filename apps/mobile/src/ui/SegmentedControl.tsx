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
import { CountBadge } from './CountBadge';
import { Icon } from './Icon';
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
  /**
   * A count beside the label (handoff M 2d: "To do 3"), drawn as a count badge and read as part
   * of the segment's name ("To do, 3"). Nothing is drawn for 0.
   */
  count?: number;
}

export interface SegmentedControlProps<V extends string> {
  /** The group's accessible name ("Show"). */
  label: string;
  segments: readonly Segment<V>[];
  /** The selected value; `null` for none yet (an answer not given). */
  value: V | null;
  onChange: (value: V) => void;
  pattern?: 'tabs' | 'radio';
  /**
   * `raised` (default): the selected segment is a raised white fill. `filled`: an answer control
   * (Going / Maybe / Not going): the selected segment is filled with the primary colour and
   * carries a check glyph, so the state is shape and words as well as colour.
   */
  variant?: 'raised' | 'filled';
  /** Every segment disabled (offline, answers closed); the selection stays visible. */
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SegmentedControl<V extends string>({
  label,
  segments,
  value,
  onChange,
  pattern = 'tabs',
  variant = 'raised',
  disabled: allDisabled = false,
  style,
  testID,
}: SegmentedControlProps<V>) {
  const styles = useStyles();
  const theme = useTheme();
  const haptic = useSelectionHaptic();
  const tabs = pattern === 'tabs';
  const filled = variant === 'filled';
  return (
    <View
      style={[styles.track, style]}
      accessibilityRole={tabs ? 'tablist' : 'radiogroup'}
      accessibilityLabel={label}
      testID={testID}
    >
      {segments.map((segment) => {
        const selected = segment.value === value;
        const disabled = allDisabled || segment.disabled === true;
        return (
          <Pressable
            key={segment.value}
            accessibilityRole={tabs ? 'tab' : 'radio'}
            accessibilityLabel={[
              segment.accessibilityLabel ?? segment.label,
              segment.count && segment.count > 0 ? String(segment.count) : null,
            ]
              .filter(Boolean)
              .join(', ')}
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
              selected && !filled ? [elevation(theme, 'raised'), styles.selected] : null,
              selected && filled ? styles.filled : null,
              selected && filled && allDisabled ? styles.filledDisabled : null,
              pressed && !selected ? styles.pressed : null,
              disabled && !(selected && filled) ? styles.disabled : null,
            ]}
            testID={testID ? `${testID}-${segment.value}` : undefined}
          >
            {selected && filled ? (
              <Icon
                name="check"
                size={18}
                color={allDisabled ? theme.colors.textMuted : theme.colors.primaryText}
              />
            ) : null}
            <Text
              style={[
                styles.label,
                selected ? styles.selectedLabel : null,
                selected && filled ? styles.filledLabel : null,
                selected && filled && allDisabled ? styles.filledDisabledLabel : null,
              ]}
            >
              {segment.label}
            </Text>
            {segment.count ? <CountBadge count={segment.count} max={9} /> : null}
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
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
  },
  selected: { borderRadius: radius.pill },
  filled: { backgroundColor: colors.primary },
  filledDisabled: { backgroundColor: colors.control },
  filledLabel: { color: colors.primaryText },
  filledDisabledLabel: { color: colors.textMuted },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.55 },
  label: { ...type.callout, color: colors.textMuted, textAlign: 'center' },
  selectedLabel: { ...fonts.semibold, color: colors.text },
}));
