/**
 * My rentals and parties placeholder (Package G; SPK-COND-003, DEC-016, DEC-076, DEC-077).
 * Replace with the screen's own tests when the screen is built.
 */
import { describeCustomerPackageGPlaceholder } from '../../../features/package-g/testing';
import { MyBookingsScreen } from '../MyBookingsScreen';

describeCustomerPackageGPlaceholder({
  Screen: MyBookingsScreen,
  testID: 'screen-my-bookings',
  title: 'Rentals and parties',
  reference: 'Package G rentals and parties, SPK-COND-003',
  capability: 'rentals',
  decisions: 'DEC-016, DEC-076, DEC-077',
  stillAvailable: 'Bookings you already made stay available here.',
  pending: 'POL-040, DEC-029, DEC-030',
});
