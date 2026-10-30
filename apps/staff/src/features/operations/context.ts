/**
 * Shared reads for the operations screens: the facility the viewer is working in (§4.3) and the
 * display names of the people a screen lists.
 *
 * Names: `GET /v1/person-names` (ID-02; SPK-IAM-002, SPK-IAM-003, §4.14) answers names and kind
 * only, never a date of birth or contact point, for at most 100 people the viewer may view; the
 * others are left out. One read per set of ids (sorted, deduplicated, split into reads of 100).
 * A person the API leaves out (or a read refused as not available) is shown as "Participant, name
 * not available" with a short reference, without implying that a record exists (§4.10).
 *
 * Facility time zone (SPK-SCHED-008): from the Today feed when the viewer may read it, otherwise
 * from `GET /v1/facilities/{id}` (any signed-in principal).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { presentationForError } from '@sportspark/api-client';
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
  // SPK-SCHED-008: the zone from the facility directory when the Today feed does not list it.
  const todaySettled = !isStaff || today.data !== undefined || today.error !== null;
  const directory = useApiQuery({
    path: '/facilities/{id}',
    request: { path: { id: facilityId ?? '' } },
    enabled: facilityId !== null && me.data !== undefined && todaySettled && !facility,
    staleTime: 60 * 60_000,
  });
  return {
    facilityId,
    name: facility?.name ?? directory.data?.name ?? null,
    timezone: facility?.timezone ?? directory.data?.timezone ?? null,
    localDate: facility?.localDate ?? null,
    window: facility?.window ?? null,
    accountId: me.data?.principal.accountId ?? session.session?.accountId ?? null,
    personId: me.data?.principal.personId ?? null,
    loading: me.data === undefined && me.error === null,
    feedSettled:
      me.data !== undefined && (!isStaff || today.data !== undefined || today.error !== null),
  };
}

export type PersonName =
  | { status: 'loading' }
  /** The API left the person out, or refused the read as not available (§4.10). */
  | { status: 'unavailable' }
  /** The read failed for another reason (offline, 5xx): the name may load later. */
  | { status: 'error'; error: ApiError; retry: () => void }
  | { status: 'ok'; name: string; kind: 'adult' | 'child' };

type PersonNameRecord = Schema<'PersonName'>;

/** `GET /v1/person-names` reads at most 100 ids at a time (PersonNamesQuery). */
export const PERSON_NAMES_MAX = 100;

function chunks(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += PERSON_NAMES_MAX)
    out.push(ids.slice(i, i + PERSON_NAMES_MAX));
  return out;
}

/** Query key of one names read (also used by tests and invalidation). */
export const personNamesKey = (ids: readonly string[]) => ['person-names', ...ids] as const;

/**
 * Display names for a list of person ids (deduplicated, one read per set of up to 100). Only
 * names and kind enter the cache (§4.14).
 */
export function usePersonNames(
  ids: readonly string[],
  enabled = true,
): ReadonlyMap<string, PersonName> {
  const api = useApi();
  const key = [...new Set(ids.filter((id) => id.length > 0))].sort().join(',');
  const groups = useMemo(() => chunks(key ? key.split(',') : []), [key]);
  const combine = useCallback(
    (
      results: readonly {
        data: readonly PersonNameRecord[] | undefined;
        error: ApiError | null;
        refetch: () => unknown;
      }[],
    ) => {
      const map = new Map<string, PersonName>();
      groups.forEach((group, index) => {
        const result = results[index];
        const byId = new Map((result?.data ?? []).map((n) => [n.personId, n]));
        for (const id of group) {
          if (result?.data) {
            const n = byId.get(id);
            map.set(
              id,
              n
                ? {
                    status: 'ok',
                    name: n.displayName || `${n.givenName} ${n.familyName}`.trim(),
                    kind: n.kind,
                  }
                : { status: 'unavailable' },
            );
          } else if (result?.error) {
            map.set(
              id,
              presentationForError(result.error) === 'unavailable'
                ? { status: 'unavailable' }
                : { status: 'error', error: result.error, retry: () => void result.refetch() },
            );
          } else {
            map.set(id, { status: 'loading' });
          }
        }
      });
      return map as ReadonlyMap<string, PersonName>;
    },
    [groups],
  );
  return useQueries({
    queries: groups.map((group) => ({
      queryKey: personNamesKey(group),
      queryFn: async ({ signal }: { signal: AbortSignal }) =>
        (await api.get('/person-names', { query: { ids: group }, signal })).items,
      enabled,
      staleTime: 5 * 60_000,
    })),
    combine: combine as (
      results: readonly { data: unknown; error: unknown; refetch: () => unknown }[],
    ) => ReadonlyMap<string, PersonName>,
  });
}

/**
 * The label of a listed person. A person whose name the viewer may not read (an assigned coach or
 * official reading a child: identity.read_person is not granted to them) keeps a short opaque
 * reference, so rows and buttons stay distinguishable (SPK-UX-009) without revealing more.
 */
export function nameOf(names: ReadonlyMap<string, PersonName>, id: string): string {
  const entry = names.get(id);
  const ref = id.slice(0, 8);
  if (!entry || entry.status === 'loading') return 'Loading name…';
  if (entry.status === 'unavailable') return `Participant, name not available (ref ${ref})`;
  if (entry.status === 'error') return `Name could not load (ref ${ref})`;
  return entry.name;
}
