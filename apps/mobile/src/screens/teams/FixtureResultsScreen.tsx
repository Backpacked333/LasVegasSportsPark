/**
 * SCR-C-28 Standings and results, one game's result (SPK-RESULT-001, SPK-RESULT-002,
 * SPK-RESULT-004, SPK-RESULT-005, SPK-DISC-004). Reads `GET /v1/fixtures/{id}` for the sides,
 * `GET /v1/fixtures/{id}/results` for the result revisions the person may see (official and
 * replaced ones: "Official", "Corrected on <date>", "Replaced by a correction on <date>"), keeping
 * every earlier result, its reason and publication time visible; and `GET /v1/fixtures/{id}/disputes`
 * for the disputes this person may see, with their status and decision. A captain can open the
 * dispute form (SCR-C-29). Incident narratives are never shown (SPK-DISC-004).
 *
 * States: loading; empty (no official result yet); ready; permission restriction (NOT_FOUND: not
 * available); stale version (a correction published: the new revision is shown, the old one kept
 * as history); offline (cached with age).
 */
import type { Schema } from '@sportspark/api-client';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { formatInstant } from '../../features/teams/format';
import type { Viewer, Workspace } from '../../features/teams/queries';
import { idParam, teamRoutes } from '../../features/teams/routes';
import {
  CLASSIFICATION_LABELS,
  PUBLICATION_CONSEQUENCE_LABELS,
  disputeStatus,
  fixtureStatus,
  resultStatus,
} from '../../features/teams/status';
import { TeamFrame } from '../../features/teams/TeamFrame';
import { Body, Detail, Section, Title } from '../../features/teams/ui';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { QueryBoundary, QueryErrorView } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type ResultRevision = Schema<'ResultRevision'>;
type FixtureDetail = Schema<'FixtureDetail'>;
type Dispute = Schema<'Dispute'>;

export function scoreText(revision: ResultRevision, fixture: FixtureDetail): string | null {
  if (revision.homeScore === null || revision.awayScore === null) return null;
  return `${fixture.home.teamName} ${revision.homeScore}, ${fixture.away?.teamName ?? 'Opponent'} ${revision.awayScore}`;
}

/** The official revision, if any, then the rest newest first (SPK-RESULT-004 history). */
export function orderRevisions(revisions: ResultRevision[]) {
  const sorted = [...revisions].sort((a, b) => b.revisionNo - a.revisionNo);
  const official = sorted.find((r) => r.status === 'official') ?? null;
  return { official, history: sorted.filter((r) => r !== official) };
}

function OfficialResult({
  revision,
  fixture,
}: {
  revision: ResultRevision;
  fixture: FixtureDetail;
}) {
  const score = scoreText(revision, fixture);
  const forfeiting =
    revision.forfeitingEntryId === fixture.home.entryId
      ? fixture.home.teamName
      : revision.forfeitingEntryId && fixture.away?.entryId === revision.forfeitingEntryId
        ? fixture.away.teamName
        : null;
  return (
    <View testID="official-result">
      <StatusBadge {...resultStatus(revision)} testID="official-status" />
      {score ? <Detail label="Score" value={score} /> : null}
      <Detail label="Outcome" value={CLASSIFICATION_LABELS[revision.classification]} />
      {forfeiting ? <Detail label="Forfeited by" value={forfeiting} /> : null}
      {revision.details.abandonment ? (
        <Detail
          label="Abandoned"
          value={`At minute ${revision.details.abandonment.minutePlayed}: ${revision.details.abandonment.reason}`}
        />
      ) : null}
      {revision.publishedAt ? (
        <Detail label="Published" value={formatInstant(revision.publishedAt)} />
      ) : null}
      {revision.supersedesRevisionId && revision.reason ? (
        <Detail label="Reason for the correction" value={revision.reason} />
      ) : null}
    </View>
  );
}

function DisputeRow({ dispute }: { dispute: Dispute }) {
  const parts = [`Submitted ${formatInstant(dispute.submittedAt)}`, dispute.reason];
  if (dispute.decisionReason) parts.push(`Decision: ${dispute.decisionReason}`);
  if (dispute.publicationConsequence) {
    parts.push(PUBLICATION_CONSEQUENCE_LABELS[dispute.publicationConsequence]);
  }
  if (dispute.appealStatus !== 'none') parts.push(`Appeal: ${dispute.appealStatus}`);
  return (
    <ListRow
      title="Dispute"
      detail={parts.join('. ')}
      status={disputeStatus(dispute)}
      testID={`dispute-${dispute.id}`}
    />
  );
}

function ResultsContent({
  workspace,
  viewer,
  fixtureId,
}: {
  workspace: Workspace;
  viewer: Viewer;
  fixtureId: string;
}) {
  const router = useRouter();
  const fixture = useApiQuery({ path: '/fixtures/{id}', request: { path: { id: fixtureId } } });
  const results = useApiQuery({
    path: '/fixtures/{id}/results',
    request: { path: { id: fixtureId } },
  });
  const disputes = useApiQuery({
    path: '/fixtures/{id}/disputes',
    request: { path: { id: fixtureId } },
  });
  return (
    <QueryBoundary
      query={fixture}
      label="the game"
      empty={{ title: 'No game', description: 'This game has nothing to show.' }}
    >
      {(f) => (
        <View>
          <Title>{`${f.home.teamName} vs ${f.away?.teamName ?? 'Bye'}`}</Title>
          <Section title="Game">
            <StatusBadge {...fixtureStatus(f)} />
            {f.scheduledStart ? (
              <Detail label="Kickoff" value={formatInstant(f.scheduledStart)} />
            ) : null}
          </Section>
          <Section title="Result">
            <QueryBoundary
              query={results}
              label="the result"
              isEmpty={(list) => list.length === 0}
              empty={{
                title: 'No official result yet',
                description: 'The result appears here once the league makes it official.',
              }}
            >
              {(list) => {
                const { official, history } = orderRevisions(list);
                return (
                  <View>
                    {official ? (
                      <OfficialResult revision={official} fixture={f} />
                    ) : (
                      <Body>No official result yet.</Body>
                    )}
                    {history.length > 0 ? (
                      <View accessibilityRole="list" testID="result-history">
                        <Body muted>Earlier results, kept as history</Body>
                        {history.map((r) => (
                          <ListRow
                            key={r.id}
                            title={scoreText(r, f) ?? CLASSIFICATION_LABELS[r.classification]}
                            detail={
                              r.publishedAt
                                ? `Published ${formatInstant(r.publishedAt)}`
                                : undefined
                            }
                            status={resultStatus(r)}
                          />
                        ))}
                      </View>
                    ) : null}
                    {viewer.captainView && official ? (
                      <Button
                        label="Dispute this result"
                        variant="secondary"
                        onPress={() =>
                          router.push(teamRoutes.dispute(workspace.entry.id, fixtureId))
                        }
                        accessibilityHint="Opens the dispute form; the window is set by the rule set"
                      />
                    ) : null}
                  </View>
                );
              }}
            </QueryBoundary>
          </Section>
          {(disputes.data?.length ?? 0) > 0 ? (
            <Section title="Disputes">
              <View accessibilityRole="list">
                {disputes.data?.map((d) => (
                  <DisputeRow key={d.id} dispute={d} />
                ))}
              </View>
            </Section>
          ) : disputes.data === undefined && disputes.error ? (
            // A failed read is shown with its code, not as "no disputes" (SPK-UX-008).
            <Section title="Disputes">
              <QueryErrorView error={disputes.error} onRetry={() => void disputes.refetch()} />
            </Section>
          ) : null}
        </View>
      )}
    </QueryBoundary>
  );
}

export function FixtureResultsScreen({
  entryId,
  fixtureId,
}: {
  entryId: string | null;
  fixtureId: string | null;
}) {
  return (
    <TeamFrame entryId={fixtureId ? entryId : null} what="this game's result">
      {(ws, viewer) =>
        fixtureId ? <ResultsContent workspace={ws} viewer={viewer} fixtureId={fixtureId} /> : null
      }
    </TeamFrame>
  );
}

/** Route component for app/team/[entryId]/results/[fixtureId].tsx. */
export function FixtureResultsRoute() {
  const params = useLocalSearchParams<{ entryId: string; fixtureId: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Result' }} />
      <FixtureResultsScreen
        entryId={idParam(params.entryId)}
        fixtureId={idParam(params.fixtureId)}
      />
    </>
  );
}
