/**
 * SCR-C-04 / SCR-C-20 RSVP (SPK-CAP-003, §4.8 `POST /v1/fixtures/{id}/availability`, §4.9).
 *
 * - States: "Available", "Unavailable", "No response". "Tentative" is offered only once DEC-064
 *   (Product and operations) enables it; until then the control says so and shows a recorded
 *   tentative answer without offering it.
 * - One idempotency key per choice: retrying the same answer reuses it, a different answer is a
 *   new intent (useApiCommand). Nothing is queued offline: the choices are disabled with the
 *   reason (§4.15 "never pretend a queued action is committed").
 * - The API decides who may answer: a person not on an effective roster gets VALIDATION_FAILED,
 *   a missing authority ACCESS_DENIED or PARTICIPANT_AUTHORITY_REQUIRED, a fixture that no longer
 *   takes answers INVALID_TRANSITION. Each is shown with its code; nothing is retried blindly.
 * - Answers are for the signed-in person only. Which permission lets a guardian answer for a
 *   child is DEC-090 (pending), so the control does not offer it.
 * - CMP-04 (§4.9): an existing answer is changed only from the revision the person saw (the
 *   `responses` revision of `GET /v1/fixtures/{id}`, then the revision the last answer returned),
 *   sent as `expectedRevision`; STALE_REVISION offers "Reload". A person the fixture read says is
 *   on no roster (`rosterStatus: null`) is not offered the choices. Answers close at kickoff: the
 *   API answers INVALID_TRANSITION with `details.code: AVAILABILITY_CLOSED`, shown in those words.
 * - RSVP is neither attendance nor eligibility; the caption says so.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity } from '../../providers/AppProviders';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, MIN_TOUCH_SIZE, spacing, type } from '../../ui/theme';
import { fixtureAcceptsRsvp, rsvpStatus, type RsvpState } from './status';

type FixtureStatus = Schema<'FixtureStatus'>;

/** The answers this build offers; "tentative" waits on DEC-064. */
export const OFFERED_RSVP_STATES: readonly RsvpState[] = ['available', 'unavailable'];

export interface RsvpControlProps {
  fixtureId: string;
  fixtureStatus: FixtureStatus;
  /** The signed-in person's recorded answer from `GET /v1/fixtures/{id}` (`responses`). */
  myResponse: RsvpState | null;
  /** The revision of that answer (CMP-04); null or absent while none is recorded. */
  responseRevision?: number | null;
  /** Whether the person is on a roster (`rosterStatus`); null or absent when the read did not say. */
  onRoster?: boolean | null;
  /** Called after a stale or closed answer so the screen reloads the fixture. */
  onReload?: () => void;
}

/** `details.code` of the API's refusal of an answer after kickoff (CMP-04). */
export const AVAILABILITY_CLOSED = 'AVAILABILITY_CLOSED';

function detailsCode(error: ApiError): string | null {
  const details = error.details as { code?: unknown } | null | undefined;
  return typeof details?.code === 'string' ? details.code : null;
}

function rsvpErrorView(error: ApiError, onRetry: () => void, onReload?: () => void) {
  if (error.code === 'PARTICIPANT_AUTHORITY_REQUIRED' || error.code === 'ACCESS_DENIED') {
    return (
      <StateView
        variant="unavailable"
        title="Responding is not available"
        description={
          error.code === 'PARTICIPANT_AUTHORITY_REQUIRED'
            ? 'You cannot answer for this participant. Which permission lets a guardian answer for a child is still being decided (DEC-090).'
            : 'You cannot answer for this fixture.'
        }
      />
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
  return <StateView variant="error" error={error} onRetry={onRetry} />;
}

export function RsvpControl({
  fixtureId,
  fixtureStatus,
  myResponse,
  responseRevision,
  onRoster,
  onReload,
}: RsvpControlProps) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const rsvp = useApiCommand('post', '/fixtures/{id}/availability', {
    // The fixture and the lists that carry its answers (Home, Schedule) are read again.
    invalidate: [
      ['api', '/fixtures/{id}'],
      ['api', '/me/fixtures'],
    ],
  });
  const [lastChoice, setLastChoice] = useState<RsvpState | null>(null);
  const recorded = (rsvp.data?.state as RsvpState | undefined) ?? myResponse ?? null;
  const open = fixtureAcceptsRsvp(fixtureStatus) && onRoster !== false;
  const current = rsvpStatus(recorded);
  // The revision this person last saw: the answer just recorded, else the fixture read's.
  const expectedRevision = rsvp.data?.revision ?? responseRevision ?? undefined;

  const choose = (state: RsvpState) => {
    if (rsvp.isProcessing) return;
    setLastChoice(state);
    // The same answer retried reuses its idempotency key; a different answer is a new intent.
    void rsvp
      .submit({
        path: { id: fixtureId },
        body: expectedRevision === undefined ? { state } : { state, expectedRevision },
      })
      .catch(() => undefined);
  };

  return (
    <View style={styles.box} testID="rsvp">
      <Text style={styles.heading} accessibilityRole="header">
        Your availability
      </Text>
      <StatusBadge {...current} testID="rsvp-current" />
      {open ? (
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="Your availability for this fixture"
          style={styles.choices}
        >
          {OFFERED_RSVP_STATES.map((state) => {
            const label = rsvpStatus(state).label;
            const selected = recorded === state;
            const disabled = offline || rsvp.isProcessing;
            return (
              <Pressable
                key={state}
                accessibilityRole="radio"
                accessibilityLabel={label}
                accessibilityHint={offline ? 'Needs a connection' : undefined}
                accessibilityState={{ checked: selected, disabled, busy: rsvp.isProcessing }}
                disabled={disabled}
                onPress={() => choose(state)}
                style={[styles.choice, selected && styles.selected, disabled && styles.disabled]}
                testID={`rsvp-${state}`}
              >
                <Text style={[styles.choiceText, selected && styles.selectedText]}>
                  {selected ? '✓ ' : ''}
                  {label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : onRoster === false ? (
        <Text style={styles.caption} testID="rsvp-not-on-roster">
          You are not on a roster for this fixture, so there is no answer for you to give. Answering
          for a child is still being decided (DEC-090).
        </Text>
      ) : (
        <Text style={styles.caption}>This fixture no longer takes availability answers.</Text>
      )}
      {open ? (
        <Text style={styles.caption}>
          "Tentative" is not offered yet: whether it is used is still being decided (DEC-064).
        </Text>
      ) : null}
      {offline && open ? (
        <Text style={styles.caption} accessibilityLiveRegion="polite">
          Answering needs a connection. Nothing is saved until you are back online.
        </Text>
      ) : null}
      {rsvp.isProcessing ? (
        <Text style={styles.caption} accessibilityLiveRegion="polite">
          Saving your answer…
        </Text>
      ) : null}
      {rsvp.status === 'success' && rsvp.data ? (
        <Text style={styles.caption} accessibilityLiveRegion="polite" testID="rsvp-recorded">
          Answer recorded: {rsvpStatus(rsvp.data.state as RsvpState).label}.
        </Text>
      ) : null}
      {rsvp.error
        ? rsvpErrorView(
            rsvp.error,
            () => lastChoice && choose(lastChoice),
            () => {
              // Clear the stale answer before reloading, so the reloaded state stands alone.
              rsvp.reset();
              onReload?.();
            },
          )
        : null}
      <Text style={styles.caption}>
        Your answer helps the team plan. It is not a check-in and does not affect eligibility.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.sm },
  heading: { ...type.body, fontWeight: '700', color: colors.text },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choice: {
    minHeight: MIN_TOUCH_SIZE,
    minWidth: MIN_TOUCH_SIZE,
    paddingHorizontal: spacing.lg,
    justifyContent: 'center',
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.primary,
    backgroundColor: colors.background,
  },
  selected: { backgroundColor: colors.primary },
  disabled: { opacity: 0.55 },
  choiceText: { ...type.body, fontWeight: '600', color: colors.primary },
  selectedText: { color: colors.primaryText },
  caption: { ...type.caption, color: colors.textMuted },
});
