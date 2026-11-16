/**
 * Book a session with a membership's included sessions (Package G, §3.16 Memberships "entitlement
 * effects"; ENR-12, SPK-COND-001, §4.9, SPK-UX-008; capability `memberships`, DEC-016, DEC-072).
 * Membership terms and member pricing stay POL-038 and DEC-007: the API applies them, the app
 * states none.
 *
 * Offered on a membership the API reports confirmed, inside its term, not suspended now, with
 * sessions of named activities (`membershipBookable`), while the switch is on. The activities come
 * from the membership's definition (`attendance.appliesTo`: its offerings, `GET /v1/offerings/{id}`,
 * and the published offerings of its programs, `GET /v1/offerings?programId=`); choosing one lists
 * its upcoming scheduled sessions inside the term (`GET /v1/offerings/{id}/sessions`) in the
 * facility's time zone (SPK-SCHED-008). "Book with this membership" sends
 * `POST /v1/session-bookings` with `membershipEnrollmentId` and one idempotency key per intent
 * (a retry after no answer reuses it). The API counts the session in its period in the same
 * transaction, and the database refuses one beyond the period's limit, so two guardians booking
 * the last included session at once can never both use it.
 *
 * States: loading (activities, sessions); empty (no listed activity, no upcoming session in the
 * term); ready; validation failure (the session is not included or the participant is not
 * eligible: the API's reasons); refused (every included session of that period used, suspended
 * then, outside the term: the API's code in words); permission restriction (not available);
 * turned off (CAPABILITY_DISABLED, naming the decisions); offline (booking disabled); processing
 * (busy); success ("Booked" with the session time); no answer ("Check again", same key).
 */
import type { ApiError } from '@sportspark/api-client';
import { useState } from 'react';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandError } from '../../ui/CommandError';
import { formatDateRange, hasPassed } from '../../features/money/format';
import { bookingStatus, type SessionBooking } from '../../features/money/status';
import { ChoiceCard } from '../../ui/ChoiceList';
import { detailCode } from '../../features/package-g/booking-model';
import { useIncludedOfferings } from '../../features/package-g/included-offerings';
import {
  inTerm,
  membershipBookingRefusal,
  type Membership,
} from '../../features/package-g/membership-model';
import { displayZone, formatRange, zoneNotice } from '../../features/today/time';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { LiveRegion, sentences } from '../../ui/announce';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { FieldValue as Field } from '../../ui/Field';
import { Section } from '../../ui/Section';
import { Actions, Choices } from '../../features/money/surfaces';
import { SupportDetails } from '../../ui/SupportDetails';

const INELIGIBLE_LABEL = 'This session cannot be booked with this membership';

/** The reasons of a refused booking that names them (ELIGIBILITY_FAILED). */
function reasonsOf(error: ApiError): string[] {
  const details = (error.details ?? {}) as { reasons?: { message?: unknown }[] };
  return (details.reasons ?? [])
    .map((r) => r.message)
    .filter((m): m is string => typeof m === 'string');
}

/** The API's refusal of this membership booking in words, or null for any other failure. */
function refusalOf(error: ApiError): string | null {
  return error.code === 'RESOURCE_CONFLICT'
    ? membershipBookingRefusal(detailCode(error.details))
    : null;
}

function BookingForm({ membership, onClose }: { membership: Membership; onClose: () => void }) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const applies = membership.attendance?.appliesTo ?? { offeringIds: [], programIds: [] };
  const { offerings, loading } = useIncludedOfferings(applies.offeringIds, applies.programIds);
  const [offeringId, setOfferingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [booked, setBooked] = useState<SessionBooking | null>(null);
  const book = useApiCommand('post', '/session-bookings', {
    invalidate: [
      ['api', '/me/memberships'],
      ['api', '/session-bookings'],
    ],
  });
  const sessions = useApiQuery({
    path: '/offerings/{id}/sessions',
    request: { path: { id: offeringId ?? '' } },
    enabled: offeringId !== null,
  });
  const chosen = offeringId ? offerings.get(offeringId) : undefined;
  const zone = displayZone(chosen?.facility?.timezone ?? null);

  if (booked) {
    return (
      <Section title="Session booked" testID={`membership-booked-${membership.enrollmentId}`}>
        <StatusBadge {...bookingStatus(booked.status)} testID="membership-booking-status" />
        <Field
          label="Session"
          value={formatRange(booked.scheduledStart, booked.scheduledEnd, zone.zone)}
        />
        <Text variant="caption" tone="muted">
          {membership.attendance?.mode === 'included_sessions'
            ? 'It counts toward the sessions this membership includes for that period.'
            : 'Booked with this membership.'}
        </Text>
        <Actions>
          <Button label="Done" variant="secondary" onPress={onClose} />
        </Actions>
      </Section>
    );
  }

  const upcoming = (sessions.data ?? []).filter(
    (s) =>
      s.status === 'scheduled' &&
      !hasPassed(s.scheduledStart, now) &&
      inTerm(membership, s.scheduledStart),
  );
  const submit = async () => {
    if (!offeringId || !sessionId) return;
    setFailure(null);
    try {
      const result = await book.submit({
        body: {
          offeringId,
          sessionId,
          participantPersonId: membership.participantPersonId,
          membershipEnrollmentId: membership.enrollmentId,
        },
      });
      setBooked(result as SessionBooking);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  const refusal = failure ? refusalOf(failure) : null;
  const ineligible = failure?.code === 'ELIGIBILITY_FAILED';
  const notice = zoneNotice(zone, now);

  return (
    <Section title="Book a session" testID={`membership-booking-${membership.enrollmentId}`}>
      <Text variant="caption" tone="muted">
        Only the activities this membership names are listed.
      </Text>
      {loading && offerings.size === 0 ? (
        <StateView variant="loading" label="activities this membership includes" />
      ) : offerings.size === 0 ? (
        <StateView
          variant="empty"
          title="No included activity is listed"
          description="None of the activities this membership includes is published right now. The front desk can help."
        />
      ) : (
        <Choices label="Included activity">
          {[...offerings.values()].map((o) => (
            <ChoiceCard
              key={o.id}
              mode="single"
              option={{
                value: o.id,
                label: o.name,
                description: formatDateRange(o.startsOn, o.endsOn),
              }}
              checked={offeringId === o.id}
              onPress={() => {
                setOfferingId(o.id);
                setSessionId(null);
                setFailure(null);
              }}
            />
          ))}
        </Choices>
      )}
      {offeringId ? (
        <QueryBoundary
          query={sessions}
          label="sessions"
          isEmpty={() => upcoming.length === 0}
          empty={{
            title: 'No upcoming sessions in the term',
            description:
              'This activity has no upcoming session inside the membership term. Choose another.',
          }}
          unavailableOffline={['booking with a membership']}
        >
          {() => (
            <Choices label="Session">
              {upcoming.map((s) => (
                <ChoiceCard
                  key={s.id}
                  mode="single"
                  option={{
                    value: s.id,
                    label: s.title ?? `Session ${s.sequence}`,
                    description: formatRange(s.scheduledStart, s.scheduledEnd, zone.zone),
                  }}
                  checked={sessionId === s.id}
                  onPress={() => {
                    setSessionId(s.id);
                    setFailure(null);
                  }}
                />
              ))}
            </Choices>
          )}
        </QueryBoundary>
      ) : null}
      {offeringId && notice ? (
        <Text variant="caption" tone="muted">
          {notice}
        </Text>
      ) : null}
      {offline ? (
        <Text variant="caption" tone="muted">
          Booking needs a connection.
        </Text>
      ) : null}
      <Actions>
        <Button
          label="Book with this membership"
          onPress={() => void submit()}
          disabled={!offeringId || !sessionId || offline || refusal !== null}
          busy={book.isProcessing}
          accessibilityHint="Uses this membership's included sessions to book the chosen session"
        />
        <Button label="Not now" variant="secondary" onPress={onClose} />
      </Actions>
      {refusal && failure ? (
        // Each refusal is announced (SPK-UX-009); the code is for support, not read out.
        <LiveRegion testID="membership-booking-refused" announcement={refusal} occurrence={failure}>
          <StatusBadge tone="neutral" label={refusal} />
          <SupportDetails
            errorCode={`${failure.code} (${detailCode(failure.details) ?? ''})`}
            reference={failure.correlationId}
          />
        </LiveRegion>
      ) : ineligible && failure ? (
        <LiveRegion
          testID="membership-booking-ineligible"
          announcement={sentences(INELIGIBLE_LABEL, ...reasonsOf(failure))}
          occurrence={failure}
        >
          <StatusBadge tone="warning" label={INELIGIBLE_LABEL} />
          {reasonsOf(failure).map((m) => (
            <Text variant="body" key={m}>
              {m}
            </Text>
          ))}
          <SupportDetails errorCode={failure.code} reference={failure.correlationId} />
        </LiveRegion>
      ) : failure ? (
        <CommandError
          wording="money"
          error={failure}
          what="the booking"
          onRetry={() => void submit()}
        />
      ) : null}
    </Section>
  );
}

/**
 * "Book a session with this membership" on one membership card; the form opens in place and stays
 * (with its outcome) while the memberships are read again.
 */
export function BookWithMembership({
  membership,
  canStart,
}: {
  membership: Membership;
  /** The switch is on and the API's record allows a booking now (`membershipBookable`). */
  canStart: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <BookingForm membership={membership} onClose={() => setOpen(false)} />;
  if (!canStart) return null;
  return (
    <Actions>
      <Button
        label="Book a session with this membership"
        variant="secondary"
        onPress={() => setOpen(true)}
        accessibilityHint="Lists the sessions this membership includes"
      />
    </Actions>
  );
}
