/**
 * SCR-S-13 Standings and brackets (SPK-RESULT-001 standings derive only from official results,
 * SPK-RESULT-003 versioned rule set and tiebreak explanations, SPK-RESULT-004 review tasks for
 * affected downstream games, SPK-COMP-001 bracket progression, SPK-UX-008). Each table names the
 * rule-set version it was computed under, when, and how many official results it derives from;
 * every tie on points shows how it was decided, step by step. Bracket nodes show where each side
 * comes from (seed, winner of, loser of, bye); a node touched by an open correction review task is
 * "under review" (recovery required). An unpublished node's seeded slots are filled from final
 * division or pool standings (CMP-10, CMP-15, SeedFromStandings.tsx). Tournament pools are behind
 * the organization's tournaments capability (DEC-016, DEC-078; PoolsScreen.tsx); brackets are
 * shown as the API holds them. Team names come with each node and table row (CMP-01).
 */
import type { Schema } from '@sportspark/api-client';
import { Fragment, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys, useRefetch } from '../../features/competition/feedback';
import { SelectField } from '../../features/competition/fields';
import {
  FORM_LENGTH,
  OUTCOME_WORD,
  useSeasonForm,
  type FormOutcome,
  type SeasonForm,
} from '../../features/competition/form';
import { formatInstant, shortRef } from '../../features/competition/format';
import { humanizeCode } from '../../features/competition/labels';
import { SeasonLinks } from '../../features/competition/nav';
import { CompeteHeader } from '../../features/competition/page';
import { SeasonEyebrow } from '../../features/competition/season-context';
import { CardHead } from '../../ui/Page';
import { EntryName, useSeasonEntries, type EntryNames } from '../../features/competition/names';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { RESULT_REVIEW_CATEGORY } from './ResultsReviewScreen';
import { SeedNode } from './SeedFromStandings';

type Standings = NonNullable<Schema<'Standings'>>;
type BracketNode = Schema<'BracketNode'>;
type BracketSource = Schema<'BracketSource'>;

const OUTCOME_TEXT: Record<Schema<'TiebreakExplanation'>['steps'][number]['outcome'], string> = {
  resolved: 'resolved the tie',
  partially_resolved: 'partly separated the teams',
  not_separating: 'did not separate the teams',
  unresolved: 'left the tie unresolved',
};

/** The last results of one team as letters, read out as words (SPK-UX-009: not colour alone). */
export function FormRun({ outcomes }: { outcomes: readonly FormOutcome[] }) {
  if (outcomes.length === 0) return <span className="caption">No results</span>;
  return (
    <span
      className="form-run"
      role="img"
      aria-label={`Last ${outcomes.length}, oldest first: ${outcomes.map((o) => OUTCOME_WORD[o]).join(', ')}`}
    >
      {outcomes.map((o, i) => (
        <span key={i} className="form-cell" data-outcome={o} aria-hidden="true">
          {o}
        </span>
      ))}
    </span>
  );
}

/**
 * A league or pool table (SPK-RESULT-003) in the condensed scoreboard type; the pool screen shows
 * its own with this. `form` adds each team's last results (derived from official results only);
 * `compact` keeps the scoring columns for the season home and leaves fair-play points, forfeits
 * and the tiebreak explanations to the standings screen.
 */
export function StandingsTable({
  standings,
  caption = 'Standings',
  form,
  compact = false,
}: {
  standings: Pick<
    Standings,
    | 'rows'
    | 'tiebreakExplanations'
    | 'ruleSetId'
    | 'ruleSetVersion'
    | 'computedAt'
    | 'sourceResultIds'
  > & { id?: string | null; playoffLine?: Standings['playoffLine'] };
  caption?: string;
  form?: SeasonForm;
  compact?: boolean;
}) {
  const names = new Map(standings.rows.map((r) => [r.teamEntryId, r.teamName]));
  const nameOf = (id: string) => names.get(id);
  const showForm = !!form?.ready;
  // The playoff line from the division's fixture specification (SPK-FIX-001): a ruled row after
  // the last qualifying position, said in words, never colour alone.
  const line = standings.playoffLine ?? null;
  const columns = 10 + (compact ? 0 : 2) + (showForm ? 1 : 0);
  return (
    <>
      <p className="caption" data-testid="standings-provenance">
        Rule set version {standings.ruleSetVersion} ({shortRef(standings.ruleSetId)}) · computed{' '}
        {formatInstant(standings.computedAt)} · from {standings.sourceResultIds.length} official{' '}
        {standings.sourceResultIds.length === 1 ? 'result' : 'results'}
        {standings.id === undefined
          ? ''
          : standings.id
            ? ` · standings revision ${shortRef(standings.id)}`
            : ' · live computation (no stored revision yet)'}
      </p>
      <div className="scoreboard-wrap">
        <table className="scoreboard">
          <caption className="sr-only-caption">{caption}</caption>
          <thead>
            <tr>
              <th scope="col" className="col-pos">
                <abbr title="Position">#</abbr>
              </th>
              <th scope="col" className="col-team">
                Team
              </th>
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
              <th scope="col" aria-label="Points">
                Pts
              </th>
              {compact ? null : (
                <>
                  <th scope="col" aria-label="Fair-play points">
                    <abbr title="Fair-play points">FP</abbr>
                  </th>
                  <th scope="col" aria-label="Forfeits">
                    <abbr title="Forfeits">FF</abbr>
                  </th>
                </>
              )}
              {showForm ? (
                <th scope="col" className="col-form">
                  Last {FORM_LENGTH}
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {standings.rows.map((row) => (
              <Fragment key={row.teamEntryId}>
                <tr data-qualifies={line ? String(row.position <= line.cutPosition) : undefined}>
                  <td className="col-pos">{row.position}</td>
                  <th scope="row" className="col-team">
                    {row.teamName}
                  </th>
                  <td className="col-num">{row.played}</td>
                  <td className="col-num">{row.won}</td>
                  <td className="col-num">{row.drawn}</td>
                  <td className="col-num">{row.lost}</td>
                  <td className="col-num">{row.goalsFor}</td>
                  <td className="col-num">{row.goalsAgainst}</td>
                  <td className="col-num">
                    {row.goalDifference > 0 ? `+${row.goalDifference}` : row.goalDifference}
                  </td>
                  <td className="col-pts">{row.points}</td>
                  {compact ? null : (
                    <>
                      <td className="col-num">{row.fairPlayPoints}</td>
                      <td className="col-num">{row.forfeits}</td>
                    </>
                  )}
                  {showForm ? (
                    <td className="col-form">
                      <FormRun outcomes={form?.of(row.teamEntryId) ?? []} />
                    </td>
                  ) : null}
                </tr>
                {line && row.position === line.cutPosition && row !== standings.rows.at(-1) ? (
                  <tr className="playoff-line">
                    <td colSpan={columns}>Playoff line: top {line.qualifyingTeams} qualify</td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {line ? (
        <p className="caption" data-testid="playoff-note">
          Top {line.qualifyingTeams} qualify for the playoff (single elimination), from the
          division&apos;s fixture specification.
        </p>
      ) : null}
      {showForm && form?.partial ? (
        <p className="caption">
          Form reads the latest 200 official results and fixtures; earlier games are not included.
        </p>
      ) : null}
      {!compact && standings.tiebreakExplanations.length > 0 ? (
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
  divisions,
}: {
  seasonId: string;
  divisionId: string;
  entries: EntryNames;
  divisions: readonly { value: string; label: string }[];
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
                          <EntryName
                            entryId={node.homeEntryId}
                            teamIdOf={entries}
                            name={node.homeTeamName}
                          />
                        </span>
                        <span>
                          {sourceText(node.sourceRule.away, nodeName)}:{' '}
                          <EntryName
                            entryId={node.awayEntryId}
                            teamIdOf={entries}
                            name={node.awayTeamName}
                          />
                        </span>
                        {node.winnerEntryId ? (
                          <span>
                            Winner:{' '}
                            <EntryName
                              entryId={node.winnerEntryId}
                              teamIdOf={entries}
                              name={
                                node.winnerEntryId === node.homeEntryId
                                  ? node.homeTeamName
                                  : node.winnerEntryId === node.awayEntryId
                                    ? node.awayTeamName
                                    : null
                              }
                            />
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
                        <div className="actions">
                          <SeedNode
                            node={node}
                            divisions={divisions}
                            teamName={(id) => teamNameOf(id, entries)}
                          />
                          <PublishNode node={node} />
                        </div>
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

function teamNameOf(entryId: string, entries: EntryNames): string {
  return entries.get(entryId)?.teamName ?? `Entry ${shortRef(entryId)}`;
}

export function StandingsScreen() {
  const { seasonId = '' } = useParams();
  const [divisionId, setDivisionId] = useState('');
  const divisions = useApiQuery({ path: '/divisions', request: { query: { seasonId } } });
  const { byId } = useSeasonEntries(seasonId);
  const divisionOptions = (divisions.data ?? []).map((d) => ({ value: d.id, label: d.name }));
  const standings = useApiQuery({
    path: '/seasons/{id}/standings',
    request: { path: { id: seasonId }, query: { ...(divisionId ? { divisionId } : {}) } },
  });
  const form = useSeasonForm(seasonId, divisionId || undefined);
  return (
    <section aria-labelledby="standings-title" className="compete">
      <CompeteHeader
        eyebrow={<SeasonEyebrow seasonId={seasonId} />}
        title="Standings and brackets"
        titleId="standings-title"
        intro="Only official results count. Standings recalculate when a result is published; every tie on points shows how it was decided."
      />
      <SeasonLinks seasonId={seasonId} />
      <section className="card card-flush" aria-labelledby="table-title">
        <CardHead
          aside={
            <div className="toolbar">
              <SelectField
                label="Division"
                value={divisionId}
                onChange={setDivisionId}
                options={divisionOptions}
                placeholder="Whole season"
              />
            </div>
          }
        >
          <h3 id="table-title">League table</h3>
        </CardHead>
        <div className="card-body">
          {divisionId ? (
            <p>
              <Link to={`/leagues/divisions/${divisionId}/pools`}>
                Tournament pools of this division
              </Link>
            </p>
          ) : null}
          <QueryBoundary
            query={standings}
            label="standings"
            isEmpty={(data) => !data || data.sourceResultIds.length === 0}
            empty={{
              title: 'No official results yet',
              description:
                'The table appears once a result of this season is published as official.',
            }}
          >
            {(data) => (data ? <StandingsTable standings={data} form={form} /> : null)}
          </QueryBoundary>
        </div>
      </section>
      <Bracket
        seasonId={seasonId}
        divisionId={divisionId}
        entries={byId}
        divisions={divisionOptions}
      />
    </section>
  );
}
