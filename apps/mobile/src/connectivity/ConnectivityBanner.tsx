/**
 * SCR-C-40 Connectivity and stale-data banner (SPK-UX-001 "Clear connectivity and stale-data
 * states", SPK-UX-008, §4.15 "Show cached-data age prominently", §6.2 "Poor connectivity").
 *
 * States: ready (online, fresh: hidden); offline (age of what is shown, actions that need a
 * connection); stale (online, shown data older than the configured threshold, which is pending
 * DEC-032/DEC-033 and absent by default); processing (refreshing after reconnecting or returning
 * to the app). Recovery of an interrupted payment is the checkout screens' job (SCR-C-15): they
 * refetch their operation on foreground through the same query layer.
 */
import { formatAge } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { receivedAtOf } from '../api/useApiQuery';
import { useApp, useConnectivity, useNow } from '../providers/AppProviders';
import { StatusBadge } from '../ui/StatusBadge';
import { colors, spacing, type } from '../ui/theme';

/** Actions the customer app never performs offline (§4.15: no payments, no capacity commitments). */
export const OFFLINE_UNAVAILABLE_ACTIONS = ['registration', 'payment', 'RSVP', 'account changes'];

/** Receipt time of the oldest data currently on screen (queries with observers). */
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
  const { reachable } = useConnectivity();
  const { services } = useApp();
  const now = useNow(15_000);
  const oldest = useOldestShownData();
  const queryClient = useQueryClient();
  const wasOffline = useRef(false);
  const [reconnecting, setReconnecting] = useState(false);

  useEffect(() => {
    if (reachable === false) wasOffline.current = true;
    else if (reachable === true && wasOffline.current) {
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
      if (queryClient.isFetching() === 0) setReconnecting(false);
    };
    const unsubscribe = queryClient.getQueryCache().subscribe(check);
    const id = setTimeout(check, 0);
    return () => {
      unsubscribe();
      clearTimeout(id);
    };
  }, [reconnecting, queryClient]);

  const age = oldest !== null ? formatAge(oldest, now) : null;

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

  const threshold = services.config.staleDataThresholdMs;
  if (threshold !== null && oldest !== null && now.getTime() - oldest > threshold) {
    return (
      <View style={styles.banner} accessibilityLiveRegion="polite" testID="connectivity-banner">
        <StatusBadge tone="warning" label="Some information may be out of date" />
        <Text style={styles.text}>Updated {age}.</Text>
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
