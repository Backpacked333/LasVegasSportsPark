/**
 * Layout pieces shared by the team screens (SCR-C-21 to SCR-C-29): a thin adapter over the visual
 * system v2 in `src/ui` (ADR-008, Phase 3), kept so existing imports compile while screens move to
 * `src/ui` directly. Every export keeps its props and its accessible output: role, name, state and
 * visible words. Accessibility (SPK-UX-009): every control has a role, a label and its state
 * (checked, disabled, busy); every value row reads as one element "label: value"; text scales with
 * the OS setting.
 *
 * Moved out: `ReasonList` (`ui/ReasonList`), `OfflineNotice` (`ui/OfflineNotice`) and the error
 * detail readers (`api/error-details`), re-exported here. `CommandFailure` stays until the three
 * command-failure views are merged.
 */
import { presentationForError, recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { createContext, useContext, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  mayHaveTakenEffect,
  refusedBeforeRunning,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '../../api/command-outcome';
import { detailCodeOf, eligibilityReasonsOf, fieldIssuesOf } from '../../api/error-details';
import { LiveRegion, sentences } from '../../ui/announce';
import { Button } from '../../ui/Button';
import { ChoiceCard } from '../../ui/ChoiceList';
import { Field, FieldErrorText, FieldInput, FieldValue, useFieldStyles } from '../../ui/Field';
import { OutcomeLost } from '../../ui/OutcomeLost';
import { ReasonList } from '../../ui/ReasonList';
import { RefusedBeforeRunning } from '../../ui/RefusedBeforeRunning';
import { Section as UiSection } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
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

/**
 * A failed command (SPK-UX-008): the API's code (with the rule code in `details.code` when there is
 * one), safe message and reference, its recovery action,
 * and the user's input kept by the caller. "Try again" repeats the same intent under the same
 * idempotency key; "Reload" fetches the current record after STALE_REVISION or
 * INVALID_TRANSITION. A refusal (ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED, protected
 * NOT_FOUND) is "not available" with no hint that a record exists (§4.10).
 *
 * An answer after which the command may have taken effect (`mayHaveTakenEffect`: a lost
 * connection or a timeout after sending, IDEMPOTENCY_IN_PROGRESS, INTERNAL_ERROR or another 5xx, a
 * success status whose body could not be read (RESPONSE_UNREADABLE), PAYMENT_OUTCOME_UNKNOWN) is
 * never "Not done" (§4.9, SPK-PAY-007): it reads "No answer yet: this
 * may already have been recorded", and "Check again" repeats the same request under the same key,
 * which the API answers with the stored outcome or runs once. IDEMPOTENCY_OUTCOME_UNAVAILABLE
 * (`tookEffectOutcomeLost`: an earlier attempt committed, its answer lost) is "This may already have
 * been done" with "Reload" (`ui/OutcomeLost`: every API record on screen is read again), never
 * "Not done". IDEMPOTENCY_SECRET_WITHHELD is a success whose one-time link cannot be shown again;
 * screens whose create returns a link show `SecretWithheld` instead, and this never calls it a
 * failure either. A refusal before running (`refusedBeforeRunning`: payments paused while the
 * service recovers from a restore, SPK-AT-028) changed nothing although it is a 503: it is "Not
 * done" with the API's message (`ui/RefusedBeforeRunning`), never "No answer yet". Pass `read` for
 * a failed read: it changed nothing, so it is "Not loaded" and "Try again".
 */
export function CommandFailure({
  error,
  onRetry,
  onReload,
  unavailableText,
  read = false,
  testID = 'command-failure',
}: {
  error: ApiError;
  onRetry?: () => void;
  onReload?: () => void;
  /** What is not available, e.g. "Inviting players is not available to you for this team." */
  unavailableText?: string;
  /** The failure is of a read (a GET), which changes nothing. */
  read?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    return (
      <View testID={testID}>
        <StateView variant="unavailable" description={unavailableText} />
      </View>
    );
  }
  if (presentation === 'turned_off') {
    // ACCESS_DENIED CAPABILITY_DISABLED (K-12): StateView shows it as turned off (DEC-016).
    return (
      <View testID={testID}>
        <StateView variant="error" error={error} />
      </View>
    );
  }
  if (!read && tookEffectOutcomeLost(error)) {
    return (
      <View testID={testID}>
        <OutcomeLost error={error} />
      </View>
    );
  }
  if (!read && refusedBeforeRunning(error)) {
    return (
      <View testID={testID}>
        <RefusedBeforeRunning error={error} onRetry={onRetry} />
      </View>
    );
  }
  const recovery = recoveryActionFor(error);
  const reasons = error.code === 'ELIGIBILITY_FAILED' ? eligibilityReasonsOf(error) : [];
  const issues = error.code === 'VALIDATION_FAILED' ? fieldIssuesOf(error) : [];
  const stale = error.isStale;
  const rule = detailCodeOf(error);
  const unknown = !read && mayHaveTakenEffect(error);
  const withheld = !read && secretWithheldOf(error) !== null;
  const label = unknown
    ? 'No answer yet: this may already have been recorded'
    : withheld
      ? 'Done, but the link cannot be shown again'
      : stale
        ? 'This changed since you opened it'
        : read
          ? 'Not loaded'
          : 'Not done';
  // NA-A01: the announcement ends with the next action, the button's label or the instruction.
  const nextAction =
    stale && onReload
      ? 'Reload'
      : recovery.retry && onRetry
        ? unknown
          ? 'Check again'
          : 'Try again'
        : recovery.label;
  return (
    <LiveRegion
      style={styles.failure}
      testID={testID}
      announcement={sentences(
        label,
        error.message,
        ...issues,
        ...reasons.map((reason) => reason.message),
        nextAction,
      )}
      occurrence={error}
    >
      <StatusBadge tone={unknown || withheld ? 'warning' : 'danger'} label={label} />
      <Text variant="body">{error.message}</Text>
      {issues.map((issue) => (
        <Text key={issue} variant="body">{`▲ ${issue}`}</Text>
      ))}
      {reasons.length > 0 ? <ReasonList reasons={reasons} /> : null}
      <Text variant="caption" tone="muted" selectable>
        {`Error code: ${error.code}${rule ? ` (${rule})` : ''}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
      </Text>
      {stale && onReload ? (
        <Button label="Reload" onPress={onReload} variant="secondary" />
      ) : recovery.retry && onRetry ? (
        <Button
          label={nextAction}
          onPress={onRetry}
          accessibilityHint={
            read ? 'Reads it again' : 'Sends the same request again; it is never applied twice'
          }
        />
      ) : (
        <Text variant="body">{nextAction}</Text>
      )}
    </LiveRegion>
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
  failure: { gap: spacing.sm, paddingVertical: spacing.sm },
}));
