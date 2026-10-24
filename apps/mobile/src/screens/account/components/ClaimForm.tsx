/**
 * Claim a participant record entered at the front desk (SCR-C-01 "create or claim the Person",
 * SCR-C-31; SPK-IAM-002: a staff-entered registration is claimable by the correct verified
 * customer without creating another participant). `POST /v1/claims/{token}/accept`:
 *
 * - a self claim links this login account to the person the desk created;
 * - a guardian claim records guardianship with exactly the permissions the claim carried.
 *
 * The code is a secret: it arrives from a link (held in memory, src/links/link-secrets) or is typed;
 * it is never stored or logged. One idempotency key per code (§4.9): "Try again" reuses it.
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../../api/useApiCommand';
import { forgetLinkSecret } from '../../../links/link-secrets';
import { isLinkToken } from '../../../links/link-targets';
import { useConnectivity } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { StateView } from '../../../ui/StateView';
import { StatusBadge } from '../../../ui/StatusBadge';
import { spacing } from '../../../ui/theme';
import { listPermissions, ME_QUERY_KEY, personNameText, usePersonName } from './account-data';
import { CommandError } from './CommandError';
import { Paragraph, TextField } from './forms';

type ClaimAccepted = Schema<'ClaimAccepted'>;

/** INVALID_TRANSITION on a claim: the state it is in now (journeys.md section 3 wording). */
export function claimNoLongerOpen(error: ApiError): string | null {
  if (error.code !== 'INVALID_TRANSITION') return null;
  const from = (error.details as { from?: unknown } | undefined)?.from;
  if (from === 'accepted') return 'This claim code has already been used.';
  if (from === 'expired') return 'This claim code has expired. Ask the front desk for a new one.';
  if (from === 'revoked') return 'This claim code was withdrawn. Ask the front desk for a new one.';
  return 'This claim code can no longer be used. Ask the front desk for a new one.';
}

export function ClaimForm({
  initialToken = null,
  intro,
}: {
  initialToken?: string | null;
  intro: string;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [token, setToken] = useState(initialToken ?? '');
  const [attempted, setAttempted] = useState(false);
  const queryClient = useQueryClient();
  const claim = useApiCommand('post', '/claims/{token}/accept');

  const trimmed = token.trim();
  const formatError =
    trimmed.length === 0
      ? 'Enter the claim code.'
      : isLinkToken(trimmed)
        ? null
        : 'A claim code has at least 16 letters, numbers, dashes or underscores.';

  const submit = async () => {
    setAttempted(true);
    if (formatError) return;
    try {
      await claim.submit({ path: { token: trimmed } });
    } catch (error) {
      // Shown below from claim.error; the code stays in the field (SPK-UX-008). A code the API
      // says is used, expired, withdrawn or unknown is dead: forget the one from the link so no
      // later screen offers it again.
      const failure = error as ApiError;
      if (claimNoLongerOpen(failure) !== null || failure.isNotFound) forgetLinkSecret('claim');
      return;
    }
    // Forget the used code before /me refreshes, so no later step offers it again.
    forgetLinkSecret('claim');
    await queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY });
  };
  if (claim.data) return <ClaimResult result={claim.data} />;

  const stale = claim.error ? claimNoLongerOpen(claim.error) : null;
  return (
    <View style={styles.form}>
      <Paragraph>{intro}</Paragraph>
      <TextField
        label="Claim code"
        hint={initialToken ? 'Filled in from the link you opened.' : 'From the front desk.'}
        value={token}
        onChangeText={(value) => {
          setToken(value);
          if (claim.error) claim.reset();
        }}
        error={attempted ? formatError : null}
        editable={!claim.isProcessing}
        testID="claim-code"
      />
      <View style={styles.inset}>
        <Button
          label="Claim record"
          onPress={() => void submit()}
          busy={claim.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
      </View>
      {offline ? (
        <Paragraph muted>Claiming needs a connection. Your code is kept.</Paragraph>
      ) : null}
      {claim.error && stale ? (
        <View style={styles.result}>
          <StatusBadge tone="neutral" label="Claim code no longer open" />
          <Paragraph inset={false}>{stale}</Paragraph>
        </View>
      ) : claim.error ? (
        <CommandError
          error={claim.error}
          onRetry={() => void submit()}
          notFound={{
            title: 'Claim code not recognised',
            description: 'Check the code with the front desk and enter it again.',
          }}
        />
      ) : null}
    </View>
  );
}

function ClaimResult({ result }: { result: ClaimAccepted }) {
  if (result.claim.kind === 'self') {
    return (
      <View style={styles.result} testID="claim-result">
        <StatusBadge tone="success" label="Linked" />
        <Paragraph inset={false}>Your account is now linked to your participant record.</Paragraph>
      </View>
    );
  }
  return <GuardianClaimResult result={result} />;
}

function GuardianClaimResult({ result }: { result: ClaimAccepted }) {
  const name = usePersonName(result.claim.subjectPersonId);
  const granted = result.grants.filter((g) => g.effective).map((g) => g.permission);
  return (
    <View style={styles.result} testID="claim-result">
      <StatusBadge tone="success" label="Claimed" />
      <Paragraph inset={false}>
        You are now recorded as guardian of {personNameText(name)} with these permissions:{' '}
        {listPermissions(granted)}.
      </Paragraph>
      <Paragraph muted inset={false}>
        Nothing else was granted.
      </Paragraph>
      {granted.length === 0 ? (
        <StateView
          variant="unavailable"
          title="No permissions yet"
          description="The claim carried no permissions that are in effect now. Ask the front desk."
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md },
  inset: { paddingHorizontal: spacing.lg },
  result: { paddingHorizontal: spacing.lg, gap: spacing.sm },
});
