/**
 * SCR-S-52 Parties placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { PARTIES } from '../meta';

describePackageGPlaceholder(PARTIES, {
  from: '/schedule/calendar',
  nav: 'Schedule sections',
  link: 'Parties',
});
