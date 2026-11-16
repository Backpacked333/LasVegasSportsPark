/**
 * Layout pieces shared by the team screens (SCR-C-21 to SCR-C-29): a thin adapter over the visual
 * system v2 in `src/ui` (ADR-008, Phase 3), kept so existing imports compile while screens move to
 * `src/ui` directly. Every export keeps its props and its accessible output: role, name, state and
 * visible words. Accessibility (SPK-UX-009): every control has a role, a label and its state
 * (checked, disabled, busy); every value row reads as one element "label: value"; text scales with
 * the OS setting.
 *
 * Moved out: `ReasonList` (`ui/ReasonList`), `OfflineNotice` (`ui/OfflineNotice`) and the error
 * detail readers (`api/error-details`), re-exported here. `CommandFailure` became `ui/CommandError`
 * (`wording="team"`).
 */
import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';
import { ChoiceCard } from '../../ui/ChoiceList';
import { Field, FieldErrorText, FieldInput, FieldValue, useFieldStyles } from '../../ui/Field';
import { Section as UiSection } from '../../ui/Section';
import { Text } from '../../ui/Text';
import { layout, makeStyles, spacing } from '../../ui/theme';

export { detailCodeOf, eligibilityReasonsOf, fieldIssuesOf } from '../../api/error-details';
export { OfflineNotice } from '../../ui/OfflineNotice';
export { ReasonList } from '../../ui/ReasonList';

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
  const styles = useStyles();
  return (
    <Text variant="title1" heading style={styles.title}>
      {children}
    </Text>
  );
}

/** A heading inside a section (announced as a header, one level below the section's). */
export function Subheading({ children }: { children: string }) {
  return (
    <Text variant="headline" heading>
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
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}) {
  return <FieldValue label={label} value={value} layout="inline" testID={testID} />;
}

export function ButtonRow({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.buttonRow}>{children}</View>;
}

/** The error of the choice a `RadioRow` belongs to (`RadioGroup error`), read with each row. */
const ChoiceErrorContext = createContext<string | null>(null);

/**
 * A radio row (`ui/ChoiceList` `ChoiceCard`): role and checked state are announced; the mark is a
 * glyph, never colour only. Its name is "Label, Detail". While its group shows an error ("Choose
 * the player to ask."), the error is the row's hint, so it is read with the choice (SPK-UX-009).
 */
export function RadioRow({
  label,
  detail,
  checked,
  onSelect,
  disabled = false,
  testID,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  onSelect: () => void;
  disabled?: boolean;
  testID?: string;
}) {
  const groupError = useContext(ChoiceErrorContext);
  return (
    <ChoiceCard
      option={{ value: label, label, description: detail }}
      mode="single"
      checked={checked}
      disabled={disabled}
      error={groupError}
      onPress={onSelect}
      testID={testID}
    />
  );
}

/**
 * A labelled radio group. `error` (a required choice not made) is the group's and each row's
 * hint, so it is read with the choice; show it under the group with `FieldError`, which announces
 * it when it appears (SPK-UX-009, NA-A01).
 */
export function RadioGroup({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | null;
  children: ReactNode;
}) {
  const styles = useStyles();
  const field = useFieldStyles();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      accessibilityHint={error ? `Error: ${error}` : undefined}
      style={styles.group}
    >
      <Text style={field.label}>{label}</Text>
      <ChoiceErrorContext.Provider value={error ?? null}>{children}</ChoiceErrorContext.Provider>
    </View>
  );
}

/**
 * A choice's (or a field's) error, shown under it and announced to screen readers when it appears
 * (`ui/announce`: a live region on Android, an announcement on iOS; SPK-UX-009, NA-A01), so a
 * person who sends a form without choosing hears why nothing was sent.
 */
export function FieldError({ error, testID }: { error?: string | null; testID?: string }) {
  return <FieldErrorText error={error} glyph="▲" testID={testID} />;
}

/** Labelled text input; the error is part of the accessible label so it is read with the field. */
export function TextField({
  label,
  value,
  onChangeText,
  error,
  hint,
  multiline = false,
  keyboardType,
  autoCapitalize,
  editable = true,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (text: string) => void;
  error?: string | null;
  hint?: string;
  multiline?: boolean;
  keyboardType?: 'default' | 'email-address' | 'phone-pad' | 'decimal-pad';
  autoCapitalize?: 'none' | 'sentences' | 'words';
  editable?: boolean;
  testID?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      <FieldInput
        accessibilityLabel={error ? `${label}. ${error}` : label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: !editable }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        invalid={!!error}
        testID={testID}
      />
      <FieldErrorText error={error} glyph="▲" alert={false} />
    </Field>
  );
}

const useStyles = makeStyles(() => ({
  title: {
    paddingHorizontal: layout.gutter,
    paddingTop: spacing.md,
    paddingBottom: spacing.xs,
  },
  buttonRow: { gap: spacing.sm, paddingTop: spacing.xs },
  group: { gap: spacing.sm },
}));
