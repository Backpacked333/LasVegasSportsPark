/**
 * Connectivity and stale-data banner for the dashboard and the workspace (SPK-UX-008 offline,
 * SCR-W-10, §4.15 "Show cached-data age prominently"): offline with the age of what is shown and
 * the actions that need a connection; stale only when a threshold is configured (pending
 * DEC-032/DEC-033). Queued offline observations (§4.15) belong to the arrival and attendance
 * screens and are not offered here.
 */
import { formatAge } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { receivedAtOf } from '../api/useApiQuery';
import { useApp, useNow } from '../providers/AppProviders';
import { StatusBadge } from '../ui/StatusBadge';

/** Nothing that commits capacity, money, guardianship, rosters or pickup authority runs offline (§4.15). */
export const OFFLINE_UNAVAILABLE_ACTIONS = [
  'assignment acceptance',
  'pickup authorisation',
  'payments and refunds',
  'registrations and roster changes',
];

function useOldestShownData(): number | null {
  const cache = useQueryClient().getQueryCache();
  return useSyncExternalStore(
    (onChange) => cache.subscribe(onChange),
    () => {
      let oldest: number | null = null;
      for (const q of cache.findAll({ type: 'active' })) {
        const at = receivedAtOf(q);
        if (at !== null && (oldest === null || at < oldest)) oldest = at;
      }
      return oldest;
    },
  );
}

export function ConnectivityBanner() {
  const { online, services } = useApp();
  const now = useNow(15_000);
  const oldest = useOldestShownData();
  const age = oldest !== null ? formatAge(oldest, now) : null;

  if (!online) {
    return (
      <div className="banner" role="alert" data-testid="connectivity-banner">
        <StatusBadge tone="warning" label="You are offline" />
        <span>
          {age ? `Showing information from ${age}.` : 'Nothing has been loaded yet.'} Needs a
          connection: {OFFLINE_UNAVAILABLE_ACTIONS.join(', ')}.
        </span>
      </div>
    );
  }
  const threshold = services.config.staleDataThresholdMs;
  if (threshold !== null && oldest !== null && now.getTime() - oldest > threshold) {
    return (
      <div className="banner" aria-live="polite" data-testid="connectivity-banner">
        <StatusBadge tone="warning" label="Some information may be out of date" />
        <span>Updated {age}.</span>
      </div>
    );
  }
  return null;
}
