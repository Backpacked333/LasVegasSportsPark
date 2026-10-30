/**
 * My rentals and parties (Package G, conditional; §3.16 Rentals and Parties rows, SPK-COND-003,
 * ENR-13; the inventory has no SCR-C id for it, Discover lists rentals under SCR-C-07). Route:
 * `/bookings`, from Account.
 *
 * Reads `GET /v1/me/bookings` (the caller's bookings, newest first, cursor pages with "Load more").
 * Each row names the activity, rental or party, its first time (and how many weeks a repeating
 * rental has) in the facility's time zone, and the status as the API states it; a row opens the
 * booking (`/bookings/[id]`), where it can be cancelled.
 *
 * Behind `CapabilityGate` for `rentals` or `parties` (DEC-016, DEC-076, DEC-077) with
 * `whenOff="notice"`: the API keeps the bookings a customer already has readable, and cancellable,
 * while a switch is off. Booking something new starts from Discover (SCR-C-07, SCR-C-09).
 *
 * States: loading; empty ("No rentals or parties yet", with Discover); ready; error with the code
 * and "Try again"; permission restriction (not available); offline or stale (cached list with its
 * age, cancelling needs a connection); turned off (notice above the list).
 */
import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { usePermissions } from '../../api/permissions';
import { useApiPages } from '../../api/useApiPages';
import { Caption } from '../../features/money/ui';
import { bookingStatus, KIND_LABELS, type Booking } from '../../features/package-g/booking-model';
import { packageGRoutes } from '../../features/package-g/routes';
import { displayZone, formatRange, zoneNotice } from '../../features/today/time';
import { RequireSession } from '../../session/RequireSession';
import { Button } from '../../ui/Button';
import { CapabilityGate } from '../../ui/CapabilityGate';
import { ListRow } from '../../ui/ListRow';
import { LoadMore } from '../../ui/LoadMore';
import { QueryBoundary } from '../../ui/QueryBoundary';
import { Screen } from '../../ui/Screen';
import { colors, spacing, type } from '../../ui/theme';

export const BOOKINGS_STILL_AVAILABLE = 'Bookings you already made stay available here.';
export const BOOKINGS_PAGE_SIZE = 20;

/** "Party. Sat, Oct 31, 10:00 AM to 12:00 PM PDT" (and "4 weeks" for a repeating rental). */
export function bookingSummary(booking: Booking): string {
  const zone = displayZone(booking.timezone);
  const first = booking.occurrences[0];
  const when = first
    ? formatRange(first.start, first.end, zone.zone)
    : formatRange(booking.firstStart, booking.lastEnd, zone.zone);
  const weeks = booking.occurrences.length > 1 ? `, ${booking.occurrences.length} weeks` : '';
  return `${KIND_LABELS[booking.kind]}. ${when}${weeks}`;
}

function BookingRows({ items }: { items: Booking[] }) {
  const router = useRouter();
  const deviceZoneNotice = items.find((b) => !displayZone(b.timezone).facility);
  return (
    <View accessibilityRole="list" accessibilityLabel="Your rentals and parties">
      {items.map((booking) => (
        <ListRow
          key={booking.id}
          title={booking.offeringName ?? KIND_LABELS[booking.kind]}
          detail={bookingSummary(booking)}
          status={bookingStatus(booking)}
          onPress={() => router.push(packageGRoutes.booking(booking.id))}
          accessibilityHint="Opens the booking"
          testID={`booking-${booking.id}`}
        />
      ))}
      {deviceZoneNotice ? (
        <View style={styles.note}>
          <Caption>{zoneNotice(displayZone(null), deviceZoneNotice.firstStart) ?? ''}</Caption>
        </View>
      ) : null}
    </View>
  );
}

function BookingsList() {
  const router = useRouter();
  const bookings = useApiPages({
    path: '/me/bookings',
    request: { query: { limit: BOOKINGS_PAGE_SIZE } },
  });
  return (
    <>
      <QueryBoundary
        query={bookings}
        label="your rentals and parties"
        isEmpty={(items) => items.length === 0}
        empty={{
          title: 'No rentals or parties yet',
          description:
            'Rentals and parties you book or request appear here with their status. Find one to book in Discover.',
          actionLabel: 'Open Discover',
          onAction: () => router.push('/discover'),
        }}
        unavailableOffline={['Canceling a booking', 'Booking']}
      >
        {(items) => <BookingRows items={items} />}
      </QueryBoundary>
      <LoadMore pages={bookings} label="bookings" />
    </>
  );
}

/** Booking something new is offered only while a switch is on (the gate shows the notice). */
function FindNew() {
  const router = useRouter();
  const permissions = usePermissions();
  const on =
    permissions.isCapabilityEnabled('rentals') === true ||
    permissions.isCapabilityEnabled('parties') === true;
  if (!on) return null;
  return (
    <View style={styles.footer}>
      <Button
        label="Find a rental or party"
        variant="secondary"
        onPress={() => router.push('/discover')}
      />
    </View>
  );
}

export function MyBookingsScreen() {
  return (
    <Screen>
      <View testID="screen-my-bookings">
        <RequireSession what="your bookings">
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">
              Rentals and parties
            </Text>
            <Caption>
              A booking is complete only when everything it needs is reserved: the space, any
              equipment and the staff.
            </Caption>
          </View>
          <CapabilityGate
            capability={['rentals', 'parties']}
            subject="Rentals and parties"
            whenOff="notice"
            stillAvailable={BOOKINGS_STILL_AVAILABLE}
          >
            <BookingsList />
            <FindNew />
          </CapabilityGate>
        </RequireSession>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: spacing.lg, paddingTop: spacing.lg, gap: spacing.xs },
  title: { ...type.title, color: colors.text },
  note: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  footer: { padding: spacing.lg },
});
