/**
 * Layout pieces for SCR-C-32 to SCR-C-38 (SPK-UX-009, SPK-UX-010): a section with a header, a
 * labelled value read as one element, a radio group to choose whose records are shown, a
 * checkbox to acknowledge a money consequence, and a labelled text field with its own error.
 * Every interactive element has a role, a label and its state; text scales with the OS setting.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SectionCard } from '../../ui/Card';
import { LiveText } from '../../ui/announce';
import { colors, fonts, MIN_TOUCH_SIZE, radius, spacing, type } from '../../ui/theme';
import type { AccountPerson } from './people';

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

/** The error of the choice a `ChoiceRow` belongs to (`ChoiceGroup error`), read with each row. */
const ChoiceErrorContext = createContext<string | null>(null);

/**
 * A group of radio (or checkbox) rows. `error` (a required choice not made) is the group's and
 * each row's hint, so it is read with the choice; show it under the group with `FieldError`, which
 * announces it when it appears (SPK-UX-009, NA-A01).
 */
export function ChoiceGroup({
  label,
  role = 'radiogroup',
  error,
  children,
  layout = 'list',
  testID,
}: {
  label: string;
  role?: 'radiogroup' | 'list';
  error?: string | null;
  children: ReactNode;
  /** `grid`: the choices are tiles side by side (start times), wrapping as text grows. */
  layout?: 'list' | 'grid';
  testID?: string;
}) {
  return (
    <View
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={error ? `Error: ${error}` : undefined}
      style={layout === 'grid' ? styles.grid : null}
      testID={testID}
    >
      <ChoiceErrorContext.Provider value={error ?? null}>{children}</ChoiceErrorContext.Provider>
    </View>
  );
}

/**
 * One radio or checkbox row; the label is the whole row and the state is announced. While its
 * `ChoiceGroup` shows an error, the error is the row's hint.
 *
 * `tile` draws it as a time tile (Book a space): `shortLabel` is shown, the full `label` is read;
 * a chosen tile is floodlight with "✓" before its text, so the choice never rests on colour.
 */
export function ChoiceRow({
  label,
  detail,
  checked,
  onPress,
  mode,
  disabled = false,
  tile = false,
  shortLabel,
  testID,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onPress: () => void;
  mode: 'radio' | 'checkbox';
  disabled?: boolean;
  tile?: boolean;
  shortLabel?: string;
  testID?: string;
}) {
  const groupError = useContext(ChoiceErrorContext);
  if (tile) {
    return (
      <Pressable
        accessibilityRole={mode}
        accessibilityLabel={detail ? `${label}, ${detail}` : label}
        accessibilityHint={groupError ? `Error: ${groupError}` : undefined}
        accessibilityState={{ checked, disabled }}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.tile,
          checked && styles.tileOn,
          pressed && styles.pressed,
          disabled && styles.dim,
        ]}
        testID={testID}
      >
        <Text style={styles.tileLabel}>{`${checked ? '✓ ' : ''}${shortLabel ?? label}`}</Text>
        {detail ? <Text style={styles.tileDetail}>{detail}</Text> : null}
      </Pressable>
    );
  }
  return (
    <Pressable
      accessibilityRole={mode}
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityHint={groupError ? `Error: ${groupError}` : undefined}
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
    <View style={styles.picker}>
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
  const describedBy = [hint, error ? `Error: ${error}` : null].filter(Boolean).join('. ');
  return (
    <View style={styles.fieldBox}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={styles.caption}>{hint}</Text> : null}
      <TextInput
        accessibilityLabel={label}
        accessibilityHint={describedBy || undefined}
        accessibilityState={{ disabled: !editable }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline={multiline}
        style={[styles.input, multiline && styles.multiline, error ? styles.inputError : null]}
        testID={testID}
      />
      <FieldError error={error} />
    </View>
  );
}

/**
 * A field's or a choice's error, shown under it and announced when it appears (SPK-UX-009): every
 * field error on the money, booking and enrollment screens goes through here.
 */
export function FieldError({ error, testID }: { error?: string | null; testID?: string }) {
  if (!error) return null;
  return (
    <LiveText style={styles.error} announcement={error} accessibilityRole="alert" testID={testID}>
      ▲ {error}
    </LiveText>
  );
}

const styles = StyleSheet.create({
  picker: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.xs },
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
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minHeight: 56,
    justifyContent: 'center',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm + 2,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    gap: 2,
  },
  tileOn: { backgroundColor: colors.floodlight, borderColor: colors.night },
  tileLabel: { ...type.body, ...fonts.extrabold, color: colors.text },
  tileDetail: { ...type.caption, fontSize: 12, lineHeight: 16, color: colors.textMuted },
  pressed: { opacity: 0.8 },
  dim: { opacity: 0.55 },
  mark: {
    width: 24,
    height: 24,
    borderWidth: 2,
    borderColor: colors.primary,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  round: { borderRadius: 12 },
  markChecked: { backgroundColor: colors.primary },
  markGlyph: { color: colors.primaryText, ...fonts.bold },
  input: {
    ...type.body,
    color: colors.text,
    minHeight: 48,
    borderWidth: 1,
    borderColor: colors.control,
    borderRadius: radius.md,
    paddingHorizontal: 14,
    paddingVertical: spacing.sm,
    backgroundColor: colors.background,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  inputError: { borderColor: colors.danger, borderWidth: 2 },
  error: { ...type.caption, color: colors.danger },
});
