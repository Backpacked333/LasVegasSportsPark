/**
 * Shared reads for the operations screens: the facility the viewer is working in (§4.3) and the
 * display names of the people a screen lists.
 *
 * Names: the API has no minimal "display name" read, so each person is read with
 * `GET /v1/people/{id}` and only the given and family names are used; contact points and dates of
 * birth in that payload are never rendered, logged or put in a URL (§4.14 child data minimized).
 * A person the viewer may not read (NOT_FOUND, ACCESS_DENIED) is shown as "Name not available".
 */
import { apiQueryKey, type ApiResponse, type Schema } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi, useApp } from '../../providers/AppProviders';

export interface OperatingFacility {
  /** The selected facility, or the only facility in the viewer's scope; null when ambiguous. */
  facilityId: string | null;
  name: string | null;
  /** IANA zone from the Today feed, when the viewer may read it (SPK-SCHED-008). */
  timezone: string | null;
  /** The facility-local date of today, from the Today feed. */
  localDate: string | null;
  /** Today's facility-local window, from the Today feed. */
  window: { start: string; end: string } | null;
  /** The viewer's account (actor of queued offline observations, §4.15). */
  accountId: string | null;
  personId: string | null;
  /** `/me` has not answered yet. */
  loading: boolean;
  /** The Today feed has answered (or will not be read), so `window` and `timezone` are final. */
  feedSettled: boolean;
}

export function useOperatingFacility(): OperatingFacility {
  const { facilityId: selected, session } = useApp();
  const me = useApiQuery({ path: '/me' });
  const isStaff = me.data?.principal.kind === 'staff';
  const today = useApiQuery({ path: '/today', enabled: isStaff, staleTime: 5 * 60_000 });
  const scoped = me.data?.principal.facilityIds ?? [];
  const listed = today.data?.facilities ?? [];
  const facilityId =
    selected ??
    (scoped.length === 1
      ? (scoped[0] as string)
      : scoped.length === 0 && listed.length === 1
        ? (listed[0]?.facilityId ?? null)
        : null);
  const facility = listed.find((f) => f.facilityId === facilityId);
  return {
    facilityId,
    name: facility?.name ?? null,
    timezone: facility?.timezone ?? null,
    localDate: facility?.localDate ?? null,
    window: facility?.window ?? null,
    accountId: me.data?.principal.accountId ?? session.session?.accountId ?? null,
    personId: me.data?.principal.personId ?? null,
    loading: me.data === undefined && me.error === null,
    feedSettled:
      me.data !== undefined && (!isStaff || today.data !== undefined || today.error !== null),
  };
}

type PersonDetail = Schema<'PersonDetail'>;

export type PersonName =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ok'; name: string; kind: PersonDetail['kind'] };

/** Display names for a list of person ids (deduplicated, cached per person). */
export function usePersonNames(ids: readonly string[]): ReadonlyMap<string, PersonName> {
  const api = useApi();
  const key = [...new Set(ids)].sort().join(',');
  const unique = useMemo(() => (key ? key.split(',') : []), [key]);
  const combine = useCallback(
    (
      results: readonly {
        data: ApiResponse<PersonDetail> | undefined;
        error: Error | null;
      }[],
    ) => {
      const map = new Map<string, PersonName>();
      unique.forEach((id, index) => {
        const r = results[index];
        if (r?.data) {
          const p = r.data.data;
          map.set(id, {
            status: 'ok',
            name: `${p.givenName} ${p.familyName}`.trim(),
            kind: p.kind,
          });
        } else if (r?.error) {
          map.set(id, { status: 'unavailable' });
        } else {
          map.set(id, { status: 'loading' });
        }
      });
      return map as ReadonlyMap<string, PersonName>;
    },
    [unique],
  );
  return useQueries({
    queries: unique.map((id) => ({
      queryKey: apiQueryKey('/people/{id}', { path: { id } }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api.request('get', '/people/{id}', { path: { id }, signal }) as Promise<
          ApiResponse<PersonDetail>
        >,
      staleTime: 5 * 60_000,
      retry: false,
    })),
    combine,
  });
}

export function nameOf(names: ReadonlyMap<string, PersonName>, id: string): string {
  const entry = names.get(id);
  if (!entry || entry.status === 'loading') return 'Loading name…';
  if (entry.status === 'unavailable') return 'Name not available';
  return entry.name;
}
