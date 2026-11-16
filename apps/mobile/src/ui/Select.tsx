/**
 * Select (ADR-008, **Proposed** visual system v2): a field-styled button that shows the current
 * choice and opens a `Sheet` of radio cards (`ChoiceCard`) to change it. Choosing closes the sheet
 * and focus goes back to the button (SPK-UX-009).
 *
 * The button is one element: role `button`, the label as its name, the current choice (or the
 * placeholder) as its value, and "Required", the hint and the error as its description
 * (`fieldAccessibility`). A change plays the selection haptic; the button shows the new choice.
 */
import { useRef, useState } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { ChoiceCard, useSelectionHaptic, type ChoiceOption } from './ChoiceList';
import { Field, fieldAccessibility, useFieldStyles, type FieldBaseProps } from './Field';
import { Icon } from './Icon';
import { Sheet } from './Sheet';
import { spacing, useTheme } from './theme';

export interface SelectProps<V extends string> extends FieldBaseProps {
  value: V | null;
  options: readonly ChoiceOption<V>[];
  onChange: (value: V) => void;
  /** Shown (and read) while nothing is chosen. */
  placeholder?: string;
  /** The sheet's title; the label by default. */
  sheetTitle?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function Select<V extends string>({
  label,
  hint,
  error,
  required,
  value,
  options,
  onChange,
  placeholder = 'Choose',
  sheetTitle,
  disabled = false,
  style,
  testID,
}: SelectProps<V>) {
  const styles = useFieldStyles();
  const { colors } = useTheme();
  const haptic = useSelectionHaptic();
  const [open, setOpen] = useState(false);
  const trigger = useRef<View>(null);
  const current = options.find((o) => o.value === value) ?? null;

  const choose = (next: V) => {
    setOpen(false);
    if (next === value) return;
    haptic();
    onChange(next);
  };

  return (
    <Field label={label} hint={hint} error={error} required={required} style={style}>
      <Pressable
        ref={trigger}
        onPress={() => setOpen(true)}
        disabled={disabled}
        accessibilityRole="button"
        {...fieldAccessibility({ label, hint, error, required })}
        accessibilityValue={{ text: current?.label ?? placeholder }}
        accessibilityState={{ disabled, expanded: open }}
        style={({ pressed }) => [
          styles.box,
          styles.boxButton,
          error ? styles.boxError : null,
          disabled ? styles.boxDisabled : null,
          pressed ? styles.pressed : null,
        ]}
        testID={testID}
      >
        <Text style={current ? styles.value : styles.placeholder}>
          {current?.label ?? placeholder}
        </Text>
        <Icon name="expand_more" size={22} color={colors.textMuted} />
      </Pressable>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={sheetTitle ?? label}
        returnFocusTo={trigger}
      >
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel={sheetTitle ?? label}
          style={{ gap: spacing.sm }}
        >
          {options.map((option) => (
            <ChoiceCard
              key={option.value}
              option={option}
              mode="single"
              checked={option.value === value}
              disabled={option.disabled}
              onPress={() => choose(option.value)}
            />
          ))}
        </View>
      </Sheet>
    </Field>
  );
}
