/**
 * Date fields (ADR-008, **Proposed** visual system v2). Values are plain ISO calendar dates
 * (`2026-11-18`), never instants: a date of birth or a camp week is the same day on every clock.
 *
 * - On iOS and Android: a field-styled button showing the date in words; it opens the system date
 *   picker (`@react-native-community/datetimepicker`): inline in a `Sheet` on iOS, the system
 *   dialog on Android.
 * - On the web and in Jest: a text input for `YYYY-MM-DD`, checked as it is typed and when it
 *   loses focus, with the error in words (SPK-UX-008: what was typed is kept).
 *
 * `DateRangeField` is two of them (start and end) in one labelled group; the end may not be before
 * the start. Accessibility (SPK-UX-009): the name is the label, the date is read in full
 * ("Tuesday 18 November 2026"), the hint and error are read after it (`fieldAccessibility`).
 * A change plays the selection haptic. Native pickers are not verified here (§6.2).
 */
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useEffect, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSelectionHaptic } from './ChoiceList';
import { Field, fieldAccessibility, useFieldStyles, type FieldBaseProps } from './Field';
import { Icon } from './Icon';
import { useInputChrome } from './input';
import { Sheet } from './Sheet';
import { makeStyles, spacing, useTheme } from './theme';

// Calendar dates -----------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;
export const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** Midnight UTC of an ISO date, or null when it is not a real calendar date. */
function utcOf(iso: string): number | null {
  const match = ISO_DATE.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const time = Date.UTC(y, m - 1, d);
  const back = new Date(time);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) {
    return null;
  }
  return time;
}

function isoOfUtc(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** Whether `iso` is a real calendar date written `YYYY-MM-DD` ("2026-02-30" is not). */
export function isIsoDate(iso: string): boolean {
  return utcOf(iso) !== null;
}

/** The ISO date `days` calendar days after `iso` (negative goes back). */
export function addIsoDays(iso: string, days: number): string {
  const time = utcOf(iso);
  if (time === null) throw new Error(`Not an ISO date: ${iso}`);
  return isoOfUtc(time + days * DAY_MS);
}

/** 0 for Sunday to 6 for Saturday. */
export function isoWeekday(iso: string): number {
  const time = utcOf(iso);
  if (time === null) throw new Error(`Not an ISO date: ${iso}`);
  return new Date(time).getUTCDay();
}

/** "Tuesday 18 November 2026" (without the year when `withYear` is false). */
export function fullDateName(iso: string, withYear = true): string {
  const time = utcOf(iso);
  if (time === null) return iso;
  const date = new Date(time);
  const words = `${WEEKDAYS[date.getUTCDay()]} ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
  return withYear ? `${words} ${date.getUTCFullYear()}` : words;
}

/** The ISO date of a picker's `Date`, read on the device's clock (the picker works in it). */
function isoOfLocal(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of an ISO date, for the picker. */
function localOf(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Why typed text is not an acceptable date, or null when it is. */
export function dateProblem(
  text: string,
  bounds: { minimumDate?: string; maximumDate?: string } = {},
): string | null {
  if (!isIsoDate(text)) return 'Enter the date as year-month-day, for example 2026-11-18.';
  if (bounds.minimumDate && text < bounds.minimumDate) {
    return `Choose ${fullDateName(bounds.minimumDate)} or later.`;
  }
  if (bounds.maximumDate && text > bounds.maximumDate) {
    return `Choose ${fullDateName(bounds.maximumDate)} or earlier.`;
  }
  return null;
}

// Presentation --------------------------------------------------------------------------------

export type DatePresentation = 'picker' | 'text';

/** The system picker on iOS and Android; typed text on the web and under Jest. */
export function datePresentationFor(runtime: { os: string; test: boolean }): DatePresentation {
  if (runtime.test) return 'text';
  return runtime.os === 'ios' || runtime.os === 'android' ? 'picker' : 'text';
}

const PRESENTATION = datePresentationFor({
  os: Platform.OS,
  test: process.env.NODE_ENV === 'test',
});

/** The hint of a typed date field when none is given. */
export const TYPED_DATE_HINT = 'Year-month-day, for example 2026-11-18';

// DateField -----------------------------------------------------------------------------------

export interface DateFieldProps extends FieldBaseProps {
  /** The chosen date (`YYYY-MM-DD`), or null for none. */
  value: string | null;
  /** A valid date, or null when the field was emptied or its text is not a usable date. */
  onChange: (value: string | null) => void;
  minimumDate?: string;
  maximumDate?: string;
  /** What the button shows with no date (device picker). */
  placeholder?: string;
  disabled?: boolean;
  /** `DateTimePicker` presentation for previews; the runtime's by default. */
  presentation?: DatePresentation;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function DateField({ presentation = PRESENTATION, ...props }: DateFieldProps) {
  return presentation === 'picker' ? <PickerDateField {...props} /> : <TextDateField {...props} />;
}

function TextDateField({
  label,
  hint,
  error,
  required,
  value,
  onChange,
  minimumDate,
  maximumDate,
  disabled = false,
  style,
  testID,
}: Omit<DateFieldProps, 'presentation'>) {
  const styles = useFieldStyles();
  const chrome = useInputChrome();
  const haptic = useSelectionHaptic();
  const [text, setText] = useState(value ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  // The value this field last reported: a new `value` from above replaces the text, the echo of
  // what was typed does not.
  const reported = useRef(value);
  useEffect(() => {
    if (value === reported.current) return;
    reported.current = value;
    setText(value ?? '');
    setProblem(null);
  }, [value]);

  const report = (next: string | null) => {
    if (next === reported.current) return;
    reported.current = next;
    if (next !== null) haptic();
    onChange(next);
  };

  const check = (typed: string, final: boolean) => {
    const trimmed = typed.trim();
    if (trimmed === '') {
      setProblem(null);
      report(null);
      return;
    }
    const why = dateProblem(trimmed, { minimumDate, maximumDate });
    if (why === null) {
      setProblem(null);
      report(trimmed);
    } else if (final || trimmed.length >= 10) {
      setProblem(why);
      report(null);
    }
  };

  const shown = error ?? problem;
  const shownHint = hint ?? TYPED_DATE_HINT;
  return (
    <Field label={label} hint={shownHint} error={shown} required={required} style={style}>
      <TextInput
        {...chrome.props}
        onBlur={() => {
          chrome.props.onBlur();
          check(text, true);
        }}
        value={text}
        onChangeText={(typed) => {
          setText(typed);
          check(typed, false);
        }}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        autoCorrect={false}
        autoCapitalize="none"
        maxLength={10}
        editable={!disabled}
        {...fieldAccessibility({ label, hint: shownHint, error: shown, required })}
        accessibilityState={{ disabled }}
        style={[
          styles.box,
          styles.input,
          chrome.focusStyle,
          shown ? styles.boxError : null,
          disabled ? styles.boxDisabled : null,
        ]}
        testID={testID}
      />
    </Field>
  );
}

function PickerDateField({
  label,
  hint,
  error,
  required,
  value,
  onChange,
  minimumDate,
  maximumDate,
  placeholder = 'Choose a date',
  disabled = false,
  style,
  testID,
}: Omit<DateFieldProps, 'presentation'>) {
  const styles = useFieldStyles();
  const own = useStyles();
  const theme = useTheme();
  const haptic = useSelectionHaptic();
  const [open, setOpen] = useState(false);
  const trigger = useRef<View>(null);
  const initial = value ?? minimumDate ?? null;

  const choose = (date: Date) => {
    const iso = isoOfLocal(date);
    if (iso === value) return;
    haptic();
    onChange(iso);
  };
  const bounds = {
    ...(minimumDate ? { minimumDate: localOf(minimumDate) } : {}),
    ...(maximumDate ? { maximumDate: localOf(maximumDate) } : {}),
  };
  const press = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: initial ? localOf(initial) : new Date(),
        mode: 'date',
        ...bounds,
        onValueChange: (_event, date) => choose(date),
      });
      return;
    }
    setOpen(true);
  };

  return (
    <Field label={label} hint={hint} error={error} required={required} style={style}>
      <Pressable
        ref={trigger}
        onPress={press}
        disabled={disabled}
        accessibilityRole="button"
        {...fieldAccessibility({ label, hint, error, required })}
        accessibilityValue={{ text: value ? fullDateName(value) : placeholder }}
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
        <Text style={value ? styles.value : styles.placeholder}>
          {value ? fullDateName(value) : placeholder}
        </Text>
        <Icon name="calendar_today" size={20} color={theme.colors.textMuted} />
      </Pressable>
      {Platform.OS === 'ios' ? (
        <Sheet
          open={open}
          onClose={() => setOpen(false)}
          title={label}
          returnFocusTo={trigger}
          closeLabel="Done"
        >
          <View style={own.picker}>
            <DateTimePicker
              value={initial ? localOf(initial) : new Date()}
              mode="date"
              display="inline"
              themeVariant={theme.dark ? 'dark' : 'light'}
              accentColor={theme.colors.primary}
              {...bounds}
              onValueChange={(_event, date) => choose(date)}
            />
          </View>
        </Sheet>
      ) : null}
    </Field>
  );
}

// DateRangeField ------------------------------------------------------------------------------

export interface DateRange {
  start: string | null;
  end: string | null;
}

export interface DateRangeFieldProps extends Omit<FieldBaseProps, 'error'> {
  value: DateRange;
  onChange: (value: DateRange) => void;
  startLabel?: string;
  endLabel?: string;
  minimumDate?: string;
  maximumDate?: string;
  /** An error of the whole range, shown under both dates. */
  error?: string | null;
  disabled?: boolean;
  presentation?: DatePresentation;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export const END_BEFORE_START = "The end date can't be before the start date.";

/** A start and an end date in one group; the end may not be before the start. */
export function DateRangeField({
  label,
  hint,
  error,
  required,
  value,
  onChange,
  startLabel = 'Start date',
  endLabel = 'End date',
  minimumDate,
  maximumDate,
  disabled,
  presentation,
  style,
  testID,
}: DateRangeFieldProps) {
  const styles = useStyles();
  const reversed = value.start !== null && value.end !== null && value.end < value.start;
  return (
    <Field label={label} hint={hint} error={error} required={required} style={style}>
      <View style={styles.range} accessibilityLabel={label} testID={testID}>
        <DateField
          label={startLabel}
          value={value.start}
          onChange={(start) => onChange({ ...value, start })}
          minimumDate={minimumDate}
          maximumDate={value.end ?? maximumDate}
          required={required}
          disabled={disabled}
          presentation={presentation}
          style={styles.rangeItem}
        />
        <DateField
          label={endLabel}
          value={value.end}
          onChange={(end) => onChange({ ...value, end })}
          minimumDate={value.start ?? minimumDate}
          maximumDate={maximumDate}
          required={required}
          error={reversed ? END_BEFORE_START : null}
          disabled={disabled}
          presentation={presentation}
          style={styles.rangeItem}
        />
      </View>
    </Field>
  );
}

const useStyles = makeStyles(() => ({
  picker: { alignItems: 'center', paddingBottom: spacing.md },
  range: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  rangeItem: { flexGrow: 1, flexBasis: 150 },
}));
