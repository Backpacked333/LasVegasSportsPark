/**
 * Reads shared by the today screens (SCR-C-03, SCR-C-04, SCR-C-06, SCR-C-18, SCR-C-19, SCR-C-20).
 * Every read goes through the typed API client and the TanStack cache under `apiQueryKey`, so the
 * same request made by two screens is one cached response with one receipt time (§4.15 data age).
 *
 * Names of family members are read from `GET /v1/people/{id}`, which the API answers only for
 * people the signed-in person may view (SPK-IAM-003); only the given name is ever displayed
 * (§4.14 child data minimised) and nothing here is logged.
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
 * API lets this person read, and a neutral label otherwise (no hint about whom it might be).
 */
export function usePersonNames(personIds: readonly string[], me: Me | undefined) {
  const selfId = me?.principal.personId ?? null;
  const others = useMemo(
    () => [...new Set(personIds)].filter((id) => id !== selfId).sort(),
    [personIds, selfId],
  );
  const requests = useMemo(() => others.map((id) => ({ path: { id } })), [others]);
  const reads = useApiReads('/people/{id}', requests, useSignedIn() && me !== undefined);
  const names = new Map<string, string>();
  if (selfId) names.set(selfId, 'You');
  others.forEach((id, index) => {
    const person = reads[index]?.data;
    names.set(id, person?.givenName ? person.givenName : UNNAMED_PERSON);
  });
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
