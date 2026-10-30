/**
 * Display names for records the competition payloads reference only by id (SPK-UX-008, §4.10,
 * §4.14). Team entries carry their team's name (CMP-01: `TeamEntry.teamName`, `SeasonFixture`,
 * `BracketNode`, `Pool`), so a season's entries give every team name in one read. People are named
 * through `GET /v1/person-names` (ID-02): names only, never a date of birth, contact point or
 * household, at most 100 ids per read. A person the viewer may not view is omitted by the API and
 * rendered as "not available" without implying the record exists. Nothing here is logged.
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { isUuid } from '../../ui/RecordRef';
import { shortRef } from './format';

const NAME_STALE_MS = 5 * 60_000;
/** The API's limit for one `GET /v1/person-names` (ID-02). */
export const PERSON_NAMES_PER_READ = 100;

type PersonNameEntry = Schema<'PersonName'>;

/** A team by its id, for records that carry no team name. */
export function TeamName({ teamId }: { teamId: string | null | undefined }) {
  const team = useApiQuery({
    path: '/teams/{id}',
    request: { path: { id: teamId ?? '' } },
    enabled: !!teamId,
    staleTime: NAME_STALE_MS,
  });
  if (!teamId) return <span>Team not set</span>;
  if (team.data) return <span>{team.data.name}</span>;
  if (team.error) return <span>Team {shortRef(teamId)} (name not available)</span>;
  return <span aria-busy="true">Team {shortRef(teamId)}</span>;
}

export interface PersonNames {
  /** The API's name entry; null when the API omitted the person; undefined while loading. */
  get(personId: string): PersonNameEntry | null | undefined;
  /** Whether this batch reads the person (rows beyond the first 100 ids read their own name). */
  covers(personId: string): boolean;
  error: ApiError | null;
  refetch: () => void;
}

/**
 * Names of a set of people in one read per 100 ids (the API's limit); ids beyond the first 100
 * are read by their own row's `PersonName`.
 */
export function usePersonNames(ids: readonly (string | null | undefined)[]): PersonNames {
  const unique = [...new Set(ids.filter((id): id is string => !!id && isUuid(id)))]
    .sort()
    .slice(0, PERSON_NAMES_PER_READ);
  const names = useApiQuery({
    path: '/person-names',
    request: { query: { ids: unique } },
    enabled: unique.length > 0,
    staleTime: NAME_STALE_MS,
  });
  const items = names.data?.items;
  const covered = unique.join(',');
  return useMemo(() => {
    const byId = new Map((items ?? []).map((n) => [n.personId, n]));
    const asked = new Set(covered ? covered.split(',') : []);
    return {
      get: (personId) => {
        const found = byId.get(personId);
        if (found) return found;
        if (items && asked.has(personId)) return null;
        return undefined;
      },
      covers: (personId) => asked.has(personId),
      error: names.error,
      refetch: () => void names.refetch(),
    };
  }, [items, covered, names]);
}

/**
 * A person's name for a row. With `names` (a list's batched read) it renders from that read;
 * otherwise it makes its own one-id read.
 */
export function PersonName({
  personId,
  names,
}: {
  personId: string | null | undefined;
  names?: PersonNames;
}) {
  if (!personId) return <span>Person not set</span>;
  if (names?.covers(personId)) {
    // The list's batched read (loading, answered or failed): no read of its own.
    const entry = names.get(personId);
    return (
      <PersonNameText
        personId={personId}
        entry={entry}
        error={entry === undefined ? names.error : null}
      />
    );
  }
  return <SinglePersonName personId={personId} />;
}

function SinglePersonName({ personId }: { personId: string }) {
  const names = usePersonNames([personId]);
  return (
    <PersonNameText
      personId={personId}
      entry={names.get(personId)}
      error={names.get(personId) === undefined ? names.error : null}
    />
  );
}

function PersonNameText({
  personId,
  entry,
  error,
}: {
  personId: string;
  entry: PersonNameEntry | null | undefined;
  error: ApiError | null;
}) {
  if (entry) return <span>{entry.displayName}</span>;
  if (entry === null || (error && presentationForError(error) === 'unavailable')) {
    return <span>Person not available to you</span>;
  }
  if (error) return <span>Person {shortRef(personId)} (name could not load)</span>;
  return <span aria-busy="true">Person {shortRef(personId)}</span>;
}

/** The season's team entries by id: each carries its team's name (CMP-01). */
export function useSeasonEntries(seasonId: string | null | undefined) {
  const entries = useApiQuery({
    path: '/team-entries',
    request: { query: { seasonId: seasonId ?? '' } },
    enabled: !!seasonId,
    staleTime: NAME_STALE_MS,
  });
  const byId = useMemo(
    () => new Map((entries.data ?? []).map((entry) => [entry.id, entry])),
    [entries.data],
  );
  return { query: entries, byId };
}

export type EntryNames = ReadonlyMap<string, { teamId: string; teamName?: string }>;

export function EntryName({
  entryId,
  teamIdOf,
  name,
}: {
  entryId: string | null | undefined;
  teamIdOf?: EntryNames;
  /** The team name the payload carries, when it does (CMP-01). */
  name?: string | null;
}) {
  if (!entryId) return <span>To be decided</span>;
  if (name) return <span>{name}</span>;
  const entry = teamIdOf?.get(entryId);
  if (!entry) return <span>Entry {shortRef(entryId)}</span>;
  if (entry.teamName) return <span>{entry.teamName}</span>;
  return <TeamName teamId={entry.teamId} />;
}

/** A rule-set version by id: name and version number (SPK-RESULT-003, SPK-FIX-004). */
export function RuleSetLabel({ ruleSetId }: { ruleSetId: string }) {
  const ruleSet = useApiQuery({
    path: '/rule-sets/{id}',
    request: { path: { id: ruleSetId } },
    staleTime: 5 * 60_000,
  });
  if (ruleSet.data) return <span>{`${ruleSet.data.name}, version ${ruleSet.data.version}`}</span>;
  if (ruleSet.error) return <span>Rule set {shortRef(ruleSetId)} (not available)</span>;
  return <span aria-busy="true">Rule set {shortRef(ruleSetId)}</span>;
}
