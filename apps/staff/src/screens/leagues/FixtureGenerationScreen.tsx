/**
 * SCR-S-09 Fixture generation, part 1: the fixture specification of one division (SPK-FIX-001
 * teams, games per team, opponent frequency, dates, blackouts, byes, minimum rest, allowed start
 * times, resources, playoff structure; SPK-FIX-003 fairness preferences, with hard constraints
 * visibly distinct from weighted preferences; SPK-UX-008). The teams are the division's approved
 * entries at the time of each run (the run keeps that snapshot). Which preferences are hard and
 * whether coach or family convenience is approved is pending DEC-049, so nothing is preset and a
 * convenience preference needs its approval reference. A specification error (dates outside the
 * season, games per team that do not match the teams and frequency) is the API's 400 answer.
 * The division's saved specifications are listed first (`GET /v1/divisions/{id}/fixture-
 * specifications`, CMP-05), so an existing one is opened and run again rather than retyped.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';
import { CommandButton } from '../../features/competition/CommandButton';
import { CommandError, fieldErrorsOf } from '../../features/competition/CommandError';
import { useFacilityOptions } from '../../features/competition/facilities';
import { keys, PendingNote } from '../../features/competition/feedback';
import {
  CheckboxField,
  NumberField,
  SelectField,
  TextField,
  YesNoField,
  parseWholeNumber,
} from '../../features/competition/fields';
import { formatDateOnly } from '../../features/competition/format';
import { FAIRNESS_PREFERENCE, WEEKDAYS } from '../../features/competition/labels';
import { LeaguesNav } from '../../features/competition/nav';
import { PENDING } from '../../features/competition/pending';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type Division = Schema<'Division'>;
type PreferenceKind = Schema<'FairnessPreferenceKind'>;
type CreateSpecification = Schema<'CreateFixtureSpecificationRequest'>;

interface StartTimeDraft {
  weekday: string;
  time: string;
}

interface PreferenceDraft {
  kind: PreferenceKind | '';
  /** 'hard' = constraint, 'preference' = weighted; nothing preselected (DEC-049). */
  strength: '' | 'hard' | 'preference';
  weight: string;
  teamEntryId: string;
  startTimes: StartTimeDraft[];
  approvalReference: string;
}

const WEEKDAY_OPTIONS = WEEKDAYS.map((label, index) => ({ value: String(index), label }));
const PREFERENCE_OPTIONS = Object.entries(FAIRNESS_PREFERENCE).map(([value, label]) => ({
  value,
  label,
}));
const TEAM_PREFERENCES: readonly PreferenceKind[] = [
  'preferred_availability',
  'approved_convenience',
];

function StartTimes({
  legend,
  value,
  onChange,
  error,
}: {
  legend: string;
  value: StartTimeDraft[];
  onChange: (value: StartTimeDraft[]) => void;
  error?: string;
}) {
  return (
    <fieldset>
      <legend>{legend}</legend>
      {value.map((slot, index) => (
        <div className="actions" key={index}>
          <SelectField
            label={`Weekday ${index + 1}`}
            value={slot.weekday}
            onChange={(weekday) =>
              onChange(value.map((s, i) => (i === index ? { ...s, weekday } : s)))
            }
            options={WEEKDAY_OPTIONS}
          />
          <TextField
            label={`Start time ${index + 1}`}
            type="time"
            value={slot.time}
            onChange={(time) => onChange(value.map((s, i) => (i === index ? { ...s, time } : s)))}
            hint="Facility-local time."
          />
          <Button
            variant="secondary"
            aria-label={`Remove start time ${index + 1}`}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            Remove
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => onChange([...value, { weekday: '', time: '' }])}>
        Add a start time
      </Button>
      {error ? (
        <span className="error-text" role="alert">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}

function parseStartTimes(value: StartTimeDraft[]): { weekday: number; time: string }[] | null {
  const out: { weekday: number; time: string }[] = [];
  for (const slot of value) {
    const weekday = parseWholeNumber(slot.weekday);
    if (weekday === null || !/^([01]\d|2[0-3]):[0-5]\d$/.test(slot.time)) return null;
    out.push({ weekday, time: slot.time });
  }
  return out;
}

function SpecificationForm({ division, season }: { division: Division; season: Schema<'Season'> }) {
  const navigate = useNavigate();
  const { facilityId: selectedFacility } = useApp();
  const facilityOptions = useFacilityOptions();
  const entries = useApiQuery({
    path: '/team-entries',
    request: { query: { seasonId: season.id, divisionId: division.id, status: 'approved' } },
  });
  const create = useApiCommand('post', '/divisions/{id}/fixture-specifications', {
    invalidate: keys('/fixture-specifications/{id}'),
  });
  const [name, setName] = useState('');
  const [facilityId, setFacilityId] = useState(division.facilityId ?? selectedFacility ?? '');
  const resources = useApiQuery({
    path: '/resources',
    request: { query: { facilityId } },
    enabled: !!facilityId,
  });
  const [gamesPerTeam, setGamesPerTeam] = useState('');
  const [frequency, setFrequency] = useState('');
  const [startsOn, setStartsOn] = useState(season.startsOn);
  const [endsOn, setEndsOn] = useState(season.endsOn);
  const [blackouts, setBlackouts] = useState<{ start: string; end: string }[]>([]);
  const [byesAllowed, setByesAllowed] = useState<boolean | null>(null);
  const [minimumRest, setMinimumRest] = useState('');
  const [startTimes, setStartTimes] = useState<StartTimeDraft[]>([]);
  const [duration, setDuration] = useState('');
  const [resourceIds, setResourceIds] = useState<string[]>([]);
  const [playoffTeams, setPlayoffTeams] = useState('');
  const [preferences, setPreferences] = useState<PreferenceDraft[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const apiErrors = fieldErrorsOf(create.error);
  const err = (key: string) => errors[key] ?? apiErrors[key];

  // CMP-01: each entry carries its team's name, so no per-team read is needed.
  const teamOptions = (entries.data ?? []).map((entry) => ({
    value: entry.id,
    label: entry.teamName,
  }));

  const submit = () => {
    const next: Record<string, string> = {};
    if (!name.trim()) next.name = 'Enter a name for this specification.';
    if (!facilityId) next.facilityId = 'Choose the facility.';
    const games = parseWholeNumber(gamesPerTeam);
    if (games === null || games < 1) next.gamesPerTeam = 'Enter the games each team plays.';
    const freq = parseWholeNumber(frequency);
    if (freq === null || freq < 1) next.opponentFrequency = 'Enter how often teams meet.';
    if (!startsOn) next.startsOn = 'Enter the first day.';
    if (!endsOn) next.endsOn = 'Enter the last day.';
    if (startsOn && endsOn && startsOn > endsOn) next.endsOn = 'The last day is before the first.';
    if (blackouts.some((b) => !b.start || !b.end || b.start > b.end))
      next.blackouts = 'Each blackout needs a first and last day in order.';
    if (byesAllowed === null) next.byesAllowed = 'Say whether byes are allowed.';
    const rest = parseWholeNumber(minimumRest);
    if (rest === null || rest < 0) next.minimumRestMinutes = 'Enter the minimum rest in minutes.';
    const times = parseStartTimes(startTimes);
    if (!times || times.length === 0)
      next.allowedStartTimes = 'Add at least one complete weekday and start time.';
    const dur = duration.trim() ? parseWholeNumber(duration) : null;
    if (duration.trim() && (dur === null || dur < 10))
      next.matchDurationMinutes = 'Enter at least 10 minutes, or leave empty.';
    if (resourceIds.length === 0) next.requiredResourceIds = 'Choose at least one resource.';
    const playoff = playoffTeams.trim() ? parseWholeNumber(playoffTeams) : null;
    if (playoffTeams.trim() && (playoff === null || playoff < 2))
      next.playoffStructure = 'Enter at least 2 qualifying teams, or leave empty.';
    const prefs: NonNullable<CreateSpecification['fairnessPreferences']> = [];
    preferences.forEach((p, index) => {
      const key = `fairnessPreferences.${index}`;
      if (!p.kind) next[key] = 'Choose the preference.';
      else if (!p.strength) next[key] = 'Say whether this is a hard constraint or a preference.';
      const weight = p.strength === 'preference' ? parseWholeNumber(p.weight) : 1;
      if (p.strength === 'preference' && (weight === null || weight < 1 || weight > 100))
        next[key] = 'Enter a weight from 1 to 100.';
      const needsTeam = p.kind !== '' && TEAM_PREFERENCES.includes(p.kind);
      const slots = needsTeam ? parseStartTimes(p.startTimes) : [];
      if (needsTeam && (!p.teamEntryId || !slots || slots.length === 0))
        next[key] = 'Name the team and at least one weekday and start time.';
      if (p.kind === 'approved_convenience' && !p.approvalReference.trim())
        next[key] = 'A convenience preference needs the approval it rests on.';
      if (p.kind && p.strength && !next[key]) {
        prefs.push({
          kind: p.kind,
          hard: p.strength === 'hard',
          weight: weight ?? 1,
          ...(needsTeam ? { teamEntryId: p.teamEntryId, startTimes: slots ?? [] } : {}),
          ...(p.kind === 'approved_convenience'
            ? { approvalReference: p.approvalReference.trim() }
            : {}),
        });
      }
    });
    setErrors(next);
    if (Object.keys(next).length > 0 || games === null || freq === null || rest === null || !times)
      return;
    void create
      .submit({
        path: { id: division.id },
        body: {
          name: name.trim(),
          facilityId,
          gamesPerTeam: games,
          opponentFrequency: freq,
          startsOn,
          endsOn,
          blackouts,
          byesAllowed: byesAllowed ?? false,
          minimumRestMinutes: rest,
          allowedStartTimes: times,
          ...(dur !== null ? { matchDurationMinutes: dur } : {}),
          requiredResourceIds: resourceIds,
          ...(playoff !== null
            ? { playoffStructure: { kind: 'single_elimination', teams: playoff } }
            : {}),
          fairnessPreferences: prefs,
        },
      })
      .then((spec) => navigate(`/leagues/fixture-specifications/${spec.id}`))
      .catch(() => undefined);
  };

  const updatePref = (index: number, patch: Partial<PreferenceDraft>) =>
    setPreferences((list) => list.map((p, i) => (i === index ? { ...p, ...patch } : p)));

  return (
    <form
      className="form"
      noValidate
      aria-label="Fixture specification"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <TextField label="Name" required value={name} onChange={setName} error={err('name')} />
      <section aria-labelledby="spec-teams-title">
        <h4 id="spec-teams-title">Teams</h4>
        <QueryBoundary
          query={entries}
          label="approved teams"
          isEmpty={(data) => data.length === 0}
          empty={{
            title: 'No approved teams in this division',
            description:
              'Fixtures are generated for the approved entries of the division. Approve entries under Team entries first.',
          }}
        >
          {(data) => (
            <ul aria-label="Teams in this specification">
              {data.map((entry) => (
                <li key={entry.id}>{entry.teamName}</li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      </section>

      <div className="constraint-group" data-kind="hard">
        <h4>
          <StatusBadge tone="danger" label="Hard constraints" /> Every proposal must meet these
        </h4>
        <SelectField
          label="Facility"
          required
          value={facilityId}
          onChange={(v) => {
            setFacilityId(v);
            setResourceIds([]);
          }}
          options={facilityOptions}
          error={err('facilityId')}
        />
        <div className="field-grid">
          <NumberField
            label="Games per team"
            required
            value={gamesPerTeam}
            onChange={setGamesPerTeam}
            error={err('gamesPerTeam')}
          />
          <NumberField
            label="Times each pair of teams meets"
            required
            value={frequency}
            onChange={setFrequency}
            error={err('opponentFrequency')}
          />
          <TextField
            label="First day"
            type="date"
            required
            value={startsOn}
            onChange={setStartsOn}
            error={err('startsOn')}
          />
          <TextField
            label="Last day"
            type="date"
            required
            value={endsOn}
            onChange={setEndsOn}
            error={err('endsOn')}
          />
          <YesNoField
            label="Byes allowed"
            required
            value={byesAllowed}
            onChange={setByesAllowed}
            error={err('byesAllowed')}
          />
          <NumberField
            label="Minimum rest between a team's games (minutes)"
            required
            value={minimumRest}
            onChange={setMinimumRest}
            error={err('minimumRestMinutes')}
          />
          <NumberField
            label="Match duration (minutes)"
            value={duration}
            onChange={setDuration}
            hint="Leave empty to use the rule set's match length plus the resource turnover."
            error={err('matchDurationMinutes')}
          />
          <NumberField
            label="Playoff: qualifying teams (single elimination)"
            value={playoffTeams}
            onChange={setPlayoffTeams}
            hint="Leave empty for no playoff."
            error={err('playoffStructure')}
          />
        </div>
        <fieldset>
          <legend>Blackout dates</legend>
          {blackouts.map((blackout, index) => (
            <div className="actions" key={index}>
              <TextField
                label={`Blackout ${index + 1} first day`}
                type="date"
                value={blackout.start}
                onChange={(start) =>
                  setBlackouts((list) => list.map((b, i) => (i === index ? { ...b, start } : b)))
                }
              />
              <TextField
                label={`Blackout ${index + 1} last day`}
                type="date"
                value={blackout.end}
                onChange={(end) =>
                  setBlackouts((list) => list.map((b, i) => (i === index ? { ...b, end } : b)))
                }
              />
              <Button
                variant="secondary"
                aria-label={`Remove blackout ${index + 1}`}
                onClick={() => setBlackouts((list) => list.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() => setBlackouts((list) => [...list, { start: '', end: '' }])}
          >
            Add a blackout
          </Button>
          {err('blackouts') ? (
            <span className="error-text" role="alert">
              {err('blackouts')}
            </span>
          ) : null}
        </fieldset>
        <StartTimes
          legend="Allowed start times"
          value={startTimes}
          onChange={setStartTimes}
          error={err('allowedStartTimes')}
        />
        <fieldset>
          <legend>Required resources</legend>
          {!facilityId ? (
            <p className="caption">Choose the facility to list its resources.</p>
          ) : resources.error ? (
            <CommandError error={resources.error} onRetry={() => void resources.refetch()} />
          ) : !resources.data ? (
            <p className="caption" aria-busy="true">
              Loading resources…
            </p>
          ) : resources.data.length === 0 ? (
            <p className="caption">This facility has no resources.</p>
          ) : (
            <div className="field-grid">
              {resources.data.map((resource) => (
                <CheckboxField
                  key={resource.id}
                  label={resource.name}
                  checked={resourceIds.includes(resource.id)}
                  onChange={(checked) =>
                    setResourceIds((ids) =>
                      checked ? [...ids, resource.id] : ids.filter((id) => id !== resource.id),
                    )
                  }
                />
              ))}
            </div>
          )}
          {err('requiredResourceIds') ? (
            <span className="error-text" role="alert">
              {err('requiredResourceIds')}
            </span>
          ) : null}
        </fieldset>
      </div>

      <div className="constraint-group" data-kind="preference">
        <h4>
          <StatusBadge tone="info" label="Fairness preferences" /> Each one is either a hard
          constraint or a weighted preference
        </h4>
        <PendingNote decision={PENDING.fairness} />
        {preferences.map((pref, index) => (
          <fieldset key={index}>
            <legend>Preference {index + 1}</legend>
            <div className="field-grid">
              <SelectField
                label="Preference"
                value={pref.kind}
                onChange={(kind) => updatePref(index, { kind: kind as PreferenceKind | '' })}
                options={PREFERENCE_OPTIONS}
              />
              <SelectField
                label="Treat as"
                value={pref.strength}
                onChange={(strength) =>
                  updatePref(index, { strength: strength as PreferenceDraft['strength'] })
                }
                options={[
                  { value: 'hard', label: 'Hard constraint (must hold)' },
                  { value: 'preference', label: 'Preference (weighted)' },
                ]}
              />
              {pref.strength === 'preference' ? (
                <NumberField
                  label="Weight (1 to 100)"
                  value={pref.weight}
                  onChange={(weight) => updatePref(index, { weight })}
                />
              ) : null}
              {pref.kind && TEAM_PREFERENCES.includes(pref.kind) ? (
                <SelectField
                  label="Team"
                  value={pref.teamEntryId}
                  onChange={(teamEntryId) => updatePref(index, { teamEntryId })}
                  options={teamOptions}
                />
              ) : null}
              {pref.kind === 'approved_convenience' ? (
                <TextField
                  label="Approval reference"
                  required
                  value={pref.approvalReference}
                  onChange={(approvalReference) => updatePref(index, { approvalReference })}
                  hint="Who approved it and where the approval is recorded."
                />
              ) : null}
            </div>
            {pref.kind && TEAM_PREFERENCES.includes(pref.kind) ? (
              <StartTimes
                legend="Preferred weekdays and start times"
                value={pref.startTimes}
                onChange={(startTimes) => updatePref(index, { startTimes })}
              />
            ) : null}
            {err(`fairnessPreferences.${index}`) ? (
              <span className="error-text" role="alert">
                {err(`fairnessPreferences.${index}`)}
              </span>
            ) : null}
            <Button
              variant="secondary"
              aria-label={`Remove preference ${index + 1}`}
              onClick={() => setPreferences((list) => list.filter((_, i) => i !== index))}
            >
              Remove preference
            </Button>
          </fieldset>
        ))}
        <Button
          variant="secondary"
          onClick={() =>
            setPreferences((list) => [
              ...list,
              {
                kind: '',
                strength: '',
                weight: '',
                teamEntryId: '',
                startTimes: [],
                approvalReference: '',
              },
            ])
          }
        >
          Add a preference
        </Button>
      </div>
      <div className="actions">
        <CommandButton type="submit" busy={create.isProcessing}>
          Save specification
        </CommandButton>
      </div>
      <CommandError error={create.error} onRetry={submit} />
    </form>
  );
}

/** SCR-S-09 "empty (no specification)": the division's saved specifications (CMP-05). */
function DivisionSpecifications({ divisionId }: { divisionId: string }) {
  const specifications = useApiQuery({
    path: '/divisions/{id}/fixture-specifications',
    request: { path: { id: divisionId } },
  });
  return (
    <section className="panel" aria-labelledby="saved-specifications-title">
      <h3 id="saved-specifications-title">Saved specifications</h3>
      <QueryBoundary
        query={specifications}
        label="saved specifications"
        isEmpty={(data) => data.items.length === 0}
        empty={{
          title: 'No specification yet',
          description: 'Define the first fixture specification of this division below.',
        }}
      >
        {(data) => (
          <ul className="list" aria-label="Saved specifications">
            {data.items.map((spec) => (
              <li key={spec.id}>
                <div className="row-text">
                  <Link className="row-title" to={`/leagues/fixture-specifications/${spec.id}`}>
                    {spec.name}
                  </Link>
                  <span className="caption">
                    {spec.teamEntryIds.length} teams · {spec.gamesPerTeam} games per team ·{' '}
                    {formatDateOnly(spec.startsOn)} to {formatDateOnly(spec.endsOn)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
    </section>
  );
}

export function FixtureGenerationScreen() {
  const { divisionId = '' } = useParams();
  const division = useApiQuery({ path: '/divisions/{id}', request: { path: { id: divisionId } } });
  const season = useApiQuery({
    path: '/seasons/{id}',
    request: { path: { id: division.data?.seasonId ?? '' } },
    enabled: !!division.data,
  });
  return (
    <section aria-labelledby="fixture-generation-title">
      <h2 id="fixture-generation-title">
        Fixture generation{division.data ? `: ${division.data.name}` : ''}
      </h2>
      <LeaguesNav />
      <p className="caption">
        A generated proposal is a draft: it is published through the normal schedule publication
        with current conflict checks (SPK-FIX-005).
      </p>
      <QueryBoundary
        query={division}
        label="the division"
        empty={{ title: '', description: '' }}
        unavailableOffline={['saving specifications', 'generating fixtures']}
      >
        {(divisionData) =>
          season.data ? (
            <>
              <DivisionSpecifications divisionId={divisionData.id} />
              <SpecificationForm division={divisionData} season={season.data} />
            </>
          ) : season.error ? (
            <CommandError error={season.error} onRetry={() => void season.refetch()} />
          ) : (
            <StateView variant="loading" label="the season" />
          )
        }
      </QueryBoundary>
    </section>
  );
}
