/**
 * Renders a query's SPK-UX-008 state (loading, empty, error, offline or stale, unavailable) and,
 * when data is present, the content with its age. Data stays on screen when a refresh fails or the
 * browser goes offline; the notice above it says how old it is.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { useApp, useNow } from '../providers/AppProviders';
import { LastUpdated } from './LastUpdated';
import { StateView } from './StateView';

export interface QueryLike<T> {
  data: T | undefined;
  error: ApiError | null;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  updatedAt: Date | null;
  refetch: () => unknown;
}

export interface QueryBoundaryProps<T> {
  query: QueryLike<T>;
  label: string;
  isEmpty?: (data: T) => boolean;
  empty: { title: string; description: string; actionLabel?: string; onAction?: () => void };
  unavailableOffline?: string[];
  /** Prefix of the age line, e.g. "As of" for the Today workspace. */
  agePrefix?: string;
  children: (data: T) => ReactNode;
}

export function QueryBoundary<T>({
  query,
  label,
  isEmpty,
  empty,
  unavailableOffline,
  agePrefix,
  children,
}: QueryBoundaryProps<T>) {
  const now = useNow();
  const { online, services } = useApp();
  const retry = () => void query.refetch();

  if (query.data === undefined) {
    if (query.error) {
      const presentation = presentationForError(query.error);
      if (presentation === 'unavailable') return <StateView variant="unavailable" />;
      if (presentation === 'offline') {
        return (
          <StateView
            variant="offline-stale"
            offline
            updatedAt={null}
            now={now}
            unavailableActions={unavailableOffline}
            onRetry={retry}
          />
        );
      }
      return <StateView variant="error" error={query.error} onRetry={retry} />;
    }
    if (query.fetchStatus === 'paused' || !online) {
      return (
        <StateView
          variant="offline-stale"
          offline
          updatedAt={null}
          now={now}
          unavailableActions={unavailableOffline}
          onRetry={retry}
        />
      );
    }
    return <StateView variant="loading" label={label} />;
  }

  const threshold = services.config.staleDataThresholdMs;
  const stale =
    threshold !== null &&
    query.updatedAt !== null &&
    now.getTime() - query.updatedAt.getTime() > threshold;
  const refreshFailed = query.error !== null && presentationForError(query.error) === 'offline';
  return (
    <div>
      {!online || refreshFailed || stale ? (
        <StateView
          variant="offline-stale"
          offline={!online || refreshFailed}
          updatedAt={query.updatedAt}
          now={now}
          unavailableActions={unavailableOffline}
          onRetry={retry}
        />
      ) : (
        <LastUpdated at={query.updatedAt} now={now} prefix={agePrefix} />
      )}
      {isEmpty?.(query.data) ? <StateView variant="empty" {...empty} /> : children(query.data)}
    </div>
  );
}
