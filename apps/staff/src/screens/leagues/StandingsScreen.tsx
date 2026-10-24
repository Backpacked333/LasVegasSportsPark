/**
 * SCR-S-13 Standings and brackets (SPK-RESULT-001 standings derive only from official results,
 * SPK-RESULT-003 versioned rule set and tiebreak explanations, SPK-RESULT-004 review tasks for
 * affected downstream games, SPK-COMP-001 bracket progression, SPK-UX-008). Each table names the
 * rule-set version it was computed under, when, and how many official results it derives from;
 * every tie on points shows how it was decided, step by step. Bracket nodes show where each side
 * comes from (seed, winner of, loser of, bye); a node touched by an open correction review task is
 * "under review" (recovery required). Tournament use is pending DEC-078; brackets are shown as the
 * API holds them.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, PendingNote, useRefetch } from '../../features/competition/feedback';
import { SelectField } from '../../features/competition/fields';
import { formatInstant, shortRef } from '../../features/competition/format';
import { humanizeCode } from '../../features/competition/labels';
import { LeaguesNav, SeasonLinks } from '../../features/competition/nav';
import { EntryName, useSeasonEntries } from '../../features/competition/names';
import { PENDING } from '../../features/competition/pending';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { RESULT_REVIEW_CATEGORY } from './ResultsReviewScreen';

type Standings = NonNullable<Schema<'Standings'>>;
type BracketNode = Schema<'BracketNode'>;
type BracketSource = Schema<'BracketSource'>;

const OUTCOME_TEXT: Record<Schema<'TiebreakExplanation'>['steps'][number]['outcome'], string> = {
  resolved: 'resolved the tie',
  partially_resolved: 'partly separated the teams',
  not_separating: 'did not separate the teams',
  unresolved: 'left the tie unresolved',
};

function StandingsTable({ standings }: { standings: Standings }) {
  const names = new Map(standings.rows.map((r) => [r.teamEntryId, r.teamName]));
  const nameOf = (id: string) => names.get(id);
  return (
    <>
      <p className="caption" data-testid="standings-provenance">
        Rule set version {standings.ruleSetVersion} ({shortRef(standings.ruleSetId)}) · computed{' '}
        {formatInstant(standings.computedAt)} · from {standings.sourceResultIds.length} official{' '}
        {standings.sourceResultIds.length === 1 ? 'result' : 'results'}
        {standings.id
          ? ` · standings revision ${shortRef(standings.id)}`
          : ' · live computation (no stored revision yet)'}
      </p>
      <div className="table-scroll">
        <table className="data-table">
          <caption>Standings</caption>
          <thead>
            <tr>
              <th scope="col">Position</th>
              <th scope="col">Team</th>
              <th scope="col">
                <abbr title="Played">P</abbr>
              </th>
              <th scope="col">
                <abbr title="Won">W</abbr>
              </th>
              <th scope="col">
                <abbr title="Drawn">D</abbr>
              </th>
              <th scope="col">
                <abbr title="Lost">L</abbr>
              </th>
              <th scope="col">
                <abbr title="Goals for">GF</abbr>
              </th>
              <th scope="col">
                <abbr title="Goals against">GA</abbr>
              </th>
              <th scope="col">
                <abbr title="Goal difference">GD</abbr>
              </th>
              <th scope="col">Points</th>
              <th scope="col">Fair-play points</th>
              <th scope="col">Forfeits</th>
            </tr>
          </thead>
          <tbody>
            {standings.rows.map((row) => (
              <tr key={row.teamEntryId}>
                <td>{row.position}</td>
                <th scope="row">{row.teamName}</th>
                <td>{row.played}</td>
                <td>{row.won}</td>
                <td>{row.drawn}</td>
                <td>{row.lost}</td>
                <td>{row.goalsFor}</td>
                <td>{row.goalsAgainst}</td>
                <td>{row.goalDifference}</td>
                <td>{row.points}</td>
                <td>{row.fairPlayPoints}</td>
                <td>{row.forfeits}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {standings.tiebreakExplanations.length > 0 ? (
        <section aria-labelledby="tiebreaks-title">
          <h4 id="tiebreaks-title">How ties were decided</h4>
          <ul className="list" aria-label="Tiebreak explanations">
            {standings.tiebreakExplanations.map((tie, index) => (
              <li key={index}>
                <div className="row-text">
                  <span className="row-title">
                    {tie.teamEntryIds.map((id) => nameOf(id) ?? `Team ${shortRef(id)}`).join(', ')}{' '}
                    on {tie.points} points
                  </span>
                  <StatusBadge
                    tone={tie.resolved ? 'success' : 'warning'}
                    label={tie.resolved ? 'Tie resolved' : 'Tie unresolved'}
                  />
                  <ol>
                    {tie.steps.map((step, i) => (
                      <li key={i}>
                        {step.tiebreaker === 'exhausted'
                          ? 'No further tiebreaker in the rule set'
                          : humanizeCode(step.tiebreaker)}{' '}
                        {OUTCOME_TEXT[step.outcome]}: {step.explanation}
                        {step.values.length > 0 ? (
                          <span className="caption">
                            {' '}
                            (
                            {step.values
                              .map(
                                (v) =>
                                  `${nameOf(v.teamEntryId) ?? shortRef(v.teamEntryId)} ${v.value}`,
                              )
                              .join('; ')}
                            )
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function sourceText(source: BracketSource, nodeName: (id: string) => string): string {
  switch (source.kind) {
    case 'seed':
      return `Seed ${source.seed}`;
    case 'winner_of':
      return `Winner of ${nodeName(source.nodeId)}`;
    case 'loser_of':
      return `Loser of ${nodeName(source.nodeId)}`;
    case 'bye':
      return 'Bye';
  }
}

function PublishNode({ node }: { node: BracketNode }) {
  const publish = useApiCommand('post', '/bracket-nodes/{id}/publish', {
    invalidate: keys('/seasons/{id}/bracket-nodes'),
  });
  const reload = useRefetch(['/seasons/{id}/bracket-nodes']);
  const send = () =>
    void publish
      .submit({ path: { id: node.id }, body: { expectedRevision: node.revision } })
      .catch(() => undefined);
  return (
    <div className="form">
      <CommandButton
        variant="secondary"
        busy={publish.isProcessing}
        aria-label={`Publish bracket node ${node.name ?? `round ${node.round} slot ${node.slot}`}`}
        onClick={send}
      >
        Publish
      </CommandButton>
      <CommandError
        error={publish.error}
        onRetry={send}
        onReload={() => {
          publish.reset();
          reload();
        }}
      />
    </div>
  );
}

function Bracket({
  seasonId,
  divisionId,
  entries,
}: {
  seasonId: string;
  divisionId: string;
  entries: ReadonlyMap<string, { teamId: string }>;
}) {
  const nodes = useApiQuery({
    path: '/seasons/{id}/bracket-nodes',
    request: { path: { id: seasonId }, query: { ...(divisionId ? { divisionId } : {}) } },
  });
  // No status filter: the API returns open and acknowledged tasks, and an acknowledged correction
  // review is still undecided (SCR-S-13 recovery state "under review").
  const reviews = useApiQuery({
    path: '/exceptions',
    request: { query: { queue: 'league_manager', limit: 100 } },
  });
  const reviewUnknown = reviews.data === undefined;
  const underReview = new Set<string>();
  for (const task of reviews.data?.items ?? []) {
    if (task.category !== RESULT_REVIEW_CATEGORY) continue;
    if (task.status !== 'open' && task.status !== 'acknowledged') continue;
    const ids = task.details.affectedBracketNodeIds;
    if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') underReview.add(id);
  }
  return (
    <section className="panel" aria-labelledby="bracket-title">
      <h3 id="bracket-title">Bracket</h3>
      <PendingNote decision={PENDING.tournaments} />
      {reviews.error ? (
        <p className="caption">
          Review tasks could not be checked ({reviews.error.code}), so whether a node is under
          review is unknown.
        </p>
      ) : null}
      <QueryBoundary
        query={nodes}
        label="bracket nodes"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No bracket',
          description: 'Bracket nodes of this season appear here once created.',
        }}
        unavailableOffline={['publishing bracket nodes']}
      >
        {(data) => {
          const byId = new Map(data.map((n) => [n.id, n]));
          const nodeName = (id: string) => {
            const n = byId.get(id);
            return n ? (n.name ?? `round ${n.round}, slot ${n.slot}`) : `node ${shortRef(id)}`;
          };
          const rounds = [...new Set(data.map((n) => n.round))].sort((a, b) => a - b);
          return rounds.map((round) => (
            <section key={round} aria-labelledby={`round-${round}`}>
              <h4 id={`round-${round}`}>Round {round}</h4>
              <ul className="list" aria-label={`Round ${round}`}>
                {data
                  .filter((n) => n.round === round)
                  .sort((a, b) => a.slot - b.slot)
                  .map((node) => (
                    <li key={node.id}>
                      <div className="row-text">
                        <span className="row-title">{node.name ?? `Slot ${node.slot}`}</span>
                        <span>
                          {sourceText(node.sourceRule.home, nodeName)}:{' '}
                          <EntryName entryId={node.homeEntryId} teamIdOf={entries} />
                        </span>
                        <span>
                          {sourceText(node.sourceRule.away, nodeName)}:{' '}
                          <EntryName entryId={node.awayEntryId} teamIdOf={entries} />
                        </span>
                        {node.winnerEntryId ? (
                          <span>
                            Winner: <EntryName entryId={node.winnerEntryId} teamIdOf={entries} />
                          </span>
                        ) : null}
                        <span>
                          {underReview.has(node.id) ? (
                            <StatusBadge tone="danger" label="Under review" />
                          ) : reviewUnknown ? (
                            <StatusBadge tone="neutral" label="Review status unknown" />
                          ) : null}{' '}
                          <StatusBadge
                            tone={node.published ? 'success' : 'pending'}
                            label={node.published ? 'Published' : 'Not published'}
                          />
                        </span>
                        {node.fixtureId ? (
                          <Link to={`/leagues/fixtures/${node.fixtureId}`}>Open the fixture</Link>
                        ) : null}
                      </div>
                      {!node.published && underReview.has(node.id) ? (
                        <p className="caption">
                          A correction review touches this node; publish it after the review is
                          decided.
                        </p>
                      ) : !node.published && reviewUnknown ? (
                        <p className="caption">
                          Publishing waits until the review tasks can be checked.
                        </p>
                      ) : !node.published ? (
                        <PublishNode node={node} />
                      ) : null}
                    </li>
                  ))}
              </ul>
            </section>
          ));
        }}
      </QueryBoundary>
    </section>
  );
}

export function StandingsScreen() {
  const { seasonId = '' } = useParams();
  const [divisionId, setDivisionId] = useState('');
  const divisions = useApiQuery({ path: '/divisions', request: { query: { seasonId } } });
  const { byId } = useSeasonEntries(seasonId);
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: { path: { id: seasonId }, query: { ...(divisionId ? { divisionId } : {}) } },
  });
  return (
    <section aria-labelledby="standings-title">
      <h2 id="standings-title">Standings and brackets</h2>
      <LeaguesNav />
      <SeasonLinks seasonId={seasonId} />
      <SelectField
        label="Division"
        value={divisionId}
        onChange={setDivisionId}
        options={(divisions.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
        placeholder="Whole season"
      />
      <section className="panel" aria-labelledby="table-title">
        <h3 id="table-title">League table</h3>
        <p className="caption">
          Only official results count. Standings recalculate when a result is published.
        </p>
        <QueryBoundary
          query={standings}
          label="standings"
          isEmpty={(data) => !data || data.sourceResultIds.length === 0}
          empty={{
            title: 'No official results yet',
            description: 'The table appears once a result of this season is published as official.',
          }}
        >
          {(data) => (data ? <StandingsTable standings={data} /> : null)}
        </QueryBoundary>
      </section>
      <Bracket seasonId={seasonId} divisionId={divisionId} entries={byId} />
    </section>
  );
}
