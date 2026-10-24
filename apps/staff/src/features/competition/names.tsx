/**
 * Display names for records the competition payloads reference only by id (team entries,
 * placement requests, suspensions, enrollments). Each name is a cached `GET` the viewer must be
 * permitted to make; a name the API will not show is rendered as "not available" without implying
 * the record exists (§4.10). For people only the given and family name are rendered: never the
 * date of birth or contact details the record may carry (§4.14 child data minimized), and nothing
 * is logged.
 */
import { apiQueryKey } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { nameUnavailable, usePersonName } from '../../api/person-names';
import { useApi } from '../../providers/AppProviders';
import { shortRef } from './format';

const NAME_STALE_MS = 5 * 60_000;

/**
 * Team names by team id for places that need text rather than an element (select options). Shares
 * the cache entries of `TeamName`; a name the API does not return falls back to a short reference.
 */
export function useTeamNames(teamIds: readonly string[]): ReadonlyMap<string, string> {
  const api = useApi();
  const unique = [...new Set(teamIds)];
  const results = useQueries({
    queries: unique.map((id) => ({
      queryKey: apiQueryKey('/teams/{id}', { path: { id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.request('get', '/teams/{id}', { path: { id }, signal }),
      staleTime: NAME_STALE_MS,
    })),
  });
  const names = new Map<string, string>();
  unique.forEach((id, index) => {
    const name = results[index]?.data?.data.name;
    names.set(id, name ?? `Team ${shortRef(id)}`);
  });
  return names;
}

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

/**
 * A person's name for a list row. Read through the minimal name read (src/api/person-names.ts):
 * the cache never holds a child's date of birth or contact points (§4.14).
 */
export function PersonName({ personId }: { personId: string | null | undefined }) {
  const person = usePersonName(personId);
  if (!personId) return <span>Person not set</span>;
  if (person.data) return <span>{`${person.data.givenName} ${person.data.familyName}`}</span>;
  if (person.error) {
    return nameUnavailable(person.error) ? (
      <span>Person {shortRef(personId)} (name not available)</span>
    ) : (
      <span>Person {shortRef(personId)} (name could not load)</span>
    );
  }
  return <span aria-busy="true">Person {shortRef(personId)}</span>;
}

/** Team entries of a season by id, for screens that hold only entry ids (brackets, fixtures). */
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

export function EntryName({
  entryId,
  teamIdOf,
}: {
  entryId: string | null | undefined;
  teamIdOf: ReadonlyMap<string, { teamId: string }>;
}) {
  if (!entryId) return <span>To be decided</span>;
  const entry = teamIdOf.get(entryId);
  if (!entry) return <span>Entry {shortRef(entryId)}</span>;
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
