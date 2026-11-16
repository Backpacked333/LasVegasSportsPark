/**
 * Layout pieces shared by the registration screens (SCR-C-07 to SCR-C-16): a thin adapter over the
 * visual system v2 in `src/ui` (ADR-008, Phase 3), kept so existing imports compile while screens
 * move to `src/ui` directly. Every export keeps its props and its accessible output: role, name,
 * state and visible words (SPK-UX-009). Every control has a role, a label and its state (checked,
 * disabled); every value row reads as one element "label: value"; text scales.
 */
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { ChoiceCard } from '../../ui/ChoiceList';
import { Field, FieldErrorText, FieldInput, FieldValue } from '../../ui/Field';
import { Section as UiSection } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

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

export function Title({ children }: { children: string }) {
  return (
    <Text variant="title1" heading>
      {children}
    </Text>
  );
}

export function Body({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return muted ? (
    <Text variant="caption" tone="muted">
      {children}
    </Text>
  ) : (
    <Text variant="body">{children}</Text>
  );
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
    <FieldValue label={label} value={value} layout="inline" emphasis={emphasis} testID={testID} />
  );
}

/**
 * A checkbox or radio row (`ui/ChoiceList` `ChoiceCard`): the role and checked state are
 * announced, never shown by colour only. Its name is "Label. Detail".
 */
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
  return (
    <ChoiceCard
      option={{ value: label, label, description: detail }}
      mode={mode === 'radio' ? 'single' : 'multiple'}
      checked={checked}
      disabled={disabled}
      onPress={onToggle}
      accessibilityLabel={detail ? `${label}. ${detail}` : label}
      testID={testID}
    />
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
  const describedBy = [hint, error ? `Error: ${error}` : null].filter(Boolean).join('. ');
  return (
    <Field label={label} hint={hint}>
      <FieldInput
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        accessibilityHint={describedBy || undefined}
        autoCorrect={false}
        multiline={multiline}
        invalid={!!error}
        testID={testID}
      />
      <FieldErrorText error={error} glyph="✕" alert={false} />
    </Field>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.buttons}>{children}</View>;
}

const useStyles = makeStyles(() => ({
  buttons: { gap: spacing.sm, paddingHorizontal: layout.gutter, paddingVertical: spacing.md },
}));
