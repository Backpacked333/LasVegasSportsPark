/**
 * SCR-C-20 Activity or fixture detail, fixture variant: the game page (SPK-UX-004, SPK-CAP-002,
 * SPK-CAP-003, SPK-READY-002, SPK-RESULT-001, SPK-RESULT-005, SPK-COMMS-005, SPK-SCHED-008,
 * SPK-UX-008, SPK-UX-009; PA-11 customer words, "game" for a fixture; ADR-008).
 *
 * - The top is the game's picture with its facts as tags, its status, the change, the required
 *   action and the RSVP (`ActivityHero`).
 * - `GET /v1/fixtures/{id}`: teams, state, time, availability counts, the venue (facility, pitches
 *   and IANA zone, CMP-04), the viewer's roster status and the answers they may see (`responses`).
 *   NOT_FOUND (the person is on neither roster and holds no view grant) is "not available", with
 *   no hint that the fixture exists (§4.10).
 * - RSVP in the shared control (`RsvpControl`, SCR-C-04: `POST /v1/fixtures/{id}/availability`, with
 *   the answer's revision as `expectedRevision`); answers of children the API lists are shown, not
 *   offered (DEC-090: the page says what to do instead, the decision in "Details for support").
 * - Material changes: the newest schedule notice about the fixture's scheduling event gives old
 *   and new details; times are on the venue's facility clock (SPK-SCHED-008).
 * - Match readiness as the customer may see it: `GET /v1/fixtures/{id}/readiness` answers with
 *   what this person may read (restricted record ids already removed by the API, SPK-CAP-002);
 *   the screen shows the assessment, each issue's responsible role and required action, and
 *   counts only, never other players' details.
 * - Result: the current official revision, else the submitted one as "Provisional"
 *   (`GET /v1/fixtures/{id}/results`, SPK-RESULT-001); a corrected result says so.
 * - Rule set summary from the team entry the person may read (`GET /v1/team-entries/{id}`);
 *   its `viewer.actingAsCaptain` (the API's answer, rule set included) decides the captain view.
 * - A captain acting for a side opens dispute submission (SCR-C-29) from an official result; the
 *   dispute screen and the API decide the rest (window, eligibility).
 * - Arrival guidance is POL-046 (Operations, pending): its plain message, the code in the fold.
 */
import { apiQueryKey, presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { artworkFor } from '../../artwork/artworkFor';
import { pendingMessage } from '../../copy/pending';
import { teamRoutes } from '../../features/teams/routes';
import {
  awayOf,
  fixtureRequiredAction,
  fixtureTitle,
  otherResponses,
  ownResponse,
  venueLocation,
  venueOf,
  viewerOnRoster,
} from '../../features/today/fixture-model';
import type { ActivityCardModel } from '../../features/today/NextActivityCard';
import { latestChangeForEvent, openAvailabilityRequest } from '../../features/today/notices';
import { nameOf, useInbox, useMe, usePersonNames, useSignedIn } from '../../features/today/queries';
import { RsvpControl } from '../../features/today/RsvpControl';
import { oldestUpdate, SectionQueryState } from '../../features/today/read-state';
import {
  currentResult,
  fixtureStatus,
  readinessStatus,
  resultStatus,
  roleLabel,
  rsvpStatus,
  severityStatus,
  type RsvpState,
} from '../../features/today/status';
import { formatDay, formatWhen, zoneNotice, zoneOf } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { LastUpdated } from '../../ui/LastUpdated';
import { Screen } from '../../ui/Screen';
import { Section } from '../../ui/Section';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { SupportDetails } from '../../ui/SupportDetails';
import { layout, makeStyles, radius, spacing, type } from '../../ui/theme';
import { ActivityHero } from './ActivityHero';

type FixtureDetail = Schema<'FixtureDetail'>;
type FixtureSide = Schema<'FixtureSide'>;
type ResultRevision = Schema<'ResultRevision'>;

export { fixtureTitle };

function availabilityLine(side: FixtureSide): string {
  const a = side.availability;
  return `${side.teamName}: ${a.available} available, ${a.unavailable} unavailable, ${a.tentative} tentative, ${a.noResponse} no response`;
}

export function scoreLine(result: ResultRevision, fixture: FixtureDetail): string {
  const away = awayOf(fixture);
  const awayName = away?.teamName ?? 'Opponent';
  const forfeiting =
    result.forfeitingEntryId === fixture.home.entryId
      ? fixture.home.teamName
      : result.forfeitingEntryId && result.forfeitingEntryId === away?.entryId
        ? awayName
        : null;
  switch (result.classification) {
    case 'forfeit':
      return forfeiting ? `Forfeit by ${forfeiting}` : 'Forfeit';
    case 'canceled':
      return 'Canceled';
    case 'abandoned':
      return 'Abandoned';
    case 'postponed':
      return 'Postponed';
    default:
      if (result.homeScore === null || result.awayScore === null) return 'Score not recorded';
      return `${fixture.home.teamName} ${result.homeScore}, ${awayName} ${result.awayScore}`;
  }
}

/** Issue sources that describe the fixture itself (time, place, closures), not a team's roster. */
const FIXTURE_LEVEL_SOURCES: ReadonlySet<string> = new Set([
  'fixture',
  'event',
  'resource',
  'closure',
  'dispute',
]);

/**
 * What of the readiness this viewer sees (SCR-C-20 "roster readiness indicator for captains",
 * private roster details hidden from non-captains; SPK-CAP-002). A captain of one side sees that
 * side's counts and the issues about that side or the fixture itself; issues the API does not
 * attribute to a side (a suspension) are left out. Everyone else sees no readiness detail.
 */
export function visibleReadiness(
  readiness: Schema<'FixtureReadiness'>,
  myEntryId: string | null,
  isCaptain: boolean,
): Pick<Schema<'FixtureReadiness'>, 'sides' | 'issues'> | null {
  if (!isCaptain || !myEntryId) return null;
  return {
    sides: readiness.sides.filter((side) => side.teamEntryId === myEntryId),
    issues: readiness.issues.filter(
      (issue) =>
        FIXTURE_LEVEL_SOURCES.has(issue.source.type) ||
        (issue.source.type === 'team_entry' && issue.source.id === myEntryId),
    ),
  };
}

function FixtureContent({ fixtureId }: { fixtureId: string }) {
  const styles = useStyles();
  const router = useRouter();
  const now = useNow();
  const signedIn = useSignedIn();
  const fixture = useApiQuery({
    path: '/fixtures/{id}',
    request: { path: { id: fixtureId } },
    enabled: signedIn,
  });
  const readiness = useApiQuery({
    path: '/fixtures/{id}/readiness',
    request: { path: { id: fixtureId } },
    enabled: signedIn && fixture.data !== undefined,
  });
  const results = useApiQuery({
    path: '/fixtures/{id}/results',
    request: { path: { id: fixtureId } },
    enabled: signedIn && fixture.data !== undefined,
  });
  const homeEntryId = fixture.data?.home.entryId ?? '';
  const awayEntryId = fixture.data ? (awayOf(fixture.data)?.entryId ?? '') : '';
  const homeEntry = useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: homeEntryId } },
    enabled: signedIn && !!homeEntryId,
  });
  const awayEntry = useApiQuery({
    path: '/team-entries/{id}',
    request: { path: { id: awayEntryId } },
    enabled: signedIn && !!awayEntryId,
  });
  const inbox = useInbox();
  const me = useMe();
  const viewerId = me.data?.principal.personId ?? me.data?.person?.id ?? null;
  // Whose answer is whose is known only once `GET /v1/me` answers: until then no answer is
  // labelled as a family member's, and the viewer's own revision is not guessed (CMP-04).
  const viewerKnown = me.data !== undefined;
  const othersAnswers = fixture.data && viewerKnown ? otherResponses(fixture.data, viewerId) : [];
  const names = usePersonNames(
    othersAnswers.map((r) => r.personId),
    me.data,
  );
  const queryClient = useQueryClient();
  // §4.10, §4.14: once the API stops serving this fixture to the person (removed from the roster,
  // guardian grant revoked), the cached copy is no longer shown and leaves the cache.
  const revoked = fixture.error !== null && presentationForError(fixture.error) === 'unavailable';
  const revokedRef = useRef(false);
  revokedRef.current = revoked;
  useEffect(
    () => () => {
      // On leaving the screen (no observer left), drop the copy the person may no longer see.
      if (revokedRef.current) {
        queryClient.removeQueries({
          queryKey: apiQueryKey('/fixtures/{id}', { path: { id: fixtureId } }),
          exact: true,
        });
      }
    },
    [queryClient, fixtureId],
  );

  const detail = revoked ? undefined : fixture.data;
  if (!detail) {
    return (
      <SectionQueryState
        read={fixture}
        label="the game"
        unavailable={{
          description:
            'This game is not available. Check the link, or contact the front desk if you expected to see it.',
        }}
      />
    );
  }

  const away = awayOf(detail);
  // The side whose entry the person may read is theirs; the other is the opponent.
  const mine = homeEntry.data ? 'home' : awayEntry.data ? 'away' : null;
  const workspace = homeEntry.data ?? awayEntry.data;
  const opponent =
    mine === 'home' ? (away?.teamName ?? null) : mine === 'away' ? detail.home.teamName : null;
  const latest = latestChangeForEvent(inbox.data?.items ?? [], detail.schedulingEventId);
  const after = latest?.change.after ?? null;
  const venue = venueOf(detail);
  // SPK-SCHED-008: the newest notice's zone, else the venue's facility zone (CMP-04).
  const zone = zoneOf(after?.timezone, latest?.change.before?.timezone, venue?.timezone);
  const model: ActivityCardModel = {
    participant: workspace ? workspace.team.name : 'Your team',
    title: fixtureTitle(detail),
    opponent,
    location: venueLocation(
      venue,
      after?.resources.map((r) => r.name),
    ),
    start: detail.scheduledStart,
    end: detail.scheduledEnd,
    zone,
    status: fixtureStatus(detail.status),
    change: latest?.change ?? null,
    // COM-06: an open availability request the viewer has not answered.
    requiredAction: viewerKnown
      ? fixtureRequiredAction(
          detail,
          viewerId,
          openAvailabilityRequest(inbox.data?.items ?? [], detail.id),
        )
      : null,
  };
  const notice = zoneNotice(zone, detail.scheduledStart ?? now);
  const result = results.data ? currentResult(results.data) : null;
  const myEntryId = mine === 'home' ? homeEntryId : mine === 'away' ? awayEntryId : null;
  // CMP-02: the API says whether the viewer acts as captain (the rule set decides co-captains);
  // an older workspace answer without `viewer` falls back to the effective role records.
  const isCaptain =
    workspace?.viewer?.actingAsCaptain ??
    (viewerId !== null &&
      (workspace?.roles ?? []).some(
        (r) =>
          r.personId === viewerId &&
          (r.role === 'captain' || r.role === 'co_captain') &&
          r.effectiveTo === null,
      ));
  const own = ownResponse(detail, viewerId);
  const ownSide = mine === 'home' ? detail.home : mine === 'away' ? away : null;
  const shownReadiness = readiness.data
    ? visibleReadiness(readiness.data, myEntryId, isCaptain)
    : null;

  return (
    <View testID="fixture-detail">
      <LastUpdated
        at={oldestUpdate([fixture.updatedAt, readiness.updatedAt, results.updatedAt])}
        now={now}
      />
      <View>
        <ActivityHero
          model={model}
          source={artworkFor({ kind: 'game', title: model.title }, 'wide').source}
          testID="fixture-card"
          rsvp={
            <RsvpControl
              key={detail.id}
              fixtureId={detail.id}
              fixtureStatus={detail.status}
              myResponse={(own?.state ?? detail.myResponse ?? null) as RsvpState | null}
              responseRevision={own?.revision ?? null}
              onRoster={viewerOnRoster(detail)}
              onReload={() => void fixture.refetch()}
            />
          }
        />
        {notice ? <Text style={styles.note}>{notice}</Text> : null}
      </View>

      {!viewerKnown && (detail.responses ?? []).length > 0 ? (
        <Section variant="carousel" title="Family answers" testID="fixture-family-answers">
          <SectionQueryState
            read={me}
            label="the family answers"
            unavailable={{ description: 'The family answers are not available to you.' }}
          />
        </Section>
      ) : null}
      {othersAnswers.length > 0 ? (
        <Section variant="carousel" title="Family answers" testID="fixture-family-answers">
          <View accessibilityRole="list" style={styles.pad}>
            {othersAnswers.map((r) => {
              const status = rsvpStatus(r.state as RsvpState);
              return (
                <View
                  key={r.personId}
                  accessible
                  accessibilityLabel={`${nameOf(names, r.personId)}: ${status.label}`}
                  style={styles.answer}
                >
                  <Text style={styles.body}>{nameOf(names, r.personId)}</Text>
                  <StatusBadge {...status} />
                </View>
              );
            })}
          </View>
          <Text
            style={styles.note}
          >{`These are the answers recorded so far. ${pendingMessage('DEC-090')}`}</Text>
          <View style={styles.pad}>
            <SupportDetails decisions={['DEC-090']} />
          </View>
        </Section>
      ) : null}

      {ownSide ? (
        // Only the viewer's own side: the opponent's answers are not theirs to see.
        <Section variant="carousel" title="Team availability" testID="fixture-availability">
          <Text style={styles.note}>{availabilityLine(ownSide)}</Text>
        </Section>
      ) : null}

      {isCaptain ? (
        <Section variant="carousel" title="Match readiness" testID="fixture-readiness">
          <SectionQueryState
            read={readiness}
            label="match readiness"
            unavailable={{ description: 'Match readiness is not available to you.' }}
          />
          {readiness.data && shownReadiness ? (
            <View style={styles.pad}>
              <StatusBadge {...readinessStatus(readiness.data.status)} testID="readiness-status" />
              <Text style={styles.note}>
                Assessed {formatWhen(readiness.data.evaluatedAt, zone.zone)}.
              </Text>
              {shownReadiness.sides.map((side) => (
                <Text key={side.teamEntryId} style={styles.body}>
                  {side.teamName}: {side.eligiblePlayers} of {side.rosterSize} rostered players
                  eligible, {side.unknownPlayers} not yet known; at least {side.minimumPlayers}{' '}
                  needed.
                </Text>
              ))}
              {shownReadiness.issues.length === 0 ? (
                <Text style={styles.note}>No open issues.</Text>
              ) : (
                <View accessibilityRole="list" style={styles.issues}>
                  {shownReadiness.issues.map((issue, index) => (
                    <View
                      key={`${issue.code}-${index}`}
                      style={styles.issue}
                      accessible
                      accessibilityLabel={`${severityStatus(issue.severity).label}. ${issue.message} Responsible: ${roleLabel(issue.responsibleRole)}. Action: ${issue.requiredAction}`}
                      testID={`readiness-issue-${index}`}
                    >
                      <StatusBadge {...severityStatus(issue.severity)} />
                      <Text style={styles.body}>{issue.message}</Text>
                      <Text style={styles.caption}>
                        Responsible: {roleLabel(issue.responsibleRole)}. Action:{' '}
                        {issue.requiredAction}
                        {issue.deadline ? ` By ${formatWhen(issue.deadline, zone.zone)}.` : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
          ) : null}
        </Section>
      ) : null}

      <Section variant="carousel" title="Result" testID="fixture-result">
        <SectionQueryState
          read={results}
          label="the result"
          unavailable={{ description: 'The result is not available to you.' }}
        />
        {results.data && !result ? <Text style={styles.note}>No result yet.</Text> : null}
        {result ? (
          <View
            style={styles.pad}
            accessible
            accessibilityLabel={`${scoreLine(result, detail)}. ${resultStatus(result, (iso) => formatDay(iso, zone.zone)).label}`}
          >
            <Text style={styles.score}>{scoreLine(result, detail)}</Text>
            <StatusBadge {...resultStatus(result, (iso) => formatDay(iso, zone.zone))} />
            {result.status === 'submitted' ? (
              <Text style={styles.note}>
                Provisional results do not count in the standings until official.
              </Text>
            ) : null}
          </View>
        ) : null}
        {result && result.status === 'official' && isCaptain && myEntryId ? (
          <View style={styles.pad}>
            <Button
              label="Dispute this result"
              variant="secondary"
              accessibilityHint="Opens the dispute form for your team; the dispute window applies"
              onPress={() => router.push(teamRoutes.dispute(myEntryId, detail.id) as Href)}
              testID="fixture-dispute"
            />
          </View>
        ) : null}
      </Section>

      <Section variant="carousel" title="Rules" testID="fixture-rules">
        {workspace ? (
          <Text style={styles.note}>
            {workspace.ruleSet.name} (version {workspace.ruleSet.version}), {workspace.season.name}
            {workspace.division ? `, ${workspace.division.name}` : ''}.
          </Text>
        ) : homeEntry.isLoading || awayEntry.isLoading ? (
          <StateView variant="loading" label="the rules" />
        ) : (
          <Text style={styles.note}>The rule set summary is shown to team members.</Text>
        )}
      </Section>

      <Section variant="carousel" title="Arrival guidance">
        <StateView
          variant="pending-decision"
          subject="Arrival guidance for this activity"
          message={pendingMessage('POL-046')}
          decisions={['POL-046']}
          owner="Operations"
        />
      </Section>
    </View>
  );
}

export function FixtureDetailScreen({ fixtureId }: { fixtureId: string | undefined }) {
  return (
    <Screen>
      <RequireSession what="this game">
        {fixtureId ? <FixtureContent fixtureId={fixtureId} /> : <StateView variant="unavailable" />}
      </RequireSession>
    </Screen>
  );
}

/** Route entry: `/fixtures/<id>` (an opaque id only). */
export function FixtureDetailRoute() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  return <FixtureDetailScreen fixtureId={typeof id === 'string' ? id : undefined} />;
}

const useStyles = makeStyles(({ colors }) => ({
  pad: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  issues: { gap: spacing.sm },
  answer: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  issue: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    backgroundColor: colors.background,
  },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  /** A note at the page's side margin, inside an edge-to-edge section. */
  note: { ...type.caption, color: colors.textMuted, paddingHorizontal: layout.gutter },
  score: { ...type.title, color: colors.text },
}));
