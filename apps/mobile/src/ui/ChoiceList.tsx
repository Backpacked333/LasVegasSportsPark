/**
 * Radio and checkbox cards (ADR-008, **Proposed** visual system v2; SPK-UX-010 "simple customer
 * choices"). `mode: 'single'` is a radio group, `mode: 'multiple'` a set of checkboxes. Each option
 * is one card and one element for screen readers (SPK-UX-009):
 *
 * - its role (`radio` or `checkbox`), its `checked` and `disabled` state;
 * - its name: the label, then the trailing words (a price) and the description, so nothing on the
 *   card is lost when hints are turned off;
 * - the group's error as its hint, read after the name.
 *
 * Selection is shown with a glyph, a border and a fill, never colour alone. A change plays the
 * selection haptic (`useSelectionHaptic`), and the screen always shows it too: a haptic is never
 * the only feedback. Each card is at least 44 pt tall.
 *
 * - `layout="tile"`: the cards are tiles side by side (start times), wrapping as text grows. A
 *   tile shows `shortLabel` when it has one ("9:00"), and its full name is still read; a chosen
 *   tile is filled and starts with "✓", so the choice never rests on colour.
 * - `leading`: a decorative node at the start of a card (an avatar); the glyph then moves to the
 *   end of the card.
 * - `ChoiceGroup`: a group of cards a screen lays out itself (each with its own words). Its
 *   `error` is the group's: the group's hint, and the hint of every card inside it, so it is read
 *   with the choice (SPK-UX-009). Show the words under the group (`FieldErrorText`).
 * - `ChoiceList` `notifyReselect`: pressing the chosen option calls `onChange` again, for a form
 *   that starts a new intent on every choice.
 */
import { createContext, useCallback, useContext, type ReactElement, type ReactNode } from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Field, useFieldStyles, type FieldBaseProps } from './Field';
import { Icon } from './Icon';
import { useHaptics } from './PressableScale';
import {
  continuousCorners,
  fonts,
  makeStyles,
  MIN_TOUCH_SIZE,
  radius,
  spacing,
  type,
  useTheme,
} from './theme';

/**
 * The selection haptic of the injected services (`useHaptics`, src/ui/PressableScale.tsx), for a
 * choice that changed. Outside `AppProviders` (a component rendered on its own) it plays nothing.
 */
export function useSelectionHaptic(): () => void {
  const haptics = useHaptics();
  return useCallback(() => haptics.selection(), [haptics]);
}

export interface ChoiceOption<V extends string = string> {
  value: V;
  label: string;
  /** What a tile shows instead of the label ("9:00"); the label is still read. */
  shortLabel?: string;
  /** A second line under the label. */
  description?: string;
  disabled?: boolean;
  /**
   * Something at the end of the card, such as a price. A string is drawn as text and read with the
   * name; for any other node, give its words in `trailingLabel`.
   */
  trailing?: ReactNode;
  trailingLabel?: string;
}

/** `list`: one card per row; `tile`: tiles side by side, wrapping as text grows. */
export type ChoiceLayout = 'list' | 'tile';

interface ChoiceListBase<V extends string> extends FieldBaseProps {
  options: readonly ChoiceOption<V>[];
  disabled?: boolean;
  layout?: ChoiceLayout;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export interface SingleChoiceListProps<V extends string> extends ChoiceListBase<V> {
  mode: 'single';
  value: V | null;
  onChange: (value: V) => void;
  /** Pressing the chosen option calls `onChange` again (it does nothing by default). */
  notifyReselect?: boolean;
}

export interface MultipleChoiceListProps<V extends string> extends ChoiceListBase<V> {
  mode: 'multiple';
  value: readonly V[];
  onChange: (value: V[]) => void;
}

export type ChoiceListProps<V extends string> =
  SingleChoiceListProps<V> | MultipleChoiceListProps<V>;

/** The words of an option's trailing slot, if it has any. */
function trailingWords(option: ChoiceOption): string | undefined {
  if (option.trailingLabel) return option.trailingLabel;
  return typeof option.trailing === 'string' ? option.trailing : undefined;
}

/** An option's accessible name: "Label, trailing, description". */
export function choiceName(option: ChoiceOption): string {
  return [option.label, trailingWords(option), option.description].filter(Boolean).join(', ');
}

// One signature per mode, so `V` is inferred from the options and the value in either mode.
export function ChoiceList<V extends string>(props: SingleChoiceListProps<V>): ReactElement;
export function ChoiceList<V extends string>(props: MultipleChoiceListProps<V>): ReactElement;
export function ChoiceList<V extends string>(props: ChoiceListProps<V>): ReactElement {
  const {
    label,
    hint,
    error,
    required,
    options,
    disabled = false,
    layout = 'list',
    style,
    testID,
  } = props;
  const styles = useStyles();
  const haptic = useSelectionHaptic();
  const isChecked = (value: V) =>
    props.mode === 'single' ? props.value === value : props.value.includes(value);

  const toggle = (value: V) => {
    if (props.mode === 'single') {
      if (props.value === value) {
        if (props.notifyReselect) props.onChange(value);
        return;
      }
      haptic();
      props.onChange(value);
      return;
    }
    haptic();
    const next = props.value.includes(value)
      ? props.value.filter((v) => v !== value)
      : // Keep the options' order, whatever order they were picked in.
        options.map((o) => o.value).filter((v) => v === value || props.value.includes(v));
    props.onChange(next);
  };

  return (
    <Field label={label} hint={hint} error={error} required={required} style={style}>
      <View
        style={layout === 'tile' ? styles.tiles : styles.list}
        accessibilityRole={props.mode === 'single' ? 'radiogroup' : undefined}
        accessibilityLabel={label}
        testID={testID}
      >
        {options.map((option) => (
          <ChoiceCard
            key={option.value}
            option={option}
            mode={props.mode}
            checked={isChecked(option.value)}
            disabled={disabled || option.disabled === true}
            error={error}
            layout={layout}
            onPress={() => toggle(option.value)}
          />
        ))}
      </View>
    </Field>
  );
}

/** The error of the `ChoiceGroup` a card is in, read with each card. */
const ChoiceGroupErrorContext = createContext<string | null>(null);

export interface ChoiceGroupProps {
  /** The group's accessible name ("Start time"). */
  label: string;
  /** `radiogroup` (default) for one choice; `list` for checkboxes. */
  role?: 'radiogroup' | 'list';
  /** A required choice not made: the group's hint and each card's (`Error: …`). */
  error?: string | null;
  layout?: ChoiceLayout;
  /** Shows the label above the cards (in the field label style); by default it is only read. */
  showLabel?: boolean;
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Cards a screen lays out itself, named and with one error for the group. */
export function ChoiceGroup({
  label,
  role = 'radiogroup',
  error,
  layout = 'list',
  showLabel = false,
  children,
  style,
  testID,
}: ChoiceGroupProps) {
  const styles = useStyles();
  const field = useFieldStyles();
  const cards = (
    <ChoiceGroupErrorContext.Provider value={error ?? null}>
      {children}
    </ChoiceGroupErrorContext.Provider>
  );
  return (
    <View
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={error ? `Error: ${error}` : undefined}
      style={[showLabel ? styles.list : layout === 'tile' ? styles.tiles : styles.list, style]}
      testID={testID}
    >
      {showLabel ? (
        <>
          <Text style={field.label}>{label}</Text>
          {layout === 'tile' ? <View style={styles.tiles}>{cards}</View> : cards}
        </>
      ) : (
        cards
      )}
    </View>
  );
}

export interface ChoiceCardProps {
  option: ChoiceOption;
  mode: 'single' | 'multiple';
  checked: boolean;
  disabled?: boolean;
  /** The group's error, read after the card's name (by default the `ChoiceGroup`'s). */
  error?: string | null;
  /** `tile`: a compact tile that shows `option.shortLabel` (see the header). */
  layout?: ChoiceLayout;
  /** A decorative node at the start of the card (an avatar); the glyph moves to the end. */
  leading?: ReactNode;
  onPress: () => void;
  /** Replaces the name from `choiceName` (a screen's own wording, such as "Name. Detail"). */
  accessibilityLabel?: string;
  /** Replaces the hint ("Error: …" by default), for a screen that reads more after the name. */
  accessibilityHint?: string;
  testID?: string;
}

/** One radio or checkbox card. `ChoiceList` draws these; `Select` draws them in its sheet. */
export function ChoiceCard({
  option,
  mode,
  checked,
  disabled = false,
  error: ownError,
  layout = 'list',
  leading,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: ChoiceCardProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const groupError = useContext(ChoiceGroupErrorContext);
  const error = ownError === undefined ? groupError : ownError;
  if (layout === 'tile') {
    return (
      <Pressable
        accessibilityRole={mode === 'single' ? 'radio' : 'checkbox'}
        accessibilityLabel={accessibilityLabel ?? choiceName(option)}
        accessibilityHint={accessibilityHint ?? (error ? `Error: ${error}` : undefined)}
        accessibilityState={{ checked, disabled }}
        disabled={disabled}
        onPress={onPress}
        testID={testID}
        style={({ pressed }) => [
          styles.tile,
          checked ? styles.tileChecked : null,
          error ? styles.invalid : null,
          pressed ? styles.pressed : null,
          disabled ? styles.disabled : null,
        ]}
      >
        <Text style={[styles.tileLabel, checked ? styles.tileTextChecked : null]}>
          {`${checked ? '✓ ' : ''}${option.shortLabel ?? option.label}`}
        </Text>
        {option.description ? (
          <Text style={[styles.description, checked ? styles.tileTextChecked : null]}>
            {option.description}
          </Text>
        ) : null}
      </Pressable>
    );
  }
  const glyph =
    mode === 'single'
      ? checked
        ? 'radio_button_checked'
        : 'radio_button_unchecked'
      : checked
        ? 'check_box'
        : 'check_box_outline_blank';
  return (
    <Pressable
      accessibilityRole={mode === 'single' ? 'radio' : 'checkbox'}
      accessibilityLabel={accessibilityLabel ?? choiceName(option)}
      accessibilityHint={accessibilityHint ?? (error ? `Error: ${error}` : undefined)}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }) => [
        styles.card,
        checked ? styles.checked : null,
        error ? styles.invalid : null,
        pressed ? styles.pressed : null,
        disabled ? styles.disabled : null,
      ]}
    >
      {leading ?? (
        <Icon name={glyph} size={24} color={checked ? colors.primary : colors.textMuted} />
      )}
      <View style={styles.text}>
        <Text style={styles.label}>{option.label}</Text>
        {option.description ? <Text style={styles.description}>{option.description}</Text> : null}
      </View>
      {typeof option.trailing === 'string' ? (
        <Text style={styles.trailing}>{option.trailing}</Text>
      ) : (
        (option.trailing ?? null)
      )}
      {leading ? (
        <Icon name={glyph} size={24} color={checked ? colors.primary : colors.textMuted} />
      ) : null}
    </Pressable>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  card: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
  },
  checked: { borderColor: colors.primary, borderWidth: 2, backgroundColor: colors.tonal },
  invalid: { borderColor: colors.danger },
  pressed: { opacity: 0.8 },
  disabled: { opacity: 0.55 },
  text: { flex: 1, gap: spacing.xxs },
  label: { ...type.body, ...fonts.semibold, color: colors.text },
  description: { ...type.footnote, color: colors.textMuted },
  trailing: { ...type.callout, ...fonts.semibold, color: colors.text },
  list: { gap: spacing.sm },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 56,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.md,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
    gap: spacing.xxs,
  },
  tileChecked: {
    backgroundColor: colors.floodlight,
    borderColor: colors.onFloodlight,
    borderWidth: 2,
  },
  tileLabel: { ...type.body, ...fonts.extrabold, color: colors.text },
  tileTextChecked: { color: colors.onFloodlight },
}));
