/**
 * SCR-S-08 Competition, season and division setup, part 3: one season, its lifecycle and rule-set
 * version, and its divisions with documented criteria (SPK-COMP-001, SPK-COMP-003, SPK-UX-008).
 * Season moves follow SeasonMachine with `expectedRevision` (§4.9). Division criteria are the
 * documented fields of SPK-COMP-003 (age band, level, category, format; location; capacity); which
 * combinations are approved is pending DEC-048, so nothing is preset. Capacity cannot drop below
 * the entries already placed: the API refuses it and the answer is shown with its code.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import {
  ConfirmMove,
  keys,
  PendingNote,
  SuccessNote,
  useRefetch,
} from '../../features/competition/feedback';
import { NumberField, TextField, parseWholeNumber } from '../../features/competition/fields';
import { useFacilityDirectory } from '../../features/competition/facilities';
import { formatDateOnly, formatInstant } from '../../features/competition/format';
import {
  COMPETITION_KIND,
  IRREVERSIBLE_MOVES,
  SEASON_STATUS,
  SEASON_TRANSITIONS,
  SPORT_FORMAT,
} from '../../features/competition/labels';
import { SeasonLinks } from '../../features/competition/nav';
import { Chip, CompeteHeader, localDay, seasonProgress } from '../../features/competition/page';
import { RuleSetLabel } from '../../features/competition/names';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { Icon } from '../../ui/Icon';
import { CardHead } from '../../ui/Page';
import { useNow } from '../../providers/AppProviders';
import { NeedsYourCall } from './NeedsYourCall';
import { GameReadinessCard, SeasonStandingsCard } from './SeasonHome';

type Season = Schema<'Season'>;
type Division = Schema<'Division'>;

function SeasonLifecycle({ season }: { season: Season }) {
  const update = useApiCommand('patch', '/seasons/{id}', {
    invalidate: keys('/seasons', '/seasons/{id}'),
  });
  const reload = useRefetch(['/seasons/{id}']);
  const [pending, setPending] = useState<Season['status'] | null>(null);
  const [confirming, setConfirming] = useState<Season['status'] | null>(null);
  const [reason, setReason] = useState('');
  const move = (to: Season['status'], why?: string) => {
    setPending(to);
    void update
      .submit({
        path: { id: season.id },
        body: { expectedRevision: season.revision, status: to, ...(why ? { reason: why } : {}) },
      })
      .then(() => {
        setConfirming(null);
        setReason('');
      })
      .catch(() => undefined);
  };
  const transitions = SEASON_TRANSITIONS[season.status];
  const confirmLabel = transitions.find((t) => t.to === confirming)?.label;
  return (
    <div className="actions">
      {transitions.map((t) => (
        <CommandButton
          key={t.to}
          variant="secondary"
          busy={update.isProcessing && pending === t.to}
          onClick={() => (IRREVERSIBLE_MOVES[t.to] ? setConfirming(t.to) : move(t.to))}
        >
          {t.label}
        </CommandButton>
      ))}
      {confirming && confirmLabel ? (
        <ConfirmMove
          label={confirmLabel}
          consequence={IRREVERSIBLE_MOVES[confirming] ?? ''}
          reason={reason}
          onReason={setReason}
          busy={update.isProcessing}
          onConfirm={() => move(confirming, reason.trim() || undefined)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
      {update.status === 'success' && update.data ? (
        <SuccessNote>{`Season ${update.data.status}`}</SuccessNote>
      ) : null}
      <CommandError
        error={update.error}
        onRetry={() => (pending ? move(pending) : undefined)}
        onReload={() => {
          update.reset();
          reload();
        }}
      />
    </div>
  );
}

export function describeCriteria(criteria: Division['criteria']): string {
  const parts: string[] = [];
  const band = criteria.ageBand;
  if (band && (band.minAge !== null || band.maxAge !== null)) {
    if (band.minAge !== null && band.maxAge !== null)
      parts.push(`Ages ${band.minAge} to ${band.maxAge}`);
    else if (band.minAge !== null) parts.push(`Ages ${band.minAge} and over`);
    else parts.push(`Ages up to ${band.maxAge}`);
  }
  if (criteria.level) parts.push(`Level: ${criteria.level}`);
  if (criteria.category) parts.push(`Category: ${criteria.category}`);
  if (criteria.format) parts.push(`Format: ${criteria.format}`);
  return parts.length > 0 ? parts.join(' · ') : 'No documented criteria';
}

function CreateDivisionForm({ season }: { season: Season }) {
  const create = useApiCommand('post', '/divisions', { invalidate: keys('/divisions') });
  const [name, setName] = useState('');
  const [minAge, setMinAge] = useState('');
  const [maxAge, setMaxAge] = useState('');
  const [level, setLevel] = useState('');
  const [category, setCategory] = useState('');
  const [format, setFormat] = useState('');
  const [capacity, setCapacity] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(create.error);

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter the division name.';
    const min = minAge.trim() ? parseWholeNumber(minAge) : null;
    const max = maxAge.trim() ? parseWholeNumber(maxAge) : null;
    if (minAge.trim() && min === null) next.minAge = 'Enter a whole number of years.';
    if (maxAge.trim() && max === null) next.maxAge = 'Enter a whole number of years.';
    if (min !== null && max !== null && min > max)
      next.maxAge = 'The maximum age is below the minimum.';
    const cap = capacity.trim() ? parseWholeNumber(capacity) : null;
    if (capacity.trim() && (cap === null || cap < 1))
      next.capacity = 'Enter at least 1 team, or leave empty.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void create
      .submit({
        body: {
          seasonId: season.id,
          name: name.trim(),
          criteria: {
            ageBand: min !== null || max !== null ? { minAge: min, maxAge: max } : null,
            level: level.trim() || null,
            category: category.trim() || null,
            format: format.trim() || null,
          },
          ...(cap !== null ? { capacityTeamEntries: cap } : {}),
        },
      })
      .then(() => {
        setName('');
        setMinAge('');
        setMaxAge('');
        setLevel('');
        setCategory('');
        setFormat('');
        setCapacity('');
      })
      .catch(() => undefined);
  };

  return (
    <form
      className="form"
      noValidate
      aria-label="New division"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Division name"
        required
        value={name}
        onChange={setName}
        error={errors.name ?? apiErrors.name}
      />
      <fieldset>
        <legend>Documented criteria (SPK-COMP-003)</legend>
        <div className="field-grid">
          <NumberField
            label="Minimum age"
            value={minAge}
            onChange={setMinAge}
            error={errors.minAge}
          />
          <NumberField
            label="Maximum age"
            value={maxAge}
            onChange={setMaxAge}
            error={errors.maxAge}
          />
          <TextField label="Playing level" value={level} onChange={setLevel} />
          <TextField label="Competition category" value={category} onChange={setCategory} />
          <TextField label="Format" value={format} onChange={setFormat} />
        </div>
        <p className="caption">
          Ages are evaluated from the date of birth at the rule set&apos;s reference date, never a
          stored age.
        </p>
      </fieldset>
      <NumberField
        label="Team capacity"
        value={capacity}
        onChange={setCapacity}
        error={errors.capacity ?? apiErrors.capacityTeamEntries}
        hint="Leave empty for no division limit."
      />
      <div className="actions">
        <CommandButton type="submit" busy={create.isProcessing}>
          Create division
        </CommandButton>
      </div>
      {create.status === 'success' && create.data ? (
        <SuccessNote>{`Division ${create.data.name} created`}</SuccessNote>
      ) : null}
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

function Divisions({ season }: { season: Season }) {
  const divisions = useApiQuery({
    path: '/divisions',
    request: { query: { seasonId: season.id } },
  });
  const [creating, setCreating] = useState(false);
  const facilities = useFacilityDirectory();
  return (
    <section className="card card-flush" aria-labelledby="divisions-title">
      <CardHead
        aside={
          <Button
            variant="secondary"
            className="button-sm"
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            {creating ? 'Close the new division form' : 'New division'}
          </Button>
        }
      >
        <h3 id="divisions-title">Divisions</h3>
      </CardHead>
      <div className="card-body">
        <PendingNote decision={PENDING.divisionCombinations} />
        {creating ? <CreateDivisionForm season={season} /> : null}
        <QueryBoundary
          query={divisions}
          label="divisions"
          isEmpty={(data) => data.length === 0}
          empty={{
            title: 'No divisions',
            description: 'Divisions of this season appear here. Use "New division" to add one.',
          }}
          unavailableOffline={['creating divisions', 'generating fixtures']}
        >
          {(data) => (
            <ul className="list division-list" aria-label="Divisions">
              {data.map((division) => (
                <li key={division.id}>
                  <div className="row-text">
                    <span className="row-title">{division.name}</span>
                    <span className="caption">{describeCriteria(division.criteria)}</span>
                    <span className="division-fill">
                      {division.capacityTeamEntries !== null ? (
                        <span className="season-bar" aria-hidden="true">
                          <span
                            style={{
                              width: `${Math.min(
                                100,
                                Math.round(
                                  (division.entryCount /
                                    Math.max(1, division.capacityTeamEntries)) *
                                    100,
                                ),
                              )}%`,
                            }}
                          />
                        </span>
                      ) : null}
                      <span>
                        Teams placed: {division.entryCount}
                        {division.capacityTeamEntries !== null
                          ? ` of ${division.capacityTeamEntries}`
                          : ' (no division limit)'}
                        {division.facilityId ? ` · ${facilities.name(division.facilityId)}` : ''}
                      </span>
                    </span>
                  </div>
                  <div className="actions-row">
                    <Link
                      className="button button-secondary button-sm"
                      to={`/leagues/divisions/${division.id}/fixture-generation`}
                    >
                      <Icon name="autorenew" size={16} />
                      Generate fixtures for {division.name}
                    </Link>
                    <Link
                      className="button button-secondary button-sm"
                      to={`/leagues/divisions/${division.id}/pools`}
                    >
                      Tournament pools of {division.name}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </div>
    </section>
  );
}

function SeasonEyebrowText({ competitionId }: { competitionId: string }) {
  const competition = useApiQuery({
    path: '/competitions/{id}',
    request: { path: { id: competitionId } },
    staleTime: 5 * 60_000,
  });
  const c = competition.data;
  return (
    <>
      {c
        ? `${COMPETITION_KIND[c.kind]} · ${SPORT_FORMAT[c.sportFormat]} · ${c.name}`
        : 'Compete · Season'}
    </>
  );
}

export function SeasonScreen() {
  const { seasonId = '' } = useParams();
  const now = useNow(60_000);
  const season = useApiQuery({ path: '/seasons/{id}', request: { path: { id: seasonId } } });
  // The same read as the divisions card (one request): divisions feed the chips, the standings
  // picker and the facility time zones of the readiness card.
  const divisions = useApiQuery({
    path: '/divisions',
    request: { query: { seasonId } },
    enabled: !!season.data,
  });
  const data = season.data;
  const progress = data ? seasonProgress(data, localDay(now)) : null;
  const badge = data ? SEASON_STATUS[data.status] : null;
  const teams = (divisions.data ?? []).reduce((sum, d) => sum + d.entryCount, 0);
  return (
    <section aria-labelledby="season-title" className="compete">
      <CompeteHeader
        eyebrow={
          data ? <SeasonEyebrowText competitionId={data.competitionId} /> : 'Compete · Season'
        }
        title={data?.name ?? 'Season'}
        titleId="season-title"
        titleClassName="season-title"
        chips={
          data && badge ? (
            <>
              <StatusBadge tone={badge.tone} label={`Season ${badge.label}`} />
              {progress ? <Chip icon="calendar_month">{progress.label}</Chip> : null}
              {divisions.data ? (
                <Chip icon="groups">
                  {divisions.data.length} {divisions.data.length === 1 ? 'division' : 'divisions'} ·{' '}
                  {teams} {teams === 1 ? 'team' : 'teams'} placed
                </Chip>
              ) : null}
            </>
          ) : null
        }
        actions={
          data ? (
            <>
              <Link
                className="button button-secondary"
                to={`/leagues/seasons/${seasonId}/fixtures`}
              >
                <Icon name="event" size={18} />
                Fixtures and readiness
              </Link>
              <Link className="button button-primary" to="/leagues/results-review">
                Review results
              </Link>
            </>
          ) : null
        }
      />
      <SeasonLinks seasonId={seasonId} />
      <QueryBoundary
        query={season}
        label="the season"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the season', 'creating divisions']}
      >
        {(data) => (
          <div className="season-grid">
            <div className="season-main">
              <SeasonStandingsCard
                seasonId={data.id}
                ruleSetId={data.ruleSetId}
                divisions={divisions.data}
              />
              <GameReadinessCard seasonId={data.id} divisions={divisions.data} />
              <Divisions season={data} />
            </div>
            <aside className="season-side" aria-label="Season decisions and details">
              <NeedsYourCall seasonId={data.id} />
              <section className="card" aria-labelledby="season-details-title">
                <h3 id="season-details-title">Season details</h3>
                <dl className="facets" aria-label="Season details">
                  <div>
                    <dt>Status</dt>
                    <dd>
                      <StatusBadge
                        tone={SEASON_STATUS[data.status].tone}
                        label={`Season ${SEASON_STATUS[data.status].label}`}
                      />
                    </dd>
                  </div>
                  <div>
                    <dt>Dates</dt>
                    <dd>
                      {formatDateOnly(data.startsOn)} to {formatDateOnly(data.endsOn)}
                    </dd>
                  </div>
                  <div>
                    <dt>Rule set</dt>
                    <dd>
                      <RuleSetLabel ruleSetId={data.ruleSetId} />
                    </dd>
                  </div>
                  <div>
                    <dt>Registration</dt>
                    <dd>
                      {data.registrationOpensAt || data.registrationClosesAt
                        ? `${formatInstant(data.registrationOpensAt)} to ${formatInstant(data.registrationClosesAt)}`
                        : 'No registration window set'}
                    </dd>
                  </div>
                </dl>
                <p className="caption">
                  The rule set can change only while the season is a draft. Renewal creates new
                  season records and never rewrites this one.
                </p>
                <SeasonLifecycle season={data} />
              </section>
            </aside>
          </div>
        )}
      </QueryBoundary>
    </section>
  );
}
