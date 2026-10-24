/**
 * SCR-S-08 Competition, season and division setup, part 1: the competitions of the organization
 * and creating one (SPK-COMP-001 competition separate from season and division, SPK-COMP-002
 * formats, SPK-UX-005 "Leagues and tournaments", SPK-UX-008 states). What the list holds is what
 * `GET /v1/competitions` returns for this viewer; creating is offered to everyone and the API
 * answers ACCESS_DENIED to an account without `competition.manage_competitions`, shown as "not
 * available to you" (the client never decides authorization).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError } from '../../features/competition/CommandError';
import { keys } from '../../features/competition/feedback';
import { SelectField, TextAreaField, TextField } from '../../features/competition/fields';
import {
  COMPETITION_KIND,
  COMPETITION_STATUS,
  SPORT_FORMAT,
} from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';

type CompetitionStatus = Schema<'CompetitionStatus'>;
type CompetitionKind = Schema<'CompetitionKind'>;
type SportFormat = Schema<'SportFormat'>;

const STATUS_OPTIONS = Object.entries(COMPETITION_STATUS).map(([value, badge]) => ({
  value,
  label: badge.label,
}));
const KIND_OPTIONS = Object.entries(COMPETITION_KIND).map(([value, label]) => ({ value, label }));
export const FORMAT_OPTIONS = Object.entries(SPORT_FORMAT).map(([value, label]) => ({
  value,
  label,
}));

function CreateCompetitionForm() {
  const navigate = useNavigate();
  const create = useApiCommand('post', '/competitions', { invalidate: keys('/competitions') });
  const [name, setName] = useState('');
  const [kind, setKind] = useState('');
  const [format, setFormat] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter the competition name.';
    if (!kind) next.kind = 'Choose league or tournament.';
    if (!format) next.format = 'Choose the soccer format.';
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void create
      .submit({
        body: {
          name: name.trim(),
          kind: kind as CompetitionKind,
          sportFormat: format as SportFormat,
          ...(description.trim() ? { description: description.trim() } : {}),
        },
      })
      .then((competition) => navigate(`/leagues/competitions/${competition.id}`))
      .catch(() => undefined);
  };

  return (
    <form
      className="form"
      noValidate
      aria-label="New competition"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField label="Name" required value={name} onChange={setName} error={errors.name} />
      <SelectField
        label="Kind"
        required
        value={kind}
        onChange={setKind}
        options={KIND_OPTIONS}
        error={errors.kind}
        hint="Tournament use by the complex is pending DEC-078 (Product owner)."
      />
      <SelectField
        label="Soccer format"
        required
        value={format}
        onChange={setFormat}
        options={FORMAT_OPTIONS}
        error={errors.format}
        hint="Each format has its own rule set; no universal indoor rule set is assumed (SPK-COMP-002)."
      />
      <TextAreaField label="Description" value={description} onChange={setDescription} />
      <div className="actions">
        <CommandButton type="submit" busy={create.isProcessing}>
          Create competition
        </CommandButton>
      </div>
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

export function LeaguesScreen() {
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const competitions = useApiQuery({
    path: '/competitions',
    request: { query: { status: (status || undefined) as CompetitionStatus | undefined } },
  });

  return (
    <section aria-labelledby="leagues-title">
      <h2 id="leagues-title">Leagues and tournaments</h2>
      <LeaguesNav />
      <div className="actions">
        <SelectField
          label="Competition status"
          value={status}
          onChange={setStatus}
          options={STATUS_OPTIONS}
          placeholder="All statuses"
        />
        <Button
          variant="secondary"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          {creating ? 'Close the new competition form' : 'New competition'}
        </Button>
      </div>
      {creating ? (
        <section className="panel" aria-labelledby="new-competition-title">
          <h3 id="new-competition-title">New competition</h3>
          <CreateCompetitionForm />
        </section>
      ) : null}
      <QueryBoundary
        query={competitions}
        label="competitions"
        isEmpty={(data) => data.length === 0}
        empty={{
          title: 'No competitions',
          description:
            'Leagues and tournaments appear here once created. Use "New competition" to create the first one.',
        }}
        unavailableOffline={['creating or changing competitions']}
      >
        {(data) => (
          <ul className="list" aria-label="Competitions">
            {data.map((competition) => {
              const badge = COMPETITION_STATUS[competition.status];
              return (
                <li key={competition.id}>
                  <div className="row-text">
                    <Link className="row-title" to={`/leagues/competitions/${competition.id}`}>
                      {competition.name}
                    </Link>
                    <span className="caption">
                      {COMPETITION_KIND[competition.kind]} · {SPORT_FORMAT[competition.sportFormat]}
                    </span>
                  </div>
                  <StatusBadge tone={badge.tone} label={`Competition ${badge.label}`} />
                </li>
              );
            })}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}
