/**
 * Renders a query's SPK-UX-008 state (loading, empty, error, offline or stale, unavailable) and,
 * when data is present, the content with its age. Valid data stays on screen when a refresh fails
 * or the device goes offline; the notice above it says how old it is.
 *
 * The empty state is `StateView`'s, or, when `empty.source` names an illustration (ADR-008), an
 * illustrated `EmptyState` announced with the same words (`announce`), so a screen keeps the
 * boundary's loading, error, offline and "not available" states and still draws its picture.
 */
import { presentationForError, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { useApp, useConnectivity, useNow } from '../providers/AppProviders';
import type { ArtworkSource } from './Artwork';
import { EmptyState } from './EmptyState';
import { LastUpdated } from './LastUpdated';
import { StateView } from './StateView';

export interface QueryLike<T> {
  data: T | undefined;
  error: ApiError | null;
  fetchStatus: 'fetching' | 'paused' | 'idle';
  updatedAt: Date | null;
  refetch: () => unknown;
}

/** What an empty answer shows: words, an optional action and an optional illustration. */
export interface QueryEmpty {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
  /** An illustration from the artwork manifest: the empty state is then an `EmptyState`. */
  source?: ArtworkSource;
  testID?: string;
}

/** The empty state of a boundary (`StateView`'s, or the illustrated one with `source`). */
function EmptyAnswer({ empty }: { empty: QueryEmpty }) {
  const { source, title, description, actionLabel, onAction, testID } = empty;
  if (!source) {
    return (
      <StateView
        variant="empty"
        title={title}
        description={description}
        actionLabel={actionLabel}
        onAction={onAction}
      />
    );
  }
  return (
    <EmptyState
      source={source}
      title={title}
      message={description}
      action={actionLabel && onAction ? { label: actionLabel, onPress: onAction } : undefined}
      announce
      testID={testID}
    />
  );
}

export interface QueryBoundaryProps<T> {
  query: QueryLike<T>;
  /** What is loading, for the announcement: "notifications". */
  label: string;
  isEmpty?: (data: T) => boolean;
  empty: QueryEmpty;
  /** Actions on this screen that need a connection, listed in the offline notice. */
  unavailableOffline?: string[];
  /**
   * Leave out "Updated just now" (a full-bleed page such as the activity, Register or the pass:
   * the age still shows offline or when a refresh failed).
   */
  hideUpdated?: boolean;
  children: (data: T) => ReactNode;
}

export function QueryBoundary<T>({
  query,
  label,
  isEmpty,
  empty,
  unavailableOffline,
  hideUpdated = false,
  children,
}: QueryBoundaryProps<T>) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const { services } = useApp();
  const offline = reachable === false;
  const retry = () => void query.refetch();

  // §4.10, §4.14: once the API answers NOT_FOUND or ACCESS_DENIED (access revoked, removed from a
  // roster), cached data of that record is no longer shown, even though the query keeps it.
  if (query.error && presentationForError(query.error) === 'unavailable') {
    return <StateView variant="unavailable" />;
  }
  if (query.data === undefined) {
    if (query.error) {
      return (
        <QueryErrorView
          error={query.error}
          onRetry={retry}
          unavailableOffline={unavailableOffline}
        />
      );
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
      ) : hideUpdated ? null : (
        <LastUpdated at={query.updatedAt} now={now} />
      )}
      {isEmpty?.(query.data) ? <EmptyAnswer empty={empty} /> : children(query.data)}
    </View>
  );
}

/**
 * A read that failed with nothing to show (SPK-UX-008): protected NOT_FOUND or a permission
 * restriction is "not available"; no connection is the offline state with "Try again"; anything
 * else shows the code and "Try again". Commands use their own CommandError wording instead.
 */
export function QueryErrorView({
  error,
  onRetry,
  unavailableOffline,
  unavailable,
}: {
  error: ApiError;
  onRetry: () => void;
  unavailableOffline?: string[];
  /** Words for "not available" on this screen; default: the generic wording. */
  unavailable?: { title?: string; description?: string };
}) {
  const now = useNow();
  const presentation = presentationForError(error);
  if (presentation === 'unavailable') return <StateView variant="unavailable" {...unavailable} />;
  if (presentation === 'offline') {
    return (
      <StateView
        variant="offline-stale"
        offline
        updatedAt={null}
        now={now}
        unavailableActions={unavailableOffline}
        onRetry={onRetry}
      />
    );
  }
  return <StateView variant="error" error={error} onRetry={onRetry} />;
}
