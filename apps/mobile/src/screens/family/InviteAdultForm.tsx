/**
 * SCR-C-31 invitation of a second guardian or a pickup delegate (SPK-IAM-004, SPK-IAM-003,
 * SPK-IAM-001: a pickup delegate is a separate identity from a guardian and a payer).
 *
 * `POST /v1/invitations` with a person scope, the relationship kind, each requested permission
 * chosen one by one (none implied by another) and the recipient's email or phone. A customer may
 * pass on only permissions they hold (`GET /v1/me` authorities; the API re-checks and answers
 * PARTICIPANT_AUTHORITY_REQUIRED). The expiry is not chosen here: it is POL-044 (pending), so the
 * API's default applies and the screen shows the `expiresAt` the API returns.
 *
 * No messaging provider is selected (§5.2), so the API returns the one-time token to the sender;
 * the screen offers it as a link through native sharing (SPK-UX-001). Whether supervised pickup is
 * used is DEC-075 (configuration `supervisedPickup`): while pending, the delegate option makes no
 * pickup claim and the pending state is shown; when decided "not used", pickup is not offered.
 * The link carries opaque ids
 * and the token only, no names (§4.14). The sender can withdraw the invitation
 * (`POST /v1/invitations/{id}/revoke`, with a reason and the expected revision) here or later
 * from "Invitations you sent" (SentInvitationsSection), which lists it with its state.
 *
 * The token is returned only in the first answer (§4.14). When that answer is lost and "Check
 * again" repeats the request under the same key, the API answers IDEMPOTENCY_SECRET_WITHHELD
 * naming the invitation it created: the form shows it as created (ui/SecretWithheld), reads
 * "Invitations you sent" again, and offers "Revoke and issue a new link", which revokes that
 * invitation and creates the same one again under a new key. "Create invitation" is held back
 * meanwhile, so a second pending invitation is never created beside one nobody has a link for.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { secretWithheldOf } from '../../api/command-outcome';
import { useApiCommand } from '../../api/useApiCommand';
import { buildAppLink } from '../../links/link-targets';
import { useApp, useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { SecretWithheld } from '../../ui/SecretWithheld';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import {
  formatDateTime,
  GRANT_PERMISSIONS,
  listPermissions,
  type GrantPermission,
} from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { CheckboxRow, ChoiceGroup, Paragraph, TextField } from '../account/components/forms';
import { INVITATION_KEYS, invitationStateLabel } from '../invitations/InvitationScreen';
import { contactFormatError } from '../onboarding/ContactPointStep';

type RelationshipKind = 'guardian' | 'delegate';
type ContactKind = 'email' | 'phone';
type CreateInvitation = Schema<'CreateInvitationRequest'>;
type InvitationIssued = Schema<'InvitationIssued'>;

export const SHARE_MESSAGE =
  'You have been invited to hold permissions in the Sportspark app. Open this link to review and accept:';

/** The audit reason of a revoke after the invitation's one-time link was lost (§4.14). */
export const WITHHELD_REVOKE_REASON =
  'The invitation link was not received by the app; revoked to issue a new one.';

export function InviteAdultForm({
  subjectPersonId,
  subjectName,
  heldPermissions,
  onClose,
}: {
  subjectPersonId: string;
  subjectName: string;
  heldPermissions: readonly GrantPermission[];
  onClose: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  // DEC-075 (Product owner): whether supervised pickup is used at all. While pending (null) the
  // pickup wording is not presented as decided; when decided "not used", pickup is not offered.
  const pickup = useApp().services.config.supervisedPickup ?? null;
  const permissions = GRANT_PERMISSIONS.filter(
    (g) => pickup !== false || g.permission !== 'collect',
  );
  const [kind, setKind] = useState<RelationshipKind>('guardian');
  const [contactKind, setContactKind] = useState<ContactKind>('email');
  const [contactValue, setContactValue] = useState('');
  const [selected, setSelected] = useState<readonly GrantPermission[]>([]);
  const [attempted, setAttempted] = useState(false);
  const invite = useApiCommand('post', '/invitations', {
    invalidate: [INVITATION_KEYS.familyList],
  });

  // The invitation was created but its link was lost: revoke and issue again, never a second one.
  const withheld = invite.error !== null && secretWithheldOf(invite.error) !== null;
  const contactError = contactFormatError(contactKind, contactValue);
  const permissionsError =
    selected.length === 0 ? 'Choose at least one permission to pass on.' : null;

  const toggle = (permission: GrantPermission, on: boolean) => {
    setSelected((current) =>
      GRANT_PERMISSIONS.map((g) => g.permission).filter((p) =>
        p === permission ? on : current.includes(p),
      ),
    );
  };

  const submit = async () => {
    setAttempted(true);
    if (contactError || permissionsError) return;
    // `expiresInHours` is published as required because the contract has a default; it is a
    // policy value (POL-044, pending), so it is left to the API's default (reported).
    const body = {
      scope: { type: 'person', personId: subjectPersonId },
      relationshipKind: kind,
      requestedPermissions: [...selected],
      recipientContact: { kind: contactKind, value: contactValue.trim() },
    } as unknown as CreateInvitation;
    try {
      await invite.submit({ body });
    } catch {
      // invite.error is rendered below; every choice is kept.
    }
  };

  if (invite.data) {
    return (
      <IssuedInvitation
        invitation={invite.data}
        contact={contactValue.trim()}
        onDone={onClose}
        onAnother={() => {
          invite.reset();
          setContactValue('');
          setSelected([]);
          setAttempted(false);
        }}
      />
    );
  }

  return (
    <View style={styles.form} testID="invite-form">
      <Paragraph>Invite another adult for {subjectName}.</Paragraph>
      <ChoiceGroup<RelationshipKind>
        label="Invite as"
        value={kind}
        onChange={setKind}
        disabled={invite.isProcessing}
        options={[
          { value: 'guardian', label: 'Guardian', detail: 'Another parent or guardian' },
          ...(pickup === false
            ? []
            : [
                {
                  value: 'delegate' as const,
                  label: pickup ? 'Pickup delegate' : 'Delegate',
                  detail: pickup
                    ? 'Someone who collects but is not a guardian'
                    : 'Another adult who is not a guardian, with only the permissions you choose',
                },
              ]),
        ]}
      />
      <ChoiceGroup<ContactKind>
        label="Send to"
        value={contactKind}
        onChange={setContactKind}
        disabled={invite.isProcessing}
        options={[
          { value: 'email', label: 'Email' },
          { value: 'phone', label: 'Phone' },
        ]}
      />
      <TextField
        label={contactKind === 'email' ? 'Their email address' : 'Their phone number'}
        hint="Only someone who has verified this email or phone in their account can accept."
        value={contactValue}
        onChangeText={setContactValue}
        keyboardType={contactKind === 'email' ? 'email-address' : 'phone-pad'}
        error={attempted ? contactError : null}
        editable={!invite.isProcessing}
        testID="invite-contact"
      />
      <View style={styles.permissions} accessibilityRole="list" accessibilityLabel="Permissions">
        <Paragraph inset={false}>Permissions to pass on. Each one is separate.</Paragraph>
        {permissions.map((g) => {
          const held = heldPermissions.includes(g.permission);
          const detail =
            g.permission === 'collect' && pickup === null ? 'Collect a child in person' : g.detail;
          return (
            <CheckboxRow
              key={g.permission}
              label={g.label}
              detail={held ? detail : `${detail}. You do not hold this, so you cannot pass it on.`}
              checked={selected.includes(g.permission)}
              disabled={!held || invite.isProcessing}
              onChange={(on) => toggle(g.permission, on)}
              testID={`invite-permission-${g.permission}`}
            />
          );
        })}
        {attempted && permissionsError ? (
          <Text
            style={styles.error}
            accessibilityRole="alert"
            accessibilityLiveRegion="polite"
            testID="invite-permissions-error"
          >
            {'✕ '}
            {permissionsError}
          </Text>
        ) : null}
      </View>
      {pickup === null ? (
        <StateView
          variant="pending-decision"
          subject="Supervised pickup"
          decisions={['DEC-075', 'DEC-005']}
          owner="Product owner (DEC-075); Operations (DEC-005)"
        />
      ) : null}
      <StateView
        variant="pending-decision"
        subject="Choosing how long an invitation stays open"
        decisions={['POL-044']}
        owner="Operator/privacy owner (DEC-004)"
      />
      <Paragraph muted>
        The app does not set an expiry. After you create the invitation, it shows the date the
        facility's system gives it.
      </Paragraph>
      <View style={styles.actions}>
        <Button
          label="Create invitation"
          onPress={() => void submit()}
          busy={invite.isProcessing}
          disabled={offline || withheld}
          accessibilityHint={
            offline
              ? 'Needs a connection'
              : withheld
                ? 'The invitation was already created; revoke it and issue a new link below'
                : undefined
          }
        />
        <Button label="Cancel" variant="secondary" onPress={onClose} />
      </View>
      {offline ? (
        <Paragraph muted>Inviting needs a connection. Your choices are kept.</Paragraph>
      ) : null}
      {invite.error && withheld ? (
        <SecretWithheld
          error={invite.error}
          what="invitation"
          listName="Invitations you sent"
          revokePath="/invitations/{id}/revoke"
          revokeReason={WITHHELD_REVOKE_REASON}
          invalidate={[INVITATION_KEYS.familyList]}
          onReissue={() => void submit()}
        />
      ) : invite.error ? (
        <CommandError error={invite.error} onRetry={() => void submit()} />
      ) : null}
    </View>
  );
}

function IssuedInvitation({
  invitation,
  contact,
  onDone,
  onAnother,
}: {
  invitation: InvitationIssued;
  contact: string;
  onDone: () => void;
  onAnother: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const [reason, setReason] = useState('');
  const [attempted, setAttempted] = useState(false);
  const revoke = useApiCommand('post', '/invitations/{id}/revoke', {
    invalidate: [INVITATION_KEYS.familyList],
  });
  const link = buildAppLink({ to: 'invitation', id: invitation.id, token: invitation.token });
  // STALE_REVISION or INVALID_TRANSITION on withdrawing: the invitation changed since it was
  // created (most likely accepted, or withdrawn on another device). The screen says it is no
  // longer open; its current state is listed under "Invitations you sent".
  const closed = revoke.error?.isStale
    ? revoke.error.code === 'INVALID_TRANSITION'
      ? invitationStateLabel((revoke.error.details as { from?: unknown } | undefined)?.from)
      : 'No longer open'
    : null;
  const status = revoke.data
    ? { tone: 'neutral' as const, label: 'Revoked' }
    : closed
      ? { tone: 'neutral' as const, label: closed }
      : { tone: 'info' as const, label: `Open until ${formatDateTime(invitation.expiresAt)}` };
  const reasonError = reason.trim().length === 0 ? 'Say why you are withdrawing it.' : null;

  const withdraw = async () => {
    setAttempted(true);
    if (reasonError) return;
    try {
      await revoke.submit({
        path: { id: invitation.id },
        body: { reason: reason.trim(), expectedRevision: invitation.revision },
      });
    } catch {
      // revoke.error is rendered below; the reason is kept.
    }
  };

  return (
    <View style={styles.form} testID="invitation-issued">
      <View style={styles.actions}>
        <StatusBadge tone={status.tone} label={status.label} />
      </View>
      <Paragraph>
        Invitation for {contact} with: {listPermissions(invitation.requestedPermissions)}.
      </Paragraph>
      {revoke.data ? (
        <Paragraph>The invitation was withdrawn and can no longer be accepted.</Paragraph>
      ) : closed && revoke.error ? (
        <>
          <Paragraph>
            This invitation changed since you created it: it may have been accepted, or withdrawn on
            another device. It can no longer be withdrawn here.
          </Paragraph>
          <Paragraph muted>
            {`Error code: ${revoke.error.code}${revoke.error.correlationId ? `. Reference: ${revoke.error.correlationId}` : ''}`}
          </Paragraph>
        </>
      ) : (
        <>
          <Paragraph>
            Share the link now: it cannot be shown again later, and the app does not send
            invitations by email or text yet.
          </Paragraph>
          <View style={styles.actions}>
            <Button
              label="Share invitation link"
              onPress={() => void Share.share({ message: `${SHARE_MESSAGE} ${link}` })}
            />
          </View>
          <TextField
            label="Reason for withdrawing"
            value={reason}
            onChangeText={setReason}
            error={attempted ? reasonError : null}
            editable={!revoke.isProcessing}
            testID="revoke-reason"
          />
          <View style={styles.actions}>
            <Button
              label="Withdraw invitation"
              variant="secondary"
              onPress={() => void withdraw()}
              busy={revoke.isProcessing}
              disabled={offline}
            />
          </View>
          {revoke.error ? (
            <CommandError error={revoke.error} onRetry={() => void withdraw()} />
          ) : null}
        </>
      )}
      <View style={styles.actions}>
        <Button label="Invite someone else" variant="secondary" onPress={onAnother} />
        <Button label="Done" variant="secondary" onPress={onDone} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  form: { gap: spacing.md, paddingTop: spacing.md },
  permissions: { paddingHorizontal: spacing.lg, gap: spacing.xs },
  actions: { paddingHorizontal: spacing.lg, gap: spacing.sm },
  error: { ...type.caption, color: colors.danger },
});
