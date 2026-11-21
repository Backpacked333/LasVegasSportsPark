/**
 * OfflineBanner (redesign handoff "Offline"): the amber banner with the time of the last good data.
 * Reads show cached data; writes are disabled with a reason, except check-ins and attendance,
 * which queue on the device and show their count (`queued`). Glyph + words, never colour alone.
 * The shell's `ConnectivityBanner` is this banner for the whole dashboard; a screen with its own
 * offline story (the arrival desk queue) can show it in place.
 */
import type { ReactNode } from 'react';
import { StatusBadge } from './StatusBadge';
import './primitives.css';

export function OfflineBanner({
  title = 'You are offline',
  lastGood,
  children,
  queued,
  testId = 'offline-banner',
}: {
  title?: string;
  /** "Showing what loaded at 8:41 AM", already in the facility's time zone; null: nothing yet. */
  lastGood: string | null;
  /** What needs a connection, or any other next step. */
  children?: ReactNode;
  /** Check-ins or attendance waiting on this device to sync. */
  queued?: { count: number; noun: string };
  testId?: string;
}) {
  return (
    <div className="banner ui-offline-banner" role="alert" data-testid={testId}>
      <StatusBadge tone="warning" label={title} />
      <span>
        {lastGood ? `Showing information from ${lastGood}.` : 'Nothing has been loaded yet.'}
        {children ? <> {children}</> : null}
      </span>
      {queued && queued.count > 0 ? (
        <span className="ui-offline-queued" data-testid="offline-queued">
          {queued.count} {queued.noun}
          {queued.count === 1 ? '' : 's'} waiting to sync
        </span>
      ) : null}
    </div>
  );
}
