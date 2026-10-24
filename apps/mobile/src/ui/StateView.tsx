/**
 * StateView: the SPK-UX-008 states a screen shows instead of (or above) its content, as defined in
 * docs/package-a/screen-and-journey-inventory.md section 3.
 *
 * - loading: data requested, not yet received.
 * - empty: request succeeded with nothing in scope; says what would appear and how to create it.
 * - error: the API's error code, safe message, correlation reference and the recovery action.
 * - offline-stale: no connection or old data; shows the age of what is shown and what is unavailable.
 * - unavailable: protected NOT_FOUND or a permission restriction; never implies the record exists.
 * - pending-decision: the screen or value waits on an operator decision (DEC-###); nothing invented.
 *
 * Every variant is announced politely to screen readers and carries text, never colour alone.
 */
import { formatAge, recoveryActionFor, type ApiError } from '@sportspark/api-client';
import type { ReactNode } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { Button } from './Button';
import { StatusBadge } from './StatusBadge';
import { colors, spacing, type } from './theme';

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
    };

export function StateView(props: StateViewProps) {
  return (
    <View
      style={styles.container}
      accessibilityLiveRegion="polite"
      testID={`state-${props.variant}`}
    >
      {renderBody(props)}
    </View>
  );
}

function renderBody(props: StateViewProps): ReactNode {
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
          <Text style={styles.caption} selectable>
            Error code: {props.error.code}
            {props.error.correlationId ? `. Reference: ${props.error.correlationId}` : ''}
          </Text>
          {onPress ? (
            <Button label={recovery.label} onPress={onPress} />
          ) : (
            <Text style={styles.body}>{recovery.label}</Text>
          )}
        </>
      );
    }
    case 'offline-stale': {
      const age = props.updatedAt ? formatAge(props.updatedAt, props.now) : null;
      return (
        <>
          <StatusBadge
            tone="warning"
            label={props.offline ? 'You are offline' : 'This information may be out of date'}
          />
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
          <Text style={styles.body}>
            {props.description ??
              'This is not available. Check the link, or contact the front desk if you expected to see something here.'}
          </Text>
          {props.actionLabel && props.onAction ? (
            <Button label={props.actionLabel} onPress={props.onAction} variant="secondary" />
          ) : null}
        </>
      );
    case 'pending-decision':
      return (
        <>
          <StatusBadge tone="pending" label="Waiting on a decision" />
          <Text style={styles.body}>
            {props.subject} is not available yet: it depends on {props.decisions.join(', ')}, which
            {props.decisions.length === 1 ? ' has' : ' have'} not been decided
            {props.owner ? ` (owner: ${props.owner})` : ''}.
          </Text>
        </>
      );
  }
}

const styles = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  title: { ...type.heading, color: colors.text },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
