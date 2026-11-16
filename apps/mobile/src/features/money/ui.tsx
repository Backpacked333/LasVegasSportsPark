/**
 * Layout pieces for SCR-C-32 to SCR-C-38 (SPK-UX-009, SPK-UX-010): a thin adapter over the visual
 * system v2 in `src/ui` (ADR-008, Phase 3), kept so existing imports compile while screens move to
 * `src/ui` directly. Every export keeps its props and its accessible output: role, name, state and
 * visible words. A section with a header, a labelled value read as one element, a radio group to
 * choose whose records are shown, a checkbox to acknowledge a money consequence, and a labelled
 * text field with its own error. Every interactive element has a role, a label and its state; text
 * scales with the OS setting.
 */
import { createContext, useContext, type ReactNode } from 'react';
import { Pressable, View } from 'react-native';
import { ChoiceCard } from '../../ui/ChoiceList';
import { Field as UiField, FieldErrorText, FieldInput, FieldValue } from '../../ui/Field';
import { Section as UiSection } from '../../ui/Section';
import { Text } from '../../ui/Text';
import {
  continuousCorners,
  fonts,
  makeStyles,
  layout,
  radius,
  spacing,
  type,
} from '../../ui/theme';
import type { AccountPerson } from './people';

/** A titled card (`ui/Section`): the title is announced as a header. */
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
    <UiSection title={title} testID={testID}>
      {children}
    </UiSection>
  );
}

/** "Label: value" read by screen readers as one sentence (`ui/Field` `FieldValue`). */
export function Field({ label, value, testID }: { label: string; value: string; testID?: string }) {
  return <FieldValue label={label} value={value} testID={testID} />;
}

export function Body({ children }: { children: ReactNode }) {
  return <Text variant="body">{children}</Text>;
}

export function Caption({ children }: { children: ReactNode }) {
  return (
    <Text variant="caption" tone="muted">
      {children}
    </Text>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.buttons}>{children}</View>;
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
  layout: arrangement = 'list',
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
  const styles = useStyles();
  return (
    <View
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={error ? `Error: ${error}` : undefined}
      style={arrangement === 'grid' ? styles.grid : styles.list}
      testID={testID}
    >
      <ChoiceErrorContext.Provider value={error ?? null}>{children}</ChoiceErrorContext.Provider>
    </View>
  );
}

/**
 * One radio or checkbox row (`ui/ChoiceList` `ChoiceCard`); the label is the whole row and the
 * state is announced. Its name is "Label, Detail". While its `ChoiceGroup` shows an error, the
 * error is the row's hint.
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
  const styles = useStyles();
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
          groupError ? styles.tileInvalid : null,
          pressed && styles.pressed,
          disabled && styles.dim,
        ]}
        testID={testID}
      >
        <Text variant="body" style={[styles.tileLabel, checked && styles.tileTextOn]}>
          {`${checked ? '✓ ' : ''}${shortLabel ?? label}`}
        </Text>
        {detail ? (
          <Text variant="footnote" tone="muted" style={checked && styles.tileTextOn}>
            {detail}
          </Text>
        ) : null}
      </Pressable>
    );
  }
  return (
    <ChoiceCard
      option={{ value: label, label, description: detail }}
      mode={mode === 'radio' ? 'single' : 'multiple'}
      checked={checked}
      disabled={disabled}
      error={groupError}
      onPress={onPress}
      testID={testID}
    />
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
  const styles = useStyles();
  if (people.length < 2) return null;
  return (
    <View style={styles.picker}>
      <Caption>{label}</Caption>
      <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.list}>
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
 * A labelled text field (`ui/Field`); the error is kept next to the field, announced when it
 * appears (`ui/announce`) and part of the input's hint, so it is read with the field (SPK-UX-008,
 * SPK-UX-009).
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
    <UiField label={label} hint={hint}>
      <FieldInput
        accessibilityLabel={label}
        accessibilityHint={describedBy || undefined}
        accessibilityState={{ disabled: !editable }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline={multiline}
        invalid={!!error}
        testID={testID}
      />
      <FieldError error={error} />
    </UiField>
  );
}

/**
 * A field's or a choice's error, shown under it and announced when it appears (SPK-UX-009): every
 * field error on the money, booking and enrollment screens goes through here.
 */
export function FieldError({ error, testID }: { error?: string | null; testID?: string }) {
  return <FieldErrorText error={error} glyph="▲" testID={testID} />;
}

const useStyles = makeStyles(({ colors }) => ({
  picker: { paddingHorizontal: layout.gutter, paddingVertical: spacing.sm, gap: spacing.xs },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  list: { gap: spacing.sm },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingTop: spacing.xs },
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
  tileOn: { backgroundColor: colors.floodlight, borderColor: colors.onFloodlight, borderWidth: 2 },
  tileInvalid: { borderColor: colors.danger },
  tileTextOn: { color: colors.onFloodlight },
  tileLabel: { ...type.body, ...fonts.extrabold },
  pressed: { opacity: 0.8 },
  dim: { opacity: 0.55 },
}));
