/**
 * Booking flow for a rental or party offering (Package G, conditional; SPK-COND-003: everything a
 * booking needs is reserved together or nothing is). Route: `/bookings/new/[offeringId]`, opened
 * from an offering (Discover SCR-C-07, the intent chooser SCR-C-09) once built.
 *
 * Placeholder until the bookings screen group builds it over
 * `GET /v1/offerings/{id}/booking-availability` and `POST /v1/bookings` (one Idempotency-Key per
 * booking intent; an unknown deposit outcome is never shown as booked). Behind `CapabilityGate`
 * for `rentals` or `parties` (DEC-016, DEC-076, DEC-077); the API refuses a booking of the kind
 * that is off with CAPABILITY_DISABLED, which shows as turned off. A malformed id is "Link not
 * available" without a request.
 */
import { useLocalSearchParams } from 'expo-router';
import { PackageGPlaceholder } from '../../features/package-g/PackageGPlaceholder';
import { routeId } from '../../features/package-g/routes';
import { NotFoundScreen } from '../not-found/NotFoundScreen';

export function BookingFlowScreen({ offeringId }: { offeringId: string | null }) {
  if (offeringId === null) return <NotFoundScreen />;
  return (
    <PackageGPlaceholder
      testID="screen-booking-flow"
      reference="Package G booking flow, SPK-COND-003"
      title="Book a rental or party"
      purpose="Free times of what the offering reserves, the booking request or instant booking, and its outcome."
      capability={['rentals', 'parties']}
      what="booking"
      pending={{
        subject: 'Rental and party terms, deposits before approval, and in-app payment',
        decisions: ['POL-040', 'DEC-029', 'DEC-030', 'DEC-019'],
        owner:
          'Product and operations; Finance for refund rules (DEC-030); Technical lead/account owners (DEC-019)',
      }}
    />
  );
}

export function BookingFlowRoute() {
  const params = useLocalSearchParams<{ offeringId: string }>();
  return <BookingFlowScreen offeringId={routeId(params.offeringId)} />;
}
