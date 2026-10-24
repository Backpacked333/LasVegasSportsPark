/**
 * SCR-S-08 Competition, season and division setup, part 2: one competition, its lifecycle, its
 * seasons and creating a season against a rule-set version of the competition's format
 * (SPK-COMP-001, SPK-COMP-002, SPK-UX-008). Status moves follow CompetitionMachine and carry
 * `expectedRevision` (§4.9); a STALE_REVISION or INVALID_TRANSITION answer offers "Reload".
 * "Copy a season as a draft" is shown as not available: the API has no copy command yet, and a
 * copy must carry no payments, attendance, enrollments, results or permissions.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import { keys, SuccessNote, useRefetch } from '../../features/competition/feedback';
import { SelectField, TextField } from '../../features/competition/fields';
import { formatDateOnly, localInputToIso } from '../../features/competition/format';
import {
  COMPETITION_KIND,
  COMPETITION_STATUS,
  COMPETITION_TRANSITIONS,
  SEASON_STATUS,
  SPORT_FORMAT,
} from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Competition = Schema<'Competition'>;

function CompetitionLifecycle({ competition }: { competition: Competition }) {
  const update = useApiCommand('patch', '/competitions/{id}', {
    invalidate: keys('/competitions', '/competitions/{id}'),
  });
  const reload = useRefetch(['/competitions/{id}']);
  const [pending, setPending] = useState<Competition['status'] | null>(null);
  const move = (to: Competition['status']) => {
    setPending(to);
    void update
      .submit({
        path: { id: competition.id },
        body: { expectedRevision: competition.revision, status: to },
      })
      .catch(() => undefined);
  };
  const transitions = COMPETITION_TRANSITIONS[competition.status];
  return (
    <div className="actions">
      {transitions.map((t) => (
        <CommandButton
          key={t.to}
          variant="secondary"
          busy={update.isProcessing && pending === t.to}
          onClick={() => move(t.to)}
        >
          {t.label}
        </CommandButton>
      ))}
      {update.status === 'success' && update.data ? (
        <SuccessNote>{`Competition ${update.data.status}`}</SuccessNote>
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

function CreateSeasonForm({ competition }: { competition: Competition }) {
  const navigate = useNavigate();
  const ruleSets = useApiQuery({
    path: '/rule-sets',
    request: { query: { format: competition.sportFormat, latestOnly: 'true' } },
  });
  const create = useApiCommand('post', '/seasons', { invalidate: keys('/seasons') });
  const [name, setName] = useState('');
  const [ruleSetId, setRuleSetId] = useState('');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [opensAt, setOpensAt] = useState('');
  const [closesAt, setClosesAt] = useState('');
  const [offeringRef, setOfferingRef] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(create.error);

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter the season name.';
    if (!ruleSetId) next.ruleSetId = 'Choose the rule-set version this season uses.';
    if (!startsOn) next.startsOn = 'Enter the first day.';
    if (!endsOn) next.endsOn = 'Enter the last day.';
    if (startsOn && endsOn && startsOn > endsOn) next.endsOn = 'The last day is before the first.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const registrationOpensAt = localInputToIso(opensAt);
    const registrationClosesAt = localInputToIso(closesAt);
    void create
      .submit({
        body: {
          competitionId: competition.id,
          name: name.trim(),
          ruleSetId,
          startsOn,
          endsOn,
          ...(registrationOpensAt ? { registrationOpensAt } : {}),
          ...(registrationClosesAt ? { registrationClosesAt } : {}),
          ...(offeringRef.trim() ? { registrationOfferingRef: offeringRef.trim() } : {}),
        },
      })
      .then((season) => navigate(`/leagues/seasons/${season.id}`))
      .catch(() => undefined);
  };

  const options = (ruleSets.data ?? []).map((r) => ({
    value: r.id,
    label: `${r.name}, version ${r.version}`,
  }));
  return (
    <form
      className="form"
      noValidate
      aria-label="New season"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField
        label="Season name"
        required
        value={name}
        onChange={setName}
        error={errors.name ?? apiErrors.name}
      />
      {ruleSets.data && ruleSets.data.length === 0 ? (
        <StateView
          variant="empty"
          title={`No rule set for ${SPORT_FORMAT[competition.sportFormat]}`}
          description="A season needs a rule-set version of the competition's format. Create one under Rule sets first."
        />
      ) : null}
      <SelectField
        label="Rule-set version"
        required
        value={ruleSetId}
        onChange={setRuleSetId}
        options={options}
        error={errors.ruleSetId ?? apiErrors.ruleSetId}
        hint={
          ruleSets.error
            ? `Rule sets could not be loaded (${ruleSets.error.code}).`
            : `Only the latest versions for ${SPORT_FORMAT[competition.sportFormat]} are listed.`
        }
      />
      <div className="field-grid">
        <TextField
          label="First day"
          type="date"
          required
          value={startsOn}
          onChange={setStartsOn}
          error={errors.startsOn ?? apiErrors.startsOn}
        />
        <TextField
          label="Last day"
          type="date"
          required
          value={endsOn}
          onChange={setEndsOn}
          error={errors.endsOn ?? apiErrors.endsOn}
        />
        <TextField
          label="Registration opens"
          type="datetime-local"
          value={opensAt}
          onChange={setOpensAt}
          hint="Your device's time zone."
        />
        <TextField
          label="Registration closes"
          type="datetime-local"
          value={closesAt}
          onChange={setClosesAt}
          hint="Your device's time zone."
        />
      </div>
      <TextField
        label="Registration offering reference"
        value={offeringRef}
        onChange={setOfferingRef}
        hint="The catalog offering customers register through, when there is one."
      />
      <div className="actions">
        <CommandButton type="submit" busy={create.isProcessing}>
          Create season (draft)
        </CommandButton>
      </div>
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

function Seasons({ competition }: { competition: Competition }) {
  const seasons = useApiQuery({
    path: '/seasons',
    request: { query: { competitionId: competition.id } },
  });
  const [creating, setCreating] = useState(false);
  return (
    <section className="panel" aria-labelledby="seasons-title">
      <h3 id="seasons-title">Seasons</h3>
      <div className="actions">
        <Button
          variant="secondary"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? 'Close the new season form' : 'New season'}
        </Button>
        <Button variant="secondary" disabled aria-describedby="copy-season-unavailable">
          Copy a season as a draft
        </Button>
      </div>
      <p className="caption" id="copy-season-unavailable">
        Copying a season is not available yet: the API has no copy command. A copy will carry no
        payments, attendance, enrollments, results or permissions.
      </p>
      {creating ? <CreateSeasonForm competition={competition} /> : null}
      <QueryBoundary
        query={seasons}
        label="seasons"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No seasons',
          description: 'Seasons of this competition appear here. Use "New season" to add one.',
        }}
        unavailableOffline={['creating seasons']}
      >
        {(data) => (
          <ul className="list" aria-label="Seasons">
            {data.map((season) => {
              const badge = SEASON_STATUS[season.status];
              return (
                <li key={season.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/leagues/seasons/${season.id}`}>
                      {season.name}
                    </Link>
                    <span className="caption">
                      {formatDateOnly(season.startsOn)} to {formatDateOnly(season.endsOn)}
                    </span>
                  </div>
                  <StatusBadge tone={badge.tone} label={`Season ${badge.label}`} />
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

export function CompetitionScreen() {
  const { competitionId = '' } = useParams();
  const competition = useApiQuery({
    path: '/competitions/{id}',
    request: { path: { id: competitionId } },
  });
  return (
    <section aria-labelledby="competition-title">
      <h2 id="competition-title">{competition.data?.name ?? 'Competition'}</h2>
      <LeaguesNav />
      <QueryBoundary
        query={competition}
        label="the competition"
        empty={{ title: '', description: '' }}
        unavailableOffline={['changing the competition', 'creating seasons']}
      >
        {(data) => {
          const badge = COMPETITION_STATUS[data.status];
          return (
            <>
              <dl className="facets" aria-label="Competition details">
                <div>
                  <dt>Kind</dt>
                  <dd>{COMPETITION_KIND[data.kind]}</dd>
                </div>
                <div>
                  <dt>Format</dt>
                  <dd>{SPORT_FORMAT[data.sportFormat]}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    <StatusBadge tone={badge.tone} label={`Competition ${badge.label}`} />
                  </dd>
                </div>
              </dl>
              {data.description ? <p>{data.description}</p> : null}
              <CompetitionLifecycle competition={data} />
              <Seasons competition={data} />
            </>
          );
        }}
      </QueryBoundary>
    </section>
  );
}
