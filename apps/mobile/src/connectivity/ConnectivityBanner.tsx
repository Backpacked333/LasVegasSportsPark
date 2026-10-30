/**
 * SCR-C-40 Connectivity and stale-data banner (SPK-UX-001 "Clear connectivity and stale-data
 * states", SPK-UX-008, §4.15 "Show cached-data age prominently", §6.2 "Poor connectivity",
 * "App backgrounding during payment").
 *
 * States, most serious first:
 * - offline: the age of what is shown and the actions that need a connection (nothing is queued:
 *   no payment, registration, RSVP or account change is ever "saved for later", §4.15);
 * - processing: "Back online. Refreshing" while what is on screen refetches after reconnecting;
 * - degraded: the device is online but the service could not refresh what is shown (no response,
 *   or the API answered INTEGRATION_UNAVAILABLE, RATE_LIMITED or INTERNAL_ERROR): the age of what
 *   is shown, the error code and "Try again";
 * - success: "Back online. Updated <age>" for a minute after the refresh finished;
 * - stale: online, but shown data is older than the configured threshold. The threshold is
 *   pending DEC-032/DEC-033 and absent by default, so by default data is never called stale;
 * - ready: online and fresh, the banner is hidden.
 *
 * Foreground refresh after an interrupted registration or payment is the query layer's
 * (`focusManager` on AppState, AppProviders); a registration found in recovery on that refresh
 * (`GET /v1/me/registration-checkouts`, or the enrollment's checkout) is pinned on Home (SCR-C-03)
 * and opens the checkout outcome screen (SCR-C-15). The stale threshold stays pending (DEC-032,
 * DEC-033): unset, data age is shown but never called stale.
 */
import { ApiError, formatAge } from '@sportspark/api-client';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { receivedAtOf } from '../api/useApiQuery';
import { useApp, useConnectivity, useNow } from '../providers/AppProviders';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/StatusBadge';
import { colors, spacing, type } from '../ui/theme';

/** Actions the customer app never performs offline (§4.15: no payments, no capacity commitments). */
export const OFFLINE_UNAVAILABLE_ACTIONS = ['registration', 'payment', 'RSVP', 'account changes'];

/** How long "Back online. Updated …" stays after a reconnect refresh. */
export const REFRESHED_NOTICE_MS = 60_000;

/** Failures that mean "the service could not refresh this", not "this is not yours to see". */
export const DEGRADED_CODES: ReadonlySet<string> = new Set([
  'NETWORK_UNAVAILABLE',
  'TIMEOUT',
  'INTEGRATION_UNAVAILABLE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
]);

/** Receipt time of the oldest data currently on screen (queries with observers). */
function useOldestShownData(): number | null {
  const cache = useQueryClient().getQueryCache();
  return useSyncExternalStore(
    // Batched like TanStack's own hooks: a query created while another component renders must not
    // update the banner during that render.
    (onChange) => cache.subscribe(notifyManager.batchCalls(onChange)),
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

/** The error code of the first on-screen query whose data could not be refreshed, if any. */
function useRefreshFailure(): string | null {
  const cache = useQueryClient().getQueryCache();
  return useSyncExternalStore(
    // Batched like TanStack's own hooks: a query created while another component renders must not
    // update the banner during that render.
    (onChange) => cache.subscribe(notifyManager.batchCalls(onChange)),
    () => {
      for (const q of cache.findAll({ type: 'active' })) {
        const error = q.state.error;
        if (
          q.state.data !== undefined &&
          error instanceof ApiError &&
          DEGRADED_CODES.has(error.code)
        ) {
          return error.code;
        }
      }
      return null;
    },
  );
}

export function ConnectivityBanner() {
  const { reachable } = useConnectivity();
  const { services } = useApp();
  const now = useNow(15_000);
  const oldest = useOldestShownData();
  const failure = useRefreshFailure();
  const queryClient = useQueryClient();
  const wasOffline = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [refreshedAt, setRefreshedAt] = useState<number | null>(null);

  useEffect(() => {
    if (reachable === false) {
      wasOffline.current = true;
      setRefreshedAt(null);
    } else if (reachable === true && wasOffline.current) {
      wasOffline.current = false;
      setReconnecting(true);
    }
  }, [reachable]);

  // After reconnecting, "Refreshing" stays until no query is fetching. The refetches start when
  // the app goes back online, so the cache is watched directly rather than through a render that
  // a fast refetch could skip; with nothing to refetch the notice clears on the next tick.
  useEffect(() => {
    if (!reconnecting) return undefined;
    const check = () => {
      if (queryClient.isFetching() === 0) {
        setReconnecting(false);
        setRefreshedAt(services.now().getTime());
      }
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    const id = setTimeout(check, 0);
    return () => {
      unsubscribe();
      clearTimeout(id);
    };
  }, [reconnecting, queryClient, services]);

  const age = oldest !== null ? formatAge(oldest, now) : null;
  const refreshNow = () => void queryClient.refetchQueries({ type: 'active' });

  if (reachable === false) {
    return (
      <View
        style={styles.banner}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        testID="connectivity-banner"
      >
        <StatusBadge tone="warning" label="You are offline" />
        <Text style={styles.text}>
          {age ? `Showing information from ${age}.` : 'Nothing has been loaded yet.'} Needs a
          connection: {OFFLINE_UNAVAILABLE_ACTIONS.join(', ')}.
        </Text>
      </View>
    );
  }

  if (reconnecting) {
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite" testID="connectivity-banner">
        <StatusBadge tone="info" label="Back online. Refreshing" />
      </View>
    );
  }

  if (failure) {
    return (
      <View
        style={styles.banner}
        accessibilityRole="alert"
        accessibilityLiveRegion="polite"
        testID="connectivity-banner"
      >
        <StatusBadge tone="warning" label="Some information could not be refreshed" />
        <Text style={styles.text}>
          {age ? `Showing information from ${age}. ` : ''}The service did not answer (error code{' '}
          {failure}). Actions that need the service may fail until it does.
        </Text>
        <Button label="Try again" variant="secondary" onPress={refreshNow} />
      </View>
    );
  }

  if (refreshedAt !== null && now.getTime() - refreshedAt < REFRESHED_NOTICE_MS) {
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite" testID="connectivity-banner">
        <StatusBadge tone="success" label={`Back online. Updated ${formatAge(refreshedAt, now)}`} />
      </View>
    );
  }

  const threshold = services.config.staleDataThresholdMs;
  if (threshold !== null && oldest !== null && now.getTime() - oldest > threshold) {
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite" testID="connectivity-banner">
        <StatusBadge tone="warning" label="Some information may be out of date" />
        <Text style={styles.text}>Updated {age}.</Text>
        <Button label="Refresh" variant="secondary" onPress={refreshNow} />
      </View>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  banner: {
    padding: spacing.md,
    gap: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  text: { ...type.caption, color: colors.text },
});
