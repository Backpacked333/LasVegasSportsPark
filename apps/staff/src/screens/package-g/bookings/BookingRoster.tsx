/**
 * Group roster of a rental booking for staff (SCR-S-51; SPK-COND-005, proposed amendment PA-09;
 * capability `rental_rosters`, DEC-103 pending). Shown only while the organization has turned
 * rental rosters on; with the switch off the panel is absent and nothing is asked of the API.
 *
 * `GET /v1/bookings/{id}/roster` lists who is on the roster (joined), who is invited and who was
 * removed, each with their liability waiver for the rental's required waiver (SPK-REG-011):
 * current, lapsed, missing, or not evaluated (liability waivers off, no waiver required, or an
 * invited contact with no record yet). A missing waiver is shown and never blocks the booking
 * (the proposed default of DEC-103).
 *
 * Staff add a person at the desk by their person reference (`POST /v1/bookings/{id}/roster`),
 * invite a contact (`POST .../roster/invitations`; the one-time code is shown once, to pass on,
 * because no messaging channel is approved: DEC-012, DEC-062), and remove a member or revoke an
 * invitation with a reason. Being on the roster grants nothing else, and the panel says so.
 */
import type { Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { usePermissions } from '../../../api/permissions';
import { useApiCommand } from '../../../api/useApiCommand';
import { useApiQuery } from '../../../api/useApiQuery';
import { WAIVER_STATUS } from '../../../features/waivers/waivers';
import { useApp } from '../../../providers/AppProviders';
import { Button } from '../../../ui/Button';
import { CommandError, CommandSuccess } from '../../../ui/CommandFeedback';
import { SelectField, TextField } from '../../../ui/FormFields';
import { QueryBoundary } from '../../../ui/QueryBoundary';
import { isUuid } from '../../../ui/RecordRef';
import { StatusBadge, type StatusTone } from '../../../ui/StatusBadge';
import { formatInstant } from '../participation/format';
import type { Booking } from './labels';

type Roster = Schema<'BookingRoster'>;
type Member = Schema<'BookingRosterMember'>;

export const ROSTER_KEY = ['api', '/bookings/{id}/roster'] as const;
export const MANAGE_ROSTER_ACTION = 'enrollment.manage_booking_roster';
export const REMOVE_ROSTER_MEMBER_ACTION = 'enrollment.remove_booking_roster_member';

const MEMBER_STATUS: Record<Member['status'], { tone: StatusTone; label: string }> = {
  joined: { tone: 'success', label: 'On the roster' },
  invited: { tone: 'pending', label: 'Invited' },
  removed: { tone: 'neutral', label: 'Removed' },
};

const WAIVER_NOTE: Record<Roster['waiver']['state'], string> = {
  evaluated:
    'Each waiver is judged against the waiver this rental requires. A missing waiver is shown here and does not block the booking (proposed, DEC-103 pending).',
  not_required: 'This rental requires no waiver, so none is evaluated.',
  capability_off: 'Liability waivers are turned off for this organization, so none is evaluated.',
};

function memberName(member: Member): string {
  if (member.displayName) return member.displayName;
  if (member.invitedContact) return `${member.invitedContact.value} (invited, no record yet)`;
  return 'Person';
}

function RemoveMember({
  bookingId,
  member,
  onDone,
}: {
  bookingId: string;
  member: Member;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const remove = useApiCommand('post', '/bookings/{id}/roster/members/{memberId}/remove', {
    invalidate: [ROSTER_KEY],
  });
  const name = memberName(member);
  if (!open) {
    return (
      <Button variant="secondary" aria-label={`Remove ${name}`} onClick={() => setOpen(true)}>
        Remove
      </Button>
    );
  }
  const submit = () => {
    if (reason.trim().length === 0) return;
    void remove
      .submit({
        path: { id: bookingId, memberId: member.id },
        body: { reason: reason.trim(), expectedRevision: member.revision },
      })
      .then(() => {
        setOpen(false);
        onDone(`${name} removed from the roster.`);
      })
      .catch(() => undefined);
  };
  return (
    <div className="form" role="group" aria-label={`Remove ${name} from the roster`}>
      <TextField
        label="Why are they removed?"
        value={reason}
        onChange={setReason}
        required
        hint={
          member.status === 'invited'
            ? 'Kept with the roster. Their open invitation is revoked too.'
            : 'Kept with the roster.'
        }
      />
      <div className="actions-row">
        <Button busy={remove.isProcessing} disabled={reason.trim().length === 0} onClick={submit}>
          Remove from roster
        </Button>
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Keep them
        </Button>
      </div>
      <CommandError error={remove.error} onRetry={() => remove.resend()} />
    </div>
  );
}

function AddPerson({ bookingId, onDone }: { bookingId: string; onDone: (m: string) => void }) {
  const [personId, setPersonId] = useState('');
  const add = useApiCommand('post', '/bookings/{id}/roster', { invalidate: [ROSTER_KEY] });
  const valid = isUuid(personId);
  const submit = () => {
    if (!valid) return;
    void add
      .submit({ path: { id: bookingId }, body: { personId: personId.trim() } })
      .then((member) => {
        setPersonId('');
        onDone(`${member?.displayName ?? 'The person'} added to the roster.`);
      })
      .catch(() => undefined);
  };
  return (
    <div className="form" role="group" aria-label="Add a person to the roster">
      <TextField
        label="Person reference"
        value={personId}
        onChange={setPersonId}
        hint="The reference shown on the person record. For somebody who is here at the desk."
        error={personId.trim().length > 0 && !valid ? 'Enter a person reference.' : undefined}
      />
      <div className="actions-row">
        <Button variant="secondary" busy={add.isProcessing} disabled={!valid} onClick={submit}>
          Add to roster
        </Button>
      </div>
      <CommandError error={add.error} onRetry={() => add.resend()} />
    </div>
  );
}

function InviteContact({ bookingId }: { bookingId: string }) {
  const [kind, setKind] = useState<'email' | 'phone' | ''>('');
  const [value, setValue] = useState('');
  const invite = useApiCommand('post', '/bookings/{id}/roster/invitations', {
    invalidate: [ROSTER_KEY],
  });
  const valid = kind !== '' && value.trim().length >= 3;
  const submit = () => {
    if (!valid) return;
    void invite
      .submit({
        path: { id: bookingId },
        body: { recipientContact: { kind, value: value.trim() } },
      })
      .then(() => setValue(''))
      .catch(() => undefined);
  };
  const issued = invite.status === 'success' ? invite.data : undefined;
  return (
    <div className="form" role="group" aria-label="Invite somebody to the roster">
      <SelectField
        label="How they are reached"
        value={kind}
        onChange={(v) => setKind(v as 'email' | 'phone' | '')}
        options={[
          { value: 'email', label: 'Email address' },
          { value: 'phone', label: 'Phone number' },
        ]}
        placeholder="Choose"
      />
      <TextField label="Email address or phone number" value={value} onChange={setValue} />
      <div className="actions-row">
        <Button variant="secondary" busy={invite.isProcessing} disabled={!valid} onClick={submit}>
          Create invitation
        </Button>
      </div>
      {issued ? (
        <div role="status" aria-label="Invitation created">
          <StatusBadge tone="success" label="Invitation created" />
          <p>
            Invitation code{' '}
            <code>
              {issued.id}.{issued.token}
            </code>
            . The code is shown only now: pass it to the invited person, who enters it in the
            customer app under Roster invitations. It expires{' '}
            {formatInstant(issued.expiresAt, null)}.
          </p>
          <p className="caption">
            Nothing is sent for you: no messaging channel is approved (DEC-012, DEC-062).
          </p>
        </div>
      ) : null}
      <CommandError error={invite.error} onRetry={() => invite.resend()} />
    </div>
  );
}

function RosterBody({
  booking,
  roster,
  canManage,
  canRemove,
}: {
  booking: Booking;
  roster: Roster;
  canManage: boolean;
  canRemove: boolean;
}) {
  const [outcome, setOutcome] = useState<string | null>(null);
  const live = roster.members.filter((m) => m.status !== 'removed');
  const removed = roster.members.filter((m) => m.status === 'removed');
  return (
    <>
      <p>
        {roster.counts.joined} {roster.counts.joined === 1 ? 'person' : 'people'} on the roster,{' '}
        {roster.counts.invited} invited
        {roster.waiver.state === 'evaluated'
          ? `, ${roster.counts.waiverOutstanding} without a current waiver`
          : ''}
        .
      </p>
      <p className="caption">{WAIVER_NOTE[roster.waiver.state]}</p>
      {live.length === 0 ? (
        <p className="caption">Nobody is on the roster yet.</p>
      ) : (
        <ul className="list" aria-label="Roster members">
          {live.map((member) => {
            const status = MEMBER_STATUS[member.status];
            const waiver = WAIVER_STATUS[member.waiverStatus];
            return (
              <li key={member.id} aria-label={memberName(member)}>
                <span className="row-text">
                  <span className="row-title">{memberName(member)}</span>
                  <span className="pg-badges">
                    <StatusBadge tone={status.tone} label={status.label} />
                    <StatusBadge tone={waiver.tone} label={waiver.label} />
                    {member.invitation && member.status === 'invited' ? (
                      <StatusBadge
                        tone={member.invitation.status === 'pending' ? 'pending' : 'neutral'}
                        label={`Invitation ${member.invitation.status}`}
                      />
                    ) : null}
                  </span>
                </span>
                {canRemove ? (
                  <RemoveMember bookingId={booking.id} member={member} onDone={setOutcome} />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {removed.length > 0 ? (
        <ul className="list" aria-label="Removed from the roster">
          {removed.map((member) => (
            <li key={member.id}>
              <span className="row-text">
                <span className="row-title">{memberName(member)}</span>
                <span className="caption">
                  Removed
                  {member.removedAt ? ` ${formatInstant(member.removedAt, booking.timezone)}` : ''}
                  {member.removalReason ? `: ${member.removalReason}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <CommandSuccess message={outcome} />
      {canManage ? (
        <>
          <AddPerson bookingId={booking.id} onDone={setOutcome} />
          <InviteContact bookingId={booking.id} />
        </>
      ) : (
        <p className="caption">Adding to the roster is not available to your role.</p>
      )}
      <p className="caption">
        Being on a rental roster grants nothing else: it is not a team entry or a registration, and
        it appears in no competition record or report.
      </p>
    </>
  );
}

export function BookingRoster({ booking }: { booking: Booking }) {
  const { online } = useApp();
  const permissions = usePermissions();
  const enabled =
    booking.kind === 'rental' && permissions.isCapabilityEnabled('rental_rosters') === true;
  const roster = useApiQuery({
    path: '/bookings/{id}/roster',
    request: { path: { id: booking.id } },
    enabled,
  });
  // Turned off (or not yet known), or not a rental: nothing new is shown or asked for.
  if (!enabled) return null;
  const live = ['requested', 'held', 'awaiting_staff', 'confirmed'].includes(booking.status);
  return (
    <section className="pg-panel" aria-labelledby="booking-roster">
      <h5 id="booking-roster">Group roster</h5>
      <p className="pg-badges">
        <StatusBadge tone="info" label="Proposed, DEC-103 pending" />
      </p>
      <QueryBoundary
        query={roster}
        label="the roster"
        empty={{ title: '', description: '' }}
        unavailableOffline={['adding to the roster', 'inviting', 'removing']}
      >
        {(data) => (
          <RosterBody
            booking={booking}
            roster={data}
            canManage={online && live && permissions.isPermitted(MANAGE_ROSTER_ACTION) === true}
            canRemove={online && permissions.isPermitted(REMOVE_ROSTER_MEMBER_ACTION) === true}
          />
        )}
      </QueryBoundary>
    </section>
  );
}
