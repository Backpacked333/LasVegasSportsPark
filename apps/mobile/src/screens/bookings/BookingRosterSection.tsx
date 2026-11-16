/**
 * The group roster of a rental, for its renter (SPK-COND-005, proposed amendment PA-09;
 * capability `rental_rosters`, DEC-103 pending). Shown only on a rental while the organization
 * has turned rental rosters on; otherwise nothing is shown and nothing is asked of the API.
 *
 * `GET /v1/bookings/{id}/roster` lists who is coming, who is invited and each one's liability
 * waiver (SPK-REG-011): accepted, needs accepting again, not accepted yet, or not checked. A
 * missing waiver is shown and never blocks the booking (the proposed default of DEC-103).
 *
 * Somebody who is only invited has not joined: the list shows the email address the renter typed,
 * or "Invited person", never a name or a waiver (a person's details are theirs until they join).
 *
 * The renter adds themselves or someone they register for (`POST /v1/bookings/{id}/roster`),
 * invites anybody else by email (`POST .../roster/invitations`: the one-time code is shown once,
 * to pass on, because nothing is sent for them: no messaging channel is approved, DEC-012,
 * DEC-062), and removes somebody again. Being on the roster grants nothing else.
 *
 * States: loading; empty; ready; validation failure (an email is needed); permission restriction
 * (not the renter: not available); offline (the list with its age; adding, inviting and removing
 * need a connection); processing; success (the list is read again).
 */
import type { ApiError, Schema } from '@sportspark/api-client';
import { useState } from 'react';
import { View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { TextField } from '../../features/money/ui';
import type { Booking } from '../../features/package-g/booking-model';
import { CommandError } from '../../features/registration/CommandError';
import { useMe, useParticipantNames } from '../../features/registration/participants';
import { WAIVER_STATUS } from '../../features/waivers/waivers';
import { useConnectivity } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StatusBadge, type StatusTone } from '../../ui/StatusBadge';
import { makeStyles, spacing } from '../../ui/theme';
import { Section } from '../../ui/Section';
import { Text } from '../../ui/Text';

type Roster = Schema<'BookingRoster'>;
type Member = Schema<'BookingRosterMember'>;

export const ROSTER_KEY = ['api', '/bookings/{id}/roster'] as const;
/** The reason the API keeps when the renter removes somebody in the app. */
export const RENTER_REMOVAL_REASON = 'Removed by the renter in the app';

const MEMBER_STATUS: Record<Member['status'], { tone: StatusTone; label: string }> = {
  joined: { tone: 'success', label: 'Coming' },
  invited: { tone: 'pending', label: 'Invited, not answered yet' },
  removed: { tone: 'neutral', label: 'Removed' },
};

const WAIVER_NOTE: Record<Roster['waiver']['state'], string> = {
  evaluated:
    'A waiver that is not accepted is shown here so you can remind people. It does not block your booking.',
  not_required: 'This rental asks for no waiver.',
  capability_off: 'Waivers are not checked for this organization.',
};

const LIVE: ReadonlyArray<Booking['status']> = ['requested', 'held', 'awaiting_staff', 'confirmed'];

/** The name of somebody who joined; for an invitation, the contact it went to or just that. */
function memberName(member: Member): string {
  if (member.displayName) return member.displayName;
  if (member.invitedContact) return member.invitedContact.value;
  return member.joinedAt === null ? 'Invited person' : 'Somebody';
}

function MemberRow({
  bookingId,
  member,
  showWaiver,
  canChange,
  onChanged,
}: {
  bookingId: string;
  member: Member;
  showWaiver: boolean;
  canChange: boolean;
  onChanged: () => void;
}) {
  const styles = useStyles();
  const [failure, setFailure] = useState<ApiError | null>(null);
  const remove = useApiCommand('post', '/bookings/{id}/roster/members/{memberId}/remove', {
    invalidate: [ROSTER_KEY],
  });
  const status = MEMBER_STATUS[member.status];
  const waiver = WAIVER_STATUS[member.waiverStatus];
  const name = memberName(member);
  // A waiver is judged only for somebody who joined: nothing is said about an invited person.
  const judged = showWaiver && member.status === 'joined';
  const submit = async () => {
    setFailure(null);
    try {
      await remove.submit({
        path: { id: bookingId, memberId: member.id },
        body: { reason: RENTER_REMOVAL_REASON, expectedRevision: member.revision },
      });
      onChanged();
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  return (
    <View style={styles.row} testID={`roster-member-${member.id}`}>
      <View
        accessible
        accessibilityLabel={`${name}, ${status.label}${judged ? `, ${waiver.label}` : ''}`}
      >
        <Text variant="body">{name}</Text>
      </View>
      <View style={styles.badges}>
        <StatusBadge tone={status.tone} label={status.label} />
        {judged ? <StatusBadge tone={waiver.tone} label={waiver.label} /> : null}
      </View>
      {canChange ? (
        <Button
          label={`Remove ${name}`}
          variant="secondary"
          onPress={() => void submit()}
          busy={remove.isProcessing}
        />
      ) : null}
      <CommandError error={failure} onRetry={() => void submit()} onReload={onChanged} />
    </View>
  );
}

function AddPeople({
  bookingId,
  roster,
  onChanged,
}: {
  bookingId: string;
  roster: Roster;
  onChanged: () => void;
}) {
  const me = useMe();
  const [failure, setFailure] = useState<ApiError | null>(null);
  const add = useApiCommand('post', '/bookings/{id}/roster', { invalidate: [ROSTER_KEY] });
  const selfId = me.data?.person?.id ?? null;
  // Themselves, and the people they register for: anybody else is invited.
  const mine = [
    ...(selfId ? [selfId] : []),
    ...(me.data?.authorities ?? [])
      .filter((a) => a.permissions.includes('register'))
      .map((a) => a.subjectPersonId),
  ];
  const names = useParticipantNames(mine);
  const live = new Set(
    roster.members.filter((m) => m.status !== 'removed' && m.personId).map((m) => m.personId),
  );
  const addable = [...new Set(mine)].filter((id) => !live.has(id));
  const submit = async (personId: string) => {
    setFailure(null);
    try {
      await add.submit({ path: { id: bookingId }, body: { personId } });
      onChanged();
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  if (addable.length === 0) return null;
  return (
    <>
      <View style={buttonRow}>
        {addable.map((personId) => (
          <Button
            key={personId}
            label={personId === selfId ? 'Add yourself' : `Add ${names(personId)}`}
            variant="secondary"
            onPress={() => void submit(personId)}
            busy={add.isProcessing}
          />
        ))}
      </View>
      <CommandError error={failure} onReload={onChanged} />
    </>
  );
}

function Invite({ bookingId, onChanged }: { bookingId: string; onChanged: () => void }) {
  const [email, setEmail] = useState('');
  const [attempted, setAttempted] = useState(false);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const invite = useApiCommand('post', '/bookings/{id}/roster/invitations', {
    invalidate: [ROSTER_KEY],
  });
  const issued = invite.status === 'success' ? invite.data : undefined;
  const emailError = /^\S+@\S+\.\S+$/.test(email.trim()) ? null : 'Enter their email address.';
  const submit = async () => {
    setAttempted(true);
    if (emailError) return;
    setFailure(null);
    try {
      await invite.submit({
        path: { id: bookingId },
        body: { recipientContact: { kind: 'email', value: email.trim() } },
      });
      setEmail('');
      setAttempted(false);
      onChanged();
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  return (
    <View testID="roster-invite">
      <TextField
        label="Invite somebody by email"
        value={email}
        onChangeText={setEmail}
        error={attempted ? emailError : null}
        testID="roster-invite-email"
      />
      <View style={buttonRow}>
        <Button
          label="Create invitation"
          variant="secondary"
          onPress={() => void submit()}
          busy={invite.isProcessing}
        />
      </View>
      {issued ? (
        <View testID="roster-invitation-issued">
          <StatusBadge tone="success" label="Invitation created" />
          <Text variant="body">{`Invitation code: ${issued.id}.${issued.token}`}</Text>
          <Text variant="caption" tone="muted">
            This code is shown only now. Nothing is sent for you: pass the code on, and they enter
            it in the app under Rentals and parties, Roster invitations, to join.
          </Text>
        </View>
      ) : null}
      <CommandError error={failure} onRetry={() => void submit()} onReload={onChanged} />
    </View>
  );
}

function RosterBody({
  booking,
  roster,
  reload,
}: {
  booking: Booking;
  roster: Roster;
  reload: () => void;
}) {
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const live = roster.members.filter((m) => m.status !== 'removed');
  const canChange = !offline;
  const canAdd = canChange && LIVE.includes(booking.status);
  const showWaiver = roster.waiver.state === 'evaluated';
  return (
    <>
      <Text variant="body">
        {`${roster.counts.joined} coming, ${roster.counts.invited} invited${
          showWaiver ? `, ${roster.counts.waiverOutstanding} without an accepted waiver` : ''
        }.`}
      </Text>
      <Text variant="caption" tone="muted">
        {WAIVER_NOTE[roster.waiver.state]}
      </Text>
      {live.length === 0 ? (
        <Text variant="caption" tone="muted">
          Nobody is on the roster yet.
        </Text>
      ) : (
        <View accessibilityRole="list" accessibilityLabel="People on the roster">
          {live.map((member) => (
            <MemberRow
              key={member.id}
              bookingId={booking.id}
              member={member}
              showWaiver={showWaiver}
              canChange={canChange}
              onChanged={reload}
            />
          ))}
        </View>
      )}
      {canAdd ? (
        <>
          <AddPeople bookingId={booking.id} roster={roster} onChanged={reload} />
          <Invite bookingId={booking.id} onChanged={reload} />
        </>
      ) : null}
      {offline ? (
        <Text variant="caption" tone="muted">
          Changing the roster needs a connection.
        </Text>
      ) : null}
      <Text variant="caption" tone="muted">
        Being on the roster is only a name on your list: it is not a registration and reserves
        nothing.
      </Text>
    </>
  );
}

export function BookingRosterSection({ booking }: { booking: Booking }) {
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
  return (
    <Section title="Who is coming" testID="booking-roster">
      <QueryBoundary
        query={roster}
        label="the roster"
        empty={{ title: 'Not available', description: '' }}
        unavailableOffline={['Adding to the roster', 'Inviting', 'Removing']}
      >
        {(data) => (
          <RosterBody booking={booking} roster={data} reload={() => void roster.refetch()} />
        )}
      </QueryBoundary>
    </Section>
  );
}

const useStyles = makeStyles(({ colors }) => ({
  row: {
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
}));

const buttonRow = { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm } as const;
