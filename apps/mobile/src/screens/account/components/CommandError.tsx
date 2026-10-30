/**
 * How a failed command is shown on the account screens (SPK-UX-008, §4.10): a protected
 * NOT_FOUND is "not available" in words chosen by the screen, never "exists but denied"; a
 * permission restriction says the person cannot do this (with the API's safe reason unless the
 * screen gives its own words); a stale record offers Reload; everything else shows the API's code,
 * safe message, reference and permitted next action. "Try again" resubmits the same intent, so the
 * idempotency key is reused (§4.9).
 *
 * An answer after which the command may have taken effect (`mayHaveTakenEffect`: a lost
 * connection or a timeout after sending, IDEMPOTENCY_IN_PROGRESS, INTERNAL_ERROR or another 5xx)
 * is never "Something went wrong": it reads "No answer yet: this may already have been recorded"
 * and "Check again" resubmits the same request under the same key, which the API answers with the
 * stored outcome or runs once. IDEMPOTENCY_OUTCOME_UNAVAILABLE (`tookEffectOutcomeLost`: an
 * earlier attempt committed, its answer lost) is "This may already have been done" with "Reload"
 * (`ui/OutcomeLost`: every API record on screen is read again), never "Something went wrong". IDEMPOTENCY_SECRET_WITHHELD is a success whose one-time link cannot be shown again:
 * screens whose create returns a link show `SecretWithheld` (with "Revoke and issue a new link");
 * here it is never called a failure either.
 */
import { recoveryActionFor, type ApiError } from '@sportspark/api-client';
import { StyleSheet, Text, View } from 'react-native';
import {
  mayHaveTakenEffect,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '../../../api/command-outcome';
import { Button } from '../../../ui/Button';
import { OutcomeLost } from '../../../ui/OutcomeLost';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { colors, spacing, type } from '../../../ui/theme';

export interface NotAvailableCopy {
  title: string;
  description: string;
  actionLabel?: string;
  onAction?: () => void;
}

export function CommandError({
  error,
  onRetry,
  onReload,
  notFound,
  denied,
}: {
  error: ApiError;
  onRetry?: () => void;
  /** For STALE_REVISION or INVALID_TRANSITION: reload the current state. */
  onReload?: () => void;
  /** Words for a protected NOT_FOUND on this screen. */
  notFound?: NotAvailableCopy;
  /** Words for ACCESS_DENIED or PARTICIPANT_AUTHORITY_REQUIRED; default: the API's safe message. */
  denied?: NotAvailableCopy;
}) {
  if (error.isNotFound) {
    return <StateView variant="unavailable" {...(notFound ?? {})} />;
  }
  if (error.isPermissionRestriction) {
    // SPK-UX-008: a denied permission is shown as not available, with the API's safe reason
    // unless the screen gives its own words. Never "Something went wrong".
    return (
      <StateView
        variant="unavailable"
        title={denied?.title ?? 'Not available to you'}
        description={denied?.description ?? error.message}
        actionLabel={denied?.actionLabel}
        onAction={denied?.onAction}
      />
    );
  }
  const reference = `Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`;
  if (secretWithheldOf(error)) {
    return (
      <View style={styles.box} accessibilityLiveRegion="polite" testID="command-secret-withheld">
        <StatusBadge tone="warning" label="Done, but the link cannot be shown again" />
        <Text style={styles.body}>{error.message}</Text>
        <Text style={styles.caption} selectable>
          {reference}
        </Text>
      </View>
    );
  }
  if (tookEffectOutcomeLost(error)) {
    return <OutcomeLost error={error} />;
  }
  if (mayHaveTakenEffect(error)) {
    const recovery = recoveryActionFor(error);
    return (
      <View style={styles.box} accessibilityLiveRegion="polite" testID="command-no-answer">
        <StatusBadge tone="warning" label="No answer yet: this may already have been recorded" />
        <Text style={styles.body}>
          There was no definite answer, so this may already have been done. Checking again is safe:
          it sends the same request, which is never applied twice.
        </Text>
        <Text style={styles.caption} selectable>
          {reference}
        </Text>
        {recovery.retry && onRetry ? (
          <Button label="Check again" onPress={onRetry} />
        ) : (
          <Text style={styles.body}>{recovery.label}</Text>
        )}
      </View>
    );
  }
  return (
    <StateView
      variant="error"
      error={error}
      onRetry={onRetry}
      onAction={error.isStale ? onReload : undefined}
    />
  );
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
