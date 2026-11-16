/**
 * Book a session with one credit of a class pack (the API's session package) (SCR-C-35 next to credits and makeups;
 * Package G §3.16 "reservation, redemption"; ENR-11, SPK-COND-002, §4.9, SPK-UX-008; package
 * redemption and reversal terms POL-039 and POL-007 are the API's, never the app's).
 *
 * Offered on a package the API reports active, with sessions left and not past its expiry, while
 * `session_packages` is on (DEC-016, DEC-074). The sessions that may be chosen come from the
 * package: its eligible offerings (`GET /v1/offerings/{id}`) and the published offerings of its
 * eligible programs (`GET /v1/offerings?programId=`); choosing one lists its upcoming scheduled
 * sessions (`GET /v1/offerings/{id}/sessions`) in the facility's time zone (SPK-SCHED-008).
 * "Book with this package" sends `POST /v1/session-bookings` with `packageEntitlementId` and one
 * idempotency key per intent (a retry after no answer reuses it). The redemption is one
 * transaction in the API and the database refuses an extra one, so two guardians booking the last
 * session at once can never both use it: the loser reads "Not available: no sessions left".
 *
 * States: loading (eligible activities, sessions); empty (no eligible activity or no upcoming
 * session); ready; validation failure (the session is not covered or the participant is not
 * eligible: the API's reasons); permission restriction (not available); turned off
 * (CAPABILITY_DISABLED, naming the decisions); offline (booking disabled); processing (busy);
 * success ("Booked" with the session time; the class pack shows one session fewer); no answer
 * ("Check again" repeats the same intent). Customer words (PA-11): "class pack" throughout.
 */
import type { ApiError } from '@sportspark/api-client';
import { useState } from 'react';
import { View } from 'react-native';
import { useApiCommand } from '../../api/useApiCommand';
import { useApiQuery } from '../../api/useApiQuery';
import { CommandFailure } from '../../features/money/CommandFailure';
import { useEligibleOfferings } from '../../features/money/eligible-offerings';
import { formatDateRange, hasPassed } from '../../features/money/format';
import { packageRefusal, type PackageEntitlement } from '../../features/money/payment-lists';
import { bookingStatus, type SessionBooking } from '../../features/money/status';
import { formatInstantIn } from '../../features/money/time-zone';
import { ChoiceCard } from '../../ui/ChoiceList';
import { displayZone, zoneAbbreviation, type DisplayZone } from '../../features/today/time';
import { useConnectivity, useNow } from '../../providers/AppProviders';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { StateView } from '../../ui/StateView';
import { StatusBadge } from '../../ui/StatusBadge';
import { Text } from '../../ui/Text';
import { FieldValue as Field } from '../../ui/Field';
import { Section } from '../../ui/Section';
import { Actions, Choices } from '../../features/money/surfaces';

/** What the API sends back for a refused booking that names its reasons (ELIGIBILITY_FAILED). */
function reasonsOf(error: ApiError): string[] {
  const details = (error.details ?? {}) as { reasons?: { message?: unknown }[] };
  return (details.reasons ?? [])
    .map((r) => r.message)
    .filter((m): m is string => typeof m === 'string');
}

function Booked({ booking, zone }: { booking: SessionBooking; zone: DisplayZone }) {
  return (
    <View testID="package-booked">
      <StatusBadge {...bookingStatus(booking.status)} testID="package-booking-status" />
      <Field
        label="Session"
        value={`${formatInstantIn(booking.scheduledStart, zone.zone)} to ${formatInstantIn(booking.scheduledEnd, zone.zone)}`}
      />
      <Text variant="caption" tone="muted">
        One session of this class pack was used for this booking.
      </Text>
    </View>
  );
}

function BookingForm({ pkg, onClose }: { pkg: PackageEntitlement; onClose: () => void }) {
  const now = useNow();
  const { reachable } = useConnectivity();
  const offline = reachable === false;
  const { offerings, loading } = useEligibleOfferings(
    pkg.appliesTo.offeringIds,
    pkg.appliesTo.programIds,
  );
  const [offeringId, setOfferingId] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);
  const [booking, setBooking] = useState<SessionBooking | null>(null);
  const book = useApiCommand('post', '/session-bookings', {
    invalidate: [
      ['api', '/me/package-entitlements'],
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

  if (booking) return <Booked booking={booking} zone={zone} />;

  const upcoming = (sessions.data ?? []).filter(
    (s) => s.status === 'scheduled' && !hasPassed(s.scheduledStart, now),
  );
  const submit = async () => {
    if (!offeringId || !sessionId) return;
    setFailure(null);
    try {
      const result = await book.submit({
        body: {
          offeringId,
          sessionId,
          participantPersonId: pkg.participantPersonId,
          packageEntitlementId: pkg.id,
        },
      });
      setBooking(result as SessionBooking);
    } catch (error) {
      setFailure(error as ApiError);
    }
  };
  const refusal = failure ? packageRefusal(failure) : null;
  const ineligible = failure?.code === 'ELIGIBILITY_FAILED';

  return (
    <View testID="package-booking">
      <Section title="Choose an activity">
        {loading && offerings.size === 0 ? (
          <StateView variant="loading" label="activities this class pack can be used for" />
        ) : offerings.size === 0 ? (
          <StateView
            variant="empty"
            title="No eligible activity is listed"
            description="None of the activities this class pack can be used for is published right now. The front desk can help."
          />
        ) : (
          <Choices label="Eligible activity">
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
      </Section>
      {offeringId ? (
        <Section title="Choose a session">
          <QueryBoundary
            query={sessions}
            label="sessions"
            isEmpty={() => upcoming.length === 0}
            empty={{
              title: 'No upcoming sessions',
              description: 'This activity has no upcoming session to book. Choose another.',
            }}
            unavailableOffline={['booking with a class pack']}
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
                      description: formatInstantIn(s.scheduledStart, zone.zone),
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
          {zone.facility ? null : (
            <Text variant="caption" tone="muted">
              {`Times are in this device's time zone (${zoneAbbreviation(now, zone.zone)}): the facility's time zone is not available for this activity.`}
            </Text>
          )}
        </Section>
      ) : null}
      {offline ? (
        <Text variant="caption" tone="muted">
          Needs a connection.
        </Text>
      ) : null}
      <Actions>
        <Button
          label="Book with this class pack"
          onPress={() => void submit()}
          disabled={!offeringId || !sessionId || offline || refusal !== null}
          busy={book.isProcessing}
          accessibilityHint="Uses one session of this class pack to book the chosen session"
        />
        <Button label="Not now" variant="secondary" onPress={onClose} />
      </Actions>
      {refusal ? (
        <StatusBadge tone="neutral" label={refusal} testID="package-booking-refused" />
      ) : ineligible && failure ? (
        <View testID="package-booking-ineligible">
          <StatusBadge tone="warning" label="This session cannot be booked with this class pack" />
          {reasonsOf(failure).map((m) => (
            <Text variant="body" key={m}>
              {m}
            </Text>
          ))}
          <Text variant="caption" tone="muted">
            Error code: {failure.code}
          </Text>
        </View>
      ) : failure ? (
        <CommandFailure error={failure} what="the booking" onRetry={() => void submit()} />
      ) : null}
    </View>
  );
}

/**
 * "Book a session" on one package card; the form opens in place and stays (with its outcome) while
 * the package is read again, even when that booking used its last session.
 */
export function BookWithPackage({
  pkg,
  canStart,
}: {
  pkg: PackageEntitlement;
  /** The switch is on and the API's record still allows a booking (`packageRedeemable`). */
  canStart: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (open) return <BookingForm pkg={pkg} onClose={() => setOpen(false)} />;
  if (!canStart) return null;
  return (
    <Actions>
      <Button
        label="Book a session with this class pack"
        variant="secondary"
        onPress={() => setOpen(true)}
        accessibilityHint="Lists the sessions this class pack can be used for"
      />
    </Actions>
  );
}
