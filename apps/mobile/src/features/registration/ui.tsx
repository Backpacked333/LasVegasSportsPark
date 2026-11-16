/**
 * Layout pieces shared by the registration screens (SCR-C-07 to SCR-C-16), built on the
 * foundation theme. Accessibility (SPK-UX-009): every control has a role, a label and its state
 * (checked, disabled); every value row reads as one element "label, value"; text scales.
 */
import type { ReactNode } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { SectionCard } from '../../ui/Card';
import { LiveText } from '../../ui/announce';
import { useInputChrome } from '../../ui/input';
import { fonts, makeStyles, MIN_TOUCH_SIZE, radius, spacing, type } from '../../ui/theme';

/** A titled card (`ui/Card` `SectionCard`): uppercase title announced as a header. */
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
    <SectionCard title={title} testID={testID}>
      {children}
    </SectionCard>
  );
}

export function Title({ children }: { children: string }) {
  const styles = useStyles();
  return (
    <Text style={styles.title} accessibilityRole="header">
      {children}
    </Text>
  );
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  const styles = useStyles();
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
  const styles = useStyles();
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
  const styles = useStyles();
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

/**
 * A labelled text field; the error is kept next to the field, announced when it appears
 * (`ui/announce`) and part of the input's hint, so it is read with the field (SPK-UX-008, SPK-UX-009).
 */
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
  const styles = useStyles();
  const input = useInputChrome();
  const describedBy = [hint, error ? `Error: ${error}` : null].filter(Boolean).join('. ');
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={styles.caption}>{hint}</Text> : null}
      <TextInput
        {...input.props}
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        accessibilityHint={describedBy || undefined}
        autoCorrect={false}
        multiline={multiline}
        style={[
          styles.input,
          input.focusStyle,
          multiline && styles.multiline,
          error ? styles.inputError : null,
        ]}
        testID={testID}
      />
      {error ? (
        <LiveText style={styles.error} announcement={error}>
          {`✕ ${error}`}
        </LiveText>
      ) : null}
    </View>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.buttons}>{children}</View>;
}

const useStyles = makeStyles(({ colors }) => ({
  title: { ...type.display, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  detail: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 8 },
  detailLabel: { ...type.caption, color: colors.textMuted, flexShrink: 1, paddingTop: 1 },
  detailValue: {
    ...type.body,
    ...fonts.semibold,
    color: colors.text,
    flexShrink: 1,
    textAlign: 'right',
  },
  emphasis: { ...fonts.bold, color: colors.text },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: { opacity: 0.8 },
  off: { opacity: 0.55 },
  mark: { ...type.heading, fontSize: 22, color: colors.primary },
  choiceText: { flex: 1, gap: 2 },
  choiceLabel: { ...type.body, color: colors.text, ...fonts.semibold },
  field: { gap: spacing.xs },
  fieldLabel: { ...type.body, color: colors.text, ...fonts.semibold },
  input: {
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.control,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    ...type.body,
    color: colors.text,
    backgroundColor: colors.background,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top', paddingVertical: spacing.sm },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  error: { ...type.caption, color: colors.danger },
  buttons: { gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
}));
