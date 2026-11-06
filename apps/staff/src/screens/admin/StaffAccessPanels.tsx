/**
 * Staff access on SCR-S-46 and the administration overview (migration 0181; §2.1 the system
 * administrator owns accounts and permissions; §4.14 least privilege, audited privileged actions;
 * SPK-IAM-004 invitations):
 *
 * - last seen: `StaffMembershipView.lastSeenAt`, when the person's active login account last
 *   authenticated a request (the API records it at most once an hour, so it is "within the hour");
 * - access reviews: the latest review on each membership row (`lastAccessReview`), recording one
 *   (`POST /v1/staff-access-reviews`, never your own access, with the next review date the reviewer
 *   chooses: no review interval is an approved policy), and the organization summary
 *   (`GET /v1/staff-access-summary`);
 * - staff invitations: invite an email address to take roles at facilities you administer
 *   (`POST /v1/staff-invitations`). The one-time token comes back once and is shown once with the
 *   acceptance link to hand over: no messaging channel is approved (DEC-012, DEC-062), so the API
 *   only records the invitation for delivery. The list (`GET /v1/staff-invitations`) shows each
 *   invitation's effective status; a pending one is revoked with a reason.
 */
import type { Schema } from '@sportspark/api-client';
import { useState, type FormEvent } from 'react';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiPages } from '../../api/useApiPages';
import { useApiQuery } from '../../api/useApiQuery';
import { useFacilityChoices } from '../../features/insight-admin/facilities';
import {
  CommandError,
  CommandSuccess,
  InsightQueryBoundary,
  fieldErrorsOf,
} from '../../features/insight-admin/feedback';
import { CheckboxGroup, SelectField, TextField } from '../../features/insight-admin/fields';
import { formatInstant, shortId } from '../../features/insight-admin/format';
import { STAFF_ROLES, roleLabel, type StaffRole } from '../../features/insight-admin/labels';
import { useApp, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { LoadMore } from '../../ui/LoadMore';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import './admin.css';

type StaffMembershipView = Schema<'StaffMembershipView'>;
type StaffInvitation = Schema<'StaffInvitation'>;
type StaffInvitationIssued = Schema<'StaffInvitationIssued'>;

export const REVIEW_ACTION = 'identity.record_staff_access_review';
export const READ_REVIEWS_ACTION = 'identity.read_staff_access_reviews';
export const INVITE_ACTION = 'identity.manage_staff_invitation';
export const READ_INVITATIONS_ACTION = 'identity.read_staff_invitations';

const MEMBERSHIPS_KEY = ['api', '/staff-memberships'] as const;
const SUMMARY_KEY = ['api', '/staff-access-summary'] as const;
const INVITATIONS_KEY = ['api', '/staff-invitations'] as const;
const DAY_MS = 86_400_000;

/** "Now", "12 min ago", "3 h ago", "4 days ago", or the date; null: never signed in. */
export function lastSeenText(at: string | null, now: Date): string {
  if (!at) return 'Never signed in';
  const ms = now.getTime() - new Date(at).getTime();
  // The API records sign-in activity at most hourly: anything inside the hour reads "this hour".
  if (ms < 3_600_000) return 'Seen within the hour';
  if (ms < DAY_MS) return `Seen ${Math.floor(ms / 3_600_000)} h ago`;
  if (ms < 14 * DAY_MS) return `Seen ${Math.floor(ms / DAY_MS)} days ago`;
  return `Seen ${formatInstant(at)}`;
}

export function reviewStatus(
  review: StaffMembershipView['lastAccessReview'],
  now: Date,
): { tone: StatusTone; label: string } {
  if (!review) return { tone: 'warning', label: 'Access never reviewed' };
  const due = new Date(review.nextReviewDueAt);
  if (due.getTime() <= now.getTime()) {
    return {
      tone: 'danger',
      label: `Access review overdue since ${formatInstant(review.nextReviewDueAt)}`,
    };
  }
  return {
    tone: review.outcome === 'confirmed' ? 'success' : 'warning',
    label: `${review.outcome === 'confirmed' ? 'Access confirmed' : 'Changes required'} ${formatInstant(review.reviewedAt)} · next review ${formatInstant(review.nextReviewDueAt)}`,
  };
}

/** Last seen and access review, written out, for one membership row. */
export function AccessFacts({ membership }: { membership: StaffMembershipView }) {
  const now = useNow();
  const review = reviewStatus(membership.lastAccessReview, now);
  return (
    <span className="ia-access-facts">
      <span className="caption">{lastSeenText(membership.lastSeenAt, now)}</span>
      <StatusBadge tone={review.tone} label={review.label} />
    </span>
  );
}

export function RecordAccessReview({
  membership,
  onOutcome,
}: {
  membership: StaffMembershipView;
  onOutcome: (message: string) => void;
}) {
  const { online } = useApp();
  const me = useApiQuery({ path: '/me' });
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<'confirmed' | 'changes_required' | ''>('');
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const record = useApiCommand('post', '/staff-access-reviews', {
    invalidate: [MEMBERSHIPS_KEY, SUMMARY_KEY],
  });
  const own = me.data?.principal.personId === membership.personId;
  if (own) {
    return <p className="caption">Your own access is reviewed by another administrator.</p>;
  }
  if (!open) {
    return (
      <Button variant="secondary" aria-expanded={false} onClick={() => setOpen(true)}>
        Record access review
      </Button>
    );
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!outcome) next.outcome = 'Choose the outcome.';
    const dueAt = due ? new Date(`${due}T00:00:00`) : null;
    if (!dueAt || Number.isNaN(dueAt.getTime()))
      next.nextReviewDueAt = 'Choose the next review date.';
    setErrors(next);
    if (Object.keys(next).length > 0 || !dueAt || !outcome) return;
    void record
      .submit({
        body: {
          personId: membership.personId,
          outcome,
          nextReviewDueAt: dueAt.toISOString(),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      })
      .then((review) => {
        setOpen(false);
        onOutcome(
          `Access review recorded for ${membership.personDisplayName ?? 'the staff member'}: next review ${formatInstant(review.nextReviewDueAt)}`,
        );
      })
      .catch(() => undefined);
  };
  const apiFields = fieldErrorsOf(record.error);
  return (
    <form
      className="ia-form"
      onSubmit={submit}
      aria-label={`Access review for ${membership.personDisplayName ?? `membership ${shortId(membership.id)}`}`}
      noValidate
    >
      <SelectField
        label="Outcome"
        value={outcome}
        onChange={(v) => setOutcome(v as typeof outcome)}
        placeholder="Choose the outcome"
        required
        options={[
          { value: 'confirmed', label: 'Roles confirmed as needed' },
          { value: 'changes_required', label: 'Changes required' },
        ]}
        error={errors.outcome ?? apiFields.outcome}
      />
      <TextField
        label="Next review due"
        type="date"
        value={due}
        onChange={setDue}
        required
        hint="You choose it: no review interval is an approved policy yet."
        error={errors.nextReviewDueAt ?? apiFields.nextReviewDueAt}
      />
      <TextField label="Notes" value={notes} onChange={setNotes} hint="Kept with the review." />
      <div className="ia-row-actions">
        <Button type="submit" busy={record.isProcessing} disabled={!online}>
          Save review
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <CommandError error={record.error} onRetry={() => void record.resend()} />
    </form>
  );
}

/** "41 staff · next access review Dec 1", from the API's summary; nothing while unknown. */
export function AccessSummaryLine() {
  const permissions = usePermissions();
  const permitted = permissions.isPermitted(READ_REVIEWS_ACTION);
  const summary = useApiQuery({ path: '/staff-access-summary', enabled: permitted === true });
  if (!summary.data) return null;
  const s = summary.data;
  const parts = [`${s.staffInEffect} staff`];
  if (s.nextReviewDueAt) parts.push(`next access review ${formatInstant(s.nextReviewDueAt)}`);
  if (s.overdue > 0) parts.push(`${s.overdue} overdue`);
  if (s.neverReviewed > 0) parts.push(`${s.neverReviewed} never reviewed`);
  return (
    <span className="caption" data-testid="access-summary">
      {parts.join(' · ')}
    </span>
  );
}

const INVITATION_BADGE: Record<StaffInvitation['status'], { tone: StatusTone; label: string }> = {
  pending: { tone: 'pending', label: 'Invitation pending' },
  accepted: { tone: 'success', label: 'Invitation accepted' },
  revoked: { tone: 'neutral', label: 'Invitation revoked' },
  expired: { tone: 'neutral', label: 'Invitation expired' },
};
const ROLE_OPTIONS = STAFF_ROLES.map((role) => ({ value: role, label: roleLabel(role) }));

function IssuedToken({ issued }: { issued: StaffInvitationIssued }) {
  return (
    <div className="ia-issued" role="status">
      <StatusBadge tone="pending" label={`Invitation pending for ${issued.recipientEmail}`} />
      <p className="caption">
        No messaging channel is approved yet (DEC-012, DEC-062), so nothing is sent automatically.
        Hand the invitation reference and one-time code to {issued.recipientEmail}; the code is
        shown only now. They accept signed in with that verified email address, until{' '}
        {formatInstant(issued.expiresAt)}.
      </p>
      <dl className="ia-dl">
        <dt>Invitation reference</dt>
        <dd>
          <code>{issued.id}</code>
        </dd>
        <dt>One-time code</dt>
        <dd>
          <code className="ia-token" data-testid="invitation-token">
            {issued.token}
          </code>
        </dd>
      </dl>
    </div>
  );
}

export function InviteStaff({ adminScope }: { adminScope: string[] | null }) {
  const { online } = useApp();
  const { choices } = useFacilityChoices();
  const options = choices.filter((c) => adminScope === null || adminScope.includes(c.id));
  const [email, setEmail] = useState('');
  const [roles, setRoles] = useState<string[]>([]);
  const [facilityIds, setFacilityIds] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [issued, setIssued] = useState<StaffInvitationIssued | null>(null);
  const invite = useApiCommand('post', '/staff-invitations', { invalidate: [INVITATIONS_KEY] });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: Record<string, string> = {};
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) next.email = 'Enter an email address.';
    if (roles.length === 0) next.roles = 'Choose at least one role.';
    if (adminScope !== null && facilityIds.length === 0) {
      next.facilityIds = 'Choose at least one facility you administer.';
    }
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    setIssued(null);
    void invite
      .submit({ body: { email: email.trim(), roles: roles as StaffRole[], facilityIds } })
      .then((result) => {
        setIssued(result);
        setEmail('');
        setRoles([]);
        setFacilityIds([]);
      })
      .catch(() => undefined);
  };
  const apiFields = fieldErrorsOf(invite.error);
  return (
    <form
      className="ia-form"
      id="invite-staff"
      onSubmit={submit}
      aria-label="Invite staff"
      noValidate
    >
      <h3>Invite staff</h3>
      <TextField
        label="Email address"
        value={email}
        onChange={setEmail}
        required
        hint="The person accepts signed in with this address verified on their account."
        error={errors.email ?? apiFields.email}
      />
      <CheckboxGroup
        legend="Roles (required)"
        options={ROLE_OPTIONS}
        selected={roles}
        onChange={setRoles}
        error={errors.roles ?? apiFields.roles}
      />
      <CheckboxGroup
        legend="Facility scope"
        options={options.map((c) => ({ value: c.id, label: c.label }))}
        selected={facilityIds}
        onChange={setFacilityIds}
        hint={
          adminScope === null
            ? 'Leave every facility unticked for the whole organization.'
            : 'You invite only to the facilities you administer.'
        }
        error={errors.facilityIds ?? apiFields.facilityIds}
      />
      <div>
        <Button type="submit" busy={invite.isProcessing} disabled={!online}>
          Send invitation
        </Button>
      </div>
      {issued ? <IssuedToken issued={issued} /> : null}
      <CommandError error={invite.error} onRetry={() => void invite.resend()} />
    </form>
  );
}

function RevokeInvitation({ invitation }: { invitation: StaffInvitation }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const revoke = useApiCommand('post', '/staff-invitations/{id}/revoke', {
    invalidate: [INVITATIONS_KEY],
  });
  if (!open) {
    return (
      <Button
        variant="secondary"
        aria-label={`Revoke invitation for ${invitation.recipientEmail}`}
        onClick={() => setOpen(true)}
      >
        Revoke
      </Button>
    );
  }
  return (
    <form
      className="ia-inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (!reason.trim()) return;
        void revoke
          .submit({
            path: { id: invitation.id },
            body: { reason: reason.trim(), expectedRevision: invitation.revision },
          })
          .then(() => setDone('Invitation revoked'))
          .catch(() => undefined);
      }}
    >
      <TextField label="Reason" value={reason} onChange={setReason} required />
      <Button type="submit" busy={revoke.isProcessing} disabled={!reason.trim()}>
        Revoke invitation
      </Button>
      <CommandSuccess message={done} />
      <CommandError error={revoke.error} onRetry={() => void revoke.resend()} />
    </form>
  );
}

export function StaffInvitationsList({ canManage }: { canManage: boolean }) {
  const permissions = usePermissions();
  const permitted = permissions.isPermitted(READ_INVITATIONS_ACTION);
  const pages = useApiPages({
    path: '/staff-invitations',
    request: { query: { limit: 25 } },
    enabled: permitted !== false,
  });
  const { choices } = useFacilityChoices();
  const facility = (id: string) => choices.find((c) => c.id === id)?.label ?? 'a facility';
  if (permitted === false) return null;
  return (
    <section className="ia-section" aria-labelledby="invitations-title">
      <h3 id="invitations-title">Staff invitations</h3>
      <InsightQueryBoundary
        query={pages}
        label="staff invitations"
        isEmpty={(items) => items.length === 0}
        empty={{ title: 'No staff invitations', description: 'Nobody has been invited yet.' }}
      >
        {(items) => (
          <ul className="list" aria-label="Staff invitations">
            {items.map((i) => {
              const badge = INVITATION_BADGE[i.status];
              return (
                <li key={i.id}>
                  <span className="row-text">
                    <span className="row-title">{i.recipientEmail}</span>
                    <span className="caption">
                      {i.roles.map(roleLabel).join(', ')} ·{' '}
                      {i.facilityIds.length === 0
                        ? 'Whole organization'
                        : i.facilityIds.map(facility).join(', ')}{' '}
                      · invited by {i.invitedByDisplayName ?? 'an administrator'} · expires{' '}
                      {formatInstant(i.expiresAt)}
                    </span>
                  </span>
                  <StatusBadge tone={badge.tone} label={badge.label} />
                  {canManage && i.status === 'pending' ? <RevokeInvitation invitation={i} /> : null}
                </li>
              );
            })}
          </ul>
        )}
      </InsightQueryBoundary>
      <LoadMore pages={pages} label="staff invitations" />
    </section>
  );
}
