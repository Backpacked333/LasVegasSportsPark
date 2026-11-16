/**
 * SCR-C-04 RSVP on Home's "Up next" card, inline (SPK-CAP-003, §4.8, §4.9; PA-11 SPK-UX-011
 * **Proposed** plain words; ADR-008). The same answer logic as `RsvpControl` (`useRsvpAnswer`):
 * one idempotency key per choice, "Check again" resends exactly the request that got no answer,
 * an existing answer changes only from the revision the person saw (CMP-04), nothing is queued
 * offline (§4.15), and the API decides who may answer.
 *
 * What differs is the look and the words, for a card a person glances at:
 * - Two choices, "Going" (sends `available`) and "Not going" (sends `unavailable`), as a radio
 *   group; the recorded answer stays visible in its journeys §3 phrase ("Available",
 *   "Unavailable", "No response").
 * - "Tentative" is not offered while DEC-064 is open, and nothing says so on the card: two choices
 *   are the whole offer.
 * - A viewer on no roster is not offered the choices; answering for a child is DEC-090, so the
 *   card says what to do instead (`pendingMessage`) and the decision is in "Details for support".
 */
import type { ApiError } from '@sportspark/api-client';
import { View } from 'react-native';
import { pendingMessage } from '../../copy/pending';
import { LiveText } from '../../ui/announce';
import { PressableScale } from '../../ui/PressableScale';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { SupportDetails } from '../../ui/SupportDetails';
import { Text } from '../../ui/Text';
import { fonts, makeStyles, MIN_TOUCH_SIZE, radius, spacing, type, useTheme } from '../../ui/theme';
import { CommandFailure } from '../teams/ui';
import {
  AVAILABILITY_CLOSED,
  detailsCode,
  NEEDS_CONNECTION,
  recordedText,
  SAVING,
  useRsvpAnswer,
  type RsvpControlProps,
} from './RsvpControl';
import { rsvpStatus, type RsvpState } from './status';

/** The two inline choices and the answer each one sends. */
export const INLINE_RSVP_CHOICES: readonly { state: RsvpState; label: string }[] = [
  { state: 'available', label: 'Going' },
  { state: 'unavailable', label: 'Not going' },
];

/** What a viewer on no roster reads on the card (DEC-090 open). */
export const NOT_ON_ROSTER_TEXT = `You're not on this game's roster. ${pendingMessage('DEC-090')}`;

function InlineError({
  error,
  onRetry,
  onReload,
}: {
  error: ApiError;
  onRetry: () => void;
  onReload: () => void;
}) {
  const styles = useStyles();
  if (error.code === 'PARTICIPANT_AUTHORITY_REQUIRED' || error.code === 'ACCESS_DENIED') {
    const forChild = error.code === 'PARTICIPANT_AUTHORITY_REQUIRED';
    return (
      <View style={styles.box}>
        <StateView
          variant="unavailable"
          title="You can't answer here"
          description={forChild ? pendingMessage('DEC-090') : "You can't answer for this game."}
        />
        <SupportDetails
          decisions={forChild ? ['DEC-090'] : undefined}
          errorCode={error.code}
          reference={error.correlationId}
        />
      </View>
    );
  }
  if (error.code === 'INVALID_TRANSITION' && detailsCode(error) === AVAILABILITY_CLOSED) {
    return (
      <View style={styles.box} testID="rsvp-closed">
        <StatusBadge tone="neutral" label="Availability closed at kickoff" />
        <StateView variant="error" error={error} onAction={onReload} />
      </View>
    );
  }
  if (error.code === 'INVALID_TRANSITION' || error.code === 'STALE_REVISION') {
    return <StateView variant="error" error={error} onAction={onReload} />;
  }
  return <CommandFailure error={error} onRetry={onRetry} testID="rsvp-failure" />;
}

export function RsvpInline({ onReload, ...props }: RsvpControlProps) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { rsvp, recorded, open, offline, choose, retry } = useRsvpAnswer(props);
  const disabled = offline || rsvp.isProcessing;
  return (
    <View style={styles.box} testID="rsvp">
      <View style={styles.head}>
        <Text variant="label" tone="muted">
          Your answer
        </Text>
        <StatusBadge {...rsvpStatus(recorded)} testID="rsvp-current" />
      </View>
      {open ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Are you going to this game?"
          style={styles.choices}
        >
          {INLINE_RSVP_CHOICES.map(({ state, label }) => {
            const selected = recorded === state;
            return (
              <PressableScale
                key={state}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityHint={offline ? 'Needs a connection' : undefined}
                accessibilityState={{ checked: selected, disabled, busy: rsvp.isProcessing }}
                disabled={disabled}
                haptic="selection"
                onPress={() => choose(state)}
                style={({ pressed }) => [
                  styles.choice,
                  selected && styles.selected,
                  pressed && !selected && { backgroundColor: colors.surface },
                  disabled && styles.disabled,
                ]}
                testID={`rsvp-${state}`}
              >
                <Text style={[styles.choiceText, selected && styles.selectedText]}>
                  {selected ? `✓ ${label}` : label}
                </Text>
              </PressableScale>
            );
          })}
        </View>
      ) : props.onRoster === false ? (
        <View style={styles.box}>
          <Text variant="footnote" tone="muted" testID="rsvp-not-on-roster">
            {NOT_ON_ROSTER_TEXT}
          </Text>
          <SupportDetails decisions={['DEC-090']} />
        </View>
      ) : (
        <Text variant="footnote" tone="muted">
          This game no longer takes answers.
        </Text>
      )}
      {offline && open ? (
        <LiveText style={styles.caption} announcement={NEEDS_CONNECTION}>
          {NEEDS_CONNECTION}
        </LiveText>
      ) : null}
      {rsvp.isProcessing ? (
        <LiveText style={styles.caption} announcement={SAVING}>
          {SAVING}
        </LiveText>
      ) : null}
      {rsvp.status === 'success' && rsvp.data ? (
        <LiveText
          style={styles.caption}
          announcement={recordedText(rsvp.data.state as RsvpState)}
          testID="rsvp-recorded"
        >
          {recordedText(rsvp.data.state as RsvpState)}
        </LiveText>
      ) : null}
      {rsvp.error ? (
        <InlineError
          error={rsvp.error}
          onRetry={retry}
          onReload={() => {
            // Clear the stale answer before reloading, so the reloaded state stands alone.
            rsvp.reset();
            onReload?.();
          }}
        />
      ) : null}
      {open ? (
        <Text variant="footnote" tone="muted">
          Helps the team plan. It isn&apos;t a check-in.
        </Text>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  box: { gap: spacing.sm },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    flexGrow: 1,
    flexBasis: 120,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.control,
    backgroundColor: colors.background,
  },
  selected: { backgroundColor: colors.primary, borderColor: colors.primary },
  disabled: { opacity: 0.55 },
  choiceText: { ...type.body, ...fonts.semibold, color: colors.text },
  selectedText: { color: colors.primaryText },
  caption: { ...type.footnote, color: colors.textMuted },
}));
