/**
 * SCR-S-56 Access hardware placeholder: behind its capability switch, reachable from its area (Package G,
 * DEC-016). Replace with the screen's own tests when the screen is built.
 */
import { describePackageGPlaceholder } from '../../testing';
import { ACCESS_HARDWARE } from '../meta';

describePackageGPlaceholder(ACCESS_HARDWARE, {
  from: '/admin',
  nav: 'Administration screens',
  link: 'Access hardware (conditional)',
});
