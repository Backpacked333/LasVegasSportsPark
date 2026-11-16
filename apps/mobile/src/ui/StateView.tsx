/**
 * StateView: the SPK-UX-008 states a screen shows instead of (or above) its content, as defined in
 * docs/package-a/screen-and-journey-inventory.md section 3.
 *
 * - loading: data requested, not yet received.
 * - empty: request succeeded with nothing in scope; says what would appear and how to create it.
 * - error: the API's safe message and the recovery action; its error code and correlation
 *   reference are in the "Details for support" fold.
 * - offline-stale: no connection or old data; shows the age of what is shown and what is unavailable.
 * - unavailable: protected NOT_FOUND or a permission restriction; never implies the record exists.
 * - pending-decision: the screen or value waits on an operator decision (DEC-###); nothing invented.
 *   It says in plain words what the customer can do instead (`message`, e.g. "Pay at the front
 *   desk for now."), with an optional `action`; without a message it says only "This isn't
 *   available in the app yet." The decisions and their owner are in the support fold.
 * - turned-off: a conditional capability the organization has switched off (K-12): "This isn't
 *   available right now.", with the decisions that may turn it on (DEC-016 and its own record) and
 *   the refused command's code in the support fold. An `error` that is the API's ACCESS_DENIED
 *   `CAPABILITY_DISABLED` answer renders this state too, so every screen shows it the same way,
 *   never as "not available" or a failure.
 *
 * Codes live only in the fold (PA-11, SPK-UX-011 **Proposed**; §4.10 requires them to be
 * available, not prominent): decision identifiers, owners, error codes and correlation references
 * are in a collapsed "Details for support" area (`SupportDetails`) that the customer opens on
 * purpose, never in the visible sentence.
 *
 * Every variant carries text, never colour alone. On Android the view is a polite live region, so
 * TalkBack reads each variant as it appears or changes. iOS has no live regions, so the variants
 * that report an answer (error, empty, offline-stale, unavailable, turned-off) are announced to
 * VoiceOver when they appear (`ui/announce`), with the visible words and the next action (NA-A01:
 * an error's recovery, "Try again"), but not the error code or a data age that changes while
 * shown. "You are offline" while the device is offline is left to the connectivity announcement,
 * which VoiceOver hears once for the app (ConnectivityAnnouncer); a read that got no answer while
 * the device is online is announced here. Loading (exposed as a busy progress indicator) and
 * pending-decision (fixed wording that answers nothing) are not announced on iOS.
 */
import {
  formatAge,
  recoveryActionFor,
  turnedOffFromError,
  turnedOffLabel,
  type ApiError,
} from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useConnectivity } from '../providers/AppProviders';
import { LiveRegion, sentences } from './announce';
import { Button } from './Button';
import { Icon } from './Icon';
import { InfoCard } from './InfoCard';
import { useRowLayout } from './ListRow';
import { StatusBadge } from './StatusBadge';
import { SupportDetails } from './SupportDetails';
import { continuousCorners, makeStyles, radius, spacing, type, useTheme } from './theme';

interface ActionProps {
  /** Label of the recovery or creation action. */
  actionLabel?: string;
  onAction?: () => void;
}

export type StateViewProps =
  | { variant: 'loading'; label: string }
  | ({ variant: 'empty'; title: string; description: string } & ActionProps)
  | { variant: 'error'; error: ApiError; onRetry?: () => void; onAction?: () => void }
  | {
      variant: 'offline-stale';
      /** When the shown data was received; null when nothing is cached. */
      updatedAt: Date | null;
      now: Date;
      /** True when the device is offline; false when online but the data is old. */
      offline: boolean;
      /** Actions that need a connection, e.g. "Registration", "Payment", "RSVP". */
      unavailableActions?: string[];
      onRetry?: () => void;
    }
  | ({ variant: 'unavailable'; title?: string; description?: string } & ActionProps)
  | {
      variant: 'pending-decision';
      /** What waits, e.g. "Account sign-in". */
      subject: string;
      /** DEC-### identifiers from docs/package-a/decision-register.md. */
      decisions: string[];
      /** Owner wording from the decision register, when known. */
      owner?: string;
      /**
       * What the customer can do instead, in plain words ("Pay at the front desk for now.").
       * Optional for now; without it the state says "This isn't available in the app yet."
       */
      message?: string;
      /** A way forward the app can offer ("Call the front desk"). */
      action?: { label: string; onPress: () => void };
    }
  | {
      variant: 'turned-off';
      /** What is turned off, e.g. "Rentals" (CAPABILITY_PRESENTATION labels). */
      subject: string;
      /** The decisions that may turn it on (DEC-016 and the capability's own record). */
      decisions: readonly string[];
      owner?: string;
      /** For a screen of existing records the API keeps available while the switch is off. */
      stillAvailable?: string;
      /** The refused command, when this state answers one (code and reference for support). */
      error?: ApiError;
    };

export function StateView(props: StateViewProps) {
  const { colors, toneBackgrounds } = useTheme();
  const styles = useStyles();
  const { reachable } = useConnectivity();
  // A command refused because its capability is turned off is not a failure (K-12, DEC-016).
  const turnedOff = props.variant === 'error' ? turnedOffFromError(props.error) : null;
  const shown: StateViewProps =
    turnedOff && props.variant === 'error'
      ? {
          variant: 'turned-off',
          subject: turnedOff.label,
          decisions: turnedOff.decisions,
          owner: turnedOff.owner,
          error: props.error,
        }
      : props;
  const tile = VARIANT_TILES[shown.variant];
  // Inside a card frame (a feature Section) the state is drawn flat, without a card of its own.
  const flat = useRowLayout() === 'flat';
  return (
    <LiveRegion
      style={
        shown.variant === 'loading'
          ? [styles.loading, flat && styles.flatLoading]
          : shown.variant === 'pending-decision'
            ? // The InfoCard is the frame: no card around it.
              [styles.pendingFrame, flat && styles.flatPending]
            : [styles.container, flat && styles.flat]
      }
      announcement={announcementFor(shown, reachable === false)}
      occurrence={shown.variant === 'error' || shown.variant === 'turned-off' ? shown.error : null}
      testID={`state-${shown.variant}`}
    >
      {tile ? (
        <View
          style={[
            styles.tile,
            {
              backgroundColor:
                tile.tone === 'accent' ? colors.floodlight : toneBackgrounds[tile.tone],
            },
          ]}
        >
          <Icon
            name={tile.icon}
            size={22}
            color={tile.tone === 'accent' ? colors.onFloodlight : colors[tile.tone]}
          />
        </View>
      ) : null}
      <StateBody state={shown} />
      {shown.variant === 'loading' && !flat ? <LoadingOutline /> : null}
    </LiveRegion>
  );
}

/**
 * Decorative outline of the content that is loading: two soft bars under the progress line, so the
 * page keeps its shape while it waits (SPK-UX-010 clear hierarchy). Static (no shimmer: restrained
 * animation, nothing moves for people who turned motion off) and hidden from screen readers, who
 * hear the progress indicator.
 */
function LoadingOutline() {
  const styles = useStyles();
  return (
    <View
      style={styles.outline}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="state-loading-outline"
    >
      <View style={[styles.outlineBar, styles.outlineBarWide]} />
      <View style={[styles.outlineBar, styles.outlineBarShort]} />
    </View>
  );
}

type TileTone = 'accent' | 'danger' | 'warning' | 'neutral' | 'pending';

/** Decorative tile per state: its icon and tone. The words carry the state. */
const VARIANT_TILES: Record<StateViewProps['variant'], { icon: string; tone: TileTone } | null> = {
  loading: null,
  empty: { icon: 'sports_soccer', tone: 'accent' },
  error: { icon: 'error', tone: 'danger' },
  'offline-stale': { icon: 'cloud_off', tone: 'warning' },
  unavailable: { icon: 'lock', tone: 'neutral' },
  // The InfoCard draws its own icon.
  'pending-decision': null,
  'turned-off': { icon: 'toggle_off', tone: 'neutral' },
};

/** Pending decision without a `message`: plain words, no codes (PA-11). */
export const PENDING_DECISION_FALLBACK = "This isn't available in the app yet.";

/** What a turned-off capability says (PA-11): the decisions are in the support fold. */
export const TURNED_OFF_MESSAGE = "This isn't available right now.";

const DEFAULT_UNAVAILABLE =
  'This is not available. Check the link, or contact the front desk if you expected to see something here.';

function offlineStaleLabel(offline: boolean): string {
  return offline ? 'You are offline' : 'This information may be out of date';
}

/**
 * What VoiceOver hears when the state appears (Android reads the live region itself): the visible
 * words with the next action, without the error code or reference, and without a data age that
 * changes while shown. `deviceOffline`: the connectivity announcement already said "You are
 * offline" for the app, so the offline state does not say it again.
 */
export function announcementFor(props: StateViewProps, deviceOffline = false): string | null {
  switch (props.variant) {
    case 'loading':
    case 'pending-decision':
      return null;
    case 'empty':
      return sentences(
        props.title,
        props.description,
        props.actionLabel && props.onAction ? props.actionLabel : null,
      );
    case 'error':
      // The recovery is the button's label or, without a button, the instruction shown.
      return sentences(
        'Something went wrong',
        props.error.message,
        recoveryActionFor(props.error).label,
      );
    case 'offline-stale':
      if (props.offline && deviceOffline) return null;
      return sentences(
        offlineStaleLabel(props.offline),
        props.unavailableActions && props.unavailableActions.length > 0
          ? `Needs a connection: ${props.unavailableActions.join(', ')}`
          : null,
        props.onRetry ? 'Try again' : null,
      );
    case 'unavailable':
      return sentences(
        props.title ?? 'Not available',
        props.description ?? DEFAULT_UNAVAILABLE,
        props.actionLabel && props.onAction ? props.actionLabel : null,
      );
    case 'turned-off':
      return sentences(turnedOffLabel(props.subject), TURNED_OFF_MESSAGE, props.stillAvailable);
  }
}

function StateBody({ state: props }: { state: StateViewProps }): ReactNode {
  const { colors } = useTheme();
  const styles = useStyles();
  switch (props.variant) {
    case 'loading':
      return (
        <View
          style={styles.row}
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={`Loading ${props.label}`}
          accessibilityState={{ busy: true }}
        >
          <ActivityIndicator color={colors.primary} />
          <Text style={styles.body}>Loading {props.label}…</Text>
        </View>
      );
    case 'empty':
      return (
        <>
          <Text style={styles.title} accessibilityRole="header">
            {props.title}
          </Text>
          <Text style={styles.body}>{props.description}</Text>
          {props.actionLabel && props.onAction ? (
            <Button label={props.actionLabel} onPress={props.onAction} variant="secondary" />
          ) : null}
        </>
      );
    case 'error': {
      const recovery = recoveryActionFor(props.error);
      const onPress = recovery.retry ? props.onRetry : props.onAction;
      return (
        <>
          <StatusBadge tone="danger" label="Something went wrong" />
          <Text style={styles.body}>{props.error.message}</Text>
          {onPress ? (
            <Button label={recovery.label} onPress={onPress} />
          ) : (
            <Text style={styles.body}>{recovery.label}</Text>
          )}
          <SupportDetails errorCode={props.error.code} reference={props.error.correlationId} />
        </>
      );
    }
    case 'offline-stale': {
      const age = props.updatedAt ? formatAge(props.updatedAt, props.now) : null;
      return (
        <>
          <StatusBadge tone="warning" label={offlineStaleLabel(props.offline)} />
          <Text style={styles.body}>
            {age
              ? `Showing information from ${age}.`
              : 'Nothing has been loaded yet. Connect to see this information.'}
          </Text>
          {props.unavailableActions && props.unavailableActions.length > 0 ? (
            <Text style={styles.caption}>
              Needs a connection: {props.unavailableActions.join(', ')}.
            </Text>
          ) : null}
          {props.onRetry ? (
            <Button label="Try again" onPress={props.onRetry} variant="secondary" />
          ) : null}
        </>
      );
    }
    case 'unavailable':
      return (
        <>
          <StatusBadge tone="neutral" label={props.title ?? 'Not available'} />
          <Text style={styles.body}>{props.description ?? DEFAULT_UNAVAILABLE}</Text>
          {props.actionLabel && props.onAction ? (
            <Button label={props.actionLabel} onPress={props.onAction} variant="secondary" />
          ) : null}
        </>
      );
    case 'pending-decision':
      return (
        <InfoCard
          tone="info"
          icon="schedule"
          title={props.subject}
          message={props.message ?? PENDING_DECISION_FALLBACK}
          action={props.action}
          style={styles.pending}
        >
          <SupportDetails decisions={props.decisions} owner={props.owner} />
        </InfoCard>
      );
    case 'turned-off':
      return (
        <>
          <StatusBadge tone="neutral" label={turnedOffLabel(props.subject)} />
          <Text style={styles.body}>{TURNED_OFF_MESSAGE}</Text>
          {props.stillAvailable ? <Text style={styles.body}>{props.stillAvailable}</Text> : null}
          <SupportDetails
            decisions={props.decisions}
            owner={props.owner}
            errorCode={props.error ? `${props.error.code} (CAPABILITY_DISABLED)` : undefined}
            reference={props.error?.correlationId}
          />
        </>
      );
  }
}

const useStyles = makeStyles(({ colors }) => ({
  container: {
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    padding: spacing.lg,
    gap: spacing.md,
    alignItems: 'flex-start',
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    ...continuousCorners,
    borderWidth: 1,
    borderColor: colors.border,
  },
  flat: {
    marginHorizontal: 0,
    paddingHorizontal: 0,
    backgroundColor: 'transparent',
    borderWidth: 0,
  },
  pendingFrame: { marginHorizontal: spacing.lg, marginVertical: spacing.sm },
  flatPending: { marginHorizontal: 0 },
  pending: { alignSelf: 'stretch' },
  loading: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.md },
  flatLoading: { paddingHorizontal: 0 },
  outline: { gap: spacing.sm },
  outlineBar: { height: 14, borderRadius: radius.pill, backgroundColor: colors.skeleton },
  outlineBarWide: { width: '72%' },
  outlineBarShort: { width: '44%' },
  tile: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    ...continuousCorners,
    alignItems: 'center',
    justifyContent: 'center',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { ...type.title, fontSize: 22, lineHeight: 24, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
}));
