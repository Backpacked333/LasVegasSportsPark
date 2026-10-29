/**
 * SCR-C-31 invitations this person sent (SPK-IAM-004): `GET /v1/me/invitations?direction=sent`,
 * newest first with "Load more", each with the people it covers, the requested permissions, the
 * address it went to and its state as the API states it ("Open until <date>", "Accepted",
 * "Declined", "Expired", "Revoked"). An open one can be withdrawn
 * (`POST /v1/invitations/{id}/revoke` with a reason and its revision; STALE_REVISION or
 * INVALID_TRANSITION: the list is reloaded and shows the invitation as it is now). The one-time
 * link is never shown again (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { spacing } from '../../ui/theme';
import { listPermissions } from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { Paragraph, SectionHeader, TextField } from '../account/components/forms';
import {
  INVITATION_KEYS,
  invitationStatus,
  relationshipLabel,
  subjectsText,
} from '../invitations/InvitationScreen';

type InvitationView = Schema<'InvitationView'>;

export function SentInvitationsSection() {
  const sent = useApiPages({
    path: '/me/invitations',
    request: { query: { direction: 'sent', limit: 20 } },
  });
  return (
    <View>
      <SectionHeader
        title="Invitations you sent"
        detail="An open invitation can be withdrawn until it is answered."
      />
      <QueryBoundary
        query={sent}
        label="invitations you sent"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No invitations sent',
          description: 'Invitations you send to another adult appear here with their state.',
        }}
        unavailableOffline={['withdrawing an invitation']}
      >
        {(items) => (
          <View accessibilityRole="list" accessibilityLabel="Invitations you sent">
            {items.map((invitation) => (
              <SentInvitationRow key={invitation.id} invitation={invitation} />
            ))}
          </View>
        )}
      </QueryBoundary>
      <LoadMore pages={sent} label="invitations" />
    </View>
  );
}

function SentInvitationRow({ invitation }: { invitation: InvitationView }) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const revoke = useApiCommand('post', '/invitations/{id}/revoke', {
    invalidate: [INVITATION_KEYS.familyList, INVITATION_KEYS.family],
  });
  const sent = useRef<{ reason: string; expectedRevision: number } | null>(null);
  const to = invitation.recipientContact?.value;
  const open = invitation.effectiveStatus === 'pending';
  const reasonError = reason.trim().length === 0 ? 'Say why you are withdrawing it.' : null;

  const send = async (body: { reason: string; expectedRevision: number }) => {
    sent.current = body;
    try {
      await revoke.submit({ path: { id: invitation.id }, body });
      sent.current = null;
      setWithdrawing(false);
    } catch {
      // revoke.error is rendered below; the reason is kept.
    }
  };
  const submit = () => {
    setAttempted(true);
    if (reasonError) return;
    void send({ reason: reason.trim(), expectedRevision: invitation.revision });
  };
  const reload = () => {
    revoke.reset();
    sent.current = null;
    setWithdrawing(false);
    void queryClient.invalidateQueries({ queryKey: INVITATION_KEYS.familyList });
  };

  return (
    <View testID={`sent-invitation-${invitation.id}`}>
      <ListRow
        title={`${relationshipLabel(invitation.relationshipKind)} for ${subjectsText(invitation.subjects)}`}
        detail={`${to ? `To ${to}. ` : ''}${listPermissions(invitation.requestedPermissions)}`}
        status={invitationStatus(invitation.effectiveStatus, invitation.expiresAt)}
      />
      {open && !withdrawing && !revoke.error ? (
        <View style={styles.inset}>
          <Button
            label={`Withdraw invitation for ${subjectsText(invitation.subjects)}`}
            variant="secondary"
            onPress={() => setWithdrawing(true)}
            disabled={offline}
            accessibilityHint={offline ? 'Needs a connection' : 'Asks for a reason first'}
          />
        </View>
      ) : null}
      {withdrawing ? (
        <View style={styles.form}>
          <TextField
            label="Reason for withdrawing"
            value={reason}
            onChangeText={(next) => {
              setReason(next);
              sent.current = null;
              if (revoke.error) revoke.reset();
            }}
            error={attempted ? reasonError : null}
            editable={!revoke.isProcessing}
            testID={`withdraw-reason-${invitation.id}`}
          />
          <View style={styles.inset}>
            <Button
              label="Withdraw invitation"
              onPress={submit}
              busy={revoke.isProcessing}
              disabled={offline}
              accessibilityHint={offline ? 'Needs a connection' : undefined}
            />
            <Button
              label="Keep it open"
              variant="secondary"
              onPress={() => setWithdrawing(false)}
            />
          </View>
        </View>
      ) : null}
      {revoke.error ? (
        <>
          {revoke.error.isStale ? (
            <Paragraph muted>
              This invitation changed since it was shown: it may have been answered, or withdrawn on
              another device.
            </Paragraph>
          ) : null}
          <CommandError
            error={revoke.error}
            onRetry={() => {
              if (sent.current) void send(sent.current);
            }}
            onReload={reload}
            notFound={{
              title: 'Invitation not available',
              description: 'This invitation is no longer listed for you.',
            }}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  inset: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm },
  form: { gap: spacing.sm, paddingTop: spacing.sm },
});
