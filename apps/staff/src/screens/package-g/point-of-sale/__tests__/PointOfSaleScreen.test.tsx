/**
 * SCR-S-55 Point of sale placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { POINT_OF_SALE } from '../meta';

describePackageGPlaceholder(POINT_OF_SALE, {
  from: '/finance',
  nav: 'Finance',
  link: 'Point of sale (SCR-S-55)',
});
