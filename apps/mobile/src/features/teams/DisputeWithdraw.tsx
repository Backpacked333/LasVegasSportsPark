/**
 * SCR-C-29 withdraw a dispute (CMP-12; SPK-RESULT-005, §4.6, §4.9): its submitter, or a captain of
 * the submitting entry, withdraws a dispute that is still submitted or under review with
 * `POST /v1/disputes/{id}/withdraw`, a reason and the dispute's revision (`expectedRevision`). A
 * decided or withdrawn dispute has nothing to withdraw (the Dispute machine's final states). Only
 * disputes the API lets this person read are shown at all (`GET /v1/fixtures/{id}/disputes`), and
 * the API checks the withdrawal again: a refusal is "not available".
 *
 * States: ready (the button); validation failure (reason required); permission restriction ("not
 * available"); stale version (reviewed or decided meanwhile: reload); offline (disabled, the reason
 * kept); processing; success ("Dispute withdrawn"); recovery: retried under the same key.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { spacing } from '../../ui/theme';
import { Body, ButtonRow, CommandFailure, OfflineNotice, TextField } from './ui';

type Dispute = Schema<'Dispute'>;

/** The states a dispute can still be withdrawn from (Dispute machine: submitted, under_review). */
export function isWithdrawable(dispute: Pick<Dispute, 'status'>): boolean {
  return dispute.status === 'submitted' || dispute.status === 'under_review';
}

export function DisputeWithdraw({
  dispute,
  onReload,
}: {
  dispute: Dispute;
  /** Reads the fixture's disputes again (after STALE_REVISION or INVALID_TRANSITION). */
  onReload: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const withdraw = useApiCommand('post', '/disputes/{id}/withdraw', {
    invalidate: [
      ['api', '/fixtures/{id}/disputes'],
      ['api', '/disputes/{id}'],
    ],
  });
  const reasonError = attempted && !reason.trim() ? 'Give the reason for withdrawing.' : null;
  const submit = () => {
    setAttempted(true);
    if (!reason.trim()) return;
    void withdraw
      .submit({
        path: { id: dispute.id },
        body: { reason: reason.trim(), expectedRevision: dispute.revision },
      })
      .catch(() => undefined);
  };

  if (withdraw.data) {
    return (
      <View accessibilityLiveRegion="polite" testID={`dispute-${dispute.id}-withdrawn`}>
        <Body>You withdrew this dispute. The league no longer reviews it.</Body>
      </View>
    );
  }
  if (!isWithdrawable(dispute)) return null;
  if (!open) {
    return (
      <Button
        label="Withdraw this dispute"
        variant="secondary"
        onPress={() => setOpen(true)}
        disabled={offline}
        accessibilityHint="Asks for a reason; the league stops reviewing it"
      />
    );
  }
  return (
    <View style={styles.group} testID={`dispute-${dispute.id}-withdraw`}>
      <TextField
        label="Reason for withdrawing"
        value={reason}
        onChangeText={setReason}
        multiline
        error={reasonError}
      />
      <Body muted>A withdrawn dispute is closed and the league stops reviewing it.</Body>
      {offline ? <OfflineNotice what="Withdrawing a dispute" /> : null}
      <ButtonRow>
        <Button
          label="Withdraw the dispute"
          onPress={submit}
          busy={withdraw.isProcessing}
          disabled={offline}
        />
        <Button
          label="Keep the dispute"
          variant="secondary"
          onPress={() => {
            withdraw.reset();
            setOpen(false);
            setAttempted(false);
          }}
        />
      </ButtonRow>
      {withdraw.error ? (
        <CommandFailure
          error={withdraw.error}
          onRetry={submit}
          onReload={() => {
            withdraw.reset();
            setOpen(false);
            onReload();
          }}
          unavailableText="Withdrawing this dispute is not available to you."
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  group: { gap: spacing.sm },
});
