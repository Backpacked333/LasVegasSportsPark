/**
 * Shared reads for the operations screens: the facility the viewer is working in (§4.3) and the
 * display names of the people a screen lists.
 *
 * Names: the API has no minimal "display name" read, so each person is read with
 * `GET /v1/people/{id}` and only the given and family names are used; contact points and dates of
 * birth in that payload are never rendered, logged or put in a URL (§4.14 child data minimized).
 * A person the viewer may not read (NOT_FOUND, ACCESS_DENIED) is shown as "Name not available".
 */
import { useMemo } from 'react';
import { nameUnavailable, usePersonNameRecords } from '../../api/person-names';
import { useApiQuery } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';

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

export type PersonName =
  | { status: 'loading' }
  /** A protected NOT_FOUND or a permission restriction: the viewer may not read this person. */
  | { status: 'unavailable' }
  /** The read failed for another reason (offline, 5xx): the name may load later. */
  | { status: 'error' }
  | { status: 'ok'; name: string; kind: 'adult' | 'child' };

/**
 * Display names for a list of person ids (deduplicated, cached per person). Read through the
 * minimal name read (src/api/person-names.ts): only names and kind enter the cache, never a date
 * of birth or contact point (§4.14).
 */
export function usePersonNames(ids: readonly string[]): ReadonlyMap<string, PersonName> {
  const records = usePersonNameRecords(ids);
  return useMemo(() => {
    const map = new Map<string, PersonName>();
    for (const [id, r] of records) {
      if (r.data) {
        map.set(id, {
          status: 'ok',
          name: `${r.data.givenName} ${r.data.familyName}`.trim(),
          kind: r.data.kind,
        });
      } else if (r.error) {
        map.set(id, { status: nameUnavailable(r.error) ? 'unavailable' : 'error' });
      } else {
        map.set(id, { status: 'loading' });
      }
    }
    return map as ReadonlyMap<string, PersonName>;
  }, [records]);
}

export function nameOf(names: ReadonlyMap<string, PersonName>, id: string): string {
  const entry = names.get(id);
  if (!entry || entry.status === 'loading') return 'Loading name…';
  if (entry.status === 'unavailable') return 'Name not available';
  if (entry.status === 'error') return 'Name could not load';
  return entry.name;
}
