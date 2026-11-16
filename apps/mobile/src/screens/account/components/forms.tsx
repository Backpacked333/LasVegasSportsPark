/**
 * Form controls for the account screens (SCR-C-01, SCR-C-17, SCR-C-31, SCR-C-36): a thin adapter
 * over the visual system v2 in `src/ui` (ADR-008, Phase 3), kept so existing imports compile while
 * screens move to `src/ui` directly. Every export keeps its props and its accessible output: role,
 * name, state and visible words. SPK-UX-009: every control has a role, an accessible name and its
 * state (checked, selected, disabled) exposed to VoiceOver and TalkBack; selection is shown with a
 * glyph and words, never colour alone; text scales with the OS setting; touch targets are at least
 * 44 pt. Field errors keep the input (SPK-UX-008 "Recoverable failures must preserve valid user
 * input").
 */
import type { ReactNode } from 'react';
import { StyleSheet, Switch, View } from 'react-native';
import { sentences } from '../../../ui/announce';
import { ChoiceCard } from '../../../ui/ChoiceList';
import { Field, FieldErrorText, FieldInput, useFieldStyles } from '../../../ui/Field';
import { Text } from '../../../ui/Text';
import { layout, makeStyles, MIN_TOUCH_SIZE, spacing, useTheme } from '../../../ui/theme';

export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  const styles = useStyles();
  return (
    <View style={styles.section}>
      <Text variant="title3" heading>
        {title}
      </Text>
      {detail ? <Text variant="body">{detail}</Text> : null}
    </View>
  );
}

/** Body text; `inset={false}` inside a container that already has the side padding. */
export function Paragraph({
  children,
  muted = false,
  inset = true,
}: {
  children: ReactNode;
  muted?: boolean;
  inset?: boolean;
}) {
  const styles = useStyles();
  return (
    <Text variant="body" tone={muted ? 'muted' : 'default'} style={inset && styles.inset}>
      {children}
    </Text>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  /** Field-level validation message (SPK-UX-008 validation failure). */
  error?: string | null;
  hint?: string;
  editable?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad';
  autoComplete?: 'email' | 'tel' | 'off';
  testID?: string;
}

/** A labelled text field (`ui/Field`); its error is announced and read with the input. */
export function TextField({
  label,
  value,
  onChangeText,
  error,
  hint,
  editable = true,
  keyboardType = 'default',
  autoComplete = 'off',
  testID,
}: TextFieldProps) {
  const styles = useStyles();
  const describedBy = [hint, error ? `Error: ${error}` : null].filter(Boolean).join('. ');
  return (
    <Field label={label} hint={hint} style={styles.inset}>
      <FieldInput
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={autoComplete}
        keyboardType={keyboardType}
        accessibilityLabel={label}
        accessibilityHint={describedBy || undefined}
        accessibilityState={{ disabled: !editable }}
        invalid={!!error}
        testID={testID}
      />
      <FieldErrorText error={error} glyph="✕" />
    </Field>
  );
}

export interface ChoiceOption<V extends string> {
  value: V;
  label: string;
  detail?: string;
  disabled?: boolean;
}

/** A labelled radio group; its rows are `RadioRow`s (or `ChoiceGroup` for plain options). */
export function RadioGroup({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  const field = useFieldStyles();
  return (
    <View
      style={[styles.group, styles.inset]}
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
    >
      <Text style={field.label}>{label}</Text>
      {children}
    </View>
  );
}

/** One radio row (`ui/ChoiceList` `ChoiceCard`), named "Label, Detail". */
export function RadioRow({
  label,
  detail,
  checked,
  onPress,
  disabled = false,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <ChoiceCard
      option={{ value: label, label, description: detail }}
      mode="single"
      checked={checked}
      disabled={disabled}
      onPress={onPress}
    />
  );
}

/** Single choice among plain options. */
export function ChoiceGroup<V extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly ChoiceOption<V>[];
  value: V | null;
  onChange: (value: V) => void;
  disabled?: boolean;
}) {
  return (
    <RadioGroup label={label}>
      {options.map((option) => (
        <RadioRow
          key={option.value}
          label={option.label}
          detail={option.detail}
          checked={option.value === value}
          disabled={disabled || option.disabled === true}
          onPress={() => onChange(option.value)}
        />
      ))}
    </RadioGroup>
  );
}

/**
 * One independent yes/no choice (checkbox, `ChoiceCard`); no choice implies another
 * (SPK-IAM-003). Its name is the label and its detail is its hint. `error` is the error of a
 * required choice among the rows ("Choose at least one permission to pass on."): it is read with
 * each row, after its detail (SPK-UX-009).
 */
export function CheckboxRow({
  label,
  detail,
  checked,
  onChange,
  disabled = false,
  error,
  testID,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  error?: string | null;
  testID?: string;
}) {
  return (
    <ChoiceCard
      option={{ value: label, label, description: detail }}
      mode="multiple"
      checked={checked}
      disabled={disabled}
      error={error}
      onPress={() => onChange(!checked)}
      accessibilityLabel={label}
      accessibilityHint={error ? sentences(detail, `Error: ${error}`) : detail}
      testID={testID}
    />
  );
}

/**
 * An on/off setting: the switch plus the words "On" or "Off" (never the switch colour alone).
 *
 * Unlike `ui/SwitchRow`, where the whole row is the switch, the switch itself stays the control
 * that screen readers reach (role, name, checked state and hint), as it always was here; the row
 * draws with the v2 text styles.
 */
export function SwitchRow({
  label,
  accessibilityLabel,
  detail,
  value,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  /** When the visible label needs its section for context, e.g. "Email for essential notices". */
  accessibilityLabel?: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  const { colors } = useTheme();
  const styles = useStyles();
  const field = useFieldStyles();
  return (
    <View style={styles.switchRow}>
      <View style={styles.switchText}>
        <Text style={field.label}>{label}</Text>
        <Text variant="footnote" tone="muted">
          {value ? 'On' : 'Off'}
          {detail ? `. ${detail}` : ''}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        trackColor={{ false: colors.control, true: colors.primary }}
        ios_backgroundColor={colors.control}
        accessibilityRole="switch"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={detail}
        accessibilityState={{ checked: value, disabled }}
        testID={testID}
      />
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  section: { paddingHorizontal: layout.gutter, paddingTop: spacing.xl, gap: spacing.xs },
  inset: { paddingHorizontal: layout.gutter },
  group: { gap: spacing.sm },
  switchText: { flex: 1, gap: spacing.xxs },
  switchRow: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
}));
