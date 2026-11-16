/**
 * CommandError: how every customer screen shows a failed command (SPK-UX-008, §4.9, §4.10, §4.14,
 * SPK-PAY-007, SPK-AT-028; ADR-008). It replaces the four failure views the feature folders had
 * (the account `CommandError`, the teams and money `CommandFailure`s and the registration
 * `CommandError`): one decision, made only with the predicates of `src/api/command-outcome.ts`,
 * in this order:
 *
 * 1. No error: nothing.
 * 2. Protected NOT_FOUND or a permission restriction (ACCESS_DENIED, PARTICIPANT_AUTHORITY_REQUIRED):
 *    "not available", never "exists but denied" (§4.10). `notFound`, `denied` or `unavailableText`
 *    give the screen's words.
 * 3. A capability the organization turned off (ACCESS_DENIED `CAPABILITY_DISABLED`, K-12): the
 *    turned-off state (`StateView`), never a failure.
 * 4. `read`: the failure of a read (a GET) changed nothing, so it is a read that did not load, with
 *    "Try again".
 * 5. `tookEffectOutcomeLost` (IDEMPOTENCY_OUTCOME_UNAVAILABLE): "This may already have been done"
 *    with "Reload" (`OutcomeLost`).
 * 6. `refusedBeforeRunning` (payments paused while the service recovers, SPK-AT-028): "Not done"
 *    with the API's message, or "Check not run" for a re-check (`RefusedBeforeRunning`).
 * 7. `secretWithheldOf` (IDEMPOTENCY_SECRET_WITHHELD): done, but its one-time link cannot be shown
 *    again; never a failure.
 * 8. `mayHaveTakenEffect` (no definite answer): "No answer yet", never "Not done" or "Something
 *    went wrong". "Check again" repeats the same request under the same idempotency key, which the
 *    API answers with the stored outcome or runs once. `payment`: the command was a payment, so it
 *    reads "Payment outcome being confirmed. Do not pay again." (SPK-PAY-007).
 * 9. A stale version (STALE_REVISION, INVALID_TRANSITION): "This changed since you opened it" or
 *    the error state, with "Reload" (`onReload`); the screen keeps the person's input.
 * 10. Anything else: the API's safe message and its permitted next action ("Try again" repeats the
 *     same intent; otherwise the instruction, or the registration recoveries `onRequote`,
 *     `onCompleteForms`, `onAlternatives`), with the API's field issues and eligibility reasons.
 *
 * The error code (with the rule code a refusal names) and the correlation reference are in the
 * "Details for support" fold (`SupportDetails`), as in `StateView` (PA-11, SPK-UX-011
 * **Proposed**). Every answer is announced when it appears (`ui/announce`: a live region on
 * Android, an announcement on iOS) with its next action (SPK-UX-009, NA-A01), never with a code.
 *
 * `wording`: each family of screens keeps the words it had, so no announcement changed in the
 * merge: `general` (the account, family, inbox, preferences and support screens), `team` (team and
 * RSVP screens: one labelled box for every outcome, with the issues and reasons in it), `money`
 * (bookings, enrollments, memberships, packages and payments; `what` names the command) and
 * `registration` (cart, checkout, forms and waitlist; PAYMENT_OUTCOME_UNKNOWN reads as a payment).
 * Where the words differ is listed in `NO_ANSWER`; bringing them together is a wording change.
 * "Check again" needs a connection in the money and registration wordings (R3-SCREEN-STATES-01).
 */
import { presentationForError, recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { Text, View } from 'react-native';
import {
  mayHaveTakenEffect,
  refusedBeforeRunning,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '../api/command-outcome';
import { detailCodeOf, eligibilityReasonsOf, fieldIssuesOf } from '../api/error-details';
import { useConnectivity } from '../providers/AppProviders';
import { LiveRegion, sentences } from './announce';
import { Button } from './Button';
import { OutcomeLost } from './OutcomeLost';
import { QueryErrorView } from './QueryBoundary';
import { ReasonList, type EligibilityReason } from './ReasonList';
import { RefusedBeforeRunning } from './RefusedBeforeRunning';
import { StateView } from './StateView';
import { StatusBadge } from './StatusBadge';
import { SupportDetails } from './SupportDetails';
import { fonts, makeStyles, spacing, type } from './theme';

export type CommandErrorWording = 'general' | 'team' | 'money' | 'registration';

/** Words for "not available" on a screen (a protected NOT_FOUND or a permission restriction). */
export interface NotAvailableCopy {
  title?: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

export interface CommandErrorProps {
  error: ApiError | null;
  /** Repeat the same intent under the same idempotency key (or read again, for a `read`). */
  onRetry?: () => void;
  /** STALE_REVISION, INVALID_TRANSITION: read the current record again. */
  onReload?: () => void;
  /** Which family of screens' words (see the header); `general` by default. */
  wording?: CommandErrorWording;
  /** The failure is of a read (a GET), which changes nothing. */
  read?: boolean;
  /** What the command was, for the wording: "the cancellation". */
  what?: string;
  /** The command was a payment: an open outcome says "Do not pay again" (SPK-PAY-007). */
  payment?: boolean;
  /** Words for a protected NOT_FOUND. */
  notFound?: NotAvailableCopy;
  /** Words for ACCESS_DENIED or PARTICIPANT_AUTHORITY_REQUIRED. */
  denied?: NotAvailableCopy;
  /** What is not available, whatever the reason ("Inviting players is not available to you."). */
  unavailableText?: string;
  /** QUOTE_EXPIRED: get a new price. */
  onRequote?: () => void;
  /** MISSING_ACKNOWLEDGMENT: open the required forms. */
  onCompleteForms?: () => void;
  /** CAPACITY_UNAVAILABLE, ELIGIBILITY_FAILED: show the waitlist or other alternatives. */
  onAlternatives?: () => void;
  /** The frame's test id; `command-failure` (team) and `command-error` (registration) by default. */
  testID?: string;
}

export const NO_ANSWER_LABEL = 'No answer yet: this may already have been recorded';
export const PAYMENT_UNKNOWN_LABEL = 'Payment outcome being confirmed. Do not pay again.';
export const STALE_LABEL = 'This changed since you opened it';
export const SECRET_WITHHELD_LABEL = 'Done, but the link cannot be shown again';

/** What "No answer yet" says in each wording (the team wording shows the API's message). */
const NO_ANSWER: Record<Exclude<CommandErrorWording, 'team'>, (what: string) => string> = {
  general: () =>
    'There was no definite answer, so this may already have been done. Checking again is safe: it sends the same request, which is never applied twice.',
  money: (what) =>
    `We did not get a definite answer about ${what}. It may already have been made. Checking again is safe: it cannot apply ${what} twice.`,
  registration: () =>
    'There was no definite answer, so this may already have gone through. Checking again is safe: it sends the same request, so nothing happens twice.',
};

/** A payment left without an answer (`payment`), when the API sent no words of its own. */
const PAYMENT_NO_ANSWER =
  'We did not get a definite answer about this payment. Checking again is safe: it asks with the same request, which can never charge you twice.';

const MONEY_DENIED =
  'This is not available to your account. A guardian who holds this permission, or the front desk, can help.';

const REGISTRATION_DENIED: Record<string, string> = {
  PARTICIPANT_AUTHORITY_REQUIRED:
    'Your account does not have the permission this needs for this participant. The person who manages their account can give you access.',
  ACCESS_DENIED: 'This is not available to your account.',
};

const DEFAULT_TEST_ID: Record<CommandErrorWording, string | undefined> = {
  general: undefined,
  team: 'command-failure',
  money: undefined,
  registration: 'command-error',
};

export function CommandError(props: CommandErrorProps) {
  const { error, wording = 'general' } = props;
  const testID = props.testID ?? DEFAULT_TEST_ID[wording];
  if (!error) return null;
  const content = <Outcome {...props} error={error} wording={wording} />;
  return testID ? <View testID={testID}>{content}</View> : content;
}

type OutcomeProps = CommandErrorProps & { error: ApiError; wording: CommandErrorWording };

function Outcome(props: OutcomeProps) {
  const { error, wording, onRetry, read = false } = props;
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') {
    return <StateView variant="unavailable" {...notAvailableCopy(props)} />;
  }
  // K-12, DEC-016: StateView shows a capability turned off as such.
  if (presentation === 'turned_off') return <StateView variant="error" error={error} />;
  if (read) {
    if (wording === 'team') return <TeamOutcome {...props} />;
    return onRetry ? (
      <QueryErrorView error={error} onRetry={onRetry} />
    ) : (
      <StateView variant="error" error={error} />
    );
  }
  if (tookEffectOutcomeLost(error)) return <OutcomeLost error={error} what={props.what} />;
  if (refusedBeforeRunning(error)) {
    return <RefusedBeforeRunning error={error} onRetry={onRetry} payment={isPayment(props)} />;
  }
  if (wording === 'team') return <TeamOutcome {...props} />;
  if (wording === 'general' && secretWithheldOf(error)) {
    return (
      <OutcomeBox
        error={error}
        label={SECRET_WITHHELD_LABEL}
        tone="warning"
        body={[error.message]}
        announcement={sentences(SECRET_WITHHELD_LABEL, error.message)}
        testID="command-secret-withheld"
      />
    );
  }
  if (mayHaveTakenEffect(error)) return <NoAnswer {...props} />;
  if (wording === 'money' && error.isStale) {
    return (
      <OutcomeBox
        error={error}
        label={STALE_LABEL}
        tone="warning"
        body={[error.message]}
        action={props.onReload ? { label: 'Reload', onPress: props.onReload } : undefined}
        announcement={sentences(STALE_LABEL, error.message, props.onReload ? 'Reload' : null)}
        testID="command-stale"
      />
    );
  }
  return <ErrorState {...props} />;
}

function isPayment({ error, wording, payment = false }: OutcomeProps): boolean {
  return payment || (wording === 'registration' && error.code === 'PAYMENT_OUTCOME_UNKNOWN');
}

function notAvailableCopy({
  error,
  wording,
  notFound,
  denied,
  unavailableText,
}: OutcomeProps): NotAvailableCopy {
  const own = error.isNotFound ? notFound : denied;
  if (own) {
    // The account screens' default title for a denial stays unless the screen gives one.
    return wording === 'general' && !error.isNotFound
      ? { title: 'Not available to you', description: error.message, ...own }
      : own;
  }
  if (unavailableText) return { description: unavailableText };
  if (error.isNotFound) return {};
  switch (wording) {
    case 'general':
      // SPK-UX-008: a denied permission is "not available", with the API's safe reason.
      return { title: 'Not available to you', description: error.message };
    case 'money':
      return { description: MONEY_DENIED };
    case 'registration':
      return { description: REGISTRATION_DENIED[error.code] };
    case 'team':
      return {};
  }
}

/** No definite answer (`mayHaveTakenEffect`), in the general, money and registration wordings. */
function NoAnswer(props: OutcomeProps) {
  const { error, onRetry, what = 'this' } = props;
  const wording = props.wording as Exclude<CommandErrorWording, 'team'>;
  const offline = useConnectivity().reachable === false;
  const payment = isPayment(props);
  const label = payment
    ? PAYMENT_UNKNOWN_LABEL
    : wording === 'money'
      ? 'No answer yet'
      : NO_ANSWER_LABEL;
  const body = payment
    ? error.code === 'PAYMENT_OUTCOME_UNKNOWN'
      ? error.message
      : PAYMENT_NO_ANSWER
    : NO_ANSWER[wording](what);
  const recovery = recoveryActionFor(error);
  // NA-A01: announced with the next action, the button's label or the instruction shown.
  const nextAction = recovery.retry && onRetry ? 'Check again' : recovery.label;
  return (
    <OutcomeBox
      error={error}
      label={label}
      tone="warning"
      body={[body]}
      action={
        recovery.retry && onRetry
          ? {
              label: nextAction,
              onPress: onRetry,
              // R3-SCREEN-STATES-01: "Check again" needs a connection; offline it neither queues
              // nor fails.
              needsConnection: (wording === 'money' || wording === 'registration') && offline,
            }
          : undefined
      }
      instruction={nextAction}
      announcement={sentences(label, body, nextAction)}
      testID="command-no-answer"
    />
  );
}

/**
 * The team screens' wording: one labelled box for every outcome after the shared ones, with the
 * API's field issues ("▲ …") and eligibility reasons in it, and the rule code a refusal names in
 * `details.code` next to the error code (CMP-13).
 */
function TeamOutcome({ error, onRetry, onReload, read = false }: OutcomeProps) {
  const recovery = recoveryActionFor(error);
  const reasons = error.code === 'ELIGIBILITY_FAILED' ? eligibilityReasonsOf(error) : [];
  const issues = error.code === 'VALIDATION_FAILED' ? fieldIssuesOf(error) : [];
  const stale = error.isStale;
  const rule = detailCodeOf(error);
  const unknown = !read && mayHaveTakenEffect(error);
  const withheld = !read && secretWithheldOf(error) !== null;
  const label = unknown
    ? NO_ANSWER_LABEL
    : withheld
      ? SECRET_WITHHELD_LABEL
      : stale
        ? STALE_LABEL
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
    <OutcomeBox
      error={error}
      errorCode={`${error.code}${rule ? ` (${rule})` : ''}`}
      label={label}
      tone={unknown || withheld ? 'warning' : 'danger'}
      body={[error.message]}
      issues={issues}
      reasons={reasons}
      action={
        stale && onReload
          ? { label: 'Reload', onPress: onReload, variant: 'secondary' }
          : recovery.retry && onRetry
            ? {
                label: nextAction,
                onPress: onRetry,
                hint: read
                  ? 'Reads it again'
                  : 'Sends the same request again; it is never applied twice',
              }
            : undefined
      }
      instruction={nextAction}
      announcement={sentences(
        label,
        error.message,
        ...issues,
        ...reasons.map((reason) => reason.message),
        nextAction,
      )}
      compact
    />
  );
}

/** `StateView`'s error state, with the registration recoveries and lists. */
function ErrorState({
  error,
  wording,
  onRetry,
  onReload,
  onRequote,
  onCompleteForms,
  onAlternatives,
}: OutcomeProps) {
  const styles = useStyles();
  const recovery = recoveryActionFor(error);
  if (wording === 'general') {
    return (
      <StateView
        variant="error"
        error={error}
        onRetry={onRetry}
        onAction={error.isStale ? onReload : undefined}
      />
    );
  }
  if (wording === 'money') {
    // A retryable failure repeats the same intent; otherwise the permitted next action is shown
    // as the instruction ("Review eligibility", "Contact support").
    return (
      <StateView variant="error" error={error} onRetry={recovery.retry ? onRetry : undefined} />
    );
  }
  const action = (() => {
    switch (error.nextAction) {
      case 'reload_and_retry':
      case 'reload_current_state':
        return onReload;
      case 'request_new_quote':
        return onRequote;
      case 'complete_acknowledgment':
        return onCompleteForms;
      case 'join_waitlist_or_choose_alternative':
      case 'review_eligibility_reasons':
        return onAlternatives;
      default:
        return undefined;
    }
  })();
  const details = (error.details ?? {}) as ReasonDetails;
  const reasons = error.code === 'ELIGIBILITY_FAILED' ? messagesOf(details.reasons) : [];
  const alternatives = error.code === 'ELIGIBILITY_FAILED' ? messagesOf(details.alternatives) : [];
  return (
    <>
      <StateView
        variant="error"
        error={error}
        onRetry={recovery.retry ? onRetry : undefined}
        onAction={recovery.retry ? undefined : action}
      />
      {reasons.length > 0 ? (
        <View style={styles.list} accessibilityRole="list">
          {reasons.map((reason) => (
            <Text key={reason} style={styles.item}>{`✕ ${reason}`}</Text>
          ))}
        </View>
      ) : null}
      {alternatives.length > 0 ? (
        <View style={styles.list} accessibilityRole="list">
          <Text style={styles.label}>What you can do instead</Text>
          {alternatives.map((alternative) => (
            <Text key={alternative} style={styles.item}>{`→ ${alternative}`}</Text>
          ))}
        </View>
      ) : null}
    </>
  );
}

interface ReasonDetails {
  reasons?: { message?: unknown }[];
  alternatives?: { message?: unknown }[];
}

function messagesOf(list: { message?: unknown }[] | undefined): string[] {
  return (list ?? [])
    .map((r) => r.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
}

interface BoxAction {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary';
  hint?: string;
  /** Offline: the button is disabled and says it needs a connection. */
  needsConnection?: boolean;
}

/**
 * One answer: its status in words, what happened, the API's issues and reasons, the next action
 * (a button, or the instruction when there is none) and the support fold. A live region announced
 * when it appears.
 */
function OutcomeBox({
  error,
  errorCode = error.code,
  label,
  tone,
  body,
  issues = [],
  reasons = [],
  action,
  instruction,
  announcement,
  compact = false,
  testID,
}: {
  error: ApiError;
  errorCode?: string;
  label: string;
  tone: 'warning' | 'danger';
  body: readonly string[];
  issues?: readonly string[];
  reasons?: readonly EligibilityReason[];
  action?: BoxAction;
  /** Shown when there is no `action`. */
  instruction?: string;
  announcement: string;
  /** The team screens' spacing (the box sits in a card). */
  compact?: boolean;
  testID?: string;
}) {
  const styles = useStyles();
  return (
    <LiveRegion
      style={compact ? styles.compact : styles.box}
      announcement={announcement}
      occurrence={error}
      testID={testID}
    >
      <StatusBadge tone={tone} label={label} />
      {body.map((text) => (
        <Text key={text} style={styles.body}>
          {text}
        </Text>
      ))}
      {issues.map((issue) => (
        <Text key={issue} style={styles.body}>{`▲ ${issue}`}</Text>
      ))}
      {reasons.length > 0 ? <ReasonList reasons={reasons} /> : null}
      {action ? (
        <>
          <Button
            label={action.label}
            onPress={action.onPress}
            variant={action.variant}
            disabled={action.needsConnection}
            accessibilityHint={action.hint}
          />
          {action.needsConnection ? <Text style={styles.caption}>Needs a connection.</Text> : null}
        </>
      ) : instruction ? (
        <Text style={styles.body}>{instruction}</Text>
      ) : null}
      <SupportDetails errorCode={errorCode} reference={error.correlationId} />
    </LiveRegion>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  compact: { gap: spacing.sm, paddingVertical: spacing.sm },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.xs },
  label: { ...type.body, ...fonts.semibold, color: colors.text },
  item: { ...type.body, color: colors.text },
}));
