/**
 * Chips (ADR-008, **Proposed** visual system v2): short filters and quick choices.
 *
 * - `Chip`: a capsule button. With `selected` given it is a selectable chip: it exposes `selected`
 *   to screen readers, turns tonal and shows a check when selected (so the state is never colour
 *   alone, SPK-UX-009), and a change plays the selection haptic. Without `selected` it is a plain
 *   action chip.
 * - `ChipRow`: a horizontal scroll of chips, either given as children or built from `options`
 *   with single or multiple selection.
 *
 * Every chip is at least 44 pt tall; its label wraps rather than shrinks at large text sizes.
 */
import type { ReactNode } from 'react';
import { Pressable, ScrollView, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSelectionHaptic } from './ChoiceList';
import { Icon } from './Icon';
import {
  fonts,
  layout,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  type,
  useTheme,
} from './theme';

export interface ChipProps {
  label: string;
  /** Present for a selectable chip; absent for a plain action chip. */
  selected?: boolean;
  onPress?: () => void;
  /** A decorative Material Symbols icon before the label. */
  icon?: string;
  disabled?: boolean;
  /** A fuller name for screen readers when the label leans on its row ("Saturday" for "Sat"). */
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

export function Chip({
  label,
  selected,
  onPress,
  icon,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ChipProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const haptic = useSelectionHaptic();
  const selectable = selected !== undefined;
  const on = selected === true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={selectable ? { selected: on, disabled } : { disabled }}
      disabled={disabled}
      onPress={() => {
        if (selectable) haptic();
        onPress?.();
      }}
      style={({ pressed }) => [
        styles.chip,
        on ? styles.selected : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
      testID={testID}
    >
      {on ? (
        <Icon name="check" size={18} color={colors.onTonal} />
      ) : icon ? (
        <Icon name={icon} size={18} color={colors.textMuted} />
      ) : null}
      <Text style={[styles.label, on ? styles.selectedLabel : null]}>{label}</Text>
    </Pressable>
  );
}

export interface ChipOption<V extends string = string> {
  value: V;
  label: string;
  icon?: string;
  disabled?: boolean;
  accessibilityLabel?: string;
}

interface ChipRowBase {
  /** What the chips choose ("Sport", "Day"): the row's accessible name. */
  label: string;
  /** Side padding of the scroll content; the page gutter by default. */
  inset?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export interface PlainChipRowProps extends ChipRowBase {
  mode?: undefined;
  children: ReactNode;
}

export interface SingleChipRowProps<V extends string> extends ChipRowBase {
  mode: 'single';
  options: readonly ChipOption<V>[];
  value: V | null;
  onChange: (value: V | null) => void;
  /** Pressing the selected chip again clears the choice (a filter that can be off). */
  allowEmpty?: boolean;
}

export interface MultipleChipRowProps<V extends string> extends ChipRowBase {
  mode: 'multiple';
  options: readonly ChipOption<V>[];
  value: readonly V[];
  onChange: (value: V[]) => void;
}

export type ChipRowProps<V extends string> =
  PlainChipRowProps | SingleChipRowProps<V> | MultipleChipRowProps<V>;

export function ChipRow<V extends string>(props: ChipRowProps<V>) {
  const styles = useStyles();
  const inset = props.inset ?? layout.gutter;
  let chips: ReactNode;
  if (props.mode === undefined) {
    chips = props.children;
  } else {
    const isOn = (value: V) =>
      props.mode === 'single' ? props.value === value : props.value.includes(value);
    const press = (value: V) => {
      if (props.mode === 'single') {
        if (props.value !== value) props.onChange(value);
        else if (props.allowEmpty) props.onChange(null);
        return;
      }
      const options = props.options.map((o) => o.value);
      props.onChange(
        props.value.includes(value)
          ? props.value.filter((v) => v !== value)
          : options.filter((v) => v === value || props.value.includes(v)),
      );
    };
    chips = props.options.map((option) => (
      <Chip
        key={option.value}
        label={option.label}
        icon={option.icon}
        disabled={option.disabled}
        accessibilityLabel={option.accessibilityLabel}
        selected={isOn(option.value)}
        onPress={() => press(option.value)}
      />
    ));
  }
  return (
    <View
      style={props.style}
      accessibilityRole="toolbar"
      accessibilityLabel={props.label}
      testID={props.testID}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.row, { paddingHorizontal: inset }]}
      >
        {chips}
      </ScrollView>
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  chip: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
  },
  selected: { backgroundColor: colors.tonal, borderColor: colors.tonal },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
  label: { ...type.callout, ...fonts.semibold, color: colors.text, flexShrink: 1 },
  selectedLabel: { color: colors.onTonal },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
}));
