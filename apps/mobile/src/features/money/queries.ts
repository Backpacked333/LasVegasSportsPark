/**
 * Shows two reads as one SPK-UX-008 state (for example an enrollment and its cancellation
 * preview): loading until both arrive, the first error otherwise, and the age of the older one.
 */
import type { ApiError } from '@sportspark/api-client';
import type { QueryLike } from '../../ui/QueryBoundary';

export function combineQueries<A, B>(
  a: QueryLike<A>,
  b: QueryLike<B>,
): QueryLike<{ a: A; b: B }> & { refetch: () => Promise<unknown> } {
  const data = a.data !== undefined && b.data !== undefined ? { a: a.data, b: b.data } : undefined;
  const error: ApiError | null = a.error ?? b.error ?? null;
  const fetchStatus =
    a.fetchStatus === 'fetching' || b.fetchStatus === 'fetching'
      ? 'fetching'
      : a.fetchStatus === 'paused' || b.fetchStatus === 'paused'
        ? 'paused'
        : 'idle';
  const updatedAt =
    a.updatedAt && b.updatedAt
      ? new Date(Math.min(a.updatedAt.getTime(), b.updatedAt.getTime()))
      : (a.updatedAt ?? b.updatedAt);
  return {
    data,
    error,
    fetchStatus,
    updatedAt,
    refetch: () => Promise.all([a.refetch(), b.refetch()]),
  };
}
