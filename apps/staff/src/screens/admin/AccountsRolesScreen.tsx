/**
 * SCR-S-46 Accounts, roles and permissions (§2.1, §4.14, SPK-STAFF-004, SPK-IAM-006, DEC-018;
 * SPK-UX-008, SPK-UX-009). Staff role assignments with facility scope and time bounds:
 *
 * - your access: the principal's roles and facility scope and your own memberships (`GET /v1/me`);
 * - assign roles (`POST /v1/staff-memberships`), change roles, scope or end date
 *   (`PATCH /v1/staff-memberships/{id}` with `expectedRevision`) and end a membership immediately
 *   with a reason (`POST /v1/staff-memberships/{id}/end`); each with an Idempotency-Key per intent.
 *   The API audits every change and decides who may make it (ACCESS_DENIED is shown with its
 *   message); revocation takes effect for exports and sessions as the API enforces (SPK-IAM-006);
 * - multifactor status for privileged staff waits on the identity provider (DEC-018);
 * - the API lists neither staff accounts nor memberships nor the audit of privileged actions, so
 *   those parts are shown as not available yet (reported API gaps).
 * A child person record is never named here (§4.14).
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import {
  ApiGap,
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
  PendingNote,
  fieldErrorsOf,
} from '../../features/insight-admin/feedback';
import { CheckboxGroup, TextField } from '../../features/insight-admin/fields';
import {
  deviceTimeZone,
  formatInstant,
  localDateTimeToInstant,
  shortId,
  UUID_PATTERN,
} from '../../features/insight-admin/format';
import {
  DECISIONS,
  MEMBERSHIP_BADGES,
  STAFF_ROLES,
  roleLabel,
  type StaffRole,
} from '../../features/insight-admin/labels';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';

type StaffMembership = Schema<'StaffMembership'>;

const ROLE_OPTIONS = STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));
const ME_KEY = ['api', '/me'] as const;

function useFacilityName() {
  const { choices } = useFacilityChoices();
  return (id: string) => choices.find((c) => c.id === id)?.label ?? `Facility ${shortId(id)}`;
}

function scopeText(facilityIds: readonly string[], name: (id: string) => string): string {
  return facilityIds.length === 0 ? 'Whole organization' : facilityIds.map(name).join(', ');
}

function MembershipSummary({ membership }: { membership: StaffMembership }) {
  const name = useFacilityName();
  const badge = MEMBERSHIP_BADGES[membership.status];
  return (
    <div className="row-text">
      <span className="row-title">
        Membership {shortId(membership.id)}: {membership.roles.map(roleLabel).join(', ')}
      </span>
      <StatusBadge tone={badge.tone} label={badge.label} />
      <span className="caption">Facility scope: {scopeText(membership.facilityIds, name)}</span>
      <span className="caption">
        From {formatInstant(membership.effectiveFrom)}
        {membership.effectiveTo
          ? ` until ${formatInstant(membership.effectiveTo)}`
          : ', no end date'}{' '}
        · revision {membership.revision}
      </span>
    </div>
  );
}

function YourAccess() {
  const me = useApiQuery({ path: '/me' });
  const name = useFacilityName();
  return (
    <section className="ia-section" aria-labelledby="your-access-title">
      <h3 id="your-access-title">Your access</h3>
      <InsightQueryBoundary
        query={me}
        label="your access"
        empty={{ title: 'Not available', description: '' }}
      >
        {(data) => (
          <>
            <dl className="ia-dl">
              <dt>Roles</dt>
              <dd>
                {data.principal.staffRoles.length > 0
                  ? data.principal.staffRoles.map(roleLabel).join(', ')
                  : 'No staff role'}
              </dd>
              <dt>Facility scope</dt>
              <dd>{scopeText(data.principal.facilityIds, name)}</dd>
            </dl>
            {data.staffMemberships.length === 0 ? (
              <p className="caption">No staff membership is recorded for you.</p>
            ) : (
              <ul className="list" aria-label="Your staff memberships">
                {data.staffMemberships.map((membership) => (
                  <li key={membership.id}>
                    <MembershipSummary membership={membership} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </InsightQueryBoundary>
    </section>
  );
}

function PersonCheck({ personId }: { personId: string }) {
  const person = useApiQuery({
    path: '/people/{id}',
    request: { path: { id: personId } },
  });
  return (
    <InsightQueryBoundary
      query={person}
      label="the person record"
      empty={{ title: 'Not available', description: '' }}
    >
      {(data) =>
        data.kind === 'adult' ? (
          <p role="status">
            {data.givenName} {data.familyName} · adult ·{' '}
            <StatusBadge
              tone={data.status === 'active' ? 'success' : 'neutral'}
              label={data.status}
            />
          </p>
        ) : (
          <p role="status">
            <StatusBadge tone="warning" label="Not an adult person" /> Staff roles need an active
            adult person record.
          </p>
        )
      }
    </InsightQueryBoundary>
  );
}

interface AssignDraft {
  personId: string;
  roles: string[];
  facilityIds: string[];
  effectiveFrom: string;
  effectiveTo: string;
  reason: string;
}

const EMPTY_DRAFT: AssignDraft = {
  personId: '',
  roles: [],
  facilityIds: [],
  effectiveFrom: '',
  effectiveTo: '',
  reason: '',
};

function AssignRoles({ onSaved }: { onSaved: (membership: StaffMembership) => void }) {
  const { online } = useApp();
  // A failed read of the facility choices is shown, and assigning waits for it: an empty scope
  // would silently mean the whole organization (SPK-UX-008).
  const { choices, error: choicesError, refetch: refetchChoices } = useFacilityChoices();
  const [draft, setDraft] = useState<AssignDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checkedPerson, setCheckedPerson] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const assign = useApiCommand('post', '/staff-memberships', { invalidate: [ME_KEY] });
  const set = (patch: Partial<AssignDraft>) => {
    setSuccess(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  const build = () => {
    const next: Record<string, string> = {};
    const personId = draft.personId.trim();
    if (!UUID_PATTERN.test(personId)) next.personId = 'Enter the person id.';
    if (draft.roles.length === 0) next.roles = 'Choose at least one role.';
    const from = draft.effectiveFrom ? localDateTimeToInstant(draft.effectiveFrom) : null;
    const to = draft.effectiveTo ? localDateTimeToInstant(draft.effectiveTo) : null;
    if (draft.effectiveFrom && !from) next.effectiveFrom = 'Enter a valid start.';
    if (draft.effectiveTo && !to) next.effectiveTo = 'Enter a valid end.';
    if (from && to && to <= from) next.effectiveTo = 'The end must be after the start.';
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      personId,
      roles: draft.roles as StaffRole[],
      facilityIds: draft.facilityIds,
      ...(from ? { effectiveFrom: from } : {}),
      ...(to ? { effectiveTo: to } : {}),
      ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
    };
  };
  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void assign
      .submit({ body })
      .then((membership) => {
        onSaved(membership);
        setDraft(EMPTY_DRAFT);
        setCheckedPerson(null);
        setSuccess(`Membership ${shortId(membership.id)} ${membership.status}`);
      })
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const apiFields = fieldErrorsOf(assign.error);

  return (
    <form className="ia-form" onSubmit={submit} aria-label="Assign staff roles" noValidate>
      <h3>Assign staff roles</h3>
      <TextField
        label="Person id"
        required
        value={draft.personId}
        onChange={(personId) => {
          setCheckedPerson(null);
          set({ personId });
        }}
        hint="An active adult person record; find people under People and families."
        error={errors.personId ?? apiFields.personId}
      />
      <div>
        <Button
          variant="secondary"
          disabled={!online || !UUID_PATTERN.test(draft.personId.trim())}
          onClick={() => setCheckedPerson(draft.personId.trim())}
        >
          Check person
        </Button>
      </div>
      {checkedPerson ? <PersonCheck personId={checkedPerson} /> : null}
      <CheckboxGroup
        legend="Roles (required)"
        options={ROLE_OPTIONS}
        selected={draft.roles}
        onChange={(roles) => set({ roles })}
        error={errors.roles ?? apiFields.roles}
      />
      <CheckboxGroup
        legend="Facility scope"
        options={choices.map((c) => ({ value: c.id, label: c.label }))}
        selected={draft.facilityIds}
        onChange={(facilityIds) => set({ facilityIds })}
        hint="Leave every facility unticked for the whole organization."
        error={apiFields.facilityIds}
      />
      <TextField
        label="Effective from"
        type="datetime-local"
        value={draft.effectiveFrom}
        onChange={(effectiveFrom) => set({ effectiveFrom })}
        hint={`Leave empty to start now. Your time zone (${deviceTimeZone()}).`}
        error={errors.effectiveFrom ?? apiFields.effectiveFrom}
      />
      <TextField
        label="Effective until"
        type="datetime-local"
        value={draft.effectiveTo}
        onChange={(effectiveTo) => set({ effectiveTo })}
        hint="Leave empty for no end date; set one for a time-bounded assignment."
        error={errors.effectiveTo ?? apiFields.effectiveTo}
      />
      <TextField
        label="Reason"
        value={draft.reason}
        onChange={(reason) => set({ reason })}
        hint="Recorded in the audit with the change."
      />
      <div>
        <Button type="submit" busy={assign.isProcessing} disabled={!online || !!choicesError}>
          Assign roles
        </Button>
      </div>
      {choicesError ? (
        <>
          <p className="caption">
            The facilities could not be read, so a facility scope cannot be chosen yet.
          </p>
          <CommandError error={choicesError} onRetry={refetchChoices} />
        </>
      ) : null}
      {!online ? <p className="caption">Changing staff roles needs a connection.</p> : null}
      <CommandSuccess message={success} />
      <CommandError
        error={assign.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
      />
    </form>
  );
}

function StaleNote({ error }: { error: { isStale: boolean } | null }) {
  if (!error?.isStale) return null;
  return (
    <p className="caption">
      This membership changed since it was shown here. The API offers no read of a single
      membership, so it cannot be reloaded on this page; your entries are kept. To start again, open
      the person&apos;s current memberships from their staff record, or end this one and assign a
      new one.
    </p>
  );
}

function ChangeMembership({
  membership,
  onSaved,
}: {
  membership: StaffMembership;
  onSaved: (membership: StaffMembership) => void;
}) {
  const { online } = useApp();
  const { choices } = useFacilityChoices();
  const [roles, setRoles] = useState<string[]>(membership.roles);
  const [facilityIds, setFacilityIds] = useState<string[]>(membership.facilityIds);
  const [until, setUntil] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const change = useApiCommand('patch', '/staff-memberships/{id}', { invalidate: [ME_KEY] });
  const build = () => {
    const next: Record<string, string> = {};
    if (roles.length === 0) next.roles = 'Keep at least one role, or end the membership.';
    const to = until ? localDateTimeToInstant(until) : null;
    if (until && !to) next.until = 'Enter a valid end.';
    setErrors(next);
    if (Object.keys(next).length > 0) return null;
    return {
      roles: roles as StaffRole[],
      facilityIds,
      ...(to ? { effectiveTo: to } : {}),
      expectedRevision: membership.revision,
    };
  };
  const send = (body: NonNullable<ReturnType<typeof build>>) =>
    void change
      .submit({ path: { id: membership.id }, body })
      .then(onSaved)
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  return (
    <form
      className="ia-form"
      onSubmit={submit}
      aria-label={`Change membership ${shortId(membership.id)}`}
      noValidate
    >
      <CheckboxGroup
        legend="Roles (required)"
        options={ROLE_OPTIONS}
        selected={roles}
        onChange={setRoles}
        error={errors.roles}
      />
      <CheckboxGroup
        legend="Facility scope"
        options={choices.map((c) => ({ value: c.id, label: c.label }))}
        selected={facilityIds}
        onChange={setFacilityIds}
        hint="Leave every facility unticked for the whole organization."
      />
      <TextField
        label="New end"
        type="datetime-local"
        value={until}
        onChange={setUntil}
        hint="Leave empty to keep the current end."
        error={errors.until}
      />
      <div>
        <Button type="submit" busy={change.isProcessing} disabled={!online}>
          Save changes
        </Button>
      </div>
      <CommandError
        error={change.error}
        onRetry={() => {
          const body = build();
          if (body) send(body);
        }}
      />
      <StaleNote error={change.error} />
    </form>
  );
}

function EndMembership({
  membership,
  onSaved,
}: {
  membership: StaffMembership;
  onSaved: (membership: StaffMembership) => void;
}) {
  const { online } = useApp();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const end = useApiCommand('post', '/staff-memberships/{id}/end', { invalidate: [ME_KEY] });
  const send = () =>
    void end
      // The membership's revision: a concurrent change by another administrator is refused
      // (STALE_REVISION), never silently overridden (§4.9).
      .submit({
        path: { id: membership.id },
        body: { reason: reason.trim(), expectedRevision: membership.revision },
      })
      .then(onSaved)
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!reason.trim()) {
      setError('Enter the reason for ending this membership.');
      return;
    }
    setError(null);
    send();
  };
  return (
    <form
      className="ia-form"
      onSubmit={submit}
      aria-label={`End membership ${shortId(membership.id)}`}
      noValidate
    >
      <TextField
        label="Reason for ending"
        required
        value={reason}
        onChange={setReason}
        error={error}
      />
      <div>
        <Button type="submit" busy={end.isProcessing} disabled={!online}>
          End membership now
        </Button>
      </div>
      <CommandError error={end.error} onRetry={send} />
      <StaleNote error={end.error} />
    </form>
  );
}

function ChangedMembership({
  membership,
  onSaved,
}: {
  membership: StaffMembership;
  onSaved: (membership: StaffMembership) => void;
}) {
  const [mode, setMode] = useState<'view' | 'change' | 'end'>('view');
  const saved = (next: StaffMembership) => {
    setMode('view');
    onSaved(next);
  };
  return (
    <li>
      <MembershipSummary membership={membership} />
      {membership.status === 'active' ? (
        <div className="ia-row-actions">
          <Button
            variant="secondary"
            aria-expanded={mode === 'change'}
            onClick={() => setMode(mode === 'change' ? 'view' : 'change')}
          >
            Change roles or scope
          </Button>
          <Button
            variant="secondary"
            aria-expanded={mode === 'end'}
            onClick={() => setMode(mode === 'end' ? 'view' : 'end')}
          >
            End membership
          </Button>
        </div>
      ) : null}
      {mode === 'change' ? (
        <ChangeMembership key={membership.revision} membership={membership} onSaved={saved} />
      ) : null}
      {mode === 'end' ? <EndMembership membership={membership} onSaved={saved} /> : null}
    </li>
  );
}

export function AccountsRolesScreen() {
  const [changed, setChanged] = useState<StaffMembership[]>([]);
  const upsert = (membership: StaffMembership) =>
    setChanged((list) => [membership, ...list.filter((m) => m.id !== membership.id)]);
  return (
    <section aria-labelledby="accounts-title" className="ia-screen">
      <h2 id="accounts-title">Accounts, roles and permissions</h2>
      <YourAccess />
      <PendingNote
        decisions={DECISIONS.identityProvider.ids}
        owner={DECISIONS.identityProvider.owner}
      >
        Multifactor status for privileged staff is not shown: it is enforced by the managed identity
        provider, which is not selected, and which roles count as privileged is not decided.
      </PendingNote>
      <ApiGap title="Staff accounts and role assignments">
        The API does not list staff accounts or memberships yet. A membership can be changed here
        right after it is assigned on this page.
      </ApiGap>
      <AssignRoles onSaved={upsert} />
      <section className="ia-section" aria-labelledby="changed-title">
        <h3 id="changed-title">Memberships changed on this page</h3>
        {changed.length === 0 ? (
          <StateView
            variant="empty"
            title="No changes yet"
            description="Memberships you assign, change or end here appear in this list with their state."
          />
        ) : (
          <ul className="list" aria-label="Memberships changed on this page">
            {changed.map((membership) => (
              <ChangedMembership key={membership.id} membership={membership} onSaved={upsert} />
            ))}
          </ul>
        )}
      </section>
      <ApiGap title="Audit of privileged actions">
        The API records every role change and privileged action in its audit, but has no endpoint to
        read the audit yet.
      </ApiGap>
    </section>
  );
}
