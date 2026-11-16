/**
 * Fields of the customer visual system v2 (ADR-008, **Proposed**): one label, hint, error and
 * required marker for every input, so every form reads the same way (SPK-UX-009, SPK-UX-010).
 *
 * - `Field` lays out the label, the hint, the control and the error. The control gets its
 *   accessible name and description from `fieldAccessibility`: the name is the label, and the
 *   description (read after it) is "Required", then the hint, then the error. A screen reader so
 *   reads the label, the hint and then the error, in that order, on the control itself.
 * - The error is shown in words next to the field (never by colour alone) and announced when it
 *   appears (`LiveText`, `ui/announce`). Valid input is kept (SPK-UX-008).
 * - `TextField` wraps `TextInput`; its `accessibilityLabel` is always the label.
 * - Error options (`FieldErrorOptions`), for the forms whose words were fixed before this system:
 *   the glyph ("✕", or "▲" on the money and team screens), whether the error is announced as
 *   "Error: …" or as the bare message, and whether it is exposed as an alert. The defaults are the
 *   words above; a form keeps its own exactly.
 * - `SearchField` is a search box with a clear button and an optional debounce (`debounceMs`),
 *   timed with plain timers so tests drive it with Jest's fake timers.
 *
 * Every target is at least 44 pt (`MIN_TOUCH_SIZE`); colours come from the theme in use.
 */
import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import {
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Icon } from './Icon';
import { LiveText, sentences } from './announce';
import { useInputChrome } from './input';
import { fonts, makeStyles, MIN_TOUCH_SIZE, radius, spacing, type, useTheme } from './theme';

/** What every field shares. */
export interface FieldBaseProps {
  /** The visible label, and the control's accessible name. */
  label: string;
  /** A short note under the label ("As it appears on the ID"). */
  hint?: string;
  /** A validation message; shown in words, announced, and read with the control. */
  error?: string | null;
  /** Shows "Required" next to the label and says it on the control. */
  required?: boolean;
}

/** The word shown and read for a required field. */
export const REQUIRED_LABEL = 'Required';

/**
 * The accessible name and description of a field's control: the name is the label, and the
 * description is "Required", the hint and "Error: …", in that order (SPK-UX-009).
 */
export function fieldAccessibility({ label, hint, error, required }: FieldBaseProps): {
  accessibilityLabel: string;
  accessibilityHint: string | undefined;
} {
  const description = sentences(
    required ? REQUIRED_LABEL : null,
    hint,
    error ? `Error: ${error}` : null,
  );
  return { accessibilityLabel: label, accessibilityHint: description || undefined };
}

/** How a field's error is drawn and announced; the defaults are `FieldError`'s. */
export interface FieldErrorOptions {
  /** The glyph before the words: "✕" (default) or "▲". */
  errorGlyph?: string;
  /** Announced as "Error: …" (`prefixed`, default) or as the bare message (`message`). */
  errorAnnouncement?: 'prefixed' | 'message';
  /** Exposed as an alert (default true). */
  errorAlert?: boolean;
}

export interface FieldProps extends FieldBaseProps, FieldErrorOptions {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * A label, an optional hint, the control and its error. Give the control
 * `fieldAccessibility(props)` so it carries the same words.
 */
export function Field({
  label,
  hint,
  error,
  required,
  errorGlyph = '✕',
  errorAnnouncement = 'prefixed',
  errorAlert = true,
  children,
  style,
  testID,
}: FieldProps) {
  const styles = useFieldStyles();
  return (
    <View style={[styles.field, style]} testID={testID}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {required ? <Text style={styles.required}>{REQUIRED_LABEL}</Text> : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
      <FieldErrorText
        error={error}
        glyph={errorGlyph}
        announcement={error && errorAnnouncement === 'prefixed' ? `Error: ${error}` : undefined}
        alert={errorAlert}
      />
    </View>
  );
}

/** A field's error in words, announced when it appears (SPK-UX-008, SPK-UX-009). */
export function FieldError({ error, testID }: { error?: string | null; testID?: string }) {
  const styles = useFieldStyles();
  if (!error) return null;
  return (
    <LiveText
      style={styles.error}
      announcement={`Error: ${error}`}
      accessibilityRole="alert"
      testID={testID}
    >
      {`✕ ${error}`}
    </LiveText>
  );
}

type PassThroughInputProps = Omit<
  TextInputProps,
  | 'value'
  | 'onChangeText'
  | 'style'
  | 'accessibilityLabel'
  | 'accessibilityHint'
  | 'accessibilityState'
  | 'editable'
>;

export interface TextFieldProps extends FieldBaseProps, FieldErrorOptions, PassThroughInputProps {
  value: string;
  onChangeText: (value: string) => void;
  editable?: boolean;
  /** The field around the input (margins in a form). */
  style?: StyleProp<ViewStyle>;
}

/** A labelled text input (`Field` around `TextInput`). */
export function TextField({
  label,
  hint,
  error,
  required,
  value,
  onChangeText,
  editable = true,
  multiline,
  style,
  onFocus,
  onBlur,
  errorGlyph,
  errorAnnouncement,
  errorAlert,
  ...input
}: TextFieldProps) {
  const styles = useFieldStyles();
  const chrome = useInputChrome();
  return (
    <Field
      label={label}
      hint={hint}
      error={error}
      required={required}
      style={style}
      errorGlyph={errorGlyph}
      errorAnnouncement={errorAnnouncement}
      errorAlert={errorAlert}
    >
      <TextInput
        autoCorrect={false}
        {...input}
        {...chrome.props}
        onFocus={(event) => {
          chrome.props.onFocus();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          chrome.props.onBlur();
          onBlur?.(event);
        }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline={multiline}
        {...fieldAccessibility({ label, hint, error, required })}
        accessibilityState={{ disabled: !editable }}
        style={[
          styles.box,
          styles.input,
          chrome.focusStyle,
          multiline ? styles.multiline : null,
          error ? styles.boxError : null,
          editable ? null : styles.boxDisabled,
        ]}
      />
    </Field>
  );
}

export interface SearchFieldProps {
  /** The accessible name ("Search activities"); also the placeholder unless one is given. */
  label?: string;
  value: string;
  /** Every keystroke, so the text on screen follows the person at once. */
  onChangeText: (value: string) => void;
  /**
   * The query to search for: after `debounceMs` without typing, at once on the keyboard's search
   * key, and at once (empty) when the field is cleared.
   */
  onSearch?: (query: string) => void;
  /** Wait this long after the last keystroke before `onSearch`; 0 or absent searches at once. */
  debounceMs?: number;
  placeholder?: string;
  clearLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A search box: search role, a clear button while it has text, and an optional debounce. */
export function SearchField({
  label = 'Search',
  value,
  onChangeText,
  onSearch,
  debounceMs = 0,
  placeholder,
  clearLabel = 'Clear search',
  style,
  testID,
}: SearchFieldProps) {
  const styles = useFieldStyles();
  const { colors } = useTheme();
  const chrome = useInputChrome();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;

  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  const searchNow = useCallback(
    (query: string) => {
      cancel();
      onSearchRef.current?.(query);
    },
    [cancel],
  );

  const change = (text: string) => {
    onChangeText(text);
    if (!onSearchRef.current) return;
    if (debounceMs <= 0) {
      searchNow(text);
      return;
    }
    cancel();
    timer.current = setTimeout(() => {
      timer.current = null;
      onSearchRef.current?.(text);
    }, debounceMs);
  };

  const clear = () => {
    onChangeText('');
    searchNow('');
  };

  return (
    <View
      style={[styles.box, styles.searchBox, chrome.focusStyle, style]}
      testID={testID ? `${testID}-box` : undefined}
    >
      <Icon name="search" size={20} color={colors.textMuted} />
      <TextInput
        {...chrome.props}
        value={value}
        onChangeText={change}
        onSubmitEditing={() => searchNow(value)}
        placeholder={placeholder ?? label}
        accessibilityRole="search"
        accessibilityLabel={label}
        returnKeyType="search"
        inputMode="search"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="never"
        style={styles.searchInput}
        testID={testID}
      />
      {value !== '' ? (
        <Pressable
          onPress={clear}
          accessibilityRole="button"
          accessibilityLabel={clearLabel}
          style={({ pressed }) => [styles.clear, pressed ? styles.pressed : null]}
          hitSlop={spacing.xs}
        >
          <Icon name="close" size={20} color={colors.textMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

/** The field styles every input of the visual system shares (Select and DateField too). */
export const useFieldStyles = makeStyles(({ colors }) => ({
  field: { gap: spacing.xs },
  labelRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'baseline', gap: spacing.sm },
  label: { ...type.body, ...fonts.semibold, color: colors.text },
  required: { ...type.footnote, color: colors.textMuted },
  hint: { ...type.footnote, color: colors.textMuted },
  error: { ...type.caption, color: colors.danger },
  /** The outlined box of a field: a text input, a select's button, a date. */
  box: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.control,
    borderRadius: radius.md,
    backgroundColor: colors.background,
  },
  boxError: { borderColor: colors.danger, borderWidth: 2 },
  boxDisabled: { backgroundColor: colors.surface },
  input: { ...type.body, color: colors.text, paddingHorizontal: 14 },
  multiline: { minHeight: 88, textAlignVertical: 'top', paddingVertical: spacing.sm },
  /** The text of a box that is a button (Select, a date on a device). */
  value: { ...type.body, color: colors.text, flex: 1 },
  placeholder: { ...type.body, color: colors.textMuted, flex: 1 },
  boxButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
  },
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderColor: colors.surface,
  },
  searchInput: {
    ...type.body,
    color: colors.text,
    flex: 1,
    minHeight: MIN_TOUCH_SIZE,
    paddingVertical: spacing.sm,
  },
  clear: {
    minWidth: MIN_TOUCH_SIZE,
    minHeight: MIN_TOUCH_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: { opacity: 0.7 },
}));

/*
 * Pieces of a field for a form that composes its own (ADR-008): the error with its glyph, the
 * outlined input without words of its own, and a read-only "label: value" fact. They draw with
 * the shared field styles.
 */

export interface FieldErrorTextProps {
  error?: string | null;
  /** The glyph before the words ("✕", or "▲" on the team and money screens). */
  glyph?: string;
  /** What is announced when it appears; the bare message by default. */
  announcement?: string | null;
  /** Exposed as an alert (default true); some forms announce a field's error without the role. */
  alert?: boolean;
  testID?: string;
}

/**
 * A field's error in words with its glyph, announced when it appears (`LiveText`; SPK-UX-008,
 * SPK-UX-009). Unlike `FieldError` it announces the bare message unless told otherwise, as the
 * money, team and choice errors always have.
 */
export function FieldErrorText({
  error,
  glyph = '✕',
  announcement,
  alert = true,
  testID,
}: FieldErrorTextProps) {
  const styles = useFieldStyles();
  if (!error) return null;
  return (
    <LiveText
      style={styles.error}
      announcement={announcement === undefined ? error : announcement}
      accessibilityRole={alert ? 'alert' : undefined}
      testID={testID}
    >
      {`${glyph} ${error}`}
    </LiveText>
  );
}

export interface FieldInputProps extends Omit<TextInputProps, 'style' | 'editable'> {
  /** Draws the error border (the words are the caller's, with `FieldErrorText`). */
  invalid?: boolean;
  editable?: boolean;
  /** Further styles after the shared box (a form's own dimming). */
  style?: StyleProp<TextStyle>;
}

/**
 * The outlined text input of a field, with the focus and theme chrome (`useInputChrome`), and no
 * accessible words of its own: the caller passes `accessibilityLabel`, `accessibilityHint` and
 * `accessibilityState` as it needs them. The error border wins over the focus colour.
 */
export function FieldInput({
  invalid = false,
  editable = true,
  multiline,
  onFocus,
  onBlur,
  style,
  ...input
}: FieldInputProps) {
  const styles = useFieldStyles();
  const chrome = useInputChrome();
  return (
    <TextInput
      {...chrome.props}
      {...input}
      onFocus={(event) => {
        chrome.props.onFocus();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        chrome.props.onBlur();
        onBlur?.(event);
      }}
      editable={editable}
      multiline={multiline}
      style={[
        styles.box,
        styles.input,
        chrome.focusStyle,
        multiline ? styles.multiline : null,
        invalid ? styles.boxError : null,
        editable ? null : styles.boxDisabled,
        style,
      ]}
    />
  );
}

export interface FieldValueProps {
  label: string;
  value: string;
  /**
   * `stacked`: the label above the value (a record's facts). `inline`: label and value on one
   * line, the value at the end, wrapping as text grows.
   */
  layout?: 'stacked' | 'inline';
  /** Both in bold (a total). */
  emphasis?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A read-only "label: value" fact, read by screen readers as one element (SPK-UX-009). */
export function FieldValue({
  label,
  value,
  layout = 'stacked',
  emphasis = false,
  style,
  testID,
}: FieldValueProps) {
  const styles = useFieldValueStyles();
  const inline = layout === 'inline';
  return (
    <View
      style={[inline ? styles.inline : styles.stacked, style]}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
    >
      <Text style={[styles.label, inline && styles.inlineLabel, emphasis && styles.emphasis]}>
        {label}
      </Text>
      <Text style={[styles.value, inline && styles.inlineValue, emphasis && styles.emphasis]}>
        {value}
      </Text>
    </View>
  );
}

const useFieldValueStyles = makeStyles(({ colors }) => ({
  stacked: { gap: spacing.xxs },
  inline: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: spacing.sm,
    paddingVertical: spacing.xxs,
  },
  label: { ...type.footnote, color: colors.textMuted },
  inlineLabel: { flexShrink: 1 },
  value: { ...type.body, color: colors.text },
  inlineValue: { ...fonts.semibold, flexShrink: 1, textAlign: 'right' },
  emphasis: { ...fonts.bold, color: colors.text },
}));
