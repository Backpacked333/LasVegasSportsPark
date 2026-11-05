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
 * Facility name, time zone and scope (SPK-SCHED-008, K-04): from the facility directory,
 * `GET /v1/facilities` (with `inStaffScope`), or `GET /v1/facilities/{id}` for a facility the
 * listing leaves out; any signed-in principal may read both. The facility-local date and day window
 * are derived from that zone and the injected clock, so these hooks never read the Today feed
 * (§4.5: the feed computes every operational source and is read only by the Today screen).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { presentationForError } from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { useFacilityDirectory, useFacilitySummary } from '../../api/facility-directory';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi, useApp, useNow } from '../../providers/AppProviders';
import { localDateOf, localDaysWindow } from '../schedule-facilities/time';

export interface OperatingFacility {
  /** The selected facility, or the only facility in the viewer's scope; null when ambiguous. */
  facilityId: string | null;
  name: string | null;
  /** IANA zone from the facility directory (SPK-SCHED-008); null while unknown. */
  timezone: string | null;
  /** The facility-local date of today (injected clock in the facility zone). */
  localDate: string | null;
  /** Today's facility-local window, local midnight to local midnight, as UTC instants. */
  window: { start: string; end: string } | null;
  /** The viewer's account (actor of queued offline observations, §4.15). */
  accountId: string | null;
  personId: string | null;
  /** `/me` has not answered yet. */
  loading: boolean;
  /** The facility directory has answered (or cannot), so `window` and `timezone` are final. */
  zoneSettled: boolean;
}

/** The local date of a zone at an instant; null for no zone or one the platform rejects. */
function localDateIn(at: Date, timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    return localDateOf(at, timeZone);
  } catch {
    return null;
  }
}

export function useOperatingFacility(): OperatingFacility {
  const { facilityId: selected, session } = useApp();
  const now = useNow(60_000);
  const signedIn = session.status === 'signed_in';
  const me = useApiQuery({ path: '/me' });
  const isStaff = me.data?.principal.kind === 'staff';
  const directory = useFacilityDirectory(signedIn);
  const scoped = me.data?.principal.facilityIds ?? [];
  // §4.3: the facilities the API says this staff principal may act at.
  const inScope = isStaff ? (directory.data?.items ?? []).filter((f) => f.inStaffScope) : [];
  const facilityId =
    selected ??
    (scoped.length === 1
      ? (scoped[0] as string)
      : scoped.length === 0 && inScope.length === 1
        ? (inScope[0]?.id ?? null)
        : null);
  const { summary, settled } = useFacilitySummary(facilityId, signedIn && me.data !== undefined);
  const timezone = summary?.timezone ?? null;
  // SPK-SCHED-008: "today" is the facility-local day, local midnight to local midnight; a new
  // window only when the local date changes, so reads keyed on it stay put during the day.
  const localDate = localDateIn(now, timezone);
  const window = useMemo(
    () => (localDate && timezone ? localDaysWindow(localDate, 1, timezone) : null),
    [localDate, timezone],
  );
  return {
    facilityId,
    name: summary?.name ?? null,
    timezone,
    localDate,
    window,
    accountId: me.data?.principal.accountId ?? session.session?.accountId ?? null,
    personId: me.data?.principal.personId ?? null,
    loading: me.data === undefined && me.error === null,
    zoneSettled: me.data !== undefined && settled,
  };
}

/**
 * The IANA zone of a facility a record names (SPK-SCHED-008): from the facility directory when it
 * lists the facility, otherwise from `GET /v1/facilities/{id}` (any signed-in principal); the same
 * reads and cache as `useOperatingFacility`. Null while it loads, when the record names no facility
 * or when the read fails: `formatInstant` then labels the device zone, so a device time is never
 * presented as facility time.
 */
export function useFacilityZone(facilityId: string | null | undefined): string | null {
  const { session } = useApp();
  const { summary } = useFacilitySummary(facilityId, session.status === 'signed_in');
  if (!facilityId) return null;
  return summary?.timezone ?? null;
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
 * reference, so rows and buttons stay distinguishable (SPK-UX-009) without revealing more. `noun`
 * says who the person is on this list ("Participant" by default; "Staff member" for an author).
 */
export function nameOf(
  names: ReadonlyMap<string, PersonName>,
  id: string,
  noun = 'Participant',
): string {
  const entry = names.get(id);
  const ref = id.slice(0, 8);
  if (!entry || entry.status === 'loading') return 'Loading name…';
  if (entry.status === 'unavailable') return `${noun}, name not available (ref ${ref})`;
  if (entry.status === 'error') return `Name could not load (ref ${ref})`;
  return entry.name;
}
