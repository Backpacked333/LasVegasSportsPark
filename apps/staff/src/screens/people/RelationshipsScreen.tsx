/**
 * SCR-S-21 Household, relationships and grants (SPK-IAM-001, SPK-IAM-003, SPK-IAM-004,
 * SPK-IAM-005, SPK-IAM-006, SPK-AT-017, DEC-004).
 *
 * - The person's authority from `GET /v1/people/{id}/authority`: every relationship in both
 *   directions with its parties (names from `GET /v1/person-names`), source and dates; each grant
 *   on it with the API's state at its clock (effective, scheduled, suspended, revoked, ended) and
 *   whether a disputed-access review restricts it ("under review"); the households the person
 *   belongs to (grouping only, never authority) and the pending invitations that concern them.
 *   An empty authority says so.
 * - Every grant is revoked individually with a reason and the grant's expected revision;
 *   revocation affects every later check (SPK-IAM-006). STALE_REVISION offers "Reload", which
 *   re-reads the authority. One more permission is granted on a relationship one at a time.
 * - Relationships are recorded with each permission chosen on its own; nothing is pre-selected and
 *   no permission implies another (SPK-IAM-003). All of these are privileged, audited commands
 *   the API authorizes; after each, the authority is read again.
 * - Invitations show their full record (SPK-IAM-004, `InvitationCard`); the expiry is the API's.
 *   The invitations covering the person, in any state, are listed from `GET /v1/invitations`.
 * - Guardian verification is DEC-004 (pending): the screen says so and records relationships with
 *   the staff source the API assigns. Offline, every change is unavailable (§4.15).
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { withServerDefaults } from '../../api/server-defaults';
import {
  INVITATION_LIST_KEYS,
  InvitationCard,
  revokedMessage,
  type Invitation,
} from '../../features/people/InvitationCard';
import { PersonName, usePeopleNames, type PeopleNames } from '../../features/people/names';
import { PeopleNav } from '../../features/people/PeopleNav';
import { PersonReferenceField, referenceError } from '../../features/people/PersonReferenceField';
import {
  GRANT_PERMISSIONS,
  GRANT_STATUS_TONE,
  INVITATION_STATUSES,
  RELATIONSHIP_KINDS,
  displayName,
  type GrantPermission,
  type InvitationStatus,
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
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { isUuid } from '../../ui/RecordRef';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { formatDateTime, localInputToIso } from '../../ui/time';
import { AUTHORITY_KEY } from './PersonRecordScreen';

/** The OpenAPI component is nullable (it is reused as a nullable field elsewhere); a created one is not. */
type Relationship = NonNullable<Schema<'Relationship'>>;
type GrantView = Schema<'GrantView'>;
type Household = Schema<'Household'>;
type PersonAuthority = Schema<'PersonAuthority'>;

export const INVITATION_HISTORY_PAGE = 20;
const ENDED_GRANT_STATES: ReadonlySet<GrantView['status']> = new Set(['revoked', 'ended']);

/** Re-read the person's authority after a change (or to load a newer version). */
function useRefreshAuthority() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: AUTHORITY_KEY });
}

function GrantRow({ grant }: { grant: GrantView }) {
  const { online } = useApp();
  const refresh = useRefreshAuthority();
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const revoke = useApiCommand('post', '/access-grants/{id}/revoke', {
    invalidate: [AUTHORITY_KEY],
  });
  const submit = () => {
    if (!reason.trim()) {
      setReasonError('Write why this permission is revoked.');
      return;
    }
    setReasonError(null);
    void revoke
      .submit({
        path: { id: grant.grantId },
        body: { expectedRevision: grant.revision, reason: reason.trim() },
      })
      .then(() => {
        setSuccess(`Permission ${grant.permission} revoked.`);
        setReason('');
      })
      .catch(() => undefined);
  };
  // STALE_REVISION or INVALID_TRANSITION: re-read the authority; the reason stays typed.
  const reload = () => {
    revoke.reset();
    void refresh();
  };
  const revocable = !ENDED_GRANT_STATES.has(grant.status);
  return (
    <li aria-label={`Permission ${grant.permission}`}>
      <div className="row-text">
        <span className="row-title">{grant.permission}</span>
        <span className="caption">
          source {grant.source} · from {formatDateTime(grant.effectiveFrom)}
          {grant.effectiveTo ? ` to ${formatDateTime(grant.effectiveTo)}` : ''}
          {grant.revokedAt ? ` · revoked ${formatDateTime(grant.revokedAt)}` : ''}
        </span>
        <span className="actions-row">
          <StatusBadge tone={GRANT_STATUS_TONE[grant.status]} label={`State: ${grant.status}`} />
          {grant.underReview ? (
            <StatusBadge tone="warning" label="Under review: restricted by an access review" />
          ) : null}
        </span>
      </div>
      <CommandSuccess message={success} />
      {revocable && online ? (
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
            aria-label={`Revoke permission ${grant.permission}`}
            onClick={submit}
          >
            Revoke
          </Button>
        </div>
      ) : null}
      <CommandError error={revoke.error} onRetry={submit} onReload={reload} />
    </li>
  );
}

function AddGrant({
  relationship,
  held,
}: {
  relationship: Relationship;
  held: readonly GrantPermission[];
}) {
  const { online } = useApp();
  const [permission, setPermission] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const grant = useApiCommand('post', '/access-grants', { invalidate: [AUTHORITY_KEY] });
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
        setSuccess(`Permission ${g.permission} granted.`);
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
      <CommandSuccess message={success} />
      <CommandError error={grant.error} onRetry={submit} />
    </div>
  );
}

function RelationshipCard({
  personId,
  relationship: r,
  grants,
  names,
}: {
  personId: string;
  relationship: Relationship;
  grants: readonly GrantView[];
  names: PeopleNames;
}) {
  const { online } = useApp();
  return (
    <li className="panel" aria-label={`Relationship ${r.kind}`}>
      <h4>
        {r.kind} · <StatusBadge tone="info" label={`Status: ${r.status}`} />
      </h4>
      <p>
        <PersonName id={r.actorPersonId} names={names} self={personId} /> holds this relationship
        over <PersonName id={r.subjectPersonId} names={names} self={personId} />.
      </p>
      <Facts
        items={[
          ['Source', r.source],
          ['Effective from', formatDateTime(r.effectiveFrom)],
          ['Effective to', r.effectiveTo ? formatDateTime(r.effectiveTo) : 'Open-ended'],
          ['Reference', <code key="id">{r.id}</code>],
        ]}
      />
      {grants.length === 0 ? (
        <p>No permissions are granted on this relationship.</p>
      ) : (
        <ul className="list" aria-label="Permissions granted">
          {grants.map((g) => (
            <GrantRow key={g.grantId} grant={g} />
          ))}
        </ul>
      )}
      {r.status === 'active' && online ? (
        <AddGrant
          relationship={r}
          held={grants.filter((g) => !ENDED_GRANT_STATES.has(g.status)).map((g) => g.permission)}
        />
      ) : null}
    </li>
  );
}

function AuthorityView({ personId, authority }: { personId: string; authority: PersonAuthority }) {
  // Announced here: a revoked invitation leaves the pending list on the next read.
  const [invitationOutcome, setInvitationOutcome] = useState<string | null>(null);
  const relationships = authority.relationships.filter((r): r is Relationship => r !== null);
  const names = usePeopleNames(
    relationships
      .flatMap((r) => [r.actorPersonId, r.subjectPersonId])
      .filter((id) => id !== personId),
  );
  return (
    <>
      <section className="panel" aria-labelledby="existing-title">
        <h3 id="existing-title">Recorded relationships and permissions</h3>
        {relationships.length === 0 ? (
          <StateView
            variant="empty"
            title="No relationships"
            description="No relationship is recorded for this person, in either direction."
          />
        ) : (
          <ul className="list" aria-label="Relationships">
            {relationships.map((r) => (
              <RelationshipCard
                key={r.id}
                personId={personId}
                relationship={r}
                grants={authority.grants.filter((g) => g.relationshipId === r.id)}
                names={names}
              />
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="households-title">
        <h3 id="households-title">Households</h3>
        <p className="caption">
          A household groups people. It never gives anyone authority over another person.
        </p>
        {authority.households.length === 0 ? (
          <p>This person is not a member of any household.</p>
        ) : (
          <ul className="list" aria-label="Households of this person">
            {authority.households.map((h) => (
              <li key={h.id}>
                <span>
                  {h.name} · {h.memberCount} member(s)
                </span>
                <code>{h.id}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="pending-invitations-title">
        <h3 id="pending-invitations-title">Pending invitations</h3>
        <CommandSuccess message={invitationOutcome} />
        {authority.pendingInvitations.length === 0 ? (
          <p>No pending invitation concerns this person.</p>
        ) : (
          <ul className="list" aria-label="Pending invitations">
            {authority.pendingInvitations.map((i) => (
              <li key={i.id}>
                <InvitationCard
                  invitation={i}
                  self={personId}
                  onRevoked={(next) => setInvitationOutcome(revokedMessage(next))}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AuthoritySection({ personId }: { personId: string }) {
  const authority = useApiQuery({
    path: '/people/{id}/authority',
    request: { path: { id: personId } },
  });
  return (
    <QueryBoundary
      query={authority}
      label="the person’s relationships, permissions and households"
      empty={{ title: '', description: '' }}
      unavailableOffline={['revoking and granting permissions']}
    >
      {(data) => <AuthorityView personId={personId} authority={data} />}
    </QueryBoundary>
  );
}

function RelationshipForm({ personId }: { personId: string }) {
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
  const create = useApiCommand('post', '/relationships', { invalidate: [AUTHORITY_KEY] });
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
  const addMember = useApiCommand('post', '/households/{id}/members', {
    invalidate: [AUTHORITY_KEY],
  });

  /** The household the last add was for, so "Try again" re-sends that same add (same intent). */
  const [addTarget, setAddTarget] = useState<string | null>(null);
  const add = (householdId: string) => {
    setAddTarget(householdId);
    return addMember
      .submit({
        path: { id: householdId },
        body: { personId, ...(label.trim() ? { label: label.trim() } : {}) },
      })
      .then(setHousehold);
  };

  const createAndAdd = () => {
    // A household created here whose add failed: only the add is sent again, never a second
    // household (SCR-S-21, partial completion not permitted).
    if (household && !household.members.some((m) => m.personId === personId)) {
      void add(household.id).catch(() => undefined);
      return;
    }
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
      <h3 id="household-title">Add to a household</h3>
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
          {household && !household.members.some((m) => m.personId === personId)
            ? `Add this person to ${household.name}`
            : 'Create household with this person'}
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
      <CommandError
        error={addMember.error}
        onRetry={() => {
          const target = addTarget ?? household?.id ?? null;
          if (target) void add(target).catch(() => undefined);
        }}
      />
      {household ? (
        <div aria-label="Household record">
          <p>
            {household.name} · <code>{household.id}</code> · {household.members.length} member(s)
          </p>
          {member ? <CommandSuccess message="This person is a member of the household." /> : null}
          <ul className="list" aria-label="Household members">
            {household.members.map((m) => (
              <li key={m.personId}>
                {m.personId === personId ? (
                  <span>this person</span>
                ) : (
                  <Link to={`/people/${m.personId}`}>Open the member’s record</Link>
                )}
                <span className="caption">{m.label ?? 'No label'}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
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
  const [issuedOutcome, setIssuedOutcome] = useState<string | null>(null);
  const invite = useApiCommand('post', '/invitations', { invalidate: INVITATION_LIST_KEYS });
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
      <CommandSuccess message={issuedOutcome} />
      {issued ? (
        <InvitationCard
          invitation={issued.invitation}
          token={issued.token}
          self={personId}
          onRevoked={(invitation) => {
            setIssued({ invitation, token: null });
            setIssuedOutcome(revokedMessage(invitation));
          }}
        />
      ) : null}
    </section>
  );
}

function InvitationHistoryList({ personId, status }: { personId: string; status: string }) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const pages = useApiPages({
    path: '/invitations',
    request: {
      query: {
        scopePersonId: personId,
        limit: INVITATION_HISTORY_PAGE,
        ...(status ? { status: status as InvitationStatus } : {}),
      },
    },
  });
  return (
    <>
      <CommandSuccess message={outcome} />
      <QueryBoundary
        query={pages}
        label="the invitations covering this person"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No invitations',
          description: status
            ? `No ${status} invitation covers this person.`
            : 'No invitation has covered this person.',
        }}
      >
        {(items) => (
          <ul className="list" aria-label="Invitations covering this person">
            {items.map((i) => (
              <li key={i.id}>
                <InvitationCard
                  invitation={i}
                  self={personId}
                  onRevoked={(next) => setOutcome(revokedMessage(next))}
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

/** Every invitation that covers the person, in any state (`GET /v1/invitations?scopePersonId`). */
function InvitationHistory({ personId }: { personId: string }) {
  const permissions = usePermissions();
  const [status, setStatus] = useState('');
  const permitted = permissions.isPermitted('identity.read_invitations');
  return (
    <section className="panel" aria-labelledby="invitation-history-title">
      <h3 id="invitation-history-title">Invitations covering this person</h3>
      {permitted === false ? (
        <p className="caption">The invitation history is not available to you.</p>
      ) : (
        <>
          <SelectField
            label="Invitation status"
            placeholder="Any status"
            options={INVITATION_STATUSES.map((s) => ({ value: s, label: s }))}
            value={status}
            onChange={setStatus}
          />
          <InvitationHistoryList key={status} personId={personId} status={status} />
        </>
      )}
    </section>
  );
}

function RelationshipsForPerson({ personId }: { personId: string }) {
  const { online } = useApp();
  const person = useApiQuery({ path: '/people/{id}', request: { path: { id: personId } } });
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
            <Link to={`/people/${personId}`}>{displayName(data)}</Link>
          </h3>
          {!online ? (
            <p className="caption">
              Offline: relationships, permissions and households cannot be changed until you
              reconnect.
            </p>
          ) : null}
          <AuthoritySection personId={personId} />
          <RelationshipForm personId={personId} />
          <HouseholdSection personId={personId} />
          <InvitationSection personId={personId} />
          <InvitationHistory personId={personId} />
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
