/**
 * What the money screens (SCR-C-34, SCR-C-35 and the Package G money screens) share on top of the
 * visual system v2 in `src/ui` (ADR-008; PA-11 customer words):
 *
 * - `MoneyEmpty`: an empty list with the `empty-payments` illustration (`ui/EmptyState`), its
 *   title a header, and the same words announced to VoiceOver when it appears as the
 *   `StateView` empty state announces them (SPK-UX-008, SPK-UX-009; TalkBack reads the live
 *   region). Screens give `QueryBoundary` no `isEmpty` and render this for an empty page, so the
 *   loading, error, offline and "not available" states stay the boundary's.
 * - `PAY_AT_DESK_MESSAGE`: what paying in the app says while the payment provider is not
 *   selected (DEC-019, Technical lead/account owners): "Pay at the front desk for now." The
 *   decision stays in the "Details for support" fold.
 * - `usePullToRefresh`: pull to refresh for a money screen: every read on the page again, as the
 *   connectivity banner's "Refresh" does (`refetchQueries({ type: 'active' })`).
 * - `Actions`: a row of buttons that wraps as text grows.
 * - `Choices`: a radio group of `ChoiceCard`s with the shared spacing, named for screen readers.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { pendingMessage } from '../../copy/pending';
import { illustrations } from '../../artwork/manifest';
import { LiveRegion, sentences } from '../../ui/announce';
import { EmptyState } from '../../ui/EmptyState';
import { makeStyles, spacing } from '../../ui/theme';

/** DEC-019 (PA-11): paying in the app waits on the payment provider; what to do instead. */
export const PAY_AT_DESK_MESSAGE = `Paying in the app isn't available yet. ${pendingMessage('DEC-019')}`;

/** The decision and its owner for the "Details for support" fold of every pay-at-desk notice. */
export const PAY_AT_DESK_SUPPORT = {
  decisions: ['DEC-019'],
  owner: 'Technical lead/account owners',
} as const;

export function MoneyEmpty({
  title,
  message,
  action,
  testID,
}: {
  title: string;
  message: string;
  action?: { label: string; onPress: () => void };
  testID?: string;
}) {
  return (
    <LiveRegion announcement={sentences(title, message, action?.label)} testID={testID}>
      <EmptyState
        source={illustrations['empty-payments']}
        title={title}
        message={message}
        action={action}
      />
    </LiveRegion>
  );
}

export function usePullToRefresh(): { refreshing: boolean; onRefresh: () => void } {
  const queryClient = useQueryClient();
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = () => {
    setRefreshing(true);
    void queryClient.refetchQueries({ type: 'active' }).finally(() => setRefreshing(false));
  };
  return { refreshing, onRefresh };
}

export function Actions({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.actions}>{children}</View>;
}

export function Choices({ label, children }: { label: string; children: ReactNode }) {
  const styles = useStyles();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
      {children}
    </View>
  );
}

const useStyles = makeStyles(() => ({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  choices: { gap: spacing.sm },
}));
