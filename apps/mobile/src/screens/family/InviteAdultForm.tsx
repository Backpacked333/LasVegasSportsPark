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
 * the screen offers it as a link through native sharing (SPK-UX-001). The link carries opaque ids
 * and the token only, no names (§4.14). The sender can withdraw the invitation
 * (`POST /v1/invitations/{id}/revoke`, with a reason and the expected revision).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Share, StyleSheet, View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { buildAppLink } from '../../links/link-targets';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StatusBadge } from '../../ui/StatusBadge';
import { spacing } from '../../ui/theme';
import {
  formatDateTime,
  GRANT_PERMISSIONS,
  listPermissions,
  type GrantPermission,
} from '../account/components/account-data';
import { CommandError } from '../account/components/CommandError';
import { CheckboxRow, ChoiceGroup, Paragraph, TextField } from '../account/components/forms';
import { contactFormatError } from '../onboarding/ContactPointStep';

type RelationshipKind = 'guardian' | 'delegate';
type ContactKind = 'email' | 'phone';
type CreateInvitation = Schema<'CreateInvitationRequest'>;
type InvitationIssued = Schema<'InvitationIssued'>;

export const SHARE_MESSAGE =
  'You have been invited to hold permissions in the Sportspark app. Open this link to review and accept:';

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
  const [kind, setKind] = useState<RelationshipKind>('guardian');
  const [contactKind, setContactKind] = useState<ContactKind>('email');
  const [contactValue, setContactValue] = useState('');
  const [selected, setSelected] = useState<readonly GrantPermission[]>([]);
  const [attempted, setAttempted] = useState(false);
  const invite = useApiCommand('post', '/invitations');

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
          {
            value: 'delegate',
            label: 'Pickup delegate',
            detail: 'Someone who collects but is not a guardian',
          },
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
        {GRANT_PERMISSIONS.map((g) => {
          const held = heldPermissions.includes(g.permission);
          return (
            <CheckboxRow
              key={g.permission}
              label={g.label}
              detail={
                held ? g.detail : `${g.detail}. You do not hold this, so you cannot pass it on.`
              }
              checked={selected.includes(g.permission)}
              disabled={!held || invite.isProcessing}
              onChange={(on) => toggle(g.permission, on)}
              testID={`invite-permission-${g.permission}`}
            />
          );
        })}
        {attempted && permissionsError ? (
          <Paragraph inset={false}>
            {'✕ '}
            {permissionsError}
          </Paragraph>
        ) : null}
      </View>
      <Paragraph muted>
        The facility's invitation policy sets how long the invitation stays open.
      </Paragraph>
      <View style={styles.actions}>
        <Button
          label="Create invitation"
          onPress={() => void submit()}
          busy={invite.isProcessing}
          disabled={offline}
          accessibilityHint={offline ? 'Needs a connection' : undefined}
        />
        <Button label="Cancel" variant="secondary" onPress={onClose} />
      </View>
      {offline ? (
        <Paragraph muted>Inviting needs a connection. Your choices are kept.</Paragraph>
      ) : null}
      {invite.error ? <CommandError error={invite.error} onRetry={() => void submit()} /> : null}
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
  const revoke = useApiCommand('post', '/invitations/{id}/revoke');
  const link = buildAppLink({ to: 'invitation', id: invitation.id, token: invitation.token });
  const status = revoke.data
    ? { tone: 'neutral' as const, label: 'Revoked' }
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
});
