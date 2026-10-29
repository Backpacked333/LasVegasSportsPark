/**
 * SCR-C-24 Availability request and responses (SPK-CAP-001, SPK-CAP-003, SPK-READY-002, DEC-064).
 * For each upcoming game of the team (`GET /v1/team-entries/{id}`): the roster's answers counted
 * per state; the answers this person may give, read from the game (`GET /v1/fixtures/{id}`,
 * CMP-04 `responses`: their own and those of every rostered child they hold `register` over, with
 * each answer's revision); and, for the captain, the request to the players without an answer
 * (features/teams/AvailabilityRequests.tsx, CMP-14). An answer is recorded with
 * `POST /v1/fixtures/{id}/availability`, sending the revision read (`expectedRevision`) when an
 * answer exists. Availability is never shown as attendance or eligibility, and a missing answer
 * never blocks a game. Times are in the facility's time zone from the game's venue (SPK-SCHED-008).
 *
 * "Tentative" is offered only once DEC-064 (Product and operations) decides to enable it: until
 * then it is not offered, and an existing tentative answer is still shown as such. When answers
 * close is the API's (at kickoff until a rule set defines a cutoff, DEC-002): a late answer is
 * refused with `AVAILABILITY_CLOSED` and said so.
 *
 * States: loading; empty (no games published); ready; validation failure (an answer for a game the
 * person is not rostered for); permission restriction (answering for another person needs
 * authority: not available); stale version (the answer changed or the game moved since loading:
 * reload; closed at kickoff); offline (answers are not queued, so the control is disabled with an
 * explanation); processing; success (the answer shown); recovery: a failed answer is retried under
 * the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import {
  AvailabilityClosed,
  AvailabilityRequests,
  availabilityClosedAt,
} from '../../features/teams/AvailabilityRequests';
import {
  rosterNames,
  TEAM_ACTIONS,
  WORKSPACE_KEY,
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
  Detail,
  OfflineNotice,
  Section,
  Subheading,
  Title,
} from '../../features/teams/ui';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryErrorView } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing } from '../../ui/theme';

type Upcoming = Schema<'UpcomingFixture'>;
type FixtureResponse = Schema<'FixtureResponse'>;

const FIXTURE_KEY = ['api', '/fixtures/{id}'] as const;

/** The answers this build offers. Tentative waits on DEC-064 and is not offered. */
export const OFFERED_ANSWERS: readonly RsvpState[] = ['available', 'unavailable'];

function AnswerControl({
  fixtureId,
  response,
  name,
  timeZone,
  onReload,
}: {
  fixtureId: string;
  /** The answer as the API returned it (revision null while none is recorded). */
  response: FixtureResponse;
  /** Null for the signed-in person; the child's name otherwise. */
  name: string | null;
  timeZone: string | null;
  onReload: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const respond = useApiCommand('post', '/fixtures/{id}/availability', {
    invalidate: [WORKSPACE_KEY, FIXTURE_KEY],
  });
  const [chosen, setChosen] = useState<RsvpState | null>(null);
  const whose = name ? `${name}'s answer` : 'Your answer';
  // The fresher of the read and the last recorded answer (the read refreshes after success).
  const recorded =
    respond.data && respond.data.revision >= (response.revision ?? 0) ? respond.data : null;
  const current: RsvpState = recorded ? recorded.state : response.state;
  const revision = recorded ? recorded.revision : response.revision;

  const submit = (state: RsvpState) => {
    setChosen(state);
    void respond
      .submit({
        path: { id: fixtureId },
        body: {
          state,
          ...(name ? { personId: response.personId } : {}),
          ...(revision !== null ? { expectedRevision: revision } : {}),
        },
      })
      .catch(() => undefined);
  };

  const answers: RsvpState[] = [...OFFERED_ANSWERS];
  if (current !== 'no_response') answers.push('no_response');

  return (
    <View style={styles.answer} testID={`answer-${fixtureId}-${name ? response.personId : 'me'}`}>
      <Body>{`${whose}: ${rsvpStatus(current).label}`}</Body>
      <ButtonRow>
        {answers.map((state) => (
          <Button
            key={state}
            label={
              state === 'no_response'
                ? `Clear ${name ? `${name}'s` : 'my'} answer`
                : `${name ? `${name}: ` : ''}${RSVP_LABELS[state]}`
            }
            variant={current === state ? 'primary' : 'secondary'}
            onPress={() => submit(state)}
            disabled={offline || current === state || respond.isProcessing}
            busy={respond.isProcessing && chosen === state}
            accessibilityHint={`Records ${RSVP_LABELS[state].toLowerCase()} for this game; it is not a check-in`}
          />
        ))}
      </ButtonRow>
      {respond.error && availabilityClosedAt(respond.error) !== null ? (
        <AvailabilityClosed error={respond.error} timeZone={timeZone} what="Answers" />
      ) : respond.error ? (
        <CommandFailure
          error={respond.error}
          onRetry={() => chosen && submit(chosen)}
          onReload={() => {
            respond.reset();
            onReload();
          }}
          unavailableText={`Answering for ${name ?? 'this person'} is not available to you.`}
        />
      ) : null}
    </View>
  );
}

function Answers({
  game,
  workspace,
  viewer,
}: {
  game: Upcoming;
  workspace: Workspace;
  viewer: Viewer;
}) {
  const detail = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: game.fixture.id } },
  });
  if (detail.data === undefined) {
    return detail.error ? (
      <QueryErrorView
        error={detail.error}
        onRetry={() => void detail.refetch()}
        unavailable={{ description: 'The answers you can give for this game are not available.' }}
      />
    ) : (
      <StateView variant="loading" label="the answers you can give" />
    );
  }
  const names = rosterNames(workspace);
  const responses = [...detail.data.responses].sort((a, b) =>
    a.personId === viewer.personId ? -1 : b.personId === viewer.personId ? 1 : 0,
  );
  const timeZone = detail.data.venue?.timezone ?? null;
  if (responses.length === 0) {
    return <Body muted>You are not on this roster, so there is no answer to give here.</Body>;
  }
  return (
    <View>
      {responses.map((response) => (
        <AnswerControl
          key={response.personId}
          fixtureId={game.fixture.id}
          response={response}
          name={
            response.personId === viewer.personId
              ? null
              : (names.get(response.personId) ?? 'Family member')
          }
          timeZone={timeZone}
          onReload={() => void detail.refetch()}
        />
      ))}
    </View>
  );
}

function GameCard({
  game,
  workspace,
  viewer,
}: {
  game: Upcoming;
  workspace: Workspace;
  viewer: Viewer;
}) {
  // The same read as Answers (one request): the venue gives the facility's zone.
  const detail = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: game.fixture.id } },
  });
  const venue = detail.data?.venue ?? null;
  const title = game.opponent ? `vs ${game.opponent.teamName}` : 'Bye';
  return (
    <Section title={title} testID={`game-${game.fixture.id}`}>
      <StatusBadge {...fixtureStatus(game.fixture, venue?.timezone)} />
      {venue ? (
        <Detail
          label="Where"
          value={`${venue.facilityName}${venue.resources.length > 0 ? `, ${venue.resources.map((r) => r.name).join(', ')}` : ''}`}
        />
      ) : null}
      <View
        accessible
        accessibilityLabel={`Answers from the roster: ${availabilitySummaryText(game.availability)}`}
      >
        <Body>{`Answers from the roster: ${availabilitySummaryText(game.availability)}`}</Body>
      </View>
      <Answers game={game} workspace={workspace} viewer={viewer} />
      {viewer.can(TEAM_ACTIONS.requestAvailability) ? (
        <View style={styles.request}>
          <Subheading>Ask the roster</Subheading>
          <AvailabilityRequests
            fixtureId={game.fixture.id}
            teamEntryId={workspace.entry.id}
            timeZone={venue?.timezone}
          />
        </View>
      ) : null}
    </Section>
  );
}

function AvailabilityContent({ workspace, viewer }: { workspace: Workspace; viewer: Viewer }) {
  const { reachable } = useConnectivity();
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
      {games.length === 0 ? (
        <StateView
          variant="empty"
          title="No games published"
          description="Games appear here once the league publishes the schedule."
        />
      ) : (
        games.map((game) => (
          <GameCard key={game.fixture.id} game={game} workspace={workspace} viewer={viewer} />
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
      unavailableOffline={['availability answers', 'availability requests']}
    >
      {(ws, viewer) => <AvailabilityContent workspace={ws} viewer={viewer} />}
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
  request: {
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  pending: { gap: spacing.xs },
});
