/**
 * SCR-S-21 Household, relationships and grants (SPK-IAM-001, SPK-IAM-003, SPK-IAM-004,
 * SPK-IAM-006, SPK-AT-017, DEC-004).
 *
 * - Relationships are recorded with each permission chosen on its own; nothing is pre-selected and
 *   no permission implies another (SPK-IAM-003). Every grant is shown and revoked individually,
 *   with a reason and the grant's expected revision; revocation affects every later check
 *   (SPK-IAM-006). All of these are privileged, audited commands the API authorizes.
 * - A household only groups people; it never gives anyone authority (SPK-IAM-001).
 * - Invitations show their full record: inviter, recipient, scope, requested and granted
 *   permissions, expiry, status (SPK-IAM-004). The expiry is the API's; none is invented here.
 * - Guardian verification is DEC-004 (pending): the screen says so and records relationships with
 *   the staff source the API assigns.
 * - The API cannot yet list a person's existing relationships, grants, households or invitations;
 *   that list is shown as not available, and the people this person holds `view` over are taken
 *   from the customer timeline's scope. Offline, every change is unavailable (§4.15: no guardian
 *   changes offline).
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { withServerDefaults } from '../../api/server-defaults';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import {
  GRANT_PERMISSIONS,
  RELATIONSHIP_KINDS,
  personName,
  type GrantPermission,
  type RelationshipKind,
} from '../../features/people/people';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { CommandError, CommandSuccess, fieldErrorsOf } from '../../ui/CommandFeedback';
import {
  CheckboxGroup,
  Facts,
  RadioGroup,
  SelectField,
  TextAreaField,
  TextField,
} from '../../ui/FormFields';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime, localInputToIso } from '../../ui/time';

/** The OpenAPI component is nullable (it is reused as a nullable field elsewhere); a created one is not. */
type Relationship = NonNullable<Schema<'Relationship'>>;
type AccessGrant = Schema<'AccessGrant'>;
type Household = Schema<'Household'>;
type Invitation = Schema<'Invitation'>;

interface RecordedRelationship {
  relationship: Relationship;
  grants: AccessGrant[];
}

function PersonLink({ id, self }: { id: string; self: string }) {
  return id === self ? <span>this person</span> : <Link to={`/people/${id}`}>{id}</Link>;
}

function GrantRow({ grant, onChange }: { grant: AccessGrant; onChange: (g: AccessGrant) => void }) {
  const { online } = useApp();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const revoke = useApiCommand('post', '/access-grants/{id}/revoke');
  const submit = () => {
    if (!reason.trim()) {
      setReasonError('Write why this permission is revoked.');
      return;
    }
    setReasonError(null);
    void revoke
      .submit({
        path: { id: grant.id },
        body: { expectedRevision: grant.revision, reason: reason.trim() },
      })
      .then(onChange)
      .catch(() => undefined);
  };
  const revoked = grant.revokedAt !== null;
  return (
    <li aria-label={`Permission ${grant.permission}`}>
      <div className="row-text">
        <span className="row-title">{grant.permission}</span>
        <span className="caption">
          source {grant.source} · from {formatDateTime(grant.effectiveFrom)}
          {grant.effectiveTo ? ` to ${formatDateTime(grant.effectiveTo)}` : ''}
          {grant.suspendedAt ? ` · suspended ${formatDateTime(grant.suspendedAt)}` : ''}
          {grant.revokedAt ? ` · revoked ${formatDateTime(grant.revokedAt)}` : ''}
          {grant.revocationReason ? ` (${grant.revocationReason})` : ''}
        </span>
        <StatusBadge
          tone={grant.effective ? 'success' : 'neutral'}
          label={grant.effective ? 'Effective now' : 'Not effective'}
        />
      </div>
      {!revoked ? (
        <div className="form">
          <TextField
            label={`Reason to revoke ${grant.permission}`}
            value={reason}
            onChange={setReason}
            error={reasonError}
          />
          <Button
            variant="secondary"
            busy={revoke.isProcessing}
            disabled={!online}
            aria-label={`Revoke permission ${grant.permission}`}
            onClick={submit}
          >
            Revoke
          </Button>
          <CommandError error={revoke.error} onRetry={submit} onReload={revoke.reset} />
        </div>
      ) : null}
    </li>
  );
}

function AddGrant({
  relationship,
  held,
  onAdded,
}: {
  relationship: Relationship;
  held: readonly GrantPermission[];
  onAdded: (grant: AccessGrant) => void;
}) {
  const { online } = useApp();
  const [permission, setPermission] = useState('');
  const [error, setError] = useState<string | null>(null);
  const grant = useApiCommand('post', '/access-grants');
  const options = GRANT_PERMISSIONS.filter((p) => !held.includes(p.value));
  if (options.length === 0) return null;
  const submit = () => {
    if (!permission) {
      setError('Choose the one permission to grant.');
      return;
    }
    setError(null);
    void grant
      .submit({
        body: { relationshipId: relationship.id, permission: permission as GrantPermission },
      })
      .then((g) => {
        onAdded(g);
        setPermission('');
      })
      .catch(() => undefined);
  };
  return (
    <div className="form">
      <SelectField
        label="Grant one more permission"
        placeholder="Choose a permission"
        options={options}
        value={permission}
        onChange={setPermission}
        error={error}
      />
      <Button variant="secondary" busy={grant.isProcessing} disabled={!online} onClick={submit}>
        Grant permission
      </Button>
      <CommandError error={grant.error} onRetry={submit} />
    </div>
  );
}

function RecordedRelationshipCard({
  personId,
  item,
  onChange,
}: {
  personId: string;
  item: RecordedRelationship;
  onChange: (next: RecordedRelationship) => void;
}) {
  const r = item.relationship;
  const replaceGrant = (g: AccessGrant) =>
    onChange({ ...item, grants: item.grants.map((x) => (x.id === g.id ? g : x)) });
  return (
    <li className="panel" aria-label={`Relationship ${r.kind}`}>
      <h4>
        {r.kind} · <StatusBadge tone="info" label={`Status: ${r.status}`} />
      </h4>
      <p>
        <PersonLink id={r.actorPersonId} self={personId} /> holds this relationship over{' '}
        <PersonLink id={r.subjectPersonId} self={personId} />.
      </p>
      <Facts
        items={[
          ['Source', r.source],
          ['Effective from', formatDateTime(r.effectiveFrom)],
          ['Effective to', r.effectiveTo ? formatDateTime(r.effectiveTo) : 'Open-ended'],
          ['Reference', <code key="id">{r.id}</code>],
        ]}
      />
      {item.grants.length === 0 ? (
        <p>No permissions are granted on this relationship.</p>
      ) : (
        <ul className="list" aria-label="Permissions granted">
          {item.grants.map((g) => (
            <GrantRow key={g.id} grant={g} onChange={replaceGrant} />
          ))}
        </ul>
      )}
      <AddGrant
        relationship={r}
        held={item.grants.filter((g) => g.revokedAt === null).map((g) => g.permission)}
        onAdded={(g) => onChange({ ...item, grants: [...item.grants, g] })}
      />
    </li>
  );
}

function RelationshipForm({
  personId,
  onRecorded,
}: {
  personId: string;
  onRecorded: (r: RecordedRelationship) => void;
}) {
  const { online } = useApp();
  const [direction, setDirection] = useState<'actor' | 'subject'>('subject');
  const [other, setOther] = useState('');
  const [kind, setKind] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [success, setSuccess] = useState<string | null>(null);
  const create = useApiCommand('post', '/relationships');
  const apiErrors = fieldErrorsOf(create.error);

  const submit = () => {
    setSuccess(null);
    const problems: Record<string, string> = {};
    const otherProblem = referenceError(other, true);
    if (otherProblem) problems['other'] = otherProblem;
    else if (other.trim().toLowerCase() === personId.toLowerCase()) {
      problems['other'] = 'Choose a different person.';
    }
    if (!kind) problems['kind'] = 'Choose the kind of relationship.';
    const effectiveFrom = localInputToIso(from);
    const effectiveTo = localInputToIso(to);
    if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
      problems['to'] = 'The end must be after the start.';
    }
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    const otherId = other.trim().toLowerCase();
    void create
      .submit({
        body: {
          actorPersonId: direction === 'actor' ? personId : otherId,
          subjectPersonId: direction === 'actor' ? otherId : personId,
          kind: kind as RelationshipKind,
          permissions: permissions as GrantPermission[],
          ...(effectiveFrom ? { effectiveFrom } : {}),
          ...(effectiveTo ? { effectiveTo } : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        },
      })
      .then((result) => {
        const relationship = result.relationship;
        if (!relationship) return;
        onRecorded({ relationship, grants: result.grants });
        setSuccess(
          `Relationship recorded. State: ${relationship.status}, ${result.grants.length} permission(s) granted.`,
        );
        setOther('');
        setKind('');
        setPermissions([]);
        setFrom('');
        setTo('');
        setReason('');
      })
      .catch(() => undefined);
  };

  return (
    <section className="panel" aria-labelledby="relationship-form-title">
      <h3 id="relationship-form-title">Record a relationship</h3>
      <StateView
        variant="pending-decision"
        subject="Verifying a guardian relationship"
        decisions={['DEC-004']}
        owner="Operator/privacy owner"
      />
      <form
        noValidate
        className="form"
        aria-label="Record a relationship"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <RadioGroup
          legend="Who holds the relationship"
          name="direction"
          required
          value={direction}
          onChange={(v) => setDirection(v as 'actor' | 'subject')}
          options={[
            { value: 'subject', label: 'Another person holds it over this person' },
            { value: 'actor', label: 'This person holds it over another person' },
          ]}
        />
        <PersonReferenceField
          label="Other person reference"
          required
          value={other}
          onChange={setOther}
          error={errors['other'] ?? apiErrors['actorPersonId'] ?? apiErrors['subjectPersonId']}
        />
        <SelectField
          label="Kind"
          required
          placeholder="Choose a kind"
          options={RELATIONSHIP_KINDS}
          value={kind}
          onChange={setKind}
          error={errors['kind'] ?? apiErrors['kind']}
        />
        <CheckboxGroup
          legend="Permissions to grant"
          hint="Each permission is granted on its own and none implies another. A relationship can be recorded with none."
          options={GRANT_PERMISSIONS}
          value={permissions}
          onChange={setPermissions}
        />
        <TextField
          label="Effective from"
          type="datetime-local"
          hint="Leave empty to start now."
          value={from}
          onChange={setFrom}
          error={apiErrors['effectiveFrom']}
        />
        <TextField
          label="Effective to"
          type="datetime-local"
          hint="Leave empty for no end date."
          value={to}
          onChange={setTo}
          error={errors['to'] ?? apiErrors['effectiveTo']}
        />
        <TextAreaField
          label="Reason"
          hint="Kept with the audit record."
          value={reason}
          onChange={setReason}
          maxLength={2000}
        />
        <Button type="submit" busy={create.isProcessing} disabled={!online}>
          Record relationship
        </Button>
      </form>
      <CommandSuccess message={success} />
      <CommandError error={create.error} onRetry={submit} />
    </section>
  );
}

function HouseholdSection({ personId }: { personId: string }) {
  const { online } = useApp();
  const [name, setName] = useState('');
  const [existing, setExisting] = useState('');
  const [label, setLabel] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [household, setHousehold] = useState<Household | null>(null);
  const create = useApiCommand('post', '/households');
  const addMember = useApiCommand('post', '/households/{id}/members');

  const add = (householdId: string) =>
    addMember
      .submit({
        path: { id: householdId },
        body: { personId, ...(label.trim() ? { label: label.trim() } : {}) },
      })
      .then(setHousehold);

  const createAndAdd = () => {
    if (!name.trim()) {
      setErrors({ name: 'Name the household.' });
      return;
    }
    setErrors({});
    void create
      .submit({ body: { name: name.trim() } })
      .then((h) => {
        setHousehold(h);
        return add(h.id);
      })
      .catch(() => undefined);
  };
  const addToExisting = () => {
    if (!isUuid(existing)) {
      setErrors({ existing: 'Enter a household reference: 36 characters.' });
      return;
    }
    setErrors({});
    void add(existing.trim().toLowerCase()).catch(() => undefined);
  };
  const member = household?.members.some((m) => m.personId === personId);

  return (
    <section className="panel" aria-labelledby="household-title">
      <h3 id="household-title">Household</h3>
      <p className="caption">
        A household groups people. It never gives anyone authority over another person.
      </p>
      <div className="form">
        <TextField
          label="New household name"
          value={name}
          onChange={setName}
          error={errors['name']}
        />
        <TextField
          label="Label for this person in the household"
          hint="Optional, for example a role in the family."
          value={label}
          onChange={setLabel}
        />
        <Button
          variant="secondary"
          busy={create.isProcessing || addMember.isProcessing}
          disabled={!online}
          onClick={createAndAdd}
        >
          Create household with this person
        </Button>
        <TextField
          label="Existing household reference"
          value={existing}
          onChange={setExisting}
          error={errors['existing']}
        />
        <Button
          variant="secondary"
          busy={addMember.isProcessing}
          disabled={!online}
          onClick={addToExisting}
        >
          Add this person to the household
        </Button>
      </div>
      <CommandError error={create.error} onRetry={createAndAdd} />
      <CommandError error={addMember.error} />
      {household ? (
        <div aria-label="Household record">
          <p>
            {household.name} · <code>{household.id}</code> · {household.members.length} member(s)
          </p>
          {member ? <CommandSuccess message="This person is a member of the household." /> : null}
          <ul className="list" aria-label="Household members">
            {household.members.map((m) => (
              <li key={m.personId}>
                <PersonLink id={m.personId} self={personId} />
                <span className="caption">{m.label ?? 'No label'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function InvitationRecord({
  invitation,
  token,
  personId,
  onChange,
}: {
  invitation: Invitation;
  token: string | null;
  personId: string;
  onChange: (i: Invitation) => void;
}) {
  const { online } = useApp();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const revoke = useApiCommand('post', '/invitations/{id}/revoke');
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
      .then(onChange)
      .catch(() => undefined);
  };
  return (
    <div className="panel" aria-label="Invitation record">
      <StatusBadge tone="pending" label={`Status: ${invitation.status}`} />
      <Facts
        items={[
          [
            'Inviter',
            invitation.invitedByPersonId ? (
              <PersonLink key="inviter" id={invitation.invitedByPersonId} self={personId} />
            ) : (
              'Staff'
            ),
          ],
          [
            'Recipient',
            invitation.recipientPersonId ? (
              <PersonLink key="recipient" id={invitation.recipientPersonId} self={personId} />
            ) : invitation.recipientContact ? (
              `${invitation.recipientContact.kind}: ${invitation.recipientContact.value}`
            ) : (
              'Not named'
            ),
          ],
          [
            'Scope',
            invitation.scope.type === 'person'
              ? 'this person'
              : `household ${invitation.scope.householdId}`,
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
          ['Revoked', invitation.revokedAt ? formatDateTime(invitation.revokedAt) : 'No'],
        ]}
      />
      {token ? (
        <p>
          One-time invitation code, shown only now. Give it only to the recipient:{' '}
          <code>{token}</code>
        </p>
      ) : null}
      {invitation.status === 'pending' ? (
        <div className="form">
          <TextField
            label="Reason to revoke the invitation"
            value={reason}
            onChange={setReason}
            error={reasonError}
          />
          <Button
            variant="secondary"
            busy={revoke.isProcessing}
            disabled={!online}
            onClick={submit}
          >
            Revoke invitation
          </Button>
          <CommandError error={revoke.error} onRetry={submit} onReload={revoke.reset} />
        </div>
      ) : null}
    </div>
  );
}

function InvitationSection({ personId }: { personId: string }) {
  const { online } = useApp();
  const [recipientMode, setRecipientMode] = useState<'person' | 'contact'>('person');
  const [recipient, setRecipient] = useState('');
  const [contactKind, setContactKind] = useState('email');
  const [contactValue, setContactValue] = useState('');
  const [kind, setKind] = useState('');
  const [permissions, setPermissions] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [issued, setIssued] = useState<{ invitation: Invitation; token: string | null } | null>(
    null,
  );
  const invite = useApiCommand('post', '/invitations');
  const submit = () => {
    const problems: Record<string, string> = {};
    if (recipientMode === 'person') {
      const p = referenceError(recipient, true);
      if (p) problems['recipient'] = p;
    } else if (contactValue.trim().length < 3) {
      problems['contact'] = 'Enter the recipient’s email address or phone number.';
    }
    if (!kind) problems['kind'] = 'Choose the relationship the recipient would hold.';
    if (permissions.length === 0) problems['permissions'] = 'Request at least one permission.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    void invite
      .submit({
        // The invitation's expiry is the API's default (a pending policy value, never set here).
        body: withServerDefaults<Schema<'CreateInvitationRequest'>, 'expiresInHours'>({
          ...(recipientMode === 'person'
            ? { recipientPersonId: recipient.trim().toLowerCase() }
            : {
                recipientContact: {
                  kind: contactKind as 'email' | 'phone',
                  value: contactValue.trim(),
                },
              }),
          scope: { type: 'person', personId },
          relationshipKind: kind as 'guardian' | 'delegate' | 'caregiver',
          requestedPermissions: permissions as GrantPermission[],
        }),
      })
      .then((result) => {
        const { token, ...invitation } = result;
        setIssued({ invitation, token });
      })
      .catch(() => undefined);
  };
  return (
    <section className="panel" aria-labelledby="invitation-title">
      <h3 id="invitation-title">Invite someone to hold permissions over this person</h3>
      <p className="caption">
        An invitation grants nothing until the recipient accepts it, and then only what is still
        authorized.
      </p>
      <form
        noValidate
        className="form"
        aria-label="Create an invitation"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <RadioGroup
          legend="Recipient"
          name="recipient-mode"
          value={recipientMode}
          onChange={(v) => setRecipientMode(v as 'person' | 'contact')}
          options={[
            { value: 'person', label: 'A person already on record' },
            { value: 'contact', label: 'An email address or phone number' },
          ]}
        />
        {recipientMode === 'person' ? (
          <PersonReferenceField
            label="Recipient person reference"
            required
            value={recipient}
            onChange={setRecipient}
            error={errors['recipient']}
          />
        ) : (
          <>
            <SelectField
              label="Contact kind"
              options={[
                { value: 'email', label: 'email' },
                { value: 'phone', label: 'phone' },
              ]}
              value={contactKind}
              onChange={setContactKind}
            />
            <TextField
              label="Contact"
              required
              value={contactValue}
              onChange={setContactValue}
              error={errors['contact']}
            />
          </>
        )}
        <SelectField
          label="Relationship"
          required
          placeholder="Choose a relationship"
          options={RELATIONSHIP_KINDS.filter((k) => k.value !== 'self_managed')}
          value={kind}
          onChange={setKind}
          error={errors['kind']}
        />
        <CheckboxGroup
          legend="Requested permissions"
          hint="Choose each one; none implies another."
          options={GRANT_PERMISSIONS}
          value={permissions}
          onChange={setPermissions}
          error={errors['permissions']}
        />
        <Button type="submit" busy={invite.isProcessing} disabled={!online}>
          Create invitation
        </Button>
      </form>
      <CommandError error={invite.error} onRetry={submit} />
      {issued ? (
        <InvitationRecord
          invitation={issued.invitation}
          token={issued.token}
          personId={personId}
          onChange={(invitation) => setIssued({ invitation, token: null })}
        />
      ) : null}
    </section>
  );
}

function ViewScope({ personId }: { personId: string }) {
  const timeline = useApiQuery({
    path: '/customers/{personId}/timeline',
    request: { path: { personId }, query: { limit: 1 } },
  });
  return (
    <QueryBoundary
      query={timeline}
      label="the people this person may view"
      empty={{ title: '', description: '' }}
    >
      {(data) =>
        data.scope.dependents.length === 0 ? (
          <p>This person holds view over no one else right now.</p>
        ) : (
          <ul className="list" aria-label="People this person may view">
            {data.scope.dependents.map((d) => (
              <li key={d.id}>
                <Link to={`/people/${d.id}`}>{d.displayName}</Link>
                <span className="caption">
                  {d.kind} · status {d.status}
                </span>
              </li>
            ))}
          </ul>
        )
      }
    </QueryBoundary>
  );
}

function RelationshipsForPerson({ personId }: { personId: string }) {
  const { online } = useApp();
  const person = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
  const [recorded, setRecorded] = useState<RecordedRelationship[]>([]);
  return (
    <QueryBoundary
      query={person}
      label="the person"
      empty={{ title: '', description: '' }}
      unavailableOffline={['recording relationships, grants, households and invitations']}
    >
      {(data) => (
        <>
          <h3>
            <Link to={`/people/${personId}`}>{personName(data)}</Link>
          </h3>
          {!online ? (
            <p className="caption">
              Offline: relationships, permissions and households cannot be changed until you
              reconnect.
            </p>
          ) : null}
          <section className="panel" aria-labelledby="existing-title">
            <h3 id="existing-title">Recorded relationships and permissions</h3>
            <StateView
              variant="unavailable"
              title="The full list is not available yet"
              description="The API cannot list a person’s relationships, permissions, households or invitations yet. What you record here is shown below with its full record."
            />
            <h4>People this person may view</h4>
            <ViewScope personId={personId} />
          </section>
          {recorded.length > 0 ? (
            <ul className="list" aria-label="Recorded in this session">
              {recorded.map((item) => (
                <RecordedRelationshipCard
                  key={item.relationship.id}
                  personId={personId}
                  item={item}
                  onChange={(next) =>
                    setRecorded((list) =>
                      list.map((x) => (x.relationship.id === next.relationship.id ? next : x)),
                    )
                  }
                />
              ))}
            </ul>
          ) : null}
          <RelationshipForm
            personId={personId}
            onRecorded={(r) => setRecorded((list) => [r, ...list])}
          />
          <HouseholdSection personId={personId} />
          <InvitationSection personId={personId} />
        </>
      )}
    </QueryBoundary>
  );
}

export function RelationshipsScreen() {
  const { personId = '' } = useParams();
  return (
    <section aria-labelledby="relationships-title">
      <h2 id="relationships-title">Household, relationships and grants</h2>
      <PeopleNav />
      {isUuid(personId) ? (
        <RelationshipsForPerson personId={personId} />
      ) : (
        <StateView variant="unavailable" />
      )}
    </section>
  );
}
