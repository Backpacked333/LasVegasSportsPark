/**
 * SCR-C-24 Availability request and responses (SPK-CAP-003, SPK-READY-002, DEC-064). For each
 * upcoming game of the team (`GET /v1/team-entries/{id}`): the roster's answers counted per state,
 * and the person's own answer, recorded with `POST /v1/fixtures/{id}/availability`. A guardian
 * may answer for a child on the roster over whom they hold `register` (from `GET /v1/me`; the API
 * re-checks). Availability is never shown as attendance or eligibility, and a missing answer never
 * blocks a game.
 *
 * "Tentative" is offered only once DEC-064 (Product and operations) decides to enable it: until
 * then it is not offered, and an existing tentative answer is still shown as such.
 *
 * Not available from the API (reported): a captain's availability request or reminder to the
 * roster (no command exists; players answer at any time), and the current answer of a child a
 * guardian answers for (only the acting person's own answer is returned).
 *
 * States: loading; empty (no games published); ready; validation failure (an answer for a game the
 * person is not rostered for); permission restriction (answering for another person needs
 * authority: not available); stale version (the game moved or ended since loading: reload);
 * offline (answers are not queued, so the control is disabled with an explanation); processing;
 * success (the answer shown); recovery: a failed answer is retried under the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import {
  useMe,
  WORKSPACE_KEY,
  respondableChildren,
  type Viewer,
  type Workspace,
} from '../../features/teams/queries';
import { idParam } from '../../features/teams/routes';
import {
  RSVP_LABELS,
  availabilitySummaryText,
  fixtureStatus,
  rsvpStatus,
  type RsvpState,
} from '../../features/teams/status';
import { TeamFrame } from '../../features/teams/TeamFrame';
import {
  Body,
  ButtonRow,
  CommandFailure,
  OfflineNotice,
  Section,
  Title,
} from '../../features/teams/ui';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

type Upcoming = Schema<'UpcomingFixture'>;

/** The answers this build offers. Tentative waits on DEC-064 and is not offered. */
export const OFFERED_ANSWERS: readonly RsvpState[] = ['available', 'unavailable'];

function AnswerControl({
  game,
  respondent,
  onReload,
}: {
  game: Upcoming;
  /** Null for the signed-in person; a child's id and name otherwise. */
  respondent: { personId: string; name: string } | null;
  onReload: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const respond = useApiCommand('post', '/fixtures/{id}/availability', {
    invalidate: [WORKSPACE_KEY],
  });
  const [chosen, setChosen] = useState<RsvpState | null>(null);
  const whose = respondent ? `${respondent.name}'s answer` : 'Your answer';
  // Only the acting person's own answer is returned by the API.
  const current: RsvpState | null | undefined = respond.data
    ? respond.data.state
    : respondent
      ? undefined
      : game.myResponse;

  const submit = (state: RsvpState) => {
    setChosen(state);
    void respond
      .submit({
        path: { id: game.fixture.id },
        body: { state, ...(respondent ? { personId: respondent.personId } : {}) },
      })
      .catch(() => undefined);
  };

  const answers: RsvpState[] = [...OFFERED_ANSWERS];
  if (current && current !== 'no_response') answers.push('no_response');

  return (
    <View
      style={styles.answer}
      testID={`answer-${game.fixture.id}-${respondent?.personId ?? 'me'}`}
    >
      <Body>
        {current === undefined
          ? `${whose}: not shown here (the service returns only your own)`
          : `${whose}: ${rsvpStatus(current).label}`}
      </Body>
      <ButtonRow>
        {answers.map((state) => (
          <Button
            key={state}
            label={
              state === 'no_response'
                ? `Clear ${respondent ? `${respondent.name}'s` : 'my'} answer`
                : `${respondent ? `${respondent.name}: ` : ''}${RSVP_LABELS[state]}`
            }
            variant={current === state ? 'primary' : 'secondary'}
            onPress={() => submit(state)}
            disabled={offline || current === state || respond.isProcessing}
            busy={respond.isProcessing && chosen === state}
            accessibilityHint={`Records ${RSVP_LABELS[state].toLowerCase()} for this game; it is not a check-in`}
          />
        ))}
      </ButtonRow>
      {respond.error ? (
        <CommandFailure
          error={respond.error}
          onRetry={() => chosen && submit(chosen)}
          onReload={() => {
            respond.reset();
            onReload();
          }}
          unavailableText={`Answering for ${respondent ? respondent.name : 'this person'} is not available to you.`}
        />
      ) : null}
    </View>
  );
}

function GameCard({
  game,
  viewer,
  dependents,
  onReload,
}: {
  game: Upcoming;
  viewer: Viewer;
  /** Children on this roster the signed-in person may answer for. */
  dependents: { personId: string; name: string }[];
  onReload: () => void;
}) {
  const title = game.opponent ? `vs ${game.opponent.teamName}` : 'Bye';
  return (
    <Section title={title} testID={`game-${game.fixture.id}`}>
      <StatusBadge {...fixtureStatus(game.fixture)} />
      <View
        accessible
        accessibilityLabel={`Answers from the roster: ${availabilitySummaryText(game.availability)}`}
      >
        <Body>{`Answers from the roster: ${availabilitySummaryText(game.availability)}`}</Body>
      </View>
      {viewer.onRoster ? <AnswerControl game={game} respondent={null} onReload={onReload} /> : null}
      {dependents.map((child) => (
        <AnswerControl key={child.personId} game={game} respondent={child} onReload={onReload} />
      ))}
      {!viewer.onRoster && dependents.length === 0 ? (
        <Body muted>You are not on this roster, so there is no answer to give here.</Body>
      ) : null}
    </Section>
  );
}

function AvailabilityContent({
  workspace,
  viewer,
  reload,
}: {
  workspace: Workspace;
  viewer: Viewer;
  reload: () => void;
}) {
  const now = useNow();
  const me = useMe();
  const { reachable } = useConnectivity();
  const dependents = respondableChildren(workspace, me.data, now).map((m) => ({
    personId: m.personId,
    name: m.displayName,
  }));
  const games = workspace.upcomingFixtures;
  return (
    <View>
      <Title>{`${workspace.team.name}: availability`}</Title>
      <Section title="How availability works">
        <Body>
          An answer helps the captain plan. It is not a check-in and does not decide who is eligible
          to play, and a missing answer never blocks a game.
        </Body>
        <View
          style={styles.pending}
          accessible
          accessibilityLabel="Tentative is not offered yet: whether it is used is still being decided (DEC-064)."
        >
          <StatusBadge tone="pending" label="Waiting on a decision" />
          <Body muted>
            Tentative is not offered yet: whether it is used is still being decided (DEC-064).
          </Body>
        </View>
        {reachable === false ? <OfflineNotice what="Answering availability" /> : null}
      </Section>
      {viewer.captainView ? (
        <Section title="Ask the roster">
          <StateView
            variant="unavailable"
            title="Requests not available yet"
            description="Sending an availability request to the roster is not available in this version. Players can answer here at any time, and the counts update as they do."
          />
        </Section>
      ) : null}
      {games.length === 0 ? (
        <StateView
          variant="empty"
          title="No games published"
          description="Games appear here once the league publishes the schedule."
        />
      ) : (
        games.map((game) => (
          <GameCard
            key={game.fixture.id}
            game={game}
            viewer={viewer}
            onReload={reload}
            dependents={dependents}
          />
        ))
      )}
    </View>
  );
}

export function AvailabilityScreen({ entryId }: { entryId: string | null }) {
  return (
    <TeamFrame
      entryId={entryId}
      what="this team's games"
      unavailableOffline={['availability answers']}
    >
      {(ws, viewer, reload) => (
        <AvailabilityContent workspace={ws} viewer={viewer} reload={reload} />
      )}
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/availability.tsx. */
export function AvailabilityRoute() {
  const entryId = idParam(useLocalSearchParams<{ entryId: string }>().entryId);
  return (
    <>
      <Stack.Screen options={{ title: 'Availability' }} />
      <AvailabilityScreen entryId={entryId} />
    </>
  );
}

const styles = StyleSheet.create({
  answer: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pending: { gap: spacing.xs },
});
