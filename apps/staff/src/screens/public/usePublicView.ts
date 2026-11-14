/**
 * Reads a public view (SPK-SCHED-010, proposed amendment PA-06) for a page nobody is signed in to:
 * re-reads it on an interval, keeps the last answer in this browser so the page still shows the
 * last schedule it received while its connection is down, and says when that answer was computed.
 *
 * What is kept is the public answer itself (no person, no contact, no record id by contract), in
 * the same small store the display preferences use; it is never a record and never sent anywhere.
 * A "not available" answer (the view was taken down, or public views were turned off) clears it:
 * a display must not keep showing a schedule the operator withdrew.
 */
import type { ApiError, PathsWithMethod, ResponseBody } from '@sportspark/api-client';
import { useEffect, useMemo } from 'react';
import { useApiQuery, type ApiQueryArgs } from '../../api/useApiQuery';
import { useApp } from '../../providers/AppProviders';

export const PUBLIC_REFRESH_MS = 30_000;
const KEEP_PREFIX = 'public-view:';

export interface PublicViewState<T> {
  /** The latest answer, or the last one kept while the connection is down. */
  data: T | undefined;
  /** True when `data` is a kept answer because the latest read failed for lack of a connection. */
  stale: boolean;
  /** The view does not exist, is not public, or public views are turned off. */
  notAvailable: boolean;
  /** Too many reads from this address; the page tries again by itself. */
  rateLimited: boolean;
  error: ApiError | null;
  loading: boolean;
}

function readKept<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function usePublicView<P extends PathsWithMethod<'get'>>(
  args: ApiQueryArgs<P>,
  keepKey: string,
  refreshMs: number = PUBLIC_REFRESH_MS,
): PublicViewState<ResponseBody<P, 'get'>> {
  type T = ResponseBody<P, 'get'>;
  const { preferences } = useApp();
  const query = useApiQuery({ ...args, refetchInterval: refreshMs, staleTime: 0 });
  const storageKey = `${KEEP_PREFIX}${keepKey}`;
  const fresh = query.data;
  const error = query.error ?? null;
  const notAvailable = error?.code === 'NOT_FOUND';

  useEffect(() => {
    if (fresh !== undefined) preferences.set(storageKey, JSON.stringify(fresh));
  }, [fresh, preferences, storageKey]);
  useEffect(() => {
    if (notAvailable) preferences.set(storageKey, null);
  }, [notAvailable, preferences, storageKey]);

  const kept = useMemo(
    () =>
      fresh === undefined && !notAvailable ? readKept<T>(preferences.get(storageKey)) : undefined,
    [fresh, notAvailable, preferences, storageKey],
  );
  const failed = error !== null || query.fetchStatus === 'paused';
  return {
    data: notAvailable ? undefined : failed ? (kept ?? fresh) : (fresh ?? kept),
    stale: failed && !notAvailable && (kept ?? fresh) !== undefined,
    notAvailable,
    rateLimited: error?.code === 'RATE_LIMITED',
    error,
    loading: query.isPending && kept === undefined && !failed,
  };
}
