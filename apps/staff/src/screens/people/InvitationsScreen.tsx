/**
 * SCR-S-21 Invitations, the organization's list for staff (SPK-IAM-004): `GET /v1/invitations`,
 * newest first, filtered by the API's effective status (a pending invitation past its expiry is
 * listed as expired), page by page with the API's cursor. Each invitation shows its full record
 * and a pending one can be revoked with a reason and its expected revision (`InvitationCard`).
 * The token is never returned by a list. Roles without `identity.read_invitations` see "not
 * available to you"; an ACCESS_DENIED answer reads the same.
 */
import { useState } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { InvitationCard, revokedMessage } from '../../features/people/InvitationCard';
import { PeopleNav } from '../../features/people/PeopleNav';
import { INVITATION_STATUSES, type InvitationStatus } from '../../features/people/people';
import { CommandSuccess } from '../../ui/CommandFeedback';
import { SelectField } from '../../ui/FormFields';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';

export const INVITATIONS_PAGE_SIZE = 25;
export const READ_INVITATIONS_ACTION = 'identity.read_invitations';

function InvitationList({ status }: { status: string }) {
  // Announced here: after a revoke the re-read list may no longer hold the card (pending filter).
  const [outcome, setOutcome] = useState<string | null>(null);
  const pages = useApiPages({
    path: '/invitations',
    request: {
      query: {
        limit: INVITATIONS_PAGE_SIZE,
        ...(status ? { status: status as InvitationStatus } : {}),
      },
    },
  });
  return (
    <>
      <CommandSuccess message={outcome} />
      <QueryBoundary
        query={pages}
        label="invitations"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No invitations',
          description: status
            ? `No invitation is ${status}.`
            : 'No invitation has been issued in this organization yet.',
        }}
        unavailableOffline={['revoking invitations']}
      >
        {(items) => (
          <ul className="list" aria-label="Invitations">
            {items.map((invitation) => (
              <li key={invitation.id}>
                <InvitationCard
                  invitation={invitation}
                  onRevoked={(i) => setOutcome(revokedMessage(i))}
                />
              </li>
            ))}
          </ul>
        )}
      </QueryBoundary>
      <LoadMore pages={pages} label="invitations" />
    </>
  );
}

export function InvitationsScreen() {
  const permissions = usePermissions();
  const [status, setStatus] = useState('pending');
  const permitted = permissions.isPermitted(READ_INVITATIONS_ACTION);
  return (
    <section aria-labelledby="invitations-title">
      <h2 id="invitations-title">Invitations</h2>
      <PeopleNav />
      <p className="caption">
        An invitation grants nothing until its recipient accepts it, and then only what is still
        authorized. Invite someone from the person&apos;s household, relationships and grants.
      </p>
      {permitted === false ? (
        <StateView
          variant="unavailable"
          title="Not available to you"
          description="The organization's invitations are not available to your role."
        />
      ) : (
        <>
          <SelectField
            label="Status"
            placeholder="Any status"
            options={INVITATION_STATUSES.map((s) => ({ value: s, label: s }))}
            value={status}
            onChange={setStatus}
          />
          <InvitationList key={status} status={status} />
        </>
      )}
    </section>
  );
}
