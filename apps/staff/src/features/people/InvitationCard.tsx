/**
 * One invitation with its full record (SCR-S-21, SPK-IAM-004): inviter, recipient, the people it
 * covers (fixed at issue), relationship, requested and granted permissions, the API's own expiry
 * and status. `effectiveStatus` is the API's reading at its clock (a pending invitation past its
 * expiry reads `expired` before any sweep records it); the client never computes expiry.
 *
 * A pending invitation is revoked with a reason and its expected revision (§4.9) and an
 * idempotency key per intent. STALE_REVISION or INVALID_TRANSITION (accepted or revoked meanwhile)
 * offers "Reload", which re-reads the lists the invitation came from. Offline, revoking is not
 * offered (§4.15). The one-time token is shown only on the record a creation returned.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess } from '../../ui/CommandFeedback';
import { Facts, TextField } from '../../ui/FormFields';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime } from '../../ui/time';
import { INVITATION_STATUS_TONE } from './people';

export type Invitation = Schema<'Invitation'>;
export type InvitationView = Schema<'InvitationView'>;

/** Query keys an invitation change refreshes: a person's authority and the invitation lists. */
export const INVITATION_LIST_KEYS = [
  ['api', '/people/{id}/authority'],
  ['api', '/invitations'],
] as const;

/** The outcome of a revoke, in the machine's words (journeys.md section 3 rule 4). */
export function revokedMessage(invitation: Invitation): string {
  return `Invitation revoked. State: ${invitation.status}.`;
}

function isView(invitation: Invitation | InvitationView): invitation is InvitationView {
  return 'effectiveStatus' in invitation;
}

function Party({
  id,
  name,
  self,
}: {
  id: string;
  name: string | null | undefined;
  self: string | undefined;
}) {
  if (id === self) return <span>this person</span>;
  return <Link to={`/people/${id}`}>{name ?? 'Open the person record'}</Link>;
}

export function InvitationCard({
  invitation,
  token = null,
  self,
  onRevoked,
}: {
  invitation: Invitation | InvitationView;
  /** The one-time code, only on the record a creation just returned. */
  token?: string | null;
  /** The person whose screen this is, shown as "this person". */
  self?: string;
  /**
   * Called with the revoked invitation; the caller then announces the outcome (a list re-read can
   * remove this card, for example from the pending ones). Without it the card announces it.
   */
  onRevoked?: (invitation: Invitation) => void;
}) {
  const { online } = useApp();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [revokedNow, setRevokedNow] = useState(false);
  const revoke = useApiCommand('post', '/invitations/{id}/revoke', {
    invalidate: INVITATION_LIST_KEYS,
  });
  const view = isView(invitation) ? invitation : null;
  const status = view?.effectiveStatus ?? invitation.status;
  const revocable = invitation.status === 'pending' && status === 'pending' && !revokedNow;
  const reload = () => {
    revoke.reset();
    void Promise.all(
      INVITATION_LIST_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
    );
  };
  const submit = () => {
    if (!reason.trim()) {
      setReasonError('Write why the invitation is revoked.');
      return;
    }
    setReasonError(null);
    void revoke
      .submit({
        path: { id: invitation.id },
        body: { expectedRevision: invitation.revision, reason: reason.trim() },
      })
      .then((next) => {
        setRevokedNow(true);
        if (onRevoked) onRevoked(next);
        else setSuccess(revokedMessage(next));
      })
      .catch(() => undefined);
  };
  const subjects = view?.subjects ?? [];
  return (
    <div
      className="panel"
      aria-label="Invitation record"
      data-testid={`invitation-${invitation.id}`}
    >
      <span className="actions-row">
        <StatusBadge tone={INVITATION_STATUS_TONE[status]} label={`Status: ${status}`} />
        {status !== invitation.status ? (
          <span className="caption">(recorded as {invitation.status})</span>
        ) : null}
      </span>
      <Facts
        items={[
          [
            'Inviter',
            invitation.invitedByPersonId ? (
              <Party
                key="inviter"
                id={invitation.invitedByPersonId}
                name={view?.inviter?.displayName}
                self={self}
              />
            ) : (
              'Staff'
            ),
          ],
          [
            'Recipient',
            invitation.recipientPersonId ? (
              <Party key="recipient" id={invitation.recipientPersonId} name={null} self={self} />
            ) : invitation.recipientContact ? (
              `${invitation.recipientContact.kind}: ${invitation.recipientContact.value}`
            ) : (
              'Not named'
            ),
          ],
          [
            'Covers',
            subjects.length > 0 ? (
              <span key="subjects">
                {subjects.map((s, i) => (
                  <span key={s.personId}>
                    {i > 0 ? ', ' : ''}
                    <Party id={s.personId} name={s.displayName} self={self} />
                  </span>
                ))}
              </span>
            ) : invitation.scope.type === 'person' ? (
              <Party key="scope" id={invitation.scope.personId} name={null} self={self} />
            ) : (
              `household ${invitation.scope.householdId}`
            ),
          ],
          ['Relationship', invitation.relationshipKind],
          ['Requested permissions', invitation.requestedPermissions.join(', ')],
          [
            'Granted permissions',
            invitation.grantedPermissions.length > 0
              ? invitation.grantedPermissions.join(', ')
              : 'None until accepted',
          ],
          ['Open until', formatDateTime(invitation.expiresAt)],
          [
            'Accepted',
            invitation.acceptedAt ? formatDateTime(invitation.acceptedAt) : 'Not accepted',
          ],
          ['Declined', invitation.declinedAt ? formatDateTime(invitation.declinedAt) : 'No'],
          ['Revoked', invitation.revokedAt ? formatDateTime(invitation.revokedAt) : 'No'],
          ['Issued', formatDateTime(invitation.createdAt)],
          ['Reference', <code key="id">{invitation.id}</code>],
        ]}
      />
      {token ? (
        <p>
          One-time invitation code, shown only now. Give it only to the recipient:{' '}
          <code>{token}</code>
        </p>
      ) : null}
      {revocable && online ? (
        <div className="form">
          <TextField
            label="Reason to revoke the invitation"
            value={reason}
            onChange={setReason}
            error={reasonError}
          />
          <Button variant="secondary" busy={revoke.isProcessing} onClick={submit}>
            Revoke invitation
          </Button>
        </div>
      ) : null}
      {revocable && !online ? (
        <p className="caption">Revoking an invitation needs a connection.</p>
      ) : null}
      <CommandSuccess message={success} />
      <CommandError error={revoke.error} onRetry={submit} onReload={reload} />
    </div>
  );
}
