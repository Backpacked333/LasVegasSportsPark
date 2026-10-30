/**
 * SCR-C-31 giving up a permission one holds (SPK-IAM-006 "Revocation takes effect on the next
 * authority check", SPK-IAM-003): the holder of a grant may end it themselves
 * (`POST /v1/access-grants/{id}/revoke`, `identity.revoke_access` with self authority, as
 * `GET /v1/me/permissions` lists it). One permission at a time, with the reason the API requires
 * and the grant's revision (STALE_REVISION or INVALID_TRANSITION: reload, the grant changed). Any
 * grant not yet withdrawn may be given up, as the API allows: in effect now, starting later
 * ("Starts <date>") or paused ("Under review", "Suspended"), each labelled with its state. While a
 * request is in flight the form cannot be cancelled: its outcome is not known yet.
 *
 * Ending a permission another adult holds over the people one manages is not offered: those grants
 * are not readable (DEC-004) and ending relationships is DEC-089.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import { ME_QUERY_KEY, permissionLabel } from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { ChoiceGroup, Paragraph, TextField } from '../account/components/forms';
import { grantStatusLabel, type GrantView } from './grants';

export const ACCESS_GRANTS_KEY = ['api', '/me/access-grants'] as const;

export function GiveUpPermission({
  personName,
  grants,
  onClose,
}: {
  personName: string;
  /** This account's grants over the person that are not withdrawn: in effect, later or paused. */
  grants: readonly GrantView[];
  onClose: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const queryClient = useQueryClient();
  const [grantId, setGrantId] = useState<string | null>(grants[0]?.grantId ?? null);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const revoke = useApiCommand('post', '/access-grants/{id}/revoke', {
    invalidate: [ME_QUERY_KEY, ACCESS_GRANTS_KEY],
  });
  // The request of the intent in flight: "Try again" resends it unchanged (§4.9).
  const sent = useRef<{ id: string; reason: string; expectedRevision: number } | null>(null);
  const chosen = grants.find((g) => g.grantId === grantId) ?? null;
  const reasonError = reason.trim().length === 0 ? 'Say why you are giving it up.' : null;

  const send = async (request: { id: string; reason: string; expectedRevision: number }) => {
    sent.current = request;
    try {
      await revoke.submit({
        path: { id: request.id },
        body: { reason: request.reason, expectedRevision: request.expectedRevision },
      });
      sent.current = null;
    } catch {
      // revoke.error is rendered below; the choice and the reason are kept.
    }
  };

  const submit = () => {
    setAttempted(true);
    if (!chosen || reasonError) return;
    void send({ id: chosen.grantId, reason: reason.trim(), expectedRevision: chosen.revision });
  };

  if (revoke.data) {
    return (
      <View style={styles.box} testID="give-up-done">
        <StatusBadge tone="neutral" label="Permission given up" />
        <Paragraph inset={false}>
          {`You no longer hold ${permissionLabel(revoke.data.permission)} for ${personName}. The list shows your permissions as they are now.`}
        </Paragraph>
        <Button label="Done" variant="secondary" onPress={onClose} />
      </View>
    );
  }

  return (
    <View style={styles.box} testID="give-up-form">
      <Paragraph inset={false}>
        {`Give up one of your permissions for ${personName}. It ends at once; getting it back needs a new invitation or the front desk.`}
      </Paragraph>
      <ChoiceGroup<string>
        label="Permission to give up"
        value={grantId}
        onChange={(next) => {
          setGrantId(next);
          sent.current = null;
          revoke.reset();
        }}
        disabled={revoke.isProcessing}
        options={grants.map((g) => ({
          value: g.grantId,
          label: permissionLabel(g.permission),
          // In effect now needs no note; a later or paused grant says which it is.
          detail:
            g.status === 'effective' && !g.underReview ? undefined : grantStatusLabel(g).label,
        }))}
      />
      <TextField
        label="Reason"
        value={reason}
        onChangeText={(next) => {
          setReason(next);
          sent.current = null;
          if (revoke.error) revoke.reset();
        }}
        error={attempted ? reasonError : null}
        editable={!revoke.isProcessing}
        testID="give-up-reason"
      />
      <View style={styles.actions}>
        <Button
          label="Give up permission"
          onPress={submit}
          busy={revoke.isProcessing}
          disabled={offline || chosen === null}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <Button
          label="Cancel"
          variant="secondary"
          onPress={onClose}
          disabled={revoke.isProcessing}
          accessibilityHint={revoke.isProcessing ? 'Waiting for the answer' : undefined}
        />
      </View>
      {offline ? (
        <Paragraph muted inset={false}>
          Giving up a permission needs a connection.
        </Paragraph>
      ) : null}
      {revoke.error ? (
        <CommandError
          error={revoke.error}
          onRetry={() => {
            if (sent.current) void send(sent.current);
          }}
          onReload={() => {
            // The grant changed since it was shown: show the permissions as they are now.
            void queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
            void queryClient.invalidateQueries({ queryKey: ACCESS_GRANTS_KEY });
            onClose();
          }}
          notFound={{
            title: 'Permission not available',
            description:
              'This permission is no longer listed for you. The list shows it as it is now.',
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { paddingTop: spacing.md, gap: spacing.sm },
  actions: { gap: spacing.sm },
});
