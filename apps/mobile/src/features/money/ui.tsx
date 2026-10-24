/**
 * Layout pieces for SCR-C-32 to SCR-C-38 (SPK-UX-009, SPK-UX-010): a section with a header, a
 * labelled value read as one element, a radio group to choose whose records are shown, a
 * checkbox to acknowledge a money consequence, and a labelled text field with its own error.
 * Every interactive element has a role, a label and its state; text scales with the OS setting.
 */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';
import type { AccountPerson } from './people';

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

/** "Label: value" read by screen readers as one sentence. */
export function Field({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return (
    <View style={styles.field} accessible accessibilityLabel={`${label}: ${value}`} testID={testID}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue}>{value}</Text>
    </View>
  );
}

export function Body({ children }: { children: ReactNode }) {
  return <Text style={styles.body}>{children}</Text>;
}

export function Caption({ children }: { children: ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>;
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttons}>{children}</View>;
}

function ChoiceMark({ checked, round }: { checked: boolean; round: boolean }) {
  return (
    <View
      style={[styles.mark, round && styles.round, checked && styles.markChecked]}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {checked ? <Text style={styles.markGlyph}>✓</Text> : null}
    </View>
  );
}

/** One radio or checkbox row; the label is the whole row and the state is announced. */
export function ChoiceRow({
  label,
  detail,
  checked,
  onPress,
  mode,
  disabled = false,
  testID,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onPress: () => void;
  mode: 'radio' | 'checkbox';
  disabled?: boolean;
  testID?: string;
}) {
  return (
    <Pressable
      accessibilityRole={mode}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.choice, pressed && styles.pressed, disabled && styles.dim]}
      testID={testID}
    >
      <ChoiceMark checked={checked} round={mode === 'radio'} />
      <View style={styles.choiceText}>
        <Text style={styles.body}>{label}</Text>
        {detail ? <Text style={styles.caption}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

/** Chooses whose records are shown; hidden when the account acts only for itself. */
export function PersonPicker({
  people,
  selected,
  onSelect,
  label,
}: {
  people: readonly AccountPerson[];
  selected: string | null;
  onSelect: (personId: string) => void;
  /** What the choice is for, e.g. "Show enrollments for". */
  label: string;
}) {
  if (people.length < 2) return null;
  return (
    <View style={styles.section}>
      <Text style={styles.caption}>{label}</Text>
      <View accessibilityRole="radiogroup" accessibilityLabel={label}>
        {people.map((person) => (
          <ChoiceRow
            key={person.personId}
            mode="radio"
            label={person.displayName}
            checked={selected === person.personId}
            onPress={() => onSelect(person.personId)}
          />
        ))}
      </View>
    </View>
  );
}

/** A labelled text field; the error is announced and kept next to the field (SPK-UX-008). */
export function TextField({
  label,
  value,
  onChangeText,
  error,
  hint,
  multiline = false,
  editable = true,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  hint?: string;
  multiline?: boolean;
  editable?: boolean;
  testID?: string;
}) {
  return (
    <View style={styles.fieldBox}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={styles.caption}>{hint}</Text> : null}
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: !editable }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline={multiline}
        style={[styles.input, multiline && styles.multiline, error ? styles.inputError : null]}
        testID={testID}
      />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite" accessibilityRole="alert">
          ▲ {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  heading: { ...type.heading, color: colors.text },
  field: { gap: 2 },
  fieldBox: { gap: spacing.xs },
  fieldLabel: { ...type.caption, color: colors.textMuted },
  fieldValue: { ...type.body, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  choiceText: { flex: 1, gap: 2 },
  pressed: { opacity: 0.8 },
  dim: { opacity: 0.55 },
  mark: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: { borderRadius: 12 },
  markChecked: { backgroundColor: colors.primary },
  markGlyph: { color: colors.primaryText, fontWeight: '700' },
  input: {
    ...type.body,
    color: colors.text,
    minHeight: MIN_TOUCH_SIZE,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  error: { ...type.caption, color: colors.danger },
});
