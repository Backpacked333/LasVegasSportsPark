/**
 * SCR-S-52 Parties (Package G, conditional; SPK-COND-003, ENR-13, §3.16 Parties), inside the
 * Schedule area (its sub-navigation and heading come from ScheduleArea). Route:
 * `/schedule/parties/*`. Space, staff (the host), equipment and guests reserved together; the
 * bookings list and detail, request-mode approval and decline, the staffing state
 * (`awaiting_staff` until the host accepts), cancellation with its bound consequence, booking for a
 * customer, and the party packages' terms and definitions, behind `CapabilityGate` for `parties`
 * (DEC-016, DEC-077). See `../bookings/BookingsArea.tsx`.
 */
import { BookingsArea } from '../bookings/BookingsArea';
import { PARTIES } from './meta';

export function PartiesScreen() {
  return <BookingsArea kind="party" meta={PARTIES} />;
}
