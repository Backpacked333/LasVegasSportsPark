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
  SEASON_STATUS,
  SPORT_FORMAT,
} from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { CompeteHeader, localDay, seasonProgress } from '../../features/competition/page';
import { useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { Icon, type IconName } from '../../ui/Icon';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge } from '../../ui/StatusBadge';
import { NeedsYourCall } from './NeedsYourCall';

type Competition = Schema<'Competition'>;
type Season = Schema<'Season'>;
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

const KIND_ICON: Record<CompetitionKind, IconName> = {
  league: 'sports_soccer',
  tournament: 'trophy',
};

const SEASON_PREFERENCE: Record<Season['status'], number> = {
  active: 0,
  open: 1,
  draft: 2,
  completed: 3,
  archived: 4,
};

/** The season a competition card shows: in play first, then open, draft, then the latest. */
export function currentSeason(seasons: readonly Season[]): Season | null {
  const sorted = [...seasons].sort(
    (a, b) =>
      SEASON_PREFERENCE[a.status] - SEASON_PREFERENCE[b.status] ||
      b.startsOn.localeCompare(a.startsOn),
  );
  return sorted[0] ?? null;
}

function CompetitionCard({
  competition,
  season,
  seasonsKnown,
  today,
}: {
  competition: Competition;
  season: Season | null;
  seasonsKnown: boolean;
  today: string;
}) {
  const badge = COMPETITION_STATUS[competition.status];
  const progress = season ? seasonProgress(season, today) : null;
  return (
    <li className="comp-card">
      <span className="comp-kind">
        <Icon name={KIND_ICON[competition.kind]} size={16} />
        <span>
          {COMPETITION_KIND[competition.kind]} · {SPORT_FORMAT[competition.sportFormat]}
        </span>
      </span>
      <Link className="comp-name" to={`/leagues/competitions/${competition.id}`}>
        {competition.name}
      </Link>
      <StatusBadge tone={badge.tone} label={`Competition ${badge.label}`} />
      {season ? (
        <>
          <span className="comp-meta">
            {season.name} · season {SEASON_STATUS[season.status].label}
            {progress ? ` · ${progress.label}` : ''}
          </span>
          {progress ? (
            <span className="season-bar" aria-hidden="true">
              <span style={{ width: `${progress.pct}%` }} />
            </span>
          ) : null}
        </>
      ) : seasonsKnown ? (
        <span className="comp-meta">No season yet</span>
      ) : null}
    </li>
  );
}

export function LeaguesScreen() {
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const now = useNow(60_000);
  const competitions = useApiQuery({
    path: '/competitions',
    request: { query: { status: (status || undefined) as CompetitionStatus | undefined } },
  });
  // One read of every season the viewer may see, for each card's current season (SCR-S-08).
  const seasons = useApiQuery({ path: '/seasons', staleTime: 5 * 60_000 });
  const byCompetition = new Map<string, Season[]>();
  for (const s of seasons.data ?? []) {
    byCompetition.set(s.competitionId, [...(byCompetition.get(s.competitionId) ?? []), s]);
  }
  const today = localDay(now);

  return (
    <section aria-labelledby="leagues-title" className="compete">
      <CompeteHeader
        eyebrow="Compete"
        title="Leagues and tournaments"
        titleId="leagues-title"
        intro="Every league and tournament with the season it is in. Open one to run its seasons, divisions, fixtures, results and standings."
        actions={
          <Button
            variant={creating ? 'secondary' : 'primary'}
            aria-expanded={creating}
            onClick={() => setCreating((open) => !open)}
          >
            {creating ? 'Close the new competition form' : 'New competition'}
          </Button>
        }
      />
      <LeaguesNav />
      {creating ? (
        <section className="panel" aria-labelledby="new-competition-title">
          <h3 id="new-competition-title">New competition</h3>
          <CreateCompetitionForm />
        </section>
      ) : null}
      <div className="season-grid">
        <div className="season-main">
          <div className="toolbar">
            <SelectField
              label="Competition status"
              value={status}
              onChange={setStatus}
              options={STATUS_OPTIONS}
              placeholder="All statuses"
            />
          </div>
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
              <ul className="comp-grid" aria-label="Competitions">
                {data.map((competition) => (
                  <CompetitionCard
                    key={competition.id}
                    competition={competition}
                    season={currentSeason(byCompetition.get(competition.id) ?? [])}
                    seasonsKnown={seasons.data !== undefined}
                    today={today}
                  />
                ))}
              </ul>
            )}
          </QueryBoundary>
        </div>
        <aside className="season-side" aria-label="League decisions">
          <NeedsYourCall />
          <section className="card" aria-labelledby="rules-title">
            <h3 id="rules-title">Rule sets</h3>
            <p className="caption">
              Each soccer format has its own versioned rule set; a season keeps the version it was
              created with (SPK-COMP-002, SPK-RESULT-003).
            </p>
            <Link className="button button-secondary button-sm" to="/leagues/rule-sets">
              Open rule sets
            </Link>
          </section>
        </aside>
      </div>
    </section>
  );
}
