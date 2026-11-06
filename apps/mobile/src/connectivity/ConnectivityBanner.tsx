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
 *
 * Screen readers (SPK-UX-009): each banner is a polite live region, which TalkBack reads for the
 * screen in view. VoiceOver has no live regions, and every Screen renders a banner while
 * expo-router keeps visited screens mounted, so the banners post nothing to VoiceOver: the root
 * navigator's one `ConnectivityAnnouncer` announces each change of state once for the app.
 */
import { ApiError, formatAge } from '@sportspark/api-client';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { StyleSheet, Text } from 'react-native';
import { receivedAtOf } from '../api/useApiQuery';
import { useApp, useConnectivity, useNow } from '../providers/AppProviders';
import { LiveRegion, sentences, useAnnouncement } from '../ui/announce';
import { Button } from '../ui/Button';
import { StatusBadge } from '../ui/StatusBadge';
import { colors, radius, spacing, toneBackgrounds, type } from '../ui/theme';

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

/** What the banner says, most serious first (see the header); null when it is hidden. */
export type ConnectivityNotice =
  | { kind: 'offline'; age: string | null }
  | { kind: 'reconnecting' }
  | { kind: 'degraded'; failure: string; age: string | null }
  | { kind: 'refreshed'; refreshedAt: number }
  | { kind: 'stale'; age: string | null }
  | null;

/**
 * The banner's state. Every banner (one per Screen) and the app's one `ConnectivityAnnouncer`
 * compute it from the same connectivity, cache and clock, so they agree.
 */
export function useConnectivityNotice(): { notice: ConnectivityNotice; now: Date } {
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
  const threshold = services.config.staleDataThresholdMs;
  const notice: ConnectivityNotice =
    reachable === false
      ? { kind: 'offline', age }
      : reconnecting
        ? { kind: 'reconnecting' }
        : failure
          ? { kind: 'degraded', failure, age }
          : refreshedAt !== null && now.getTime() - refreshedAt < REFRESHED_NOTICE_MS
            ? { kind: 'refreshed', refreshedAt }
            : threshold !== null && oldest !== null && now.getTime() - oldest > threshold
              ? { kind: 'stale', age }
              : null;
  return { notice, now };
}

/**
 * What VoiceOver hears for a notice: the visible words, without the age that changes while it is
 * shown. The error code of a degraded refresh is kept: it is fixed while shown and is what the
 * person reads out to support.
 */
export function connectivityAnnouncement(notice: ConnectivityNotice): string | null {
  switch (notice?.kind) {
    case 'offline':
      return sentences(
        'You are offline',
        `Needs a connection: ${OFFLINE_UNAVAILABLE_ACTIONS.join(', ')}`,
      );
    case 'reconnecting':
      return 'Back online. Refreshing';
    case 'degraded':
      return sentences(
        'Some information could not be refreshed',
        `The service did not answer (error code ${notice.failure}). Actions that need the service may fail until it does`,
        'Try again',
      );
    case 'refreshed':
      return 'Back online. Information updated';
    case 'stale':
      return sentences('Some information may be out of date', 'Refresh');
    default:
      return null;
  }
}

/**
 * The connectivity announcement for VoiceOver, made once for the app (SPK-UX-009). Every Screen
 * renders its own banner and expo-router keeps visited screens mounted, so the banners are live
 * regions for TalkBack only (TalkBack reads the one on screen) and this, rendered once by the root
 * navigator, is what VoiceOver hears when the state changes.
 */
export function ConnectivityAnnouncer() {
  const { notice } = useConnectivityNotice();
  useAnnouncement(connectivityAnnouncement(notice));
  return null;
}

export function ConnectivityBanner() {
  const { notice, now } = useConnectivityNotice();
  const queryClient = useQueryClient();
  const refreshNow = () => void queryClient.refetchQueries({ type: 'active' });
  // On iOS the words are announced once for the app by ConnectivityAnnouncer, not per banner.
  const ANNOUNCED_BY_ROOT = null;

  if (notice === null) return null;
  switch (notice.kind) {
    case 'offline':
      return (
        <LiveRegion
          style={styles.banner}
          accessibilityRole="alert"
          announcement={ANNOUNCED_BY_ROOT}
          testID="connectivity-banner"
        >
          <StatusBadge tone="warning" label="You are offline" />
          <Text style={styles.text}>
            {notice.age
              ? `Showing information from ${notice.age}.`
              : 'Nothing has been loaded yet.'}{' '}
            Needs a connection: {OFFLINE_UNAVAILABLE_ACTIONS.join(', ')}.
          </Text>
        </LiveRegion>
      );
    case 'reconnecting':
      return (
        <LiveRegion
          style={styles.banner}
          announcement={ANNOUNCED_BY_ROOT}
          testID="connectivity-banner"
        >
          <StatusBadge tone="info" label="Back online. Refreshing" />
        </LiveRegion>
      );
    case 'degraded':
      return (
        <LiveRegion
          style={styles.banner}
          accessibilityRole="alert"
          announcement={ANNOUNCED_BY_ROOT}
          testID="connectivity-banner"
        >
          <StatusBadge tone="warning" label="Some information could not be refreshed" />
          <Text style={styles.text}>
            {notice.age ? `Showing information from ${notice.age}. ` : ''}The service did not answer
            (error code {notice.failure}). Actions that need the service may fail until it does.
          </Text>
          <Button label="Try again" variant="secondary" onPress={refreshNow} />
        </LiveRegion>
      );
    case 'refreshed':
      return (
        <LiveRegion
          style={styles.banner}
          announcement={ANNOUNCED_BY_ROOT}
          testID="connectivity-banner"
        >
          <StatusBadge
            tone="success"
            label={`Back online. Updated ${formatAge(notice.refreshedAt, now)}`}
          />
        </LiveRegion>
      );
    case 'stale':
      return (
        <LiveRegion
          style={styles.banner}
          announcement={ANNOUNCED_BY_ROOT}
          testID="connectivity-banner"
        >
          <StatusBadge tone="warning" label="Some information may be out of date" />
          <Text style={styles.text}>Updated {notice.age}.</Text>
          <Button label="Refresh" variant="secondary" onPress={refreshNow} />
        </LiveRegion>
      );
  }
}

const styles = StyleSheet.create({
  banner: {
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: 14,
    gap: spacing.xs,
    backgroundColor: toneBackgrounds.warning,
    borderWidth: 1,
    borderColor: colors.warningBorder,
    borderRadius: radius.md,
  },
  text: { ...type.caption, color: colors.text },
});
