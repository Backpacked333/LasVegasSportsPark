/**
 * Layout pieces shared by the registration screens (SCR-C-07 to SCR-C-16), built on the
 * foundation theme. Accessibility (SPK-UX-009): every control has a role, a label and its state
 * (checked, disabled); every value row reads as one element "label, value"; text scales.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';

export function Section({
  title,
  children,
  testID,
}: {
  title: string;
  children: ReactNode;
  testID?: string;
}) {
  return (
    <View style={styles.section} testID={testID}>
      <Text style={styles.heading} accessibilityRole="header">
        {title}
      </Text>
      {children}
    </View>
  );
}

export function Title({ children }: { children: string }) {
  return (
    <Text style={styles.title} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return <Text style={muted ? styles.caption : styles.body}>{children}</Text>;
}

/** One "label: value" fact, read as a single element by screen readers. */
export function Detail({
  label,
  value,
  emphasis = false,
  testID,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  testID?: string;
}) {
  return (
    <View
      style={styles.detail}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
    >
      <Text style={[styles.detailLabel, emphasis && styles.emphasis]}>{label}</Text>
      <Text style={[styles.detailValue, emphasis && styles.emphasis]}>{value}</Text>
    </View>
  );
}

/** A checkbox or radio row: the role and checked state are announced, never shown by colour only. */
export function ChoiceRow({
  label,
  detail,
  checked,
  onToggle,
  mode = 'checkbox',
  disabled = false,
  testID,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onToggle: () => void;
  mode?: 'checkbox' | 'radio';
  disabled?: boolean;
  testID?: string;
}) {
  const mark = mode === 'checkbox' ? (checked ? '☑' : '☐') : checked ? '◉' : '○';
  return (
    <Pressable
      accessibilityRole={mode}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={({ pressed }) => [styles.choice, pressed && styles.pressed, disabled && styles.off]}
      testID={testID}
    >
      <Text
        style={styles.mark}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {mark}
      </Text>
      <View style={styles.choiceText}>
        <Text style={styles.choiceLabel}>{label}</Text>
        {detail ? <Text style={styles.caption}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

export function TextField({
  label,
  value,
  onChangeText,
  error,
  hint,
  multiline = false,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  error?: string;
  hint?: string;
  multiline?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={styles.caption}>{hint}</Text> : null}
      <TextInput
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        accessibilityHint={hint}
        autoCorrect={false}
        multiline={multiline}
        style={[styles.input, multiline && styles.multiline, error ? styles.inputError : null]}
        testID={testID}
      />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {`✕ ${error}`}
        </Text>
      ) : null}
    </View>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttons}>{children}</View>;
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: { ...type.title, color: colors.text },
  heading: { ...type.heading, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  detail: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  detailLabel: { ...type.body, color: colors.textMuted, flexShrink: 1 },
  detailValue: { ...type.body, color: colors.text, flexShrink: 1, textAlign: 'right' },
  emphasis: { fontWeight: '700', color: colors.text },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.8 },
  off: { opacity: 0.55 },
  mark: { ...type.heading, color: colors.primary },
  choiceText: { flex: 1, gap: 2 },
  choiceLabel: { ...type.body, color: colors.text, fontWeight: '600' },
  field: { gap: spacing.xs },
  fieldLabel: { ...type.body, color: colors.text, fontWeight: '600' },
  input: {
    minHeight: MIN_TOUCH_SIZE,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    ...type.body,
    color: colors.text,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top', paddingVertical: spacing.sm },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  error: { ...type.caption, color: colors.danger },
  buttons: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
});
