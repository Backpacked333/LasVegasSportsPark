/**
 * SCR-S-46 Accounts, roles and permissions (§2.1, §4.14, SPK-STAFF-004, SPK-IAM-006, DEC-018;
 * SPK-UX-008, SPK-UX-009). Staff role assignments with facility scope and time bounds:
 *
 * - your access: the principal's roles and facility scope and your own memberships (`GET /v1/me`);
 * - the organization's staff memberships (`GET /v1/staff-memberships`, ID-05) by person, role,
 *   facility and status, newest first with the API's cursor, each with the person's display name
 *   as the API returns it; "first administrator" is the empty state;
 * - assign roles (`POST /v1/staff-memberships`), change roles, scope or end date
 *   (`PATCH /v1/staff-memberships/{id}` with `expectedRevision`) and end a membership immediately
 *   with a reason (`POST /v1/staff-memberships/{id}/end`); each with an Idempotency-Key per intent.
 *   They are offered when `GET /v1/me/permissions` lists `identity.manage_staff_membership`
 *   (system administrators); the API still decides and its ACCESS_DENIED is shown with its message.
 *   A STALE_REVISION offers "Reload", which re-reads that membership
 *   (`GET /v1/staff-memberships/{id}`) and keeps what was typed;
 * - audited privileged actions: each membership's audit history on request and the audit records
 *   browser (`GET /v1/audit-records`, itself audited); revocation takes effect for exports and
 *   sessions as the API enforces (SPK-IAM-006);
 * - multifactor status for privileged staff waits on the identity provider (DEC-018).
 * A child person record is never named here (§4.14); filters stay in page state, not the address.
 */
import type { Schema } from '@sportspark/api-client';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { AuditTrail } from '../../features/insight-admin/audit';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import {
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
  PendingNote,
  fieldErrorsOf,
} from '../../features/insight-admin/feedback';
import { CheckboxGroup, SelectField, TextField } from '../../features/insight-admin/fields';
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
import { AdminNav } from '../../features/insight-admin/nav';
import { useApp } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge } from '../../ui/StatusBadge';

type StaffMembership = Schema<'StaffMembership'>;
type StaffMembershipView = Schema<'StaffMembershipView'>;

const ROLE_OPTIONS = STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));
const ME_KEY = ['api', '/me'] as const;
const MEMBERSHIPS_KEY = ['api', '/staff-memberships'] as const;
const MEMBERSHIP_KEY = ['api', '/staff-memberships/{id}'] as const;
const INVALIDATE = [ME_KEY, MEMBERSHIPS_KEY, MEMBERSHIP_KEY] as const;
const MANAGE_ACTION = 'identity.manage_staff_membership';

function useFacilityName() {
  const { choices } = useFacilityChoices();
  return (id: string) => choices.find((c) => c.id === id)?.label ?? `Facility ${shortId(id)}`;
}

function scopeText(facilityIds: readonly string[], name: (id: string) => string): string {
  return facilityIds.length === 0 ? 'Whole organization' : facilityIds.map(name).join(', ');
}

function MembershipSummary({
  membership,
  personName,
}: {
  membership: StaffMembership;
  /** The display name the API returned with the membership (null: not available to you). */
  personName?: string | null;
}) {
  const name = useFacilityName();
  const badge = MEMBERSHIP_BADGES[membership.status];
  return (
    <div className="row-text">
      <span className="row-title" id={`membership-${membership.id}`}>
        {personName !== undefined ? `${personName ?? 'Name not available'} · ` : ''}
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

function AssignRoles() {
  const { online } = useApp();
  // A failed read of the facility choices is shown, and assigning waits for it: an empty scope
  // would silently mean the whole organization (SPK-UX-008).
  const { choices, error: choicesError, refetch: refetchChoices } = useFacilityChoices();
  const [draft, setDraft] = useState<AssignDraft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [checkedPerson, setCheckedPerson] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const assign = useApiCommand('post', '/staff-memberships', { invalidate: INVALIDATE });
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

function ChangeMembership({
  membership,
  onSaved,
  onReload,
}: {
  membership: StaffMembership;
  onSaved: () => void;
  /** Re-read this membership after STALE_REVISION; the form keeps what was typed. */
  onReload: () => void;
}) {
  const { online } = useApp();
  const { choices } = useFacilityChoices();
  const [roles, setRoles] = useState<string[]>(membership.roles);
  const [facilityIds, setFacilityIds] = useState<string[]>(membership.facilityIds);
  const [until, setUntil] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const change = useApiCommand('patch', '/staff-memberships/{id}', { invalidate: INVALIDATE });
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
      .then(() => onSaved())
      .catch(() => undefined);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body = build();
    if (body) send(body);
  };
  const reload = () => {
    change.reset();
    onReload();
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
        onReload={reload}
      />
    </form>
  );
}

function EndMembership({
  membership,
  onSaved,
  onReload,
}: {
  membership: StaffMembership;
  onSaved: () => void;
  onReload: () => void;
}) {
  const { online } = useApp();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const end = useApiCommand('post', '/staff-memberships/{id}/end', { invalidate: INVALIDATE });
  const send = () =>
    void end
      // The membership's revision: a concurrent change by another administrator is refused
      // (STALE_REVISION), never silently overridden (§4.9).
      .submit({
        path: { id: membership.id },
        body: { reason: reason.trim(), expectedRevision: membership.revision },
      })
      .then(() => onSaved())
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
      <CommandError
        error={end.error}
        onRetry={send}
        onReload={() => {
          end.reset();
          onReload();
        }}
      />
    </form>
  );
}

function MembershipRow({ item, canManage }: { item: StaffMembershipView; canManage: boolean }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<'view' | 'change' | 'end'>('view');
  const [reloaded, setReloaded] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  // After STALE_REVISION: the membership as it stands now (ID-05 single read), so the next attempt
  // carries the current revision.
  const fresh = useApiQuery({
    path: '/staff-memberships/{id}',
    request: { path: { id: item.id } },
    enabled: reloaded,
  });
  const membership: StaffMembershipView = fresh.data ?? item;
  const reload = () => {
    setReloaded(true);
    void queryClient.invalidateQueries({ queryKey: MEMBERSHIP_KEY });
  };
  const saved = (what: string) => () => {
    setMode('view');
    setSuccess(what);
  };
  return (
    <li aria-labelledby={`membership-${membership.id}`}>
      <MembershipSummary membership={membership} personName={membership.personDisplayName} />
      {fresh.error ? <CommandError error={fresh.error} onRetry={reload} /> : null}
      {reloaded && fresh.data ? (
        <p className="caption" role="status">
          Reloaded: revision {fresh.data.revision}. Your entries are kept; review them and save
          again.
        </p>
      ) : null}
      <CommandSuccess message={success} />
      {membership.status === 'active' && canManage ? (
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
      {mode === 'change' && membership.status === 'active' ? (
        <ChangeMembership
          membership={membership}
          onSaved={saved('Changes saved')}
          onReload={reload}
        />
      ) : null}
      {mode === 'end' && membership.status === 'active' ? (
        <EndMembership
          membership={membership}
          onSaved={saved('Membership ended')}
          onReload={reload}
        />
      ) : null}
      <AuditTrail
        targetType="staff_membership"
        targetId={membership.id}
        subject={`membership ${shortId(membership.id)}`}
      />
    </li>
  );
}

interface ListFilters {
  personId?: string;
  role?: StaffRole;
  facilityId?: string;
  status?: 'active' | 'ended';
}

function MembershipPages({ filters, canManage }: { filters: ListFilters; canManage: boolean }) {
  const pages = useApiPages({
    path: '/staff-memberships',
    request: { query: { limit: 25, ...filters } },
  });
  const filtered = Object.keys(filters).length > 0;
  return (
    <>
      <InsightQueryBoundary
        query={pages}
        label="staff memberships"
        isEmpty={(items) => items.length === 0}
        empty={
          filtered
            ? {
                title: 'No membership matches',
                description: 'No staff membership matches these filters.',
              }
            : {
                title: 'No staff memberships yet',
                description:
                  'This organization has no staff membership yet; the first system administrator assigns the first roles.',
              }
        }
        unavailableOffline={['assigning, changing or ending roles']}
        deniedDescription="Listing staff memberships is for the general manager and system administration."
      >
        {(items) => (
          <ul className="list" aria-label="Staff memberships">
            {items.map((item) => (
              <MembershipRow key={item.id} item={item} canManage={canManage} />
            ))}
          </ul>
        )}
      </InsightQueryBoundary>
      <LoadMore pages={pages} label="staff memberships" />
    </>
  );
}

function StaffMemberships({ canManage }: { canManage: boolean }) {
  const { choices } = useFacilityChoices();
  const [personId, setPersonId] = useState('');
  const [role, setRole] = useState('');
  const [facilityId, setFacilityId] = useState('');
  const [status, setStatus] = useState('active');
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ListFilters>({ status: 'active' });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const person = personId.trim();
    if (person && !UUID_PATTERN.test(person)) {
      setError('Enter a full person id.');
      return;
    }
    setError(null);
    setApplied({
      ...(person ? { personId: person } : {}),
      ...(role ? { role: role as StaffRole } : {}),
      ...(facilityId ? { facilityId } : {}),
      ...(status ? { status: status as 'active' | 'ended' } : {}),
    });
  };
  return (
    <section className="ia-section" aria-labelledby="memberships-title">
      <h3 id="memberships-title">Staff role assignments</h3>
      <form
        className="ia-inline-form"
        onSubmit={submit}
        aria-label="Filter staff memberships"
        noValidate
      >
        <TextField label="Person id" value={personId} onChange={setPersonId} error={error} />
        <SelectField
          label="Role"
          value={role}
          onChange={setRole}
          placeholder="All roles"
          options={ROLE_OPTIONS}
        />
        <SelectField
          label="Facility"
          value={facilityId}
          onChange={setFacilityId}
          placeholder="Any facility"
          options={choices.map((c) => ({ value: c.id, label: c.label }))}
          hint="Memberships scoped to it or to the whole organization."
        />
        <SelectField
          label="Status"
          value={status}
          onChange={setStatus}
          placeholder="Any status"
          options={[
            { value: 'active', label: 'active' },
            { value: 'ended', label: 'ended' },
          ]}
        />
        <Button type="submit" variant="secondary">
          Show memberships
        </Button>
      </form>
      <MembershipPages key={JSON.stringify(applied)} filters={applied} canManage={canManage} />
    </section>
  );
}

function ManageAccess({ children }: { children: (canManage: boolean) => ReactNode }) {
  const permissions = usePermissions();
  const allowed = permissions.isPermitted(MANAGE_ACTION);
  return (
    <>
      {allowed === false ? (
        <p className="caption">
          Assigning, changing and ending staff roles is not available to you: it is for system
          administrators.
        </p>
      ) : null}
      {allowed === undefined && permissions.query.error ? (
        <CommandError
          error={permissions.query.error}
          onRetry={() => void permissions.query.refetch()}
        />
      ) : null}
      {children(allowed === true)}
    </>
  );
}

export function AccountsRolesScreen() {
  return (
    <section aria-labelledby="accounts-title" className="ia-screen">
      <h2 id="accounts-title">Accounts, roles and permissions</h2>
      <AdminNav />
      <YourAccess />
      <PendingNote
        decisions={DECISIONS.identityProvider.ids}
        owner={DECISIONS.identityProvider.owner}
      >
        Multifactor status for privileged staff is not shown: it is enforced by the managed identity
        provider, which is not selected, and which roles count as privileged is not decided.
      </PendingNote>
      <ManageAccess>
        {(canManage) => (
          <>
            {canManage ? <AssignRoles /> : null}
            <StaffMemberships canManage={canManage} />
          </>
        )}
      </ManageAccess>
      <section className="ia-section" aria-labelledby="audit-link-title">
        <h3 id="audit-link-title">Audited privileged actions</h3>
        <p className="caption">
          Every role change and privileged action is audited by the API. Open a membership&apos;s
          audit history above, or search all <Link to="/admin/audit">audit records</Link>.
        </p>
      </section>
    </section>
  );
}
