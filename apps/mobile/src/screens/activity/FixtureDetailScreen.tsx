/**
 * SCR-C-20 Activity or fixture detail, fixture variant (SPK-UX-004, SPK-CAP-002, SPK-CAP-003,
 * SPK-READY-002, SPK-RESULT-001, SPK-RESULT-005, SPK-COMMS-005, SPK-SCHED-008, SPK-UX-008,
 * SPK-UX-009).
 *
 * - `GET /v1/fixtures/{id}`: teams, state, time, availability counts and the person's own RSVP.
 *   NOT_FOUND (the person is on neither roster and holds no view grant) is "not available", with
 *   no hint that the fixture exists (§4.10).
 * - The next-activity card (SCR-C-04) with RSVP (`POST /v1/fixtures/{id}/availability`).
 * - Material changes: the newest schedule notice about the fixture's scheduling event gives old
 *   and new details, the field names and the facility's time zone.
 * - Match readiness as the customer may see it: `GET /v1/fixtures/{id}/readiness` answers with
 *   what this person may read (restricted record ids already removed by the API, SPK-CAP-002);
 *   the screen shows the assessment, each issue's responsible role and required action, and
 *   counts only, never other players' details.
 * - Result: the current official revision, else the submitted one as "Provisional"
 *   (`GET /v1/fixtures/{id}/results`, SPK-RESULT-001); a corrected result says so.
 * - Rule set summary from the team entry the person may read (`GET /v1/team-entries/{id}`).
 * - Arrival guidance is POL-046 (Operations, pending); dispute submission is SCR-C-29, not in
 *   this app yet.
 */
import { apiQueryKey, presentationForError, type Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { NextActivityCard, type ActivityCardModel } from '../../features/today/NextActivityCard';
import { latestChangeForEvent } from '../../features/today/notices';
import { useInbox, useMe, useSignedIn } from '../../features/today/queries';
import { RsvpControl } from '../../features/today/RsvpControl';
import { Caption, oldestUpdate, Section, SectionQueryState } from '../../features/today/Section';
import {
  currentResult,
  fixtureStatus,
  readinessStatus,
  resultStatus,
  roleLabel,
  severityStatus,
  type RsvpState,
} from '../../features/today/status';
import { displayZone, formatDay, formatWhen, zoneNotice } from '../../features/today/time';
import { useNow } from '../../providers/AppProviders';
import { RequireSession } from '../../session/RequireSession';
import { LastUpdated } from '../../ui/LastUpdated';
import { Screen } from '../../ui/Screen';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';

type FixtureDetail = Schema<'FixtureDetail'>;
type FixtureSide = Schema<'FixtureSide'>;
type ResultRevision = Schema<'ResultRevision'>;

/** The generated type of `away` is distorted by its nullable `allOf`; this is its real shape. */
function awayOf(fixture: FixtureDetail): FixtureSide | null {
  return (fixture.away as FixtureSide | null) ?? null;
}

export function fixtureTitle(fixture: FixtureDetail): string {
  const away = awayOf(fixture);
  return away ? `${fixture.home.teamName} vs ${away.teamName}` : `${fixture.home.teamName} (bye)`;
}

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
        label="the fixture"
        unavailable={{
          description:
            'This fixture is not available. Check the link, or contact the front desk if you expected to see it.',
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
  const zone = displayZone(after?.timezone ?? latest?.change.before?.timezone ?? null);
  const model: ActivityCardModel = {
    participant: workspace ? workspace.team.name : 'Your team',
    title: fixtureTitle(detail),
    opponent,
    location: after?.resources.map((r) => r.name).join(', ') || null,
    start: detail.scheduledStart,
    end: detail.scheduledEnd,
    zone,
    status: fixtureStatus(detail.status),
    change: latest?.change ?? null,
    requiredAction: null,
  };
  const notice = zoneNotice(zone, detail.scheduledStart ?? now);
  const result = results.data ? currentResult(results.data) : null;
  const myEntryId = mine === 'home' ? homeEntryId : mine === 'away' ? awayEntryId : null;
  const viewerId = me.data?.principal.personId ?? me.data?.person?.id ?? null;
  const isCaptain =
    viewerId !== null &&
    (workspace?.roles ?? []).some(
      (r) =>
        r.personId === viewerId &&
        (r.role === 'captain' || r.role === 'co_captain') &&
        r.effectiveTo === null,
    );
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
      <Section title="Fixture">
        <NextActivityCard
          model={model}
          testID="fixture-card"
          rsvp={
            <RsvpControl
              fixtureId={detail.id}
              fixtureStatus={detail.status}
              myResponse={(detail.myResponse as RsvpState | null) ?? null}
              onReload={() => void fixture.refetch()}
            />
          }
        />
        {notice ? <Caption>{notice}</Caption> : null}
      </Section>

      {ownSide ? (
        // Only the viewer's own side: the opponent's answers are not theirs to see.
        <Section title="Team availability" testID="fixture-availability">
          <Caption>{availabilityLine(ownSide)}</Caption>
        </Section>
      ) : null}

      {isCaptain ? (
        <Section title="Match readiness" testID="fixture-readiness">
          <SectionQueryState
            read={readiness}
            label="match readiness"
            unavailable={{ description: 'Match readiness is not available to you.' }}
          />
          {readiness.data && shownReadiness ? (
            <View style={styles.pad}>
              <StatusBadge {...readinessStatus(readiness.data.status)} testID="readiness-status" />
              <Caption>Assessed {formatWhen(readiness.data.evaluatedAt, zone.zone)}.</Caption>
              {shownReadiness.sides.map((side) => (
                <Text key={side.teamEntryId} style={styles.body}>
                  {side.teamName}: {side.eligiblePlayers} of {side.rosterSize} rostered players
                  eligible, {side.unknownPlayers} not yet known; at least {side.minimumPlayers}{' '}
                  needed.
                </Text>
              ))}
              {shownReadiness.issues.length === 0 ? (
                <Caption>No open issues.</Caption>
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

      <Section title="Result" testID="fixture-result">
        <SectionQueryState
          read={results}
          label="the result"
          unavailable={{ description: 'The result is not available to you.' }}
        />
        {results.data && !result ? <Caption>No result yet.</Caption> : null}
        {result ? (
          <View
            style={styles.pad}
            accessible
            accessibilityLabel={`${scoreLine(result, detail)}. ${resultStatus(result, (iso) => formatDay(iso, zone.zone)).label}`}
          >
            <Text style={styles.score}>{scoreLine(result, detail)}</Text>
            <StatusBadge {...resultStatus(result, (iso) => formatDay(iso, zone.zone))} />
            {result.status === 'submitted' ? (
              <Caption>Provisional results do not count in the standings until official.</Caption>
            ) : null}
          </View>
        ) : null}
        {result ? <Caption>Disputing a result is not available in the app yet.</Caption> : null}
      </Section>

      <Section title="Rules" testID="fixture-rules">
        {workspace ? (
          <Caption>
            {workspace.ruleSet.name} (version {workspace.ruleSet.version}), {workspace.season.name}
            {workspace.division ? `, ${workspace.division.name}` : ''}.
          </Caption>
        ) : homeEntry.isLoading || awayEntry.isLoading ? (
          <StateView variant="loading" label="the rules" />
        ) : (
          <Caption>The rule set summary is shown to team members.</Caption>
        )}
      </Section>

      <Section title="Arrival guidance">
        <StateView
          variant="pending-decision"
          subject="Arrival guidance for this activity"
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
      <RequireSession what="this fixture">
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

const styles = StyleSheet.create({
  pad: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  issues: { gap: spacing.sm },
  issue: {
    gap: spacing.xs,
    padding: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 6,
  },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
  score: { ...type.title, color: colors.text },
});
