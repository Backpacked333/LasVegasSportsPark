/**
 * SCR-S-51 Rentals (Package G, conditional; SPK-COND-003, SPK-REG-001 rental request, ENR-13,
 * §3.16 Rentals), inside the Schedule area (its sub-navigation and heading come from ScheduleArea).
 * Route: `/schedule/rentals/*`. Bookings list and detail, request-mode approval and decline,
 * cancellation with its bound consequence, booking for a customer with free times, and the rental
 * offerings' booking terms and definitions, behind `CapabilityGate` for `rentals` (DEC-016,
 * DEC-076). See `../bookings/BookingsArea.tsx`.
 */
import { BookingsArea } from '../bookings/BookingsArea';
import { RENTALS } from './meta';

export function RentalsScreen() {
  return <BookingsArea kind="rental" meta={RENTALS} />;
}
