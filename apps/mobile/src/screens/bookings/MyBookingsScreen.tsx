/**
 * My rentals and parties (Package G, conditional; SPK-COND-003, §3.16; the inventory has no
 * SCR-C id for it, Discover lists rentals under SCR-C-07). Route: `/bookings`, from Account.
 *
 * Placeholder until the bookings screen group builds it over `GET /v1/me/bookings` (paged:
 * `useApiPages` and `LoadMore`) and `GET /v1/bookings/{id}`. Behind `CapabilityGate` for `rentals`
 * or `parties` (DEC-016, DEC-076, DEC-077) with `whenOff="notice"`: the API keeps the bookings a
 * customer already has readable, and cancellable, while a switch is off.
 */
import { PackageGPlaceholder } from '../../features/package-g/PackageGPlaceholder';

export function MyBookingsScreen() {
  return (
    <PackageGPlaceholder
      testID="screen-my-bookings"
      reference="Package G rentals and parties, SPK-COND-003"
      title="Rentals and parties"
      purpose="Your rentals and parties with their status, what each reserves, and cancellation."
      capability={['rentals', 'parties']}
      what="your bookings"
      whenOff="notice"
      stillAvailable="Bookings you already made stay available here."
      pending={{
        subject: 'Rental and party terms, and whether a request takes a deposit before approval',
        decisions: ['POL-040', 'DEC-029', 'DEC-030'],
        owner: 'Product and operations; Finance for refund rules (DEC-030)',
      }}
    />
  );
}
