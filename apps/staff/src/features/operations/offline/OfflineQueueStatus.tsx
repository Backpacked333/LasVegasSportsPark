/**
 * SCR-W-10 workspace connectivity state, also shown on the arrival screens (§4.15, SPK-UX-008,
 * SPK-AT-018): how many observations are queued on this device, whether they are being
 * synchronised, the outcome of the last synchronisation ("Synchronised at <time>", "<n>
 * synchronised, <m> for review") and a way to synchronise now. A queued observation is never
 * presented as recorded.
 */
import { formatAge } from '@sportspark/api-client';
import { Link } from 'react-router';
import { useApp, useNow } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { StatusBadge } from '../../../ui/StatusBadge';
import { CommandError } from '../feedback';
import { formatInstant } from '../format';
import { useOfflineQueue } from './OfflineQueueProvider';

export function OfflineQueueStatus({ reviewPath = '/arrival/offline' }: { reviewPath?: string }) {
  const queue = useOfflineQueue();
  const { online } = useApp();
  const now = useNow(15_000);
  const { mine, others, state, syncing, syncError } = queue;
  const lastSync = state.lastSync;
  const forReview = state.review.length;
  if (mine.length === 0 && others.length === 0 && forReview === 0 && !lastSync && !syncError) {
    return null;
  }
  const oldest = mine.reduce<string | null>(
    (min, q) => (min === null || q.queuedAt < min ? q.queuedAt : min),
    null,
  );
  return (
    <section className="ops-queue" aria-label="Offline queue" data-testid="offline-queue-status">
      {syncing ? (
        <StatusBadge tone="pending" label="Synchronising" />
      ) : mine.length > 0 ? (
        <StatusBadge
          tone="warning"
          label={`${mine.length} observation${mine.length === 1 ? '' : 's'} queued on this device (not yet recorded)`}
        />
      ) : null}
      {oldest ? (
        <span className="caption">Oldest queued {formatAge(new Date(oldest), now)}.</span>
      ) : null}
      {others.length > 0 ? (
        <span className="caption">
          {others.length} queued by another account on this device: they are synchronised when that
          account signs in here.
        </span>
      ) : null}
      {lastSync ? (
        <span className="caption" data-testid="last-sync">
          Synchronised at {formatInstant(lastSync.at)}: {lastSync.synchronised} synchronised
          {lastSync.duplicates > 0 ? `, ${lastSync.duplicates} already recorded` : ''},{' '}
          {lastSync.conflicts + lastSync.rejected} for review.
        </span>
      ) : null}
      {forReview > 0 ? (
        <Link to={reviewPath}>
          Review {forReview} kept observation{forReview === 1 ? '' : 's'}
        </Link>
      ) : null}
      {mine.length > 0 && online ? (
        <Button variant="secondary" busy={syncing} onClick={() => void queue.sync()}>
          Synchronise now
        </Button>
      ) : null}
      {mine.length > 0 && !online ? (
        <span className="caption">Synchronises once when the connection returns.</span>
      ) : null}
      {syncError ? <CommandError error={syncError} onRetry={() => void queue.sync()} /> : null}
    </section>
  );
}
