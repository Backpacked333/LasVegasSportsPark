/**
 * SecretWithheld: the IDEMPOTENCY_SECRET_WITHHELD answer (§4.9, §4.14, SPK-UX-008) on the create
 * commands whose response carries a one-time link: family invitations (`POST /v1/invitations`),
 * team invitations (`POST /v1/team-entries/{id}/invitations`) and calendar feeds
 * (`POST /v1/me/calendar-feeds`).
 *
 * The answer comes when "Check again" repeats a create under the same key after the first answer
 * was lost: the record was created (`details.resourceId`), but its link is returned only in the
 * original response and is never stored, so it cannot be shown again. It is never shown as a
 * failure. The lists that show the record are read again (they are otherwise refreshed only after
 * a success), and "Revoke and issue a new link" revokes the record nobody holds a link for and
 * then creates the same request again under a new key (next action `revoke_and_reissue`):
 *
 * - the revoke succeeds, or the API answers that the record is already revoked or expired: the
 *   create is sent again (`onReissue`), and its outcome is shown by the screen as usual;
 * - the revoke gets no definite answer: "Check again" repeats the revoke under its own same key;
 *   nothing is created until it is known to be revoked, so two usable links never exist;
 * - the record was already accepted or declined: nothing is created again; the state is named and
 *   the list shows it;
 * - the API did not name the record: the list is the place to revoke it.
 */
import type { ApiError } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { mayHaveTakenEffect, secretWithheldOf } from '../api/command-outcome';
import { useApiCommand } from '../api/useApiCommand';
import { useConnectivity } from '../providers/AppProviders';
import { Button } from './Button';
import { StateView } from './StateView';
import { StatusBadge } from './StatusBadge';
import { colors, spacing, type } from './theme';

/** The revoke commands of the records whose create withholds a one-time link. */
export type WithheldRevokePath =
  '/invitations/{id}/revoke' | '/team-invitations/{id}/revoke' | '/me/calendar-feeds/{id}/revoke';

/** States after which the withheld record can no longer be used, so issuing a new one is safe. */
const NO_LONGER_USABLE: ReadonlySet<string> = new Set(['revoked', 'expired']);

function transitionFrom(error: ApiError): string | null {
  if (error.code !== 'INVALID_TRANSITION') return null;
  const from = (error.details as { from?: unknown } | null | undefined)?.from;
  return typeof from === 'string' ? from : null;
}

export interface SecretWithheldProps {
  /** The IDEMPOTENCY_SECRET_WITHHELD answer of the create command. */
  error: ApiError;
  /** What was created, for the wording: "invitation", "calendar feed". */
  what: string;
  /** Where the record is listed, e.g. "Invitations you sent". */
  listName: string;
  revokePath: WithheldRevokePath;
  /** The audit reason sent with the revoke, when the command takes one. */
  revokeReason?: string;
  /** Queries that list the record: read again now and after the revoke. */
  invalidate: readonly (readonly unknown[])[];
  /** Sends the same create again; the screen's intent has ended, so it gets a new key. */
  onReissue: () => unknown;
  testID?: string;
}

export function SecretWithheld({
  error,
  what,
  listName,
  revokePath,
  revokeReason,
  invalidate,
  onReissue,
  testID = 'secret-withheld',
}: SecretWithheldProps) {
  const queryClient = useQueryClient();
  const { reachable } = useConnectivity();
  const resourceId = secretWithheldOf(error)?.resourceId ?? null;
  const revoke = useApiCommand('post', revokePath, { invalidate });
  // The lists are fixed for the component's life (a literal at every call site).
  const lists = useRef(invalidate);

  useEffect(() => {
    // The record was created although no success reached this device: show it in its list. Once
    // per answer.
    for (const queryKey of lists.current) void queryClient.invalidateQueries({ queryKey });
  }, [error, queryClient]);

  const reissue = async () => {
    if (!resourceId) return;
    try {
      await revoke.submit({
        path: { id: resourceId },
        body: revokeReason ? { reason: revokeReason } : {},
      });
    } catch (failure) {
      const from = transitionFrom(failure as ApiError);
      // Already revoked or expired (on another device, or from the list): its link is dead.
      if (from === null || !NO_LONGER_USABLE.has(from)) return;
    }
    onReissue();
  };

  const answered = revoke.error ? transitionFrom(revoke.error) : null;
  // Accepted or declined already: the record was used, so nothing is issued again.
  const used = answered !== null && !NO_LONGER_USABLE.has(answered);
  // Revoked or expired already: the create is being sent again; nothing to show for the revoke.
  const revokeError = answered !== null && !used ? null : revoke.error;

  return (
    <View style={styles.box} accessibilityLiveRegion="polite" testID={testID}>
      <StatusBadge tone="warning" label="Created, but the link cannot be shown again" />
      <Text style={styles.body}>
        {`Your earlier request went through: the ${what} was created. Its one-time link is shown only in the first answer, which did not reach this device, so it cannot be shown again.`}
      </Text>
      <Text style={styles.caption} selectable>
        {`Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`}
      </Text>
      {used ? (
        <Text style={styles.body} testID={`${testID}-used`}>
          {`It can no longer be revoked: it was ${answered} already. Its state is shown under "${listName}". Nothing new was created.`}
        </Text>
      ) : resourceId ? (
        <>
          <Text style={styles.body}>
            {`Revoke it and issue a new link: the first link stops working and a new ${what} is created for you to share.`}
          </Text>
          <Button
            label={
              revokeError && mayHaveTakenEffect(revokeError)
                ? 'Check again'
                : 'Revoke and issue a new link'
            }
            onPress={() => void reissue()}
            busy={revoke.isProcessing}
            disabled={reachable === false}
            accessibilityHint={`Revokes the ${what} that was created, then creates a new one`}
          />
        </>
      ) : (
        <Text style={styles.body}>
          {`Find it under "${listName}" and revoke it there, then create a new one.`}
        </Text>
      )}
      {revokeError && !used ? (
        mayHaveTakenEffect(revokeError) ? (
          <View style={styles.inner} testID={`${testID}-revoke-unknown`}>
            <StatusBadge tone="warning" label="No answer yet: the revoke may already be recorded" />
            <Text style={styles.body}>
              {`Nothing new is created until the first ${what} is known to be revoked. Checking again is safe: it cannot revoke twice.`}
            </Text>
            <Text style={styles.caption}>{`Error code: ${revokeError.code}`}</Text>
          </View>
        ) : revokeError.isNotFound || revokeError.isPermissionRestriction ? (
          <StateView variant="unavailable" />
        ) : (
          <StateView variant="error" error={revokeError} onRetry={() => void reissue()} />
        )
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { padding: spacing.lg, gap: spacing.md, alignItems: 'flex-start' },
  inner: { gap: spacing.sm },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
