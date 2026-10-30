/**
 * The outcome of `POST /v1/team-entries/{id}/invitations` (SCR-C-23, SCR-C-27; SPK-IAM-004,
 * SPK-CAP-001). No messaging provider is selected (§5.2, DEC-020), so the API returns the
 * invitation token once to the inviter, who shares the link with the native share sheet. The token
 * is never logged, stored or shown as text.
 *
 * The link uses the app's proposed link format for the SCR-C-39 link landing,
 * `sportspark://link?to=team-invitation&id=<id>&token=<token>`; which links count as verified is
 * DEC-061 (pending).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { invitationStatus } from './status';

type Issued = Schema<'TeamInvitationIssued'>;

/**
 * The audit reason of a revoke after a team invitation's one-time link was lost: a retry under the
 * same key was answered IDEMPOTENCY_SECRET_WITHHELD (§4.14, ui/SecretWithheld).
 */
export const WITHHELD_REVOKE_REASON =
  'The invitation link was not received by the app; revoked by the captain to issue a new one.';

export function teamInvitationLink(invitationId: string, token: string): string {
  const query = new URLSearchParams({ to: 'team-invitation', id: invitationId, token });
  return `sportspark://link?${query.toString()}`;
}

export function InvitationIssued({
  invitation,
  recipient,
  teamName,
}: {
  invitation: Issued;
  /** "ada@example.com" or a roster suggestion's name. */
  recipient: string;
  teamName: string;
}) {
  const [shareFailed, setShareFailed] = useState(false);
  const share = async () => {
    setShareFailed(false);
    try {
      await Share.share({
        message: `You are invited to join ${teamName}. Open this link in the Sportspark app: ${teamInvitationLink(invitation.id, invitation.token)}`,
      });
    } catch {
      setShareFailed(true);
    }
  };
  return (
    <View style={styles.box} testID={`invitation-issued-${invitation.id}`}>
      <StatusBadge {...invitationStatus(invitation)} />
      <Text style={styles.body}>{`Invitation for ${recipient}.`}</Text>
      <Text style={styles.caption}>
        It grants nothing until it is accepted. Share the link with the player: this is the only
        time the app can show it.
      </Text>
      <Button
        label={`Share the invitation for ${recipient}`}
        onPress={() => void share()}
        variant="secondary"
      />
      {shareFailed ? (
        <Text style={styles.body}>The share sheet could not open. Try again.</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  box: { gap: spacing.xs, paddingVertical: spacing.xs },
  body: { ...type.body, color: colors.text },
  caption: { ...type.caption, color: colors.textMuted },
});
