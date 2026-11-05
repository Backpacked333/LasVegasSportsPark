/**
 * Reads shared by the today screens (SCR-C-03, SCR-C-04, SCR-C-06, SCR-C-18, SCR-C-19, SCR-C-20).
 * Every read goes through the typed API client and the TanStack cache under `apiQueryKey`, so the
 * same request made by two screens is one cached response with one receipt time (§4.15 data age).
 *
 * Names of family members come from `GET /v1/person-names` (ID-02, `api/person-names.ts`): names
 * only, never a date of birth or contact, and only for people the signed-in person may view
 * (SPK-IAM-003); only the given name is ever displayed (§4.14 child data minimised) and nothing
 * here is logged.
 */
import {
  apiQueryKey,
  type ApiError,
  type ApiResponse,
  type OptionsArg,
  type PathsWithMethod,
  type ResponseBody,
  type Schema,
} from '@sportspark/api-client';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { usePersonNames as usePersonNameEntries } from '../../api/person-names';
import { useApiQuery } from '../../api/useApiQuery';
import { useApi, useApp } from '../../providers/AppProviders';
import { calendarWindowQuery } from './calendar';

type GetPath = PathsWithMethod<'get'>;
type RequestOf<P extends GetPath> = Omit<NonNullable<OptionsArg<P, 'get'>[0]>, 'signal'>;
type Me = Schema<'Me'>;

/** The inbox page every today screen shares with SCR-C-06 (same key, same cache entry). */
export const INBOX_PAGE_SIZE = 50;
/** How far ahead Schedule and Home look by default: a display window, not a policy value. */
export const SCHEDULE_WINDOW_DAYS = 28;

export function useSignedIn(): boolean {
  return useApp().session.status === 'signed_in';
}

export function useMe() {
  return useApiQuery({ path: '/me', enabled: useSignedIn() });
}

export function useInbox() {
  return useApiQuery({
    path: '/me/inbox',
    request: { query: { limit: INBOX_PAGE_SIZE } },
    enabled: useSignedIn(),
  });
}

/** The family calendar from the start of `anchor`'s local day for `days` days (SPK-YOUTH-007). */
export function useCalendarWindow(anchor: Date, days: number, zone: string) {
  return useApiQuery({
    path: '/me/family-calendar',
    request: { query: calendarWindowQuery(anchor, 0, days, zone) },
    enabled: useSignedIn(),
  });
}

export interface ReadResult<T> {
  data: T | undefined;
  error: ApiError | null;
  isPending: boolean;
  updatedAt: Date | null;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  refetch: () => void;
}

/** Several GETs of one path in parallel, each cached under its own `apiQueryKey`. */
export function useApiReads<P extends GetPath>(
  path: P,
  requests: readonly RequestOf<P>[],
  enabled = true,
): ReadResult<ResponseBody<P, 'get'>>[] {
  const api = useApi();
  const results = useQueries({
    queries: requests.map((request) => ({
      queryKey: apiQueryKey(path, request as { path?: object; query?: object }),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        (
          api.request as (
            method: 'get',
            path: string,
            options: object,
          ) => Promise<ApiResponse<ResponseBody<P, 'get'>>>
        )('get', path, { ...request, signal }),
      enabled,
    })),
  });
  return results.map((r) => ({
    data: r.data?.data,
    error: (r.error as ApiError | null) ?? null,
    isPending: r.isPending && r.fetchStatus !== 'idle',
    updatedAt: r.data?.receivedAt ?? null,
    fetchStatus: r.fetchStatus,
    refetch: () => void r.refetch(),
  }));
}

/** `count` consecutive calendar windows of `days` days; window 0 is useCalendarWindow's. */
export function useCalendarWindows(anchor: Date, count: number, days: number, zone: string) {
  const first = calendarWindowQuery(anchor, 0, days, zone).from;
  const requests = useMemo(
    () =>
      Array.from({ length: count }, (_, index) => ({
        query: calendarWindowQuery(new Date(first), index, days, zone),
      })),
    [first, count, days, zone],
  );
  return useApiReads('/me/family-calendar', requests, useSignedIn());
}

/** Self plus the people the API says this person holds `view` over (`GET /v1/me` authorities). */
export function viewablePersonIds(me: Me | undefined): string[] {
  if (!me) return [];
  const ids: string[] = [];
  if (me.principal.personId) ids.push(me.principal.personId);
  for (const a of me.authorities) {
    if (a.permissions.includes('view') && !ids.includes(a.subjectPersonId)) {
      ids.push(a.subjectPersonId);
    }
  }
  return ids;
}

/** Shown while a name loads, or when the API does not let this person see it. */
export const UNNAMED_PERSON = 'Family member';

/**
 * Display names for participants: "You" for the signed-in person, the given name for others the
 * API lets this person read (`GET /v1/person-names`, one read per set of ids), and a neutral label
 * otherwise (no hint about whom it might be).
 */
export function usePersonNames(personIds: readonly string[], me: Me | undefined) {
  const selfId = me?.principal.personId ?? null;
  const others = useMemo(
    () => [...new Set(personIds)].filter((id) => id !== selfId).sort(),
    [personIds, selfId],
  );
  const entries = usePersonNameEntries(me !== undefined ? others : []);
  const names = new Map<string, string>();
  if (selfId) names.set(selfId, 'You');
  for (const id of others) {
    const entry = entries.get(id);
    names.set(id, entry?.state === 'ready' ? entry.name.givenName : UNNAMED_PERSON);
  }
  return names;
}

export function nameOf(names: Map<string, string>, personId: string): string {
  return names.get(personId) ?? UNNAMED_PERSON;
}

/** Public offering views (name, location label) for calendar items (`GET /v1/offerings/{id}`). */
export function useOfferings(offeringIds: readonly string[]) {
  const ids = useMemo(() => [...new Set(offeringIds)].sort(), [offeringIds]);
  const requests = useMemo(() => ids.map((id) => ({ path: { id } })), [ids]);
  const reads = useApiReads('/offerings/{id}', requests, useSignedIn());
  const map = new Map<string, Schema<'Offering'>>();
  ids.forEach((id, index) => {
    const offering = reads[index]?.data;
    if (offering) map.set(id, offering);
  });
  return map;
}

/** One facility of the organization with its IANA zone and name (`GET /v1/facilities/{id}`, K-04). */
export function useFacility(facilityId: string | null | undefined) {
  return useApiQuery({
    path: '/facilities/{id}',
    request: { path: { id: facilityId ?? '' } },
    enabled: useSignedIn() && !!facilityId,
    // Facility names and zones change rarely; one read serves every card on the screen.
    staleTime: 10 * 60_000,
  });
}

/** The teams the signed-in person and the people they may view are on (`GET /v1/me/team-entries`). */
export function useMyTeams(enabled = true) {
  return useApiQuery({ path: '/me/team-entries', enabled: useSignedIn() && enabled });
}

/** Fixtures of those teams in one window of at most 120 days (`GET /v1/me/fixtures`, CMP-02). */
export function useMyFixtures(window: { from: string; to: string }, enabled = true) {
  return useApiQuery({
    path: '/me/fixtures',
    request: { query: window },
    enabled: useSignedIn() && enabled,
  });
}
