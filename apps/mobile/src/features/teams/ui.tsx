/**
 * Layout pieces shared by the team screens (SCR-C-21 to SCR-C-29), built on the foundation theme.
 * Accessibility (SPK-UX-009): every control has a role, a label and its state (checked, disabled,
 * busy); every value row reads as one element "label: value"; text scales with the OS setting.
 */
import {
  presentationForError,
  recoveryActionFor,
  type ApiError,
  type Schema,
} from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';
import { roleWords } from './format';
import { severityStatus } from './status';

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

/** A heading inside a section (announced as a header, one level below the section's). */
export function Subheading({ children }: { children: string }) {
  return (
    <Text style={styles.subheading} accessibilityRole="header">
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
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}) {
  return (
    <View
      style={styles.detail}
      accessible
      accessibilityLabel={`${label}: ${value}`}
      testID={testID}
    >
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

export function ButtonRow({ children }: { children: ReactNode }) {
  return <View style={styles.buttonRow}>{children}</View>;
}

/** A radio row: role and checked state are announced; the mark is a glyph, never colour only. */
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
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${label}, ${detail}` : label}
      accessibilityState={{ checked, disabled }}
      disabled={disabled}
      onPress={onSelect}
      style={({ pressed }) => [
        styles.choice,
        pressed && styles.pressed,
        disabled && styles.inactive,
      ]}
      testID={testID}
    >
      <Text
        style={styles.mark}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {checked ? '◉' : '○'}
      </Text>
      <View style={styles.choiceText}>
        <Text style={styles.choiceLabel}>{label}</Text>
        {detail ? <Text style={styles.caption}>{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

export function RadioGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.group}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {children}
    </View>
  );
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
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      {hint ? <Text style={styles.caption}>{hint}</Text> : null}
      <TextInput
        accessibilityLabel={error ? `${label}. ${error}` : label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: !editable }}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        multiline={multiline}
        keyboardType={keyboardType}
        autoCapitalize={autoCapitalize}
        style={[styles.input, multiline && styles.multiline, !editable && styles.inactive]}
        testID={testID}
      />
      {error ? (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {`▲ ${error}`}
        </Text>
      ) : null}
    </View>
  );
}

type Reason = Pick<
  Schema<'EligibilityReason'>,
  'code' | 'severity' | 'message' | 'responsibleRole' | 'requiredAction'
>;

/**
 * Eligibility or readiness reasons with who resolves them (SPK-READY-003, SPK-CAP-004). A rule that
 * needs league approval is shown as a pending approval, never as a denial (SCR-C-26).
 */
export function ReasonList({ reasons, testID }: { reasons: Reason[]; testID?: string }) {
  return (
    <View accessibilityRole="list" style={styles.group} testID={testID}>
      {reasons.map((reason, index) => (
        <View key={`${reason.code}-${index}`} style={styles.reason}>
          <StatusBadge
            {...(reason.code === 'approval_required'
              ? { tone: 'pending' as const, label: 'League approval required' }
              : severityStatus(reason.severity))}
          />
          <Text style={styles.body}>{reason.message}</Text>
          <Text style={styles.caption}>
            {`${roleWords(reason.responsibleRole)}: ${reason.requiredAction}`}
          </Text>
        </View>
      ))}
    </View>
  );
}

function isReason(value: unknown): value is Reason {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.code === 'string' && typeof v.message === 'string';
}

/** `details.reasons` of an ELIGIBILITY_FAILED answer, when the API sent them. */
export function eligibilityReasonsOf(error: ApiError): Reason[] {
  const details = error.details as { reasons?: unknown } | undefined;
  if (!details || !Array.isArray(details.reasons)) return [];
  return details.reasons.filter(isReason).map((r) => ({
    code: r.code,
    severity: (['blocking', 'warning', 'info', 'unknown'] as const).includes(r.severity)
      ? r.severity
      : 'unknown',
    message: r.message,
    responsibleRole: typeof r.responsibleRole === 'string' ? r.responsibleRole : 'league_manager',
    requiredAction: typeof r.requiredAction === 'string' ? r.requiredAction : '',
  }));
}

/** Field issues of a VALIDATION_FAILED answer from the API's request validation. */
export function fieldIssuesOf(error: ApiError): string[] {
  if (!Array.isArray(error.details)) return [];
  return error.details
    .filter(
      (d): d is { path: string; message: string } =>
        !!d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string',
    )
    .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message));
}

/**
 * The rule code of a refusal whose `details` is an object with a `code` (for example the handover
 * rules ROLE_NOT_HELD or CAPTAIN_MUST_BE_ADULT under VALIDATION_FAILED, CMP-13), or null.
 */
export function detailCodeOf(error: ApiError): string | null {
  const details = error.details;
  if (!details || typeof details !== 'object' || Array.isArray(details)) return null;
  const code = (details as { code?: unknown }).code;
  return typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(code) ? code : null;
}

/**
 * A failed command (SPK-UX-008): the API's code (with the rule code in `details.code` when there is
 * one), safe message and reference, its recovery action,
 * and the user's input kept by the caller. "Try again" repeats the same intent under the same
 * idempotency key; "Reload" fetches the current record after STALE_REVISION or
 * INVALID_TRANSITION. A refusal (ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED, protected
 * NOT_FOUND) is "not available" with no hint that a record exists (§4.10).
 */
export function CommandFailure({
  error,
  onRetry,
  onReload,
  unavailableText,
  testID = 'command-failure',
}: {
  error: ApiError;
  onRetry?: () => void;
  onReload?: () => void;
  /** What is not available, e.g. "Inviting players is not available to you for this team." */
  unavailableText?: string;
  testID?: string;
}) {
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
  const recovery = recoveryActionFor(error);
  const reasons = error.code === 'ELIGIBILITY_FAILED' ? eligibilityReasonsOf(error) : [];
  const issues = error.code === 'VALIDATION_FAILED' ? fieldIssuesOf(error) : [];
  const stale = error.isStale;
  const rule = detailCodeOf(error);
  return (
    <View style={styles.failure} testID={testID} accessibilityLiveRegion="polite">
      <StatusBadge
        tone={error.outcomeUnknown ? 'warning' : 'danger'}
        label={
          error.outcomeUnknown
            ? 'No answer yet: this may already have been recorded'
            : stale
              ? 'This changed since you opened it'
              : 'Not done'
        }
      />
      <Text style={styles.body}>{error.message}</Text>
      {issues.map((issue) => (
        <Text key={issue} style={styles.body}>{`▲ ${issue}`}</Text>
      ))}
      {reasons.length > 0 ? <ReasonList reasons={reasons} /> : null}
      <Text style={styles.caption} selectable>
        {`Error code: ${error.code}${rule ? ` (${rule})` : ''}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
      </Text>
      {stale && onReload ? (
        <Button label="Reload" onPress={onReload} variant="secondary" />
      ) : recovery.retry && onRetry ? (
        <Button
          label="Try again"
          onPress={onRetry}
          accessibilityHint="Sends the same request again; it is never applied twice"
        />
      ) : (
        <Text style={styles.body}>{recovery.label}</Text>
      )}
    </View>
  );
}

/** A command that needs a connection while the device is offline (SPK-UX-008, §4.15). */
export function OfflineNotice({ what }: { what: string }) {
  return (
    <View style={styles.notice} accessible accessibilityLabel={`${what} needs a connection`}>
      <StatusBadge tone="warning" label="Needs a connection" />
      <Text style={styles.body}>
        {`${what} needs a connection. Nothing is queued: your entries are kept on this screen.`}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  heading: { ...type.heading, color: colors.text },
  title: {
    ...type.title,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  body: { ...type.body, color: colors.text },
  subheading: { ...type.body, color: colors.text, fontWeight: '700' },
  caption: { ...type.caption, color: colors.textMuted },
  detail: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  detailLabel: { ...type.body, color: colors.textMuted, minWidth: 120 },
  detailValue: { ...type.body, color: colors.text, flexShrink: 1, fontWeight: '600' },
  buttonRow: { gap: spacing.sm, paddingTop: spacing.xs },
  group: { gap: spacing.xs },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  choiceText: { flex: 1 },
  choiceLabel: { ...type.body, color: colors.text },
  mark: { ...type.heading, color: colors.primary },
  pressed: { opacity: 0.7 },
  inactive: { opacity: 0.55 },
  field: { gap: spacing.xs },
  fieldLabel: { ...type.body, color: colors.text, fontWeight: '600' },
  input: {
    ...type.body,
    minHeight: MIN_TOUCH_SIZE,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    backgroundColor: colors.background,
  },
  multiline: { minHeight: 88, textAlignVertical: 'top' },
  error: { ...type.caption, color: colors.danger },
  reason: { gap: spacing.xs, paddingVertical: spacing.xs },
  failure: { gap: spacing.sm, paddingVertical: spacing.sm },
  notice: { gap: spacing.xs, paddingVertical: spacing.xs },
});
