/**
 * Renders a query's SPK-UX-008 state (loading, empty, error, offline or stale, unavailable) and,
 * when data is present, the content with its age. Valid data stays on screen when a refresh fails
 * or the device goes offline; the notice above it says how old it is.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useApp, useConnectivity, useNow } from '../providers/AppProviders';
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
  /** What is loading, for the announcement: "notifications". */
  label: string;
  isEmpty?: (data: T) => boolean;
  empty: { title: string; description: string; actionLabel?: string; onAction?: () => void };
  /** Actions on this screen that need a connection, listed in the offline notice. */
  unavailableOffline?: string[];
  children: (data: T) => ReactNode;
}

export function QueryBoundary<T>({
  query,
  label,
  isEmpty,
  empty,
  unavailableOffline,
  children,
}: QueryBoundaryProps<T>) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const { services } = useApp();
  const offline = reachable === false;
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
    if (query.fetchStatus === 'paused' || offline) {
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
    <View style={{ flex: 1 }}>
      {offline || refreshFailed || stale ? (
        <StateView
          variant="offline-stale"
          offline={offline || refreshFailed}
          updatedAt={query.updatedAt}
          now={now}
          unavailableActions={unavailableOffline}
          onRetry={retry}
        />
      ) : (
        <LastUpdated at={query.updatedAt} now={now} />
      )}
      {isEmpty?.(query.data) ? <StateView variant="empty" {...empty} /> : children(query.data)}
    </View>
  );
}
