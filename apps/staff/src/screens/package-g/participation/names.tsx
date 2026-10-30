/**
 * Names for the opaque ids Package G records carry (SCR-S-51 to SCR-S-54; SPK-UX-003 every action
 * shows whose it is, §4.10, §4.14).
 *
 * - People: `GET /v1/person-names` (ID-02), names only: never a date of birth, contact point or
 *   household. One read per set of up to 100 ids (sorted, deduplicated, split above 100), cached
 *   under `['person-names', ...ids]`. A person the API leaves out reads "Name not available",
 *   never that the person exists. Nothing is logged and no id is put in a route.
 * - Offerings, programs, resources and assets: each read from the API that owns it, so the API
 *   decides who may see it; a refused read is "not available".
 */
import { presentationForError, type ApiError, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo, type ReactNode } from 'react';
import { useApiQuery } from '../../../api/useApiQuery';
import { useApi } from '../../../providers/AppProviders';
import { shortRef } from './format';

export type PersonName = Schema<'PersonName'>;

/** The API reads at most 100 ids at a time (PersonNamesQuery). */
export const PERSON_NAMES_MAX = 100;

export type PersonNameEntry =
  | { state: 'loading' }
  | { state: 'ready'; name: PersonName }
  /** The API omitted the person: the viewer may not view them (never "exists but hidden"). */
  | { state: 'unavailable' }
  | { state: 'error'; error: ApiError; retry: () => void };

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PERSON_NAMES_MAX) {
    out.push(ids.slice(i, i + PERSON_NAMES_MAX));
  }
  return out;
}

export function usePersonNames(
  ids: readonly (string | null | undefined)[],
): ReadonlyMap<string, PersonNameEntry> {
  const api = useApi();
  const key = [...new Set(ids.filter((id): id is string => !!id))].sort().join(',');
  const groups = useMemo(() => chunks(key ? key.split(',') : []), [key]);
  const combine = useCallback(
    (
      results: readonly {
        data: readonly PersonName[] | undefined;
        error: Error | null;
        refetch: () => unknown;
      }[],
    ) => {
      const map = new Map<string, PersonNameEntry>();
      groups.forEach((group, index) => {
        const result = results[index];
        const byId = new Map((result?.data ?? []).map((p) => [p.personId, p]));
        for (const id of group) {
          if (result?.data) {
            const name = byId.get(id);
            map.set(id, name ? { state: 'ready', name } : { state: 'unavailable' });
          } else if (result?.error) {
            const error = result.error as ApiError;
            map.set(
              id,
              presentationForError(error) === 'unavailable'
                ? { state: 'unavailable' }
                : { state: 'error', error, retry: () => void result.refetch() },
            );
          } else {
            map.set(id, { state: 'loading' });
          }
        }
      });
      return map as ReadonlyMap<string, PersonNameEntry>;
    },
    [groups],
  );
  return useQueries({
    queries: groups.map((group) => ({
      queryKey: ['person-names', ...group],
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.get('/person-names', { query: { ids: group }, signal })).items,
      staleTime: 5 * 60_000,
    })),
    combine,
  });
}

/** One person's name as text, with the state when it is not ready. */
export function personNameText(entry: PersonNameEntry | undefined, fallback = 'Person'): string {
  if (!entry || entry.state === 'loading') return `${fallback} (loading name)`;
  if (entry.state === 'ready') return entry.name.displayName;
  if (entry.state === 'unavailable') return 'Name not available';
  return presentationForError(entry.error) === 'offline'
    ? `${fallback} (name not loaded: offline)`
    : `${fallback} (name could not load: ${entry.error.code})`;
}

export function PersonNameView({ id, fallback = 'Person' }: { id: string; fallback?: string }) {
  const names = usePersonNames([id]);
  return <span>{personNameText(names.get(id), fallback)}</span>;
}

function readFailure(error: ApiError, what: string, id: string): string {
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') return `${what} not available`;
  if (presentation === 'offline') return `${what} ${shortRef(id)} (offline)`;
  return `${what} ${shortRef(id)} (could not load: ${error.code})`;
}

export function OfferingName({ id }: { id: string }) {
  const offering = useApiQuery({
    path: '/offerings/{id}',
    request: { path: { id } },
    staleTime: 5 * 60_000,
  });
  if (offering.data) return <span>{offering.data.name}</span>;
  if (offering.error) return <span>{readFailure(offering.error, 'Offering', id)}</span>;
  return <span>Offering {shortRef(id)}</span>;
}

export function ProgramName({ id }: { id: string }) {
  const program = useApiQuery({
    path: '/programs/{id}',
    request: { path: { id } },
    staleTime: 5 * 60_000,
  });
  if (program.data) return <span>{program.data.name}</span>;
  if (program.error) return <span>{readFailure(program.error, 'Program', id)}</span>;
  return <span>Program {shortRef(id)}</span>;
}

export function ResourceName({ id }: { id: string }) {
  const resource = useApiQuery({
    path: '/resources/{id}',
    request: { path: { id } },
    staleTime: 5 * 60_000,
  });
  if (resource.data) return <span>{resource.data.name}</span>;
  if (resource.error) return <span>{readFailure(resource.error, 'Resource', id)}</span>;
  return <span>Resource {shortRef(id)}</span>;
}

export function AssetName({ id }: { id: string }) {
  const asset = useApiQuery({
    path: '/assets/{id}',
    request: { path: { id } },
    staleTime: 5 * 60_000,
  });
  if (asset.data) return <span>{asset.data.name}</span>;
  if (asset.error) return <span>{readFailure(asset.error, 'Equipment', id)}</span>;
  return <span>Equipment {shortRef(id)}</span>;
}

/** "A, B and C" from names rendered as nodes. */
export function JoinedList({ children }: { children: readonly ReactNode[] }) {
  return (
    <>
      {children.map((child, index) => (
        <span key={index}>
          {index > 0 ? (index === children.length - 1 ? ' and ' : ', ') : null}
          {child}
        </span>
      ))}
    </>
  );
}
