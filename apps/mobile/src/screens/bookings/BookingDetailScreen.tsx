/**
 * One rental or party (Package G, conditional; §3.16 Rentals and Parties rows, SPK-COND-003,
 * ENR-13). Route: `/bookings/[id]`, from `/bookings` and from the booking flow's outcome.
 *
 * Reads `GET /v1/bookings/{id}` (the booker, or staff; anyone else gets a protected NOT_FOUND,
 * shown as "not available" without implying the booking exists, §4.10). Shows the status and what
 * is still outstanding as the API lists it (approval, payment, staffing: a paid booking waiting for
 * its staff is never shown as confirmed, SPK-COND-003), every occurrence with what it reserves in
 * the facility's time zone (SPK-SCHED-008), the number of guests, the approved terms it was booked
 * under (access conditions, host responsibilities), and why it ended. A held booking links to its
 * basket, where it is paid (quote and checkout, SCR-C-11 to SCR-C-15) and shows the hold's expiry.
 * Cancellation (`CancelBooking`) is never gated by the capability switch (DEC-016).
 *
 * States: loading; ready; error with the code and "Try again"; not available (protected
 * NOT_FOUND or ACCESS_DENIED); offline or stale (cached with its age, canceling needs a
 * connection); success and failures of the cancellation (see CancelBooking).
 */
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { useApiQuery } from '../../api/useApiQuery';
import { Body, ButtonRow, Caption, Field, Section } from '../../features/money/ui';
import {
  bookingStatus,
  confirmationText,
  endReasonText,
  KIND_LABELS,
  outstandingText,
  resourceName,
  type Booking,
} from '../../features/package-g/booking-model';
import { routeId } from '../../features/package-g/routes';
import { formatInstantIn } from '../../features/package-g/time';
import { registrationRoutes } from '../../features/registration/routes';
import { displayZone, formatRange, zoneNotice } from '../../features/today/time';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { StatusBadge } from '../../ui/StatusBadge';
import { colors, spacing, type } from '../../ui/theme';
import { NotFoundScreen } from '../not-found/NotFoundScreen';
import { CancelBooking } from './CancelBooking';

function HoldSection({ booking }: { booking: Booking }) {
  const router = useRouter();
  const zone = displayZone(booking.timezone);
  const basketId = booking.basketId;
  const basket = useApiQuery({
    path: '/baskets/{id}',
    request: { path: { id: basketId ?? '' } },
    enabled: basketId !== null,
  });
  if (basketId === null) return null;
  const expires = basket.data?.holdExpiresAt ?? null;
  return (
    <Section title="Pay to confirm" testID="booking-hold">
      {expires ? (
        <Field
          label="Held until"
          value={`${formatInstantIn(expires, zone.zone)}. The facility's system releases the time then.`}
        />
      ) : basket.error ? (
        <Caption>The hold's expiry cannot be shown right now; your basket shows it.</Caption>
      ) : null}
      {basket.data?.status === 'checking_out' ? (
        <StatusBadge tone="warning" label="Payment in progress: open the basket for its outcome" />
      ) : null}
      <Body>The price, approved taxes and fees, and any deposit are shown in your basket.</Body>
      <ButtonRow>
        <Button
          label="Go to basket"
          onPress={() => router.push(registrationRoutes.basket(basketId))}
          accessibilityHint="Opens the basket where this booking is paid"
        />
      </ButtonRow>
    </Section>
  );
}

function BookingView({ booking, reload }: { booking: Booking; reload: () => void }) {
  const zone = displayZone(booking.timezone);
  const status = bookingStatus(booking);
  const outstanding = outstandingText(booking.outstanding);
  const ended = endReasonText(booking.endReason);
  const notice = zoneNotice(zone, booking.firstStart);
  return (
    <View>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {booking.offeringName ?? KIND_LABELS[booking.kind]}
        </Text>
        <StatusBadge {...status} testID="booking-status" />
      </View>

      {outstanding.length > 0 ? (
        <Section title="Still to happen" testID="booking-outstanding">
          <View accessibilityRole="list">
            {outstanding.map((text) => (
              <Body key={text}>{`• ${text}`}</Body>
            ))}
          </View>
        </Section>
      ) : null}

      {booking.status === 'held' ? <HoldSection booking={booking} /> : null}

      <Section title={booking.occurrences.length > 1 ? 'Times' : 'Time'} testID="booking-times">
        <View
          accessibilityRole="list"
          accessibilityLabel={`${booking.occurrences.length} ${booking.occurrences.length === 1 ? 'time' : 'times'}`}
        >
          {booking.occurrences.map((o) => (
            <Field
              key={o.start}
              label={formatRange(o.start, o.end, zone.zone)}
              value={`${o.resources.map((r) => resourceName(r.name)).join(', ')}${
                o.eventId === null && booking.status === 'requested'
                  ? '. Not reserved until the request is approved'
                  : ''
              }`}
            />
          ))}
        </View>
        {notice ? <Caption>{notice}</Caption> : null}
        {booking.guestCount !== null ? (
          <Field label="Guests" value={String(booking.guestCount)} />
        ) : null}
        {booking.equipmentAssetIds.length > 0 ? (
          <Field
            label="Equipment"
            value={`${booking.equipmentAssetIds.length} ${booking.equipmentAssetIds.length === 1 ? 'item' : 'items'} reserved with the booking`}
          />
        ) : null}
      </Section>

      <Section title="Terms" testID="booking-terms">
        <Field
          label="How it is confirmed"
          value={confirmationText(booking.terms.confirmationMode)}
        />
        {booking.terms.accessConditions ? (
          <Field label="Access conditions" value={booking.terms.accessConditions} />
        ) : null}
        {booking.terms.hostResponsibilities ? (
          <Field label="Host responsibilities" value={booking.terms.hostResponsibilities} />
        ) : null}
      </Section>

      {booking.status === 'declined' && booking.decisionReason ? (
        <Section title="Why it was not approved">
          <Body>{booking.decisionReason}</Body>
        </Section>
      ) : null}
      {(booking.status === 'canceled' || booking.status === 'expired') && ended ? (
        <Section title={booking.status === 'canceled' ? 'Why it was canceled' : 'Why it expired'}>
          <Body>{ended}</Body>
        </Section>
      ) : null}

      <CancelBooking booking={booking} onReload={reload} />
    </View>
  );
}

export function BookingDetailScreen({ bookingId }: { bookingId: string | null }) {
  if (bookingId === null) return <NotFoundScreen />;
  return <BookingDetail bookingId={bookingId} />;
}

function BookingDetail({ bookingId }: { bookingId: string }) {
  const booking = useApiQuery({ path: '/bookings/{id}', request: { path: { id: bookingId } } });
  return (
    <Screen>
      <View testID="screen-booking-detail">
        <RequireSession what="this booking">
          <QueryBoundary
            query={booking}
            label="the booking"
            empty={{ title: 'Not available', description: '' }}
            unavailableOffline={['Canceling']}
          >
            {(data) => <BookingView booking={data} reload={() => void booking.refetch()} />}
          </QueryBoundary>
        </RequireSession>
      </View>
    </Screen>
  );
}

/** Route component for app/bookings/[id].tsx; a malformed id is "Link not available". */
export function BookingDetailRoute() {
  const params = useLocalSearchParams<{ id: string }>();
  return (
    <>
      <Stack.Screen options={{ title: 'Booking' }} />
      <BookingDetailScreen bookingId={routeId(params.id)} />
    </>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.sm },
  title: { ...type.title, color: colors.text },
});
