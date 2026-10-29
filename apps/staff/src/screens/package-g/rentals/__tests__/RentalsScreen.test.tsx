/**
 * SCR-S-51 Rentals placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { RENTALS } from '../meta';

describePackageGPlaceholder(RENTALS, {
  from: '/schedule/calendar',
  nav: 'Schedule sections',
  link: 'Rentals',
});
