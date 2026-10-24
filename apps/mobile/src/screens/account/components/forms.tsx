/**
 * Form controls for the account screens (SCR-C-01, SCR-C-17, SCR-C-31, SCR-C-36), SPK-UX-009:
 * every control has a role, an accessible name and its state (checked, selected, disabled) exposed
 * to VoiceOver and TalkBack; selection is shown with a glyph and words, never colour alone; text
 * scales with the OS setting; touch targets are at least 44 pt. Field errors keep the input
 * (SPK-UX-008 "Recoverable failures must preserve valid user input").
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../../ui/theme';

export function SectionHeader({ title, detail }: { title: string; detail?: string }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle} accessibilityRole="header">
        {title}
      </Text>
      {detail ? <Text style={styles.body}>{detail}</Text> : null}
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
  return (
    <Text style={[styles.paragraph, !inset && styles.flush, muted && styles.muted]}>
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
  const describedBy = [hint, error ? `Error: ${error}` : null].filter(Boolean).join('. ');
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      {hint ? <Text style={styles.caption}>{hint}</Text> : null}
      <TextInput
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
        style={[styles.input, error ? styles.inputError : null, !editable && styles.disabled]}
        testID={testID}
      />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite" accessibilityRole="alert">
          ✕ {error}
        </Text>
      ) : null}
    </View>
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
  return (
    <View style={styles.field} accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text style={styles.label}>{label}</Text>
      {children}
    </View>
  );
}

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
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
    >
      <Text
        style={styles.glyph}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {checked ? '◉' : '○'}
      </Text>
      <View style={styles.choiceText}>
        <Text style={[styles.body, disabled && styles.muted]}>{label}</Text>
        {detail ? <Text style={styles.caption}>{detail}</Text> : null}
      </View>
    </Pressable>
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

/** One independent yes/no choice (checkbox); no choice implies another (SPK-IAM-003). */
export function CheckboxRow({
  label,
  detail,
  checked,
  onChange,
  disabled = false,
  testID,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={label}
      accessibilityHint={detail}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={() => onChange(!checked)}
      style={({ pressed }) => [styles.choice, pressed && styles.pressed]}
      testID={testID}
    >
      <Text
        style={styles.glyph}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {checked ? '☑' : '☐'}
      </Text>
      <View style={styles.choiceText}>
        <Text style={[styles.body, disabled && styles.muted]}>{label}</Text>
        {detail ? <Text style={styles.caption}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

/** An on/off setting: the switch plus the words "On" or "Off" (never the switch colour alone). */
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
  return (
    <View style={styles.switchRow}>
      <View style={styles.choiceText}>
        <Text style={styles.body}>{label}</Text>
        <Text style={styles.caption}>
          {value ? 'On' : 'Off'}
          {detail ? `. ${detail}` : ''}
        </Text>
      </View>
      <Switch
        value={value}
        onValueChange={onChange}
        disabled={disabled}
        accessibilityRole="switch"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={detail}
        accessibilityState={{ checked: value, disabled }}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, gap: spacing.xs },
  sectionTitle: { ...type.heading, color: colors.text },
  paragraph: { ...type.body, color: colors.text, paddingHorizontal: spacing.lg },
  flush: { paddingHorizontal: 0 },
  body: { ...type.body, color: colors.text },
  muted: { color: colors.textMuted },
  caption: { ...type.caption, color: colors.textMuted },
  field: { gap: spacing.xs, paddingHorizontal: spacing.lg },
  label: { ...type.body, fontWeight: '600', color: colors.text },
  input: {
    ...type.body,
    minHeight: MIN_TOUCH_SIZE,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    color: colors.text,
  },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  disabled: { backgroundColor: colors.surface },
  error: { ...type.caption, color: colors.danger },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.xs,
  },
  choiceText: { flex: 1, gap: 2 },
  glyph: { ...type.heading, color: colors.primary, width: 24, textAlign: 'center' },
  pressed: { opacity: 0.7 },
  switchRow: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
});
