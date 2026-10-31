/**
 * SecretWithheld: the IDEMPOTENCY_SECRET_WITHHELD and IDEMPOTENCY_OUTCOME_UNAVAILABLE answers
 * (§4.9, §4.14, SPK-UX-008; `mustNotCreateAgain`) on the create commands whose response carries a
 * one-time link: family invitations (`POST /v1/invitations`), team invitations
 * (`POST /v1/team-entries/{id}/invitations`) and calendar feeds (`POST /v1/me/calendar-feeds`).
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
 * - the record was already accepted or declined: nothing is created again; the state is named,
 *   with where it now appears (`answeredShownAt`; a list of open records no longer shows it);
 * - the API did not name the record: the list is the place to revoke it.
 *
 * IDEMPOTENCY_OUTCOME_UNAVAILABLE comes when an earlier attempt under the key committed but its
 * response was never recorded: the record may exist, unnamed, and its link is lost as well. It
 * reads "This may already have been done", "Reload" reads the lists again, and the record, if it
 * is there, is revoked from its list. In both cases the screen holds back creating again; "Start a
 * new one" (`onStartOver`, offered only where the record could not be named) ends the intent once
 * the person has looked, so the next create is theirs to choose.
 */
import type { ApiError } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  mayHaveTakenEffect,
  secretWithheldOf,
  tookEffectOutcomeLost,
} from '../api/command-outcome';
import { useApiCommand } from '../api/useApiCommand';
import { useConnectivity } from '../providers/AppProviders';
import { Button } from './Button';
import { OUTCOME_LOST_LABEL } from './OutcomeLost';
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
  /** The IDEMPOTENCY_SECRET_WITHHELD or IDEMPOTENCY_OUTCOME_UNAVAILABLE answer of the create. */
  error: ApiError;
  /** What was created, for the wording: "invitation", "calendar feed". */
  what: string;
  /** Where the record is listed while it is open and can be revoked, e.g. "Invitations you sent". */
  listName: string;
  /**
   * Where a record answered meanwhile (accepted or declined) appears, as a phrase ("on the
   * team's roster"), or null where it appears nowhere. Omit when `listName` lists every state.
   */
  answeredShownAt?: (state: string) => string | null;
  revokePath: WithheldRevokePath;
  /** The audit reason sent with the revoke, when the command takes one. */
  revokeReason?: string;
  /** Queries that list the record: read again now and after the revoke. */
  invalidate: readonly (readonly unknown[])[];
  /** Sends the same create again; the screen's intent has ended, so it gets a new key. */
  onReissue: () => unknown;
  /**
   * Where the record could not be named: ends the create's intent so the form can be used again
   * (the next create gets a new key). The person is told to revoke the earlier one first.
   */
  onStartOver?: () => void;
  testID?: string;
}

export function SecretWithheld({
  error,
  what,
  listName,
  answeredShownAt,
  revokePath,
  revokeReason,
  invalidate,
  onReissue,
  onStartOver,
  testID = 'secret-withheld',
}: SecretWithheldProps) {
  const queryClient = useQueryClient();
  const { reachable } = useConnectivity();
  const lost = tookEffectOutcomeLost(error);
  const resourceId = secretWithheldOf(error)?.resourceId ?? null;
  const revoke = useApiCommand('post', revokePath, { invalidate });
  // The lists are fixed for the component's life (a literal at every call site).
  const lists = useRef(invalidate);

  useEffect(() => {
    // The record was (or may have been) created although no success reached this device: show it
    // in its list. Once per answer.
    for (const queryKey of lists.current) void queryClient.invalidateQueries({ queryKey });
  }, [error, queryClient]);
  const reloadLists = () => {
    for (const queryKey of lists.current) void queryClient.invalidateQueries({ queryKey });
  };
  // The lists that show only open records no longer show one answered meanwhile.
  const openOnly = answeredShownAt !== undefined;
  const reference = `Error code: ${error.code}${error.correlationId ? `. Reference: ${error.correlationId}` : ''}`;
  const findIt = openOnly
    ? `If it is still open, it is listed under "${listName}": revoke it there. Once it is accepted or declined it no longer appears there.`
    : `Find it under "${listName}" and revoke it there.`;
  const startOver = onStartOver ? (
    <Button
      label="Start a new one"
      variant="secondary"
      onPress={onStartOver}
      accessibilityHint={`Lets you create another ${what}; revoke the earlier one first if it is listed`}
    />
  ) : null;

  if (lost) {
    return (
      <View style={styles.box} accessibilityLiveRegion="polite" testID={testID}>
        <StatusBadge tone="warning" label={OUTCOME_LOST_LABEL} />
        <Text style={styles.body}>
          {`Your earlier request reached the service and may have created the ${what}, but its answer was lost, so its one-time link cannot be shown. Nothing new is created until you have looked.`}
        </Text>
        <Text style={styles.body}>{findIt}</Text>
        <Text style={styles.caption} selectable>
          {reference}
        </Text>
        <Button
          label="Reload"
          variant="secondary"
          onPress={reloadLists}
          accessibilityHint={`Reads "${listName}" again`}
        />
        {startOver}
      </View>
    );
  }

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
  const usedAt =
    answered === null ? null : answeredShownAt ? answeredShownAt(answered) : `under "${listName}"`;
  // Revoked or expired already: the create is being sent again; nothing to show for the revoke.
  const revokeError = answered !== null && !used ? null : revoke.error;

  return (
    <View style={styles.box} accessibilityLiveRegion="polite" testID={testID}>
      <StatusBadge tone="warning" label="Created, but the link cannot be shown again" />
      <Text style={styles.body}>
        {`Your earlier request went through: the ${what} was created. Its one-time link is shown only in the first answer, which did not reach this device, so it cannot be shown again.`}
      </Text>
      <Text style={styles.caption} selectable>
        {reference}
      </Text>
      {used ? (
        <Text style={styles.body} testID={`${testID}-used`}>
          {`It can no longer be revoked: it was ${answered} already. ${
            usedAt ? `It is shown ${usedAt}.` : `It no longer appears under "${listName}".`
          } Nothing new was created.`}
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
        <>
          <Text style={styles.body}>{`${findIt} Then create a new one.`}</Text>
          {startOver}
        </>
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
